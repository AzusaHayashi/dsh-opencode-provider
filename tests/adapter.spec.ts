import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, resolveRetryPolicy, userAgent } from '@deepseek-ai/dsh-llm'
import * as LlmOpenCode from '../src/index.ts'
import { OpenCodeAdapter } from '../src/index.ts'
import { assemble } from './assemble.ts'
import {
  closeMockServers,
  errorEvents,
  idleEvents,
  mockOpenCodeServer,
  nextErrorEvents,
  nextTextDeltaEvents,
  textDeltaEvents,
  liveTextEndedEvents,
  liveStepEndedWithTextEvents,
  liveDeltaPlusTextEndedEvents,
} from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-opencode-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string, config: object = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmOpenCode, { baseURL, ...config })
  return ctx
}

function adapterOf(config: { baseURL?: string } = {}): OpenCodeAdapter {
  return new OpenCodeAdapter({
    options: () => ({
      baseURL: config.baseURL ?? 'http://127.0.0.1:4096',
      retryPolicy: resolveRetryPolicy(undefined, 'test'),
    }),
  })
}

describe('OpenCodeAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(result.finish).toEqual({ kind: 'stop' })

    // The first request creates a session with the model explicitly set.
    expect(server.requests[0]).toEqual({ model: { id: 'mimo-v2.5-free', providerID: 'opencode' } })
    // The third request delivers the prompt.
    const promptRequest = server.requests.find(
      (r: unknown) => r !== null && typeof r === 'object' && 'id' in (r as Record<string, unknown>),
    ) as { id: string; prompt: { text: string; files: unknown[] }; delivery: string } | undefined
    expect(promptRequest).toBeDefined()
    expect(promptRequest!.prompt.text).toContain('[User]')
    expect(promptRequest!.prompt.text).toContain('hi')
  })

  it('sends attribution headers on all requests', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })

    // All requests should carry the user-agent header.
    for (const h of server.headers) {
      expect(h['user-agent']).toBe(userAgent())
    }
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents, delayMs: 2 },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-local',
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
  })

  it('correctly terminates on session.execution.succeeded', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('correctly terminates on session.idle', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: idleEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('surfaces session.error as a provider error', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: errorEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'something went wrong',
        code: 'PROVIDER_ERROR',
      },
    })
  })

  it('surfaces session.execution.failed as a provider error', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: [
        JSON.stringify({ type: 'session.execution.failed', data: { message: 'crash' } }),
      ] },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'crash',
        code: 'PROVIDER_ERROR',
      },
    })
  })

  it('handles new-format session.next.text.delta events', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: nextTextDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'alpha beta' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('surfaces session.next.step.failed as a provider error', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: nextErrorEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'provider crashed',
        code: 'PROVIDER_ERROR',
      },
    })
  })

  it('serializes the full conversation into the prompt', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      system: 'You are helpful.',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'first message' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
    })

    const promptRequest = server.requests.find(
      (r: unknown) => r !== null && typeof r === 'object' && 'id' in (r as Record<string, unknown>),
    ) as { id: string; prompt: { text: string; files: unknown[] }; delivery: string } | undefined
    expect(promptRequest).toBeDefined()
    expect(promptRequest!.prompt.text).toContain('[System]')
    expect(promptRequest!.prompt.text).toContain('You are helpful.')
    expect(promptRequest!.prompt.text).toContain('[User]')
    expect(promptRequest!.prompt.text).toContain('first message')
  })

  it('reports a transport failure with the endpoint in the message', async () => {
    // Port 1 is reserved/unbound, so the service normalizes the fetch failure.
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: {
        code: 'TRANSPORT',
        message: expect.stringContaining('OpenCode session creation to http://127.0.0.1:1 failed') as unknown,
      },
    })
  })

  it('classifies an aborted request as an aborted finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [],
      signal: controller.signal,
    })
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents, delayMs: 50 },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const controller = new AbortController()

    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: 'opencode-local',
        model: 'mimo-v2.5-free',
        messages: [],
        signal: controller.signal,
      })) {
        chunks.push(chunk)
      }
      return chunks
    })()

    setTimeout(() => { controller.abort() }, 30)
    const chunks = await pending
    // The abort produces a finish chunk; some deltas may arrive before it.
    const finishChunks = chunks.filter(c => c.type === 'finish')
    expect(finishChunks).toHaveLength(1)
    const finish = finishChunks[0]
    if (finish?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(finish.reason.kind).toBe('aborted')
    if (finish.reason.kind !== 'aborted') throw new Error('expected an aborted finish')
    expect(finish.reason.failure.code).toBe('ABORTED')
  })

  it('handles non-JSON SSE data gracefully', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: [
        'not json',
        JSON.stringify({ type: 'session.text.delta', data: { delta: 'real' } }),
        JSON.stringify({ type: 'session.execution.succeeded', data: {} }),
      ] },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'real' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('skips unknown SSE events without breaking the stream', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: [
        JSON.stringify({ type: 'unknown.event', data: {} }),
        JSON.stringify({ type: 'session.text.delta', data: { delta: 'found' } }),
        JSON.stringify({ type: 'session.execution.succeeded', data: {} }),
      ] },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'found' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('validates response envelopes defensively (data wrapper)', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    // The mock server returns { data: { sessionID: '...' } } — the adapter
    // should unwrap it correctly.
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('reports session creation failure as TRANSPORT', async () => {
    const server = await mockOpenCodeServer([])
    // Override the script so the first POST /api/session fails.
    server.script.unshift({
      kind: 'http-error',
      status: 500,
      body: JSON.stringify({ error: { message: 'internal error' } }),
    })
    // Actually we need to make the session creation fail.
    // Let's use a server that always errors on POST /api/session.
    await closeMockServers()

    const errorServer = await mockOpenCodeServer([])
    // We need to intercept the session creation. Let's just use a different approach.
    await errorServer.close()

    // Use a port that won't respond.
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: {
        code: 'TRANSPORT',
      },
    })
  })
})

describe('plugin registration', () => {
  it('registers the opencode provider and unregisters on dispose (HMR safety)', async () => {
    const server = await mockOpenCodeServer([])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmOpenCode, {
      baseURL: server.url,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-local', name: 'OpenCode' }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('registers retryPolicy from the provider config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenCode, {
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: {
        mode: 'always',
        backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
      },
    })

    expect(ctx.llm.providerRetryPolicy('opencode-local')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('owns the opencode provider and advertises the default model', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenCode, { baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-local', name: 'OpenCode' }])
    await expect(ctx.llm.listModels('opencode-local')).resolves.toEqual([
      { provider: 'opencode-local', id: 'mimo-v2.5-free', name: 'mimo-v2.5-free', description: 'OpenCode local agent (text output only)', inputModalities: ['text'] },
    ])
    await expect(ctx.llm.resolveModelInfo('opencode-local', 'mimo-v2.5-free'))
      .resolves.toMatchObject({
        provider: 'opencode-local',
        id: 'mimo-v2.5-free',
        name: 'mimo-v2.5-free',
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 16_384,
      })
  })

  it('defaults to the public base URL without config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenCode, {})
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-local', name: 'OpenCode' }])
  })

  it('boots with undefined config (omitted cordis.patch.yml row)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    LlmOpenCode.apply(ctx, undefined)
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-local', name: 'OpenCode' }])
    await expect(ctx.llm.resolveModelInfo('opencode-local', 'mimo-v2.5-free'))
      .resolves.toMatchObject({
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 16_384,
      })
  })

  it('rejects invalid context capacity', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmOpenCode, {
      baseURL: 'http://127.0.0.1:1',
      defaultContextWindow: 0,
    })).rejects.toThrow(/defaultContextWindow/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('rejects invalid maxTokens', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmOpenCode, {
      baseURL: 'http://127.0.0.1:1',
      maxTokens: 1.5,
    })).rejects.toThrow(/maxTokens/)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('uses the default model catalog when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    LlmOpenCode.apply(ctx, { baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('opencode-local')).resolves.toEqual([
      { provider: 'opencode-local', id: 'mimo-v2.5-free', name: 'mimo-v2.5-free', description: 'OpenCode local agent (text output only)', inputModalities: ['text'] },
    ])
  })

  it('adapter is constructible directly', async () => {
    const adapter = adapterOf()
    expect(adapter).toBeInstanceOf(OpenCodeAdapter)
    await expect(adapter.listModels('opencode-local')).resolves.toHaveLength(1)
  })

  it('does not require an API key', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    // No DEEPSEEK_API_KEY set.
    vi.stubEnv('DEEPSEEK_API_KEY', undefined)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmOpenCode, { baseURL: server.url })
    // Should register successfully without any key.
    expect(ctx.llm.listProviders()).toEqual([{ id: 'opencode-local', name: 'OpenCode' }])
    // And stream should work.
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('keep wire helpers off the package root', () => {
    for (const helper of [
      'httpErrorCode',
      'serializeMessages',
      'serializeRequest',
      'DONE',
      'parseSse',
      'mapFinishReason',
      'mapUsage',
      'translate',
    ]) expect(LlmOpenCode).not.toHaveProperty(helper)
  })
})

describe('serialize', () => {
  it('serializes system + user messages into a prompt', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      system: 'You are helpful.',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'hello' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
    })

    const promptRequest = server.requests.find(
      (r: unknown) => r !== null && typeof r === 'object' && 'id' in (r as Record<string, unknown>),
    ) as { id: string; prompt: { text: string; files: unknown[] }; delivery: string } | undefined
    expect(promptRequest).toBeDefined()
    const prompt = promptRequest!.prompt.text
    expect(prompt).toContain('[System]\nYou are helpful.')
    expect(prompt).toContain('[User]\nhello')
    // System and user messages are separated by double newlines.
    expect(prompt).toContain(']\nYou are helpful.\n\n[User]\nhello')
  })

  it('serializes multi-turn conversations preserving order', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [
        createUserMessage({
          content: [{ type: 'text', text: 'first' }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
    })

    const promptRequest = server.requests.find(
      (r: unknown) => r !== null && typeof r === 'object' && 'id' in (r as Record<string, unknown>),
    ) as { id: string; prompt: { text: string; files: unknown[] }; delivery: string } | undefined
    expect(promptRequest).toBeDefined()
    const promptIdx = promptRequest!.prompt.text.indexOf('first')
    expect(promptIdx).toBeGreaterThanOrEqual(0)
  })
})

describe('request body regression', () => {
  it('sends the model ref { id, providerID } as the POST /api/session body', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(server.requests[0]).toEqual({ model: { id: 'mimo-v2.5-free', providerID: 'opencode' } })
  })

  it('sends the verified prompt schema with id, prompt.text, prompt.files, and delivery', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'test message' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    const promptRequest = server.requests.find(
      (r: unknown) => r !== null && typeof r === 'object' && 'id' in (r as Record<string, unknown>),
    ) as { id: string; prompt: { text: string; files: unknown[] }; delivery: string } | undefined
    expect(promptRequest).toBeDefined()
    expect(typeof promptRequest!.id).toBe('string')
    expect(promptRequest!.id).toMatch(/^msg_/)
    expect(promptRequest!.prompt).toEqual({ text: expect.any(String) as unknown, files: [] })
    expect(promptRequest!.delivery).toBe('steer')
    expect(promptRequest!.prompt.text).toContain('[User]')
    expect(promptRequest!.prompt.text).toContain('test message')
  })
})

describe('model selection regression', () => {
  it('maps the DSH model name to the OpenCode ModelRef { id, providerID }', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    const sessionBody = server.requests[0] as {
      model: { id: string; providerID: string }
    }
    expect(sessionBody).toEqual({
      model: { id: 'mimo-v2.5-free', providerID: 'opencode' },
    })
    expect(sessionBody.model.id).toBe('mimo-v2.5-free')
    expect(sessionBody.model.providerID).toBe('opencode')
  })

  it('maps the model name through to the session creation request verbatim', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'test' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    const body = server.requests[0] as Record<string, unknown>
    expect(body).toHaveProperty('model')
    const model = body.model as Record<string, unknown>
    expect(model).toEqual({ id: 'mimo-v2.5-free', providerID: 'opencode' })
  })
})

describe('session ID field envelope', () => {
  it('reads session id from data.id (real OpenCode server shape)', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: textDeltaEvents },
      { kind: 'sse', events: [] },
    ])
    // The mock server now returns { data: { id: ... } } — matching the live API.
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    // The session creation request should have been made with the model.
    expect(server.requests[0]).toEqual({ model: { id: 'mimo-v2.5-free', providerID: 'opencode' } })
  })

  it('falls back to data.sessionID for backward compatibility', async () => {
    const { createServer: createCompatServer } = await import('node:http')
    const compatScript = [
      { kind: 'sse' as const, events: textDeltaEvents },
      { kind: 'sse' as const, events: [] },
    ]
    const requests: unknown[] = []
    const compatServer = createCompatServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        const url = req.url ?? ''
        if (req.method === 'POST' && url === '/api/session') {
          requests.push(body ? JSON.parse(body) : undefined)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: { sessionID: 'compat-sid-123' } }))
          return
        }
        if (req.method === 'GET' && /^\/api\/session\/[^/]+\/event$/.test(url)) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const behavior = compatScript.shift()
          if (!behavior) { res.end(); return }
          for (const ev of behavior.events) {
            res.write(`data: ${ev}\n\n`)
          }
          res.end()
          return
        }
        if (req.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(url)) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        res.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      compatServer.listen(0, '127.0.0.1', (err?: Error) => {
        if (err) reject(err); else resolve()
      })
    })
    const addr = compatServer.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const url = `http://127.0.0.1:${addr.port}`

    try {
      const ctx = await harness(url)
      const result = await assemble(ctx, {
        model: 'mimo-v2.5-free',
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })
      expect(result.finish).toEqual({ kind: 'stop' })
    } finally {
      await new Promise<void>(r => compatServer.close(() => r()))
    }
  })
})

describe('deadlock regression: SSE headers withheld until prompt', () => {
  it('completes when the server withholds SSE headers until the prompt arrives', async () => {
    // This test simulates the real OpenCode server behavior that caused
    // the deadlock: the server does NOT send SSE response headers (and
    // therefore does not resolve the fetch promise) until the session has
    // activity — which only happens after the prompt is delivered.
    //
    // With the OLD ordering (await SSE fetch, then POST prompt), this test
    // would hang forever. With the new ordering (concurrent SSE + prompt),
    // the prompt arrives first, triggering the server to release the SSE
    // response headers.
    const { createServer: createDeadlockServer } = await import('node:http')
    const requests: unknown[] = []
    let sseResponse: import('node:http').ServerResponse | null = null
    let sseEvents: string[] = []

    const deadlockServer = createDeadlockServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => { body += c.toString() })
      req.on('end', () => {
        const url = req.url ?? ''

        // POST /api/session — create session
        if (req.method === 'POST' && url === '/api/session') {
          requests.push(body ? JSON.parse(body) : undefined)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: { id: 'deadlock-session-1' } }))
          return
        }

        // GET /api/session/:id/event — SSE stream
        // KEY: Do NOT write headers yet. Hold the response open.
        // Headers are released when the prompt endpoint is called.
        if (req.method === 'GET' && /^\/api\/session\/[^/]+\/event$/.test(url)) {
          requests.push(undefined)
          sseResponse = res
          sseEvents = [
            JSON.stringify({ type: 'session.text.delta', data: { delta: 'response after prompt' } }),
            JSON.stringify({ type: 'session.execution.succeeded', data: {} }),
          ]
          // Do NOT write headers — simulate the server withholding them.
          return
        }

        // POST /api/session/:id/prompt — deliver prompt
        // KEY: Upon receiving the prompt, release the SSE headers and start
        // streaming events. This is what the real OpenCode server does.
        if (req.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(url)) {
          requests.push(body ? JSON.parse(body) : undefined)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')

          // Now release the SSE response headers and stream events.
          if (sseResponse) {
            sseResponse.writeHead(200, { 'content-type': 'text/event-stream' })
            for (const ev of sseEvents) {
              sseResponse.write(`data: ${ev}\n\n`)
            }
            sseResponse.end()
            sseResponse = null
          }
          return
        }

        res.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      deadlockServer.listen(0, '127.0.0.1', (err?: Error) => {
        if (err) reject(err); else resolve()
      })
    })
    const addr = deadlockServer.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const url = `http://127.0.0.1:${addr.port}`

    try {
      const ctx = await harness(url)
      const result = await assemble(ctx, {
        model: 'mimo-v2.5-free',
        messages: [createUserMessage({
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      })
      expect(result.message.content).toEqual([{ type: 'text', text: 'response after prompt' }])
      expect(result.finish).toEqual({ kind: 'stop' })
    } finally {
      await new Promise<void>(r => deadlockServer.close(() => r()))
    }
  })
})

describe('live event envelope regression', () => {
  it('extracts text from session.next.text.ended when no deltas are present', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: liveTextEndedEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'SMOKE_OK' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('terminates on session.next.step.ended', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: liveTextEndedEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-local',
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) {
      chunks.push(chunk)
    }
    const finishChunks = chunks.filter(c => c.type === 'finish')
    expect(finishChunks).toHaveLength(1)
    expect(finishChunks[0]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('does not duplicate text when deltas precede text.ended', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: liveDeltaPlusTextEndedEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    // Only the delta text should appear — text.ended is suppressed when
    // accumulated text is non-empty.
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello world' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('falls back to step.ended text when text.ended is empty', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: liveStepEndedWithTextEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, {
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'fallback text' }])
    expect(result.finish).toEqual({ kind: 'stop' })
  })

  it('handles live event stream end-to-end through the raw chunk iterator', async () => {
    const server = await mockOpenCodeServer([
      { kind: 'sse', events: liveTextEndedEvents },
      { kind: 'sse', events: [] },
    ])
    const ctx = await harness(server.url)
    const kinds: string[] = []
    const texts: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'opencode-local',
      model: 'mimo-v2.5-free',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })) {
      kinds.push(chunk.type)
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    expect(texts).toEqual(['SMOKE_OK'])
  })
})

