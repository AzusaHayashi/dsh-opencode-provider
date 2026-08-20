/**
 * Serialize DSH conversation messages into an OpenCode prompt string.
 * The full conversation context is embedded so OpenCode preserves history
 * without relying on hidden global state.
 *
 * @module dsh-llm-opencode/serialize
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/**
 * Serialize the complete DSH GenerateOptions conversation into a single prompt
 * string suitable for OpenCode's POST /api/session/{sessionID}/prompt endpoint.
 *
 * System prompt comes first, followed by all messages in order. This preserves
 * the full conversation context without relying on OpenCode's global state.
 */
export declare function serializeConversation(options: GenerateOptions): string;
//# sourceMappingURL=serialize.d.ts.map