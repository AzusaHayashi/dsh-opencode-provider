/**
 * Register an {@link OpenCodeAdapter} for the `opencode-local` provider route on
 * `ctx.llm`. The adapter talks to a local OpenCode server at 127.0.0.1:4096
 * (configurable via cordis.yml) and requires no API key.
 *
 * @module dsh-opencode-provider
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
export { DEFAULT_BASE_URL, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, OPENCODE_PROVIDER_ID, OpenCodeAdapter, } from './adapter.ts';
export type { OpenCodeAdapterOptions, OpenCodeConnectionOptions } from './adapter.ts';
export declare const name = "llm-opencode";
export declare const inject: string[];
/**
 * Plugin config. Every field is optional in yml: the base URL defaults to
 * the local OpenCode server and no API key is required.
 */
export interface Config {
    /** Endpoint base; defaults to http://127.0.0.1:4096. */
    baseURL?: string;
    /** Positive context capacity used when the selected model has no exact value. */
    defaultContextWindow?: number;
    /** Default per-request output cap; explicit request values win. */
    maxTokens?: number;
    /** Advisory models shown by discovery consumers; defaults to mimo-v2.5-free. */
    models?: Array<{
        id: string;
        name?: string;
        description?: string;
        contextWindow?: number;
    }>;
    /** Provider-owned model-request retry policy; omission uses normal mode. */
    retryPolicy?: RetryPolicyConfig;
}
export declare function apply(ctx: Context, config: Config | undefined): void;
//# sourceMappingURL=index.d.ts.map