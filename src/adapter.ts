/**
 * `OpenCodeAdapter`: drives the local `opencode` CLI in JSON-event mode and
 * emits harness StreamChunks.
 *
 * Why the CLI instead of the HTTP server: OpenCode v1.19.x exposes two model
 * runtimes. "native" models (the free `opencode/*-free` catalogue) are only
 * executable by the first-party client, and the headless `opencode serve`
 * runner rejects them with `SessionRunnerModel.UnsupportedApiError`, while the
 * OpenCode backend rejects them with `FreeTierError` when the request does not
 * come from a first-party client. `opencode run` is a first-party client, so
 * spawning it is the only supported path that keeps the free catalogue usable
 * from inside another harness.
 *
 * The adapter serializes the whole DSH conversation into one prompt, pipes it
 * to the CLI over stdin (no command-line length limits), and translates the
 * CLI's `--format json` event lines into harness StreamChunks.
 *
 * This adapter is text-output only: OpenCode runs its own internal agent/tool
 * loop, so structured DSH tool calling is not advertised.
 *
 * @module dsh-llm-opencode/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { serializeConversation } from './serialize.ts'

/** Default context window when a model entry does not declare one. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 16_384

/**
 * Wire provider ID inside OpenCode. The DSH route is `opencode-local`, but the
 * model string handed to `opencode run` is `opencode/<model>`.
 */
export const OPENCODE_PROVIDER_ID = 'opencode'

/** Default CLI executable looked up on `PATH`. */
export const DEFAULT_CLI_PATH = 'opencode'

/** Default wall-clock cap for one CLI turn. */
export const DEFAULT_TIMEOUT_MS = 600_000

/** Catalogue entry surfaced to DSH model pickers. */
export interface OpenCodeModelEntry {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
}

/**
 * Free models verified to work through `opencode run` at the time of writing
 * (OpenCode CLI 1.19.3). Availability is upstream-controlled; run
 * `opencode models` and probe the live catalogue before relying on an id.
 */
export const DEFAULT_MODELS: readonly OpenCodeModelEntry[] = [
  { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash (free)' },
  { id: 'glm-5.3-flash-free', name: 'GLM-5.3 Flash (free)' },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash (free)' },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview (free)' },
]

/** Connection facts resolved once per stream call. */
export interface OpenCodeConnectionOptions {
  cliPath: string
  timeoutMs: number
  models: readonly OpenCodeModelEntry[]
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link OpenCodeAdapter}. */
export interface OpenCodeAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => OpenCodeConnectionOptions
  /**
   * Test seam: replace the CLI process factory. Production omits it and the
   * adapter spawns the real executable.
   */
  spawn?: (command: string, args: readonly string[]) => ChildProcess
}

/** Normalize one configured model entry into the DSH model description. */
function modelInfo(provider: string, entry: OpenCodeModelEntry): LlmModelInfo {
  return {
    provider,
    id: entry.id,
    name: entry.name ?? entry.id,
    description: entry.description ?? 'OpenCode local agent (text output only)',
    inputModalities: ['text'],
  }
}

/** One parsed CLI stdout event line, narrowed to the fields we consume. */
interface CliEvent {
  type?: string
  part?: { text?: unknown }
  error?: { name?: unknown; data?: { message?: unknown } }
}

/**
 * The OpenCode LLM adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 */
export class OpenCodeAdapter extends LlmAdapter {
  private readonly spawnCli: (command: string, args: readonly string[]) => ChildProcess

  constructor(private readonly config: OpenCodeAdapterOptions) {
    super()
    this.spawnCli = config.spawn ?? ((command, args) => spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    }))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode (local CLI)' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const { models } = this.config.options()
    return Promise.resolve(models.map((entry) => modelInfo(provider, entry)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const { models } = this.config.options()
    const entry = models.find((candidate) => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      description: entry?.description ?? 'OpenCode local agent (text output only)',
      inputModalities: ['text'],
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: entry?.maxTokens ?? DEFAULT_MAX_TOKENS,
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const prompt = serializeConversation(options)
    const modelArg = `${OPENCODE_PROVIDER_ID}/${options.model}`

    // Spawn the first-party CLI. `--format json` emits one JSON object per
    // line on stdout; stderr is diagnostic only.
    let child: ChildProcess
    try {
      child = this.spawnCli(connection.cliPath, ['run', '--format', 'json', '-m', modelArg])
    } catch (error) {
      throw new LlmError(
        `OpenCode CLI launch failed (${connection.cliPath}): ${String(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }

    const stdin = child.stdin
    const stdout = child.stdout
    const stderr = child.stderr

    let stderrText = ''
    stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8')
      if (stderrText.length > 4_000) stderrText = stderrText.slice(-4_000)
    })

    let exited = false
    let exitCode: number | null = null
    let spawnError: Error | undefined
    const killChild = (): void => {
      if (exited) return
      try {
        child.kill()
      } catch {
        // Process may already be gone.
      }
    }
    if (stdin === null || stdout === null) {
      killChild()
      throw new LlmError('OpenCode CLI was spawned without piped stdio', 'TRANSPORT')
    }
    child.on('error', (error: Error) => {
      spawnError = error
    })
    child.on('close', (code: number | null) => {
      exited = true
      exitCode = code
    })

    // Abort forwarding: the harness cancels a turn by aborting the signal.
    const onAbort = (): void => killChild()
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        killChild()
        throw new LlmError('OpenCode request aborted by caller', 'ABORTED')
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const watchdog = setTimeout(() => killChild(), connection.timeoutMs)

    // Feed the conversation through stdin: no argv length ceiling, and the
    // CLI treats EOF as "run this prompt".
    stdin.on('error', () => {
      // Broken pipe when the child exits early; surfaced via exit code.
    })
    try {
      stdin.write(prompt)
      stdin.end()
    } catch {
      // Ignore: the close handler reports the failure.
    }

    let buffer = ''
    let accumulatedText = ''
    let blockOpened = false
    let errorMessage: string | undefined

    /**
     * Parse one stdout line.
     * @param line - raw line, possibly empty.
     * @returns the text delta to emit, or null for non-text events.
     */
    const consumeLine = (line: string): string | null => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return null
      let event: CliEvent
      try {
        event = JSON.parse(trimmed) as CliEvent
      } catch {
        return null
      }
      if (event.type === 'text') {
        const text = typeof event.part?.text === 'string' ? event.part.text : ''
        return text.length === 0 ? null : text
      }
      if (event.type === 'error') {
        const dataMessage = event.error?.data?.message
        const name = event.error?.name
        const message = typeof dataMessage === 'string' && dataMessage.length > 0
          ? dataMessage
          : typeof name === 'string' && name.length > 0
            ? name
            : 'OpenCode CLI error'
        errorMessage = message
      }
      return null
    }

    try {
      for await (const chunk of stdout) {
        buffer += (chunk as Buffer).toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const delta = consumeLine(line)
          if (delta === null) continue
          if (!blockOpened) {
            blockOpened = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          accumulatedText += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }
      }
      const tail = consumeLine(buffer)
      if (tail !== null) {
        if (!blockOpened) {
          blockOpened = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        accumulatedText += tail
        yield { type: 'text-delta', index: 0, text: tail }
      }
    } finally {
      clearTimeout(watchdog)
      options.signal?.removeEventListener('abort', onAbort)
      killChild()
    }

    // stdout can close a tick before the process reports its exit status;
    // wait briefly so error paths see the real code.
    await new Promise<void>((resolve) => {
      if (exited) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, 2_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    if (options.signal?.aborted) {
      throw new LlmError('OpenCode request aborted by caller', 'ABORTED')
    }
    if (spawnError !== undefined) {
      throw new LlmError(
        `OpenCode CLI could not run (${connection.cliPath}): ${spawnError.message}`,
        'TRANSPORT',
        { cause: spawnError },
      )
    }
    if (errorMessage !== undefined) {
      if (blockOpened) {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulatedText } }
      }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: errorMessage, code: 'PROVIDER_ERROR' } },
      }
      return
    }
    if (exitCode !== null && exitCode !== 0 && accumulatedText.length === 0) {
      throw new LlmError(
        `OpenCode CLI exited with code ${String(exitCode)}${stderrText.length > 0 ? `: ${stderrText.slice(0, 500)}` : ''}`,
        'TRANSPORT',
      )
    }

    if (blockOpened) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulatedText } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
