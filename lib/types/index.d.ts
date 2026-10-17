/**
 * Register an {@link OpenCodeAdapter} for the `opencode-local` provider route on
 * `ctx.llm`. The adapter spawns the local `opencode` CLI (`opencode run
 * --format json`) instead of calling the OpenCode HTTP server, because the
 * supported free models are only executable by a first-party client.
 *
 * @module dsh-opencode-provider
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { OpenCodeModelEntry } from './adapter.ts';
export { DEFAULT_CLI_PATH, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MODELS, DEFAULT_TIMEOUT_MS, OPENCODE_PROVIDER_ID, OpenCodeAdapter, } from './adapter.ts';
export type { OpenCodeAdapterOptions, OpenCodeConnectionOptions, OpenCodeModelEntry, } from './adapter.ts';
export declare const name = "llm-opencode";
export declare const inject: string[];
/**
 * Plugin config. Every field is optional in yml. The CLI path defaults to
 * `opencode` on `PATH` and can be overridden with `OPENCODE_CLI_PATH`.
 */
export interface Config {
    /** Path to the `opencode` executable; defaults to `OPENCODE_CLI_PATH` or `opencode`. */
    cliPath?: string;
    /** Positive context capacity used when the selected model has no exact value. */
    defaultContextWindow?: number;
    /** Default per-request output cap; explicit request values win. */
    maxTokens?: number;
    /** Wall-clock cap for one CLI turn; defaults to 600000 ms. */
    timeoutMs?: number;
    /** Models shown to DSH model pickers; defaults to a small free-model catalogue. */
    models?: OpenCodeModelEntry[];
    /** Provider-owned model-request retry policy; omission uses normal mode. */
    retryPolicy?: RetryPolicyConfig;
}
export declare function apply(ctx: Context, config: Config | undefined): void;
//# sourceMappingURL=index.d.ts.map