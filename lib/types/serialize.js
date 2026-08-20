/**
 * Serialize DSH conversation messages into an OpenCode prompt string.
 * The full conversation context is embedded so OpenCode preserves history
 * without relying on hidden global state.
 *
 * @module dsh-llm-opencode/serialize
 */
/** Flatten text blocks of a message into a single string. */
function flattenText(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Format one message for the prompt. */
function formatMessage(message) {
    const text = flattenText(message.content);
    if (text.length === 0)
        return '';
    switch (message.role) {
        case 'system':
            return `[System]\n${text}`;
        case 'user':
            return `[User]\n${text}`;
        case 'assistant':
            return `[Assistant]\n${text}`;
        default:
            return text;
    }
}
/**
 * Serialize the complete DSH GenerateOptions conversation into a single prompt
 * string suitable for OpenCode's POST /api/session/{sessionID}/prompt endpoint.
 *
 * System prompt comes first, followed by all messages in order. This preserves
 * the full conversation context without relying on OpenCode's global state.
 */
export function serializeConversation(options) {
    const parts = [];
    if (options.system !== undefined && options.system.length > 0) {
        parts.push(`[System]\n${options.system}`);
    }
    for (const message of options.messages) {
        const formatted = formatMessage(message);
        if (formatted.length > 0) {
            parts.push(formatted);
        }
    }
    return parts.join('\n\n');
}
//# sourceMappingURL=serialize.js.map