/**
 * OpenCode session API wire format. Types only.
 *
 * @module dsh-llm-opencode/types
 */

/** Model reference sent in session creation and model-switch requests. */
export interface WireModelRef {
  id: string
  providerID: string
}

/** Response body for POST /api/session. */
export interface WireSessionResponse {
  data?: {
    id?: string
    sessionID?: string
  }
}

/** SSE event payload delivered via GET /api/session/{sessionID}/event. */
export interface WireEvent {
  type?: string | undefined
  data?: unknown
}

/** Text-delta event data. */
export interface WireTextDeltaEvent {
  type: 'session.text.delta'
  data: {
    delta?: string
    text?: string
  }
}

/** Text-ended event: carries the complete final text for the block. */
export interface WireTextEndedEvent {
  type: 'session.next.text.ended'
  data: {
    text?: string
    textID?: string
    assistantMessageID?: string
  }
}

/** Step-ended event: carries finish reason and tokens. */
export interface WireStepEndedEvent {
  type: 'session.next.step.ended'
  data: {
    finish?: string
    cost?: number
    tokens?: { input?: number; output?: number }
    assistantMessageID?: string
  }
}

/** Session terminal event types (legacy and current). */
export type WireTerminalEventType =
  | 'session.execution.succeeded'
  | 'session.idle'
  | 'session.execution.failed'
  | 'session.error'
  | 'session.next.step.succeeded'
  | 'session.next.step.idle'
  | 'session.next.step.failed'
  | 'session.next.step.ended'

/** Session error event data. */
export interface WireSessionError {
  type: WireTerminalEventType
  data?: {
    message?: string
    error?: string
  }
}

/** Prompt request body for POST /api/session/{sessionID}/prompt. */
export interface WirePromptRequest {
  prompt: string
  steer?: string
}

/** Interrupt response (empty 200). */
export type WireInterruptResponse = void

