import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { OpenCodeAdapter } from '../src/index.ts'
import type { OpenCodeAdapterOptions, OpenCodeConnectionOptions } from '../src/index.ts'

/** Build a fake CLI child process that emits the given stdout lines. */
function fakeChild(lines: string[], exitCode: number | null = 0): ChildProcess {
  const proc = new EventEmitter() as unknown as ChildProcess
  const stdout = Readable.from(lines.map((line) => Buffer.from(`${line}\n`, 'utf8')))
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  Object.assign(proc, { stdout, stderr, stdin, kill: () => {} })
  // Emit `close` only after the consumer has drained stdout, like a real child.
  const emitClose = (): void => {
    setImmediate(() => {
      ;(proc as unknown as EventEmitter).emit('close', exitCode)
    })
  }
  stdout.once('end', emitClose)
  stdout.once('error', emitClose)
  return proc
}

/** JSON line as emitted by `opencode run --format json` for assistant text. */
function textEvent(text: string): string {
  return JSON.stringify({
    type: 'text',
    part: { type: 'text', text },
  })
}

/** JSON line as emitted by `opencode run --format json` on failure. */
function errorEvent(message: string): string {
  return JSON.stringify({
    type: 'error',
    error: { name: 'APIError', data: { message } },
  })
}

interface BuildOptions {
  lines?: string[]
  exitCode?: number | null
  captured?: { command: string; args: readonly string[]; stdin: string }
  resolveDirectory?: (sessionId: string | undefined) => Promise<string | undefined>
}

/** Construct an adapter whose CLI factory is a scripted fake. */
function buildAdapter(options: BuildOptions = {}): OpenCodeAdapter {
  const connection: OpenCodeConnectionOptions = {
    cliPath: 'fake-opencode',
    timeoutMs: 5_000,
    models: [{ id: 'mimo-v2.6-flash-free', name: 'MiMo', contextWindow: 1000, maxTokens: 100 }],
    retryPolicy: { mode: 'normal', maxRetries: 0 } as OpenCodeConnectionOptions['retryPolicy'],
  }
  const adapterOptions: OpenCodeAdapterOptions = {
    options: () => connection,
    ...(options.resolveDirectory === undefined ? {} : { resolveDirectory: options.resolveDirectory }),
    spawn: (command, args) => {
      if (options.captured !== undefined) {
        options.captured.command = command
        options.captured.args = args
      }
      const child = fakeChild(options.lines ?? [], options.exitCode ?? 0)
      if (options.captured !== undefined) {
        let capturedText = ''
        child.stdin?.on('data', (chunk: Buffer) => {
          capturedText += chunk.toString('utf8')
        })
        child.on('close', () => {
          options.captured!.stdin = capturedText
        })
      }
      return child
    },
  }
  return new OpenCodeAdapter(adapterOptions)
}

/** Drive `adapter.stream()` and collect every chunk. */
async function collect(adapter: OpenCodeAdapter): Promise<unknown[]> {
  const chunks: unknown[] = []
  const iterable = adapter.stream({
    model: 'mimo-v2.6-flash-free',
    system: 'Be terse.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK' }] }],
  })
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** Drive `adapter.stream()` with a session id stamped on the request. */
async function collectWithSession(adapter: OpenCodeAdapter, sessionId: string): Promise<unknown[]> {
  const chunks: unknown[] = []
  const iterable = adapter.stream({
    model: 'mimo-v2.6-flash-free',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say OK' }] }],
    sessionId: sessionId as never,
  })
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('OpenCodeAdapter', () => {
  it('lists the configured models', async () => {
    const adapter = buildAdapter()
    const models = await adapter.listModels('opencode-local')
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ provider: 'opencode-local', id: 'mimo-v2.6-flash-free' })
  })

  it('resolves the configured context window', async () => {
    const adapter = buildAdapter()
    const resolved = await adapter.resolveModel('opencode-local', 'mimo-v2.6-flash-free')
    expect(resolved.context?.contextWindow).toBe(1000)
    expect(resolved.defaultMaxTokens).toBe(100)
  })

  it('spawns `run --format json -m opencode/<model>` and pipes the prompt to stdin', async () => {
    const captured = { command: '', args: [] as readonly string[], stdin: '' }
    const adapter = buildAdapter({ captured, lines: [textEvent('OK')] })
    await collect(adapter)
    expect(captured.command).toBe('fake-opencode')
    expect(captured.args).toEqual(['run', '--format', 'json', '-m', 'opencode/mimo-v2.6-flash-free'])
    expect(captured.stdin).toContain('Be terse.')
    expect(captured.stdin).toContain('Say OK')
  })

  it('translates a text event into block/text-delta/block-end/finish', async () => {
    const adapter = buildAdapter({ lines: [textEvent('HELLO')] })
    const chunks = await collect(adapter)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'HELLO' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'HELLO' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('accumulates multiple text events into one block', async () => {
    const adapter = buildAdapter({ lines: [textEvent('A'), textEvent('B'), textEvent('C')] })
    const chunks = await collect(adapter)
    const deltas = chunks.filter((chunk) => (chunk as { type: string }).type === 'text-delta')
    expect(deltas).toHaveLength(3)
    const end = chunks.find((chunk) => (chunk as { type: string }).type === 'block-end')
    expect((end as { block: { text: string } }).block.text).toBe('ABC')
  })

  it('surfaces a CLI error event as an error finish', async () => {
    const adapter = buildAdapter({ lines: [errorEvent('free tier rejected')], exitCode: 1 })
    const chunks = await collect(adapter)
    const finish = chunks.at(-1) as {
      type: string
      reason: { kind: string; failure?: { message: string } }
    }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure?.message).toBe('free tier rejected')
  })

  it('throws when the CLI exits non-zero without any text', async () => {
    const adapter = buildAdapter({ lines: [], exitCode: 2 })
    await expect(collect(adapter)).rejects.toThrow(/exited with code 2/)
  })

  it('ignores malformed stdout lines', async () => {
    const adapter = buildAdapter({ lines: ['not json', textEvent('OK')] })
    const chunks = await collect(adapter)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'OK' })
  })

  it('passes `--dir <session cwd>` so edits land in the session project tree', async () => {
    const captured = { command: '', args: [] as readonly string[], stdin: '' }
    const seen: (string | undefined)[] = []
    const adapter = buildAdapter({
      captured,
      lines: [textEvent('OK')],
      resolveDirectory: async (sessionId) => {
        seen.push(sessionId)
        return 'D:\\Projects\\EpubOnline'
      },
    })
    await collectWithSession(adapter, 'session-1502d863-6427-481f-bf6b-806d66c75ce0')
    expect(seen).toEqual(['session-1502d863-6427-481f-bf6b-806d66c75ce0'])
    expect(captured.args).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'opencode/mimo-v2.6-flash-free',
      '--dir',
      'D:\\Projects\\EpubOnline',
    ])
  })

  it('omits `--dir` when the session directory cannot be resolved', async () => {
    const captured = { command: '', args: [] as readonly string[], stdin: '' }
    const adapter = buildAdapter({
      captured,
      lines: [textEvent('OK')],
      resolveDirectory: async () => undefined,
    })
    await collectWithSession(adapter, 'session-missing')
    expect(captured.args).toEqual(['run', '--format', 'json', '-m', 'opencode/mimo-v2.6-flash-free'])
  })

  it('keeps the legacy argv when no directory resolver is configured', async () => {
    const captured = { command: '', args: [] as readonly string[], stdin: '' }
    const adapter = buildAdapter({ captured, lines: [textEvent('OK')] })
    await collectWithSession(adapter, 'session-1502d863-6427-481f-bf6b-806d66c75ce0')
    expect(captured.args).toEqual(['run', '--format', 'json', '-m', 'opencode/mimo-v2.6-flash-free'])
  })
})
