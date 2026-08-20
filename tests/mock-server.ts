import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the mock server receives. */
export type Behavior =
  | { kind: 'sse'; events: string[]; delayMs?: number }
  | { kind: 'http-error'; status: number; body: string; contentType?: string; headers?: Record<string, string> }
  | { kind: 'close-early'; events: string[] }

export interface MockServer {
  url: string
  /** Bodies of received requests, in order. */
  requests: unknown[]
  /** Header bags of received requests, in order (parallel to `requests`). */
  headers: IncomingMessage['headers'][]
  script: Behavior[]
  close(): Promise<void>
}

const servers: Server[] = []

/** Close every server opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
}

/** A minimal complete text delta event. */
export const textDeltaEvents = [
  JSON.stringify({ type: 'session.text.delta', data: { delta: 'hello' } }),
  JSON.stringify({ type: 'session.text.delta', data: { delta: ' world' } }),
  JSON.stringify({ type: 'session.execution.succeeded', data: {} }),
]

/** A complete text generation ending in idle. */
export const idleEvents = [
  JSON.stringify({ type: 'session.text.delta', data: { delta: 'hi' } }),
  JSON.stringify({ type: 'session.idle', data: {} }),
]

/** An error event. */
export const errorEvents = [
  JSON.stringify({ type: 'session.text.delta', data: { delta: 'partial' } }),
  JSON.stringify({ type: 'session.error', data: { message: 'something went wrong' } }),
]

/** New-format (session.next.*) text delta events. */
export const nextTextDeltaEvents = [
  JSON.stringify({ type: 'session.next.text.delta', data: { delta: 'alpha' } }),
  JSON.stringify({ type: 'session.next.text.delta', data: { delta: ' beta' } }),
  JSON.stringify({ type: 'session.next.step.succeeded', data: {} }),
]

/** New-format (session.next.*) error event. */
export const nextErrorEvents = [
  JSON.stringify({ type: 'session.next.text.delta', data: { delta: 'partial' } }),
  JSON.stringify({ type: 'session.next.step.failed', data: { error: { type: 'unknown', message: 'provider crashed' } } }),
]

/**
 * Captured live event envelope: text.ended carries final text, step.ended is
 * terminal. No delta events — the server sends the complete text in text.ended.
 * This is the real MiMo behavior observed against a live OpenCode server.
 */
export const liveTextEndedEvents = [
  JSON.stringify({ type: 'session.next.prompt.admitted', data: {} }),
  JSON.stringify({ type: 'session.next.prompted', data: {} }),
  JSON.stringify({ type: 'session.next.step.started', data: { timestamp: 1787237103123, sessionID: 'test', assistantMessageID: 'msg_live_1', agent: 'build', model: { id: 'mimo-v2.5-free', providerID: 'opencode', variant: 'default' } } }),
  JSON.stringify({ type: 'session.next.text.started', data: { timestamp: 1787237103127, sessionID: 'test', assistantMessageID: 'msg_live_1', textID: 'text-0' } }),
  JSON.stringify({ type: 'session.next.text.ended', data: { timestamp: 1787237104235, sessionID: 'test', assistantMessageID: 'msg_live_1', textID: 'text-0', text: 'SMOKE_OK' } }),
  JSON.stringify({ type: 'session.next.step.ended', data: { timestamp: 1787237104239, sessionID: 'test', assistantMessageID: 'msg_live_1', finish: 'stop', cost: 0, tokens: { input: 54, output: 34, reasoning: 0, cache: { read: 3520, write: 0 } } } }),
]

/**
 * Live envelope with text.ended carrying empty text and step.ended with
 * fallback text — verifies the step.ended text extraction path.
 */
export const liveStepEndedWithTextEvents = [
  JSON.stringify({ type: 'session.next.text.started', data: { sessionID: 'test', assistantMessageID: 'msg_live_2', textID: 'text-0' } }),
  JSON.stringify({ type: 'session.next.text.ended', data: { sessionID: 'test', assistantMessageID: 'msg_live_2', textID: 'text-0', text: '' } }),
  JSON.stringify({ type: 'session.next.step.ended', data: { sessionID: 'test', assistantMessageID: 'msg_live_2', finish: 'stop', text: 'fallback text' } }),
]

/**
 * Mixed deltas then text.ended — verifies no duplicate text when deltas
 * were already received before text.ended arrives.
 */
export const liveDeltaPlusTextEndedEvents = [
  JSON.stringify({ type: 'session.next.text.delta', data: { delta: 'hello' } }),
  JSON.stringify({ type: 'session.next.text.delta', data: { delta: ' world' } }),
  JSON.stringify({ type: 'session.next.text.ended', data: { sessionID: 'test', textID: 'text-0', text: 'hello world' } }),
  JSON.stringify({ type: 'session.next.step.ended', data: { sessionID: 'test', finish: 'stop', tokens: { output: 10 } } }),
]

/**
 * Local OpenCode API stand-in: replays scripted behaviors per request.
 * Routes:
 *   POST /api/session            -> { data: { id: '...' } }
 *   GET  /api/session/:id/event  -> SSE stream of events
 *   POST /api/session/:id/prompt -> 200 OK
 *   POST /api/session/:id/interrupt -> 200 OK
 */
export async function mockOpenCodeServer(script: Behavior[]): Promise<MockServer> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let sessionCounter = 0

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      const url = request.url ?? ''

      // POST /api/session — create session
      if (request.method === 'POST' && url === '/api/session') {
        requests.push(body ? JSON.parse(body) : undefined)
        headers.push(request.headers)
        sessionCounter++
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: { id: `session-${sessionCounter}` } }))
        return
      }

      // GET /api/session/:id/event — SSE event stream
      if (request.method === 'GET' && /^\/api\/session\/[^/]+\/event$/.test(url)) {
        requests.push(undefined)
        headers.push(request.headers)
        const behavior = script.shift()
        if (!behavior) {
          response.writeHead(500).end('mock script exhausted')
          return
        }
        if (behavior.kind === 'http-error') {
          response.writeHead(behavior.status, {
            'content-type': behavior.contentType ?? 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const write = (index: number): void => {
          if (index >= behavior.events.length) {
            if (behavior.kind === 'sse') response.end()
            else response.destroy()
            return
          }
          response.write(`data: ${behavior.events[index]}\n\n`)
          setTimeout(() => { write(index + 1) }, behavior.kind === 'sse' ? behavior.delayMs ?? 0 : 5)
        }
        write(0)
        return
      }

      // POST /api/session/:id/prompt — deliver prompt
      if (request.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(url)) {
        requests.push(body ? JSON.parse(body) : undefined)
        headers.push(request.headers)
        const behavior = script.shift()
        if (!behavior) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{}')
          return
        }
        if (behavior.kind === 'http-error') {
          response.writeHead(behavior.status, {
            'content-type': behavior.contentType ?? 'application/json',
            ...behavior.headers,
          })
          response.end(behavior.body)
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }

      // POST /api/session/:id/interrupt — abort
      if (request.method === 'POST' && /^\/api\/session\/[^/]+\/interrupt$/.test(url)) {
        requests.push(body ? JSON.parse(body) : undefined)
        headers.push(request.headers)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }

      response.writeHead(404).end('not found')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    headers,
    script,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

