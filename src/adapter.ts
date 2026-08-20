/**
 * `OpenCodeAdapter`: HTTP + SSE against a local OpenCode server, emitting
 * harness StreamChunks. The adapter creates a session, subscribes to events,
 * sends the serialized conversation as a prompt, and translates SSE events
 * into the harness streaming protocol.
 *
 * This adapter is text-output only because OpenCode runs its own internal
 * agent/tool loop. Structured DSH tool calling is not advertised.
 *
 * @module dsh-llm-opencode/adapter
 */

import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { randomBytes } from 'node:crypto'
import { serializeConversation } from './serialize.ts'
import type {
  WireEvent,
  WireTextDeltaEvent,
  WireTextEndedEvent,
  WireStepEndedEvent,
} from './types.ts'

/** Default base URL for the local OpenCode server. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:4096'

/** Default context window for the OpenCode provider. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 16_384

/** Timeout (ms) for the SSE stream to return HTTP response headers. */
const SSE_ESTABLISH_TIMEOUT_MS = 10_000

/** Timeout (ms) for the prompt POST to return 200. */
const PROMPT_ADMISSION_TIMEOUT_MS = 10_000

/** Timeout (ms) for a terminal SSE event to arrive after prompt delivery. */
const TERMINAL_COMPLETION_TIMEOUT_MS = 120_000

/**
 * The providerID used in the OpenCode `ModelRef` when selecting a model.
 * This maps the DSH `opencode-local` provider route to the wire-level
 * `opencode` providerID that the OpenCode server expects.
 */
export const OPENCODE_PROVIDER_ID = 'opencode'

/** Error codes for terminal OpenCode session events. */
const ERROR_CODE_MAP: Record<string, string> = {
  'session.execution.failed': 'PROVIDER_ERROR',
  'session.error': 'PROVIDER_ERROR',
  'session.next.step.failed': 'PROVIDER_ERROR',
}

/** Generate a unique message ID for prompt requests. */
function generateMessageId(): string {
  return `msg_${Date.now()}_${randomBytes(8).toString('hex')}`
}

/** Read the response body as text, returning empty string on failure. */
async function errorBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * Race a promise against a timeout. Resolves with the promise result or
 * rejects with an `LlmError` tagged with the stage and session ID.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  stage: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new LlmError(
        `OpenCode ${stage} timed out after ${ms}ms (session ${sessionId})`,
        'TIMEOUT',
      ))
    }, ms)

    // Forward caller abort into the timer race.
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new LlmError(
        `OpenCode ${stage} aborted (session ${sessionId})`,
        'ABORTED',
      ))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

/**
 * Best-effort POST to the interrupt endpoint so the server stops processing.
 * Fire-and-forget; errors are swallowed.
 */
async function interruptSession(
  baseURL: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await fetch(`${baseURL}/api/session/${sessionId}/interrupt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        ...attributionHeaders(),
      },
      body: '{}',
      signal: signal ?? null,
    })
  } catch {
    // Interrupt is best-effort; the caller owns the terminal error.
  }
}

/** Validate an SSE line and extract the data payload. */
function parseSseLine(line: string): string | null {
  if (line.startsWith('data: ')) return line.slice(6)
  return null
}

/** Parse an SSE event string into typed event data. */
function parseSseEvent(raw: string): WireEvent {
  try {
    return JSON.parse(raw) as WireEvent
  } catch {
    return { type: undefined, data: undefined }
  }
}

/**
 * Validate an OpenCode response envelope. The server may wrap responses in
 * `{ data: { ... } }` or return them directly.
 */
function unwrapEnvelope(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'data' in body) {
    return (body as Record<string, unknown>).data
  }
  return body
}

/** Connection options resolved once per stream call. */
export interface OpenCodeConnectionOptions {
  baseURL: string
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link OpenCodeAdapter}. */
export interface OpenCodeAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => OpenCodeConnectionOptions
}

function modelInfo(provider: string): LlmModelInfo {
  return {
    provider,
    id: 'mimo-v2.5-free',
    name: 'mimo-v2.5-free',
    description: 'OpenCode local agent (text output only)',
    inputModalities: ['text'],
  }
}

/**
 * The OpenCode LLM adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * The adapter creates a fresh OpenCode session per stream call, serializes
 * the full DSH conversation into the prompt, and translates SSE events into
 * harness StreamChunks.
 */
export class OpenCodeAdapter extends LlmAdapter {
  constructor(private readonly config: OpenCodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([modelInfo(provider)])
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      description: 'OpenCode local agent (text output only)',
      inputModalities: ['text'],
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()

    // Create a new OpenCode session.
    let sessionId: string | undefined
    try {
      const createResponse = await fetch(`${connection.baseURL}/api/session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify({ model: { id: options.model, providerID: OPENCODE_PROVIDER_ID } }),
        signal: options.signal ?? null,
      })
      if (!createResponse.ok) {
        const body = await errorBody(createResponse)
        throw new LlmError(
          `OpenCode session creation failed (HTTP ${createResponse.status}): ${body}`,
          'TRANSPORT',
          { status: createResponse.status },
        )
      }
      const createBody: unknown = await createResponse.json()
      const unwrapped = unwrapEnvelope(createBody) as Record<string, unknown> | null | undefined
      const bodyRecord = createBody as Record<string, unknown>
      const dataField = bodyRecord.data as Record<string, unknown> | undefined
      const candidate = (unwrapped?.id as string | undefined)
        ?? (dataField?.id as string | undefined)
        ?? (bodyRecord.id as string | undefined)
        ?? (unwrapped?.sessionID as string | undefined)
        ?? (dataField?.sessionID as string | undefined)
        ?? (bodyRecord.sessionID as string | undefined)
      if (typeof candidate !== 'string' || candidate.length === 0) {
        throw new LlmError('OpenCode session creation returned no session ID', 'EMPTY_RESPONSE')
      }
      sessionId = candidate
    } catch (error: unknown) {
      if (options.signal?.aborted) {
        throw new LlmError('OpenCode request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(
        `OpenCode session creation to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    // Start the SSE stream and send the prompt concurrently to avoid a
    // deadlock: the server may withhold SSE response headers until the
    // session has activity, which only happens after prompt delivery.
    const eventController = new AbortController()
    const mergedSignal = options.signal === undefined
      ? eventController.signal
      : AbortSignal.any([options.signal, eventController.signal])

    // Fire the SSE fetch WITHOUT awaiting — the promise runs concurrently
    // with prompt delivery. The server will send response headers once the
    // prompt creates session activity.
    const sseFetchPromise = fetch(
      `${connection.baseURL}/api/session/${sessionId}/event`,
      {
        method: 'GET',
        headers: {
          'accept': 'text/event-stream',
          ...attributionHeaders(),
        },
        signal: mergedSignal,
      },
    )

    // Serialize the full DSH conversation into the prompt.
    const prompt = serializeConversation(options)

    // Send the prompt FIRST (concurrently with SSE establishment).
    let eventReader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const promptResponse: Response = await withTimeout(
        fetch(
          `${connection.baseURL}/api/session/${sessionId}/prompt`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'accept': 'application/json',
              ...attributionHeaders(),
            },
            body: JSON.stringify({
              id: generateMessageId(),
              prompt: { text: prompt, files: [] },
              delivery: 'steer',
            }),
            signal: mergedSignal,
          },
        ),
        PROMPT_ADMISSION_TIMEOUT_MS,
        'prompt admission',
        sessionId,
        options.signal,
      )
      if (!promptResponse.ok) {
        const body = await errorBody(promptResponse)
        throw new LlmError(
          `OpenCode prompt delivery failed (HTTP ${promptResponse.status}): ${body}`,
          'TRANSPORT',
          { status: promptResponse.status },
        )
      }
    } catch (error: unknown) {
      eventController.abort()
      void interruptSession(connection.baseURL, sessionId)
      if (error instanceof LlmError) throw error
      if (options.signal?.aborted) {
        throw new LlmError('OpenCode request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(
        `OpenCode prompt delivery to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    // Now await the SSE stream — the prompt has created session activity
    // so the server will flush response headers.
    try {
      const eventResponse: Response = await withTimeout(
        sseFetchPromise,
        SSE_ESTABLISH_TIMEOUT_MS,
        'SSE stream establishment',
        sessionId,
        options.signal,
      )
      if (!eventResponse.ok) {
        const body = await errorBody(eventResponse)
        throw new LlmError(
          `OpenCode event subscription failed (HTTP ${eventResponse.status}): ${body}`,
          'TRANSPORT',
          { status: eventResponse.status },
        )
      }
      if (!eventResponse.body) {
        throw new LlmError('OpenCode event stream returned no body', 'EMPTY_RESPONSE')
      }
      eventReader = eventResponse.body.getReader()
    } catch (error: unknown) {
      eventController.abort()
      void interruptSession(connection.baseURL, sessionId)
      if (error instanceof LlmError) throw error
      if (options.signal?.aborted) {
        throw new LlmError('OpenCode request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(
        `OpenCode event subscription to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    // Read SSE events and translate to StreamChunks.
    let blockOpened = false
    let accumulatedText = ''
    const decoder = new TextDecoder()
    let sseBuffer = ''

    try {
      // Use a terminal-completion timeout to avoid hanging forever if the
      // server never sends a terminal event.
      const terminalTimer = setTimeout(() => {
        eventController.abort()
      }, TERMINAL_COMPLETION_TIMEOUT_MS)

      try {
        while (true) {
          const readPromise = eventReader.read()
          const { value, done } = await withTimeout(
            readPromise,
            TERMINAL_COMPLETION_TIMEOUT_MS,
            'terminal completion',
            sessionId,
            options.signal,
          )
          if (done) break

          sseBuffer += decoder.decode(value, { stream: true })
          const lines = sseBuffer.split('\n')
          sseBuffer = lines.pop() ?? ''

          for (const line of lines) {
            const data = parseSseLine(line)
            if (data === null) continue

            const event = parseSseEvent(data)
            const eventType = event.type

            if (eventType === 'session.text.delta' || eventType === 'session.next.text.delta') {
              const deltaEvent = event as WireTextDeltaEvent
              const delta = deltaEvent.data.delta ?? deltaEvent.data.text ?? ''
              if (delta.length === 0) continue

              if (!blockOpened) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                blockOpened = true
              }
              accumulatedText += delta
              yield { type: 'text-delta', index: 0, text: delta }
              continue
            }

            // session.next.text.ended carries the complete final text for a
            // text block. Use it only when no deltas were received to avoid
            // duplicating text that was already streamed.
            if (eventType === 'session.next.text.ended') {
              const endedEvent = event as WireTextEndedEvent
              const finalText = endedEvent.data.text ?? ''
              if (finalText.length > 0 && accumulatedText.length === 0) {
                if (!blockOpened) {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  blockOpened = true
                }
                accumulatedText += finalText
                yield { type: 'text-delta', index: 0, text: finalText }
              }
              continue
            }

            // session.next.step.ended is terminal. Any text in this event
            // (or a preceding text.ended) must be flushed before finishing.
            if (eventType === 'session.next.step.ended') {
              const stepEvent = event as WireStepEndedEvent
              // If step.ended carries text we haven't seen yet, emit it.
              const stepText = (stepEvent.data as Record<string, unknown> | undefined)?.text
              if (typeof stepText === 'string' && stepText.length > 0 && accumulatedText.length === 0) {
                if (!blockOpened) {
                  yield { type: 'block-start', index: 0, blockType: 'text' }
                  blockOpened = true
                }
                accumulatedText += stepText
                yield { type: 'text-delta', index: 0, text: stepText }
              }
              clearTimeout(terminalTimer)
              if (blockOpened) {
                yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulatedText } }
              }
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }

            if (
              eventType === 'session.execution.succeeded' || eventType === 'session.idle'
              || eventType === 'session.next.step.succeeded' || eventType === 'session.next.step.idle'
            ) {
              clearTimeout(terminalTimer)
              if (blockOpened) {
                yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulatedText } }
              }
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }

            if (
              eventType === 'session.execution.failed' || eventType === 'session.error'
              || eventType === 'session.next.step.failed'
            ) {
              clearTimeout(terminalTimer)
              void interruptSession(connection.baseURL, sessionId)
              if (blockOpened) {
                yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulatedText } }
              }
              const errorData = event.data as {
                message?: string
                error?: string | { message?: string }
              } | undefined
              const errorMessage = errorData?.message
                ?? (typeof errorData?.error === 'string' ? errorData.error : undefined)
                ?? (typeof errorData?.error === 'object' && errorData.error !== null ? errorData.error.message : undefined)
                ?? `OpenCode session ${eventType}`
              yield {
                type: 'finish',
                reason: {
                  kind: 'error',
                  failure: {
                    message: errorMessage,
                    code: ERROR_CODE_MAP[eventType] ?? 'PROVIDER_ERROR',
                  },
                },
              }
              return
            }
            // Unknown events are silently skipped (merge-extensible).
          }
        }
        clearTimeout(terminalTimer)
      } catch (error: unknown) {
        clearTimeout(terminalTimer)
        void interruptSession(connection.baseURL, sessionId)
        if (error instanceof LlmError) throw error
        if (options.signal?.aborted) {
          throw new LlmError('OpenCode request aborted by caller', 'ABORTED', { cause: error })
        }
        throw new LlmError(
          `OpenCode event stream from ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }
    } finally {
      eventController.abort()
    }

    // Stream ended without a terminal event — treat as clean stop.
    if (blockOpened) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: accumulatedText } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

