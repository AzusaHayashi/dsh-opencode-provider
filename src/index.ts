/**
 * Register an {@link OpenCodeAdapter} for the `opencode-local` provider route on
 * `ctx.llm`. The adapter talks to a local OpenCode server at 127.0.0.1:4096
 * (configurable via cordis.yml) and requires no API key.
 *
 * @module dsh-opencode-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  OpenCodeAdapter,
} from './adapter.ts'
import type { OpenCodeConnectionOptions } from './adapter.ts'

export {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  OPENCODE_PROVIDER_ID,
  OpenCodeAdapter,
} from './adapter.ts'
export type { OpenCodeAdapterOptions, OpenCodeConnectionOptions } from './adapter.ts'

export const name = 'llm-opencode'
export const inject = ['llm']

/** The single provider route this plugin owns. */
const PROVIDER = 'opencode-local'

/**
 * Plugin config. Every field is optional in yml: the base URL defaults to
 * the local OpenCode server and no API key is required.
 */
export interface Config {
  /** Endpoint base; defaults to http://127.0.0.1:4096. */
  baseURL?: string
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Advisory models shown by discovery consumers; defaults to mimo-v2.5-free. */
  models?: Array<{ id: string; name?: string; description?: string; contextWindow?: number }>
  /** Provider-owned model-request retry policy; omission uses normal mode. */
  retryPolicy?: RetryPolicyConfig
}

/** Resolve, validate, and return the connection facts. */
function resolveConnection(config: Config | undefined): OpenCodeConnectionOptions {
  const {
    baseURL = DEFAULT_BASE_URL,
    defaultContextWindow = DEFAULT_CONTEXT_WINDOW,
    maxTokens = DEFAULT_MAX_TOKENS,
    retryPolicy,
  } = config ?? {}
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-opencode: defaultContextWindow must be a positive integer')
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-opencode: maxTokens must be a positive safe integer')
  }
  return {
    baseURL,
    retryPolicy: resolveRetryPolicy(retryPolicy, 'llm-opencode: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config | undefined): void {
  // eslint-disable-next-line prefer-const
  let current: () => Config | undefined = () => config
  let lastRaw: Config | undefined
  let lastGood: OpenCodeConnectionOptions | undefined
  const options = (): OpenCodeConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveConnection(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-opencode: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new OpenCodeAdapter({ options })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}

