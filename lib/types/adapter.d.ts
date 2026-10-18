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
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ChildProcess } from 'node:child_process';
/** Default context window when a model entry does not declare one. */
export declare const DEFAULT_CONTEXT_WINDOW = 128000;
/** Default per-request output-token cap. */
export declare const DEFAULT_MAX_TOKENS = 16384;
/**
 * Wire provider ID inside OpenCode. The DSH route is `opencode-local`, but the
 * model string handed to `opencode run` is `opencode/<model>`.
 */
export declare const OPENCODE_PROVIDER_ID = "opencode";
/** Default CLI executable looked up on `PATH`. */
export declare const DEFAULT_CLI_PATH = "opencode";
/** Default wall-clock cap for one CLI turn. */
export declare const DEFAULT_TIMEOUT_MS = 600000;
/** Catalogue entry surfaced to DSH model pickers. */
export interface OpenCodeModelEntry {
    id: string;
    name?: string;
    description?: string;
    contextWindow?: number;
    maxTokens?: number;
}
/**
 * Free models verified to work through `opencode run` at the time of writing
 * (OpenCode CLI 1.19.3). Availability is upstream-controlled; run
 * `opencode models` and probe the live catalogue before relying on an id.
 */
export declare const DEFAULT_MODELS: readonly OpenCodeModelEntry[];
/** Connection facts resolved once per stream call. */
export interface OpenCodeConnectionOptions {
    cliPath: string;
    timeoutMs: number;
    models: readonly OpenCodeModelEntry[];
    retryPolicy: ResolvedRetryPolicy;
}
/** Constructor options for {@link OpenCodeAdapter}. */
export interface OpenCodeAdapterOptions {
    /** Current validated connection facts; called once per operation. */
    options: () => OpenCodeConnectionOptions;
    /**
     * Resolve the absolute working directory for one session identity. The DSH
     * host process runs from the harness checkout, so the spawned CLI must be
     * pointed at the session's project tree explicitly.
     */
    resolveDirectory?: (sessionId: string | undefined) => Promise<string | undefined>;
    /**
     * Test seam: replace the CLI process factory. Production omits it and the
     * adapter spawns the real executable.
     */
    spawn?: (command: string, args: readonly string[]) => ChildProcess;
}
/**
 * The OpenCode LLM adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 */
export declare class OpenCodeAdapter extends LlmAdapter {
    private readonly config;
    private readonly spawnCli;
    private readonly resolveDirectory;
    constructor(config: OpenCodeAdapterOptions);
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//# sourceMappingURL=adapter.d.ts.map