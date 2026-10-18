/**
 * Register an {@link OpenCodeAdapter} for the `opencode-local` provider route on
 * `ctx.llm`. The adapter spawns the local `opencode` CLI (`opencode run
 * --format json`) instead of calling the OpenCode HTTP server, because the
 * supported free models are only executable by a first-party client.
 *
 * @module dsh-opencode-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CLI_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_TIMEOUT_MS,
  OpenCodeAdapter,
} from './adapter.ts'
import type { OpenCodeConnectionOptions, OpenCodeModelEntry } from './adapter.ts'

export {
  DEFAULT_CLI_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_TIMEOUT_MS,
  OPENCODE_PROVIDER_ID,
  OpenCodeAdapter,
} from './adapter.ts'
export type {
  OpenCodeAdapterOptions,
  OpenCodeConnectionOptions,
  OpenCodeModelEntry,
} from './adapter.ts'

export const name = 'llm-opencode'
export const inject = ['llm', 'sessionQuery']

/** The single provider route this plugin owns. */
const PROVIDER = 'opencode-local'

/**
 * Plugin config. Every field is optional in yml. The CLI path defaults to
 * `opencode` on `PATH` and can be overridden with `OPENCODE_CLI_PATH`.
 */
export interface Config {
  /** Path to the `opencode` executable; defaults to `OPENCODE_CLI_PATH` or `opencode`. */
  cliPath?: string
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Default per-request output cap; explicit request values win. */
  maxTokens?: number
  /** Wall-clock cap for one CLI turn; defaults to 600000 ms. */
  timeoutMs?: number
  /** Models shown to DSH model pickers; defaults to a small free-model catalogue. */
  models?: OpenCodeModelEntry[]
  /** Provider-owned model-request retry policy; omission uses normal mode. */
  retryPolicy?: RetryPolicyConfig
}

/** Normalize configured models, applying the context/max-token defaults. */
function resolveModels(
  models: OpenCodeModelEntry[] | undefined,
  defaultContextWindow: number,
  maxTokens: number,
): readonly OpenCodeModelEntry[] {
  const source = models !== undefined && models.length > 0 ? models : DEFAULT_MODELS
  return source.map((entry) => ({
    ...entry,
    contextWindow: entry.contextWindow ?? defaultContextWindow,
    maxTokens: entry.maxTokens ?? maxTokens,
  }))
}

/** Resolve, validate, and return the connection facts. */
function resolveConnection(config: Config | undefined): OpenCodeConnectionOptions {
  const {
    cliPath = process.env.OPENCODE_CLI_PATH ?? DEFAULT_CLI_PATH,
    defaultContextWindow = DEFAULT_CONTEXT_WINDOW,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    models,
    retryPolicy,
  } = config ?? {}
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-opencode: defaultContextWindow must be a positive integer')
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-opencode: maxTokens must be a positive safe integer')
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('llm-opencode: timeoutMs must be a positive integer')
  }
  if (typeof cliPath !== 'string' || cliPath.length === 0) {
    throw new Error('llm-opencode: cliPath must be a non-empty string')
  }
  return {
    cliPath,
    timeoutMs,
    models: resolveModels(models, defaultContextWindow, maxTokens),
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

  const adapter = new OpenCodeAdapter({
    options,
    resolveDirectory: async (sessionId) => resolveSessionDirectory(ctx, sessionId),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}

/**
 * Resolve the absolute working directory recorded for one session.
 *
 * The adapter runs inside the DSH host process, whose `process.cwd()` is the
 * harness checkout (`D:\Projects\deepseek-harness`) rather than the session's
 * project directory. `opencode run` defaults to the process cwd, so without
 * this lookup every spawned CLI edits the wrong tree.
 *
 * @param ctx - plugin context carrying the session query service.
 * @param sessionId - session identity stamped on the request by the agent loop.
 * @returns the recorded session cwd, or undefined when it cannot be resolved.
 */
async function resolveSessionDirectory(
  ctx: Context,
  sessionId: string | undefined,
): Promise<string | undefined> {
  if (sessionId === undefined) return undefined
  const query = ctx.get('sessionQuery')
  if (query === undefined) return undefined
  try {
    const observation = await query.observeSession(sessionId as never, { projectionMode: 'none' })
    const cwd = observation.header.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    // A missing or unreadable session must not fail the turn: the caller falls
    // back to the process cwd, which is still a usable working directory.
    return undefined
  }
}
