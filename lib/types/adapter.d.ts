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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
/** Default base URL for the local OpenCode server. */
export declare const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
/** Default context window for the OpenCode provider. */
export declare const DEFAULT_CONTEXT_WINDOW = 128000;
/** Default per-request output-token cap. */
export declare const DEFAULT_MAX_TOKENS = 16384;
/**
 * The providerID used in the OpenCode `ModelRef` when selecting a model.
 * This maps the DSH `opencode-local` provider route to the wire-level
 * `opencode` providerID that the OpenCode server expects.
 */
export declare const OPENCODE_PROVIDER_ID = "opencode";
/** Connection options resolved once per stream call. */
export interface OpenCodeConnectionOptions {
    baseURL: string;
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options for {@link OpenCodeAdapter}. */
export interface OpenCodeAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => OpenCodeConnectionOptions;
}
/**
 * The OpenCode LLM adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * The adapter creates a fresh OpenCode session per stream call, serializes
 * the full DSH conversation into the prompt, and translates SSE events into
 * harness StreamChunks.
 */
export declare class OpenCodeAdapter extends LlmAdapter {
    private readonly config;
    constructor(config: OpenCodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=adapter.d.ts.map