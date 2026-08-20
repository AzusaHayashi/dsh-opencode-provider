import { LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { randomBytes } from "node:crypto";
//#region src/serialize.ts
/** Flatten text blocks of a message into a single string. */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Format one message for the prompt. */
function formatMessage(message) {
	const text = flattenText(message.content);
	if (text.length === 0) return "";
	switch (message.role) {
		case "system": return `[System]\n${text}`;
		case "user": return `[User]\n${text}`;
		case "assistant": return `[Assistant]\n${text}`;
		default: return text;
	}
}
/**
* Serialize the complete DSH GenerateOptions conversation into a single prompt
* string suitable for OpenCode's POST /api/session/{sessionID}/prompt endpoint.
*
* System prompt comes first, followed by all messages in order. This preserves
* the full conversation context without relying on OpenCode's global state.
*/
function serializeConversation(options) {
	const parts = [];
	if (options.system !== void 0 && options.system.length > 0) parts.push(`[System]\n${options.system}`);
	for (const message of options.messages) {
		const formatted = formatMessage(message);
		if (formatted.length > 0) parts.push(formatted);
	}
	return parts.join("\n\n");
}
//#endregion
//#region src/adapter.ts
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
/** Default base URL for the local OpenCode server. */
const DEFAULT_BASE_URL = "http://127.0.0.1:4096";
/** Default context window for the OpenCode provider. */
const DEFAULT_CONTEXT_WINDOW = 128e3;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 16384;
/** Timeout (ms) for the SSE stream to return HTTP response headers. */
const SSE_ESTABLISH_TIMEOUT_MS = 1e4;
/** Timeout (ms) for the prompt POST to return 200. */
const PROMPT_ADMISSION_TIMEOUT_MS = 1e4;
/** Timeout (ms) for a terminal SSE event to arrive after prompt delivery. */
const TERMINAL_COMPLETION_TIMEOUT_MS = 12e4;
/**
* The providerID used in the OpenCode `ModelRef` when selecting a model.
* This maps the DSH `opencode-local` provider route to the wire-level
* `opencode` providerID that the OpenCode server expects.
*/
const OPENCODE_PROVIDER_ID = "opencode";
/** Error codes for terminal OpenCode session events. */
const ERROR_CODE_MAP = {
	"session.execution.failed": "PROVIDER_ERROR",
	"session.error": "PROVIDER_ERROR",
	"session.next.step.failed": "PROVIDER_ERROR"
};
/** Generate a unique message ID for prompt requests. */
function generateMessageId() {
	return `msg_${Date.now()}_${randomBytes(8).toString("hex")}`;
}
/** Read the response body as text, returning empty string on failure. */
async function errorBody(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
/**
* Race a promise against a timeout. Resolves with the promise result or
* rejects with an `LlmError` tagged with the stage and session ID.
*/
function withTimeout(promise, ms, stage, sessionId, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new LlmError(`OpenCode ${stage} timed out after ${ms}ms (session ${sessionId})`, "TIMEOUT"));
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new LlmError(`OpenCode ${stage} aborted (session ${sessionId})`, "ABORTED"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		}, (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
	});
}
/**
* Best-effort POST to the interrupt endpoint so the server stops processing.
* Fire-and-forget; errors are swallowed.
*/
async function interruptSession(baseURL, sessionId, signal) {
	try {
		await fetch(`${baseURL}/api/session/${sessionId}/interrupt`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"accept": "application/json",
				...attributionHeaders()
			},
			body: "{}",
			signal: signal ?? null
		});
	} catch {}
}
/** Validate an SSE line and extract the data payload. */
function parseSseLine(line) {
	if (line.startsWith("data: ")) return line.slice(6);
	return null;
}
/** Parse an SSE event string into typed event data. */
function parseSseEvent(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return {
			type: void 0,
			data: void 0
		};
	}
}
/**
* Validate an OpenCode response envelope. The server may wrap responses in
* `{ data: { ... } }` or return them directly.
*/
function unwrapEnvelope(body) {
	if (body !== null && typeof body === "object" && "data" in body) return body.data;
	return body;
}
function modelInfo(provider) {
	return {
		provider,
		id: "mimo-v2.5-free",
		name: "mimo-v2.5-free",
		description: "OpenCode local agent (text output only)",
		inputModalities: ["text"]
	};
}
/**
* The OpenCode LLM adapter. One instance serves every model name it was
* registered under (the harness model name IS the wire model name).
*
* The adapter creates a fresh OpenCode session per stream call, serializes
* the full DSH conversation into the prompt, and translates SSE events into
* harness StreamChunks.
*/
var OpenCodeAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "OpenCode"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve([modelInfo(provider)]);
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve({
			provider,
			id: model,
			name: model,
			description: "OpenCode local agent (text output only)",
			inputModalities: ["text"],
			context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
			defaultMaxTokens: DEFAULT_MAX_TOKENS
		});
	}
	async *stream(options) {
		const connection = this.config.options();
		let sessionId;
		try {
			const createResponse = await fetch(`${connection.baseURL}/api/session`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"accept": "application/json",
					...attributionHeaders()
				},
				body: JSON.stringify({ model: {
					id: options.model,
					providerID: OPENCODE_PROVIDER_ID
				} }),
				signal: options.signal ?? null
			});
			if (!createResponse.ok) {
				const body = await errorBody(createResponse);
				throw new LlmError(`OpenCode session creation failed (HTTP ${createResponse.status}): ${body}`, "TRANSPORT", { status: createResponse.status });
			}
			const createBody = await createResponse.json();
			const unwrapped = unwrapEnvelope(createBody);
			const bodyRecord = createBody;
			const dataField = bodyRecord.data;
			const candidate = unwrapped?.id ?? dataField?.id ?? bodyRecord.id ?? unwrapped?.sessionID ?? dataField?.sessionID ?? bodyRecord.sessionID;
			if (typeof candidate !== "string" || candidate.length === 0) throw new LlmError("OpenCode session creation returned no session ID", "EMPTY_RESPONSE");
			sessionId = candidate;
		} catch (error) {
			if (options.signal?.aborted) throw new LlmError("OpenCode request aborted by caller", "ABORTED", { cause: error });
			if (error instanceof LlmError) throw error;
			throw new LlmError(`OpenCode session creation to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		const eventController = new AbortController();
		const mergedSignal = options.signal === void 0 ? eventController.signal : AbortSignal.any([options.signal, eventController.signal]);
		const sseFetchPromise = fetch(`${connection.baseURL}/api/session/${sessionId}/event`, {
			method: "GET",
			headers: {
				"accept": "text/event-stream",
				...attributionHeaders()
			},
			signal: mergedSignal
		});
		const prompt = serializeConversation(options);
		let eventReader;
		try {
			const promptResponse = await withTimeout(fetch(`${connection.baseURL}/api/session/${sessionId}/prompt`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"accept": "application/json",
					...attributionHeaders()
				},
				body: JSON.stringify({
					id: generateMessageId(),
					prompt: {
						text: prompt,
						files: []
					},
					delivery: "steer"
				}),
				signal: mergedSignal
			}), PROMPT_ADMISSION_TIMEOUT_MS, "prompt admission", sessionId, options.signal);
			if (!promptResponse.ok) {
				const body = await errorBody(promptResponse);
				throw new LlmError(`OpenCode prompt delivery failed (HTTP ${promptResponse.status}): ${body}`, "TRANSPORT", { status: promptResponse.status });
			}
		} catch (error) {
			eventController.abort();
			interruptSession(connection.baseURL, sessionId);
			if (error instanceof LlmError) throw error;
			if (options.signal?.aborted) throw new LlmError("OpenCode request aborted by caller", "ABORTED", { cause: error });
			throw new LlmError(`OpenCode prompt delivery to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		try {
			const eventResponse = await withTimeout(sseFetchPromise, SSE_ESTABLISH_TIMEOUT_MS, "SSE stream establishment", sessionId, options.signal);
			if (!eventResponse.ok) {
				const body = await errorBody(eventResponse);
				throw new LlmError(`OpenCode event subscription failed (HTTP ${eventResponse.status}): ${body}`, "TRANSPORT", { status: eventResponse.status });
			}
			if (!eventResponse.body) throw new LlmError("OpenCode event stream returned no body", "EMPTY_RESPONSE");
			eventReader = eventResponse.body.getReader();
		} catch (error) {
			eventController.abort();
			interruptSession(connection.baseURL, sessionId);
			if (error instanceof LlmError) throw error;
			if (options.signal?.aborted) throw new LlmError("OpenCode request aborted by caller", "ABORTED", { cause: error });
			throw new LlmError(`OpenCode event subscription to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		let blockOpened = false;
		let accumulatedText = "";
		const decoder = new TextDecoder();
		let sseBuffer = "";
		try {
			const terminalTimer = setTimeout(() => {
				eventController.abort();
			}, TERMINAL_COMPLETION_TIMEOUT_MS);
			try {
				while (true) {
					const { value, done } = await withTimeout(eventReader.read(), TERMINAL_COMPLETION_TIMEOUT_MS, "terminal completion", sessionId, options.signal);
					if (done) break;
					sseBuffer += decoder.decode(value, { stream: true });
					const lines = sseBuffer.split("\n");
					sseBuffer = lines.pop() ?? "";
					for (const line of lines) {
						const data = parseSseLine(line);
						if (data === null) continue;
						const event = parseSseEvent(data);
						const eventType = event.type;
						if (eventType === "session.text.delta" || eventType === "session.next.text.delta") {
							const deltaEvent = event;
							const delta = deltaEvent.data.delta ?? deltaEvent.data.text ?? "";
							if (delta.length === 0) continue;
							if (!blockOpened) {
								yield {
									type: "block-start",
									index: 0,
									blockType: "text"
								};
								blockOpened = true;
							}
							accumulatedText += delta;
							yield {
								type: "text-delta",
								index: 0,
								text: delta
							};
							continue;
						}
						if (eventType === "session.next.text.ended") {
							const finalText = event.data.text ?? "";
							if (finalText.length > 0 && accumulatedText.length === 0) {
								if (!blockOpened) {
									yield {
										type: "block-start",
										index: 0,
										blockType: "text"
									};
									blockOpened = true;
								}
								accumulatedText += finalText;
								yield {
									type: "text-delta",
									index: 0,
									text: finalText
								};
							}
							continue;
						}
						if (eventType === "session.next.step.ended") {
							const stepText = event.data?.text;
							if (typeof stepText === "string" && stepText.length > 0 && accumulatedText.length === 0) {
								if (!blockOpened) {
									yield {
										type: "block-start",
										index: 0,
										blockType: "text"
									};
									blockOpened = true;
								}
								accumulatedText += stepText;
								yield {
									type: "text-delta",
									index: 0,
									text: stepText
								};
							}
							clearTimeout(terminalTimer);
							if (blockOpened) yield {
								type: "block-end",
								index: 0,
								block: {
									type: "text",
									text: accumulatedText
								}
							};
							yield {
								type: "finish",
								reason: { kind: "stop" }
							};
							return;
						}
						if (eventType === "session.execution.succeeded" || eventType === "session.idle" || eventType === "session.next.step.succeeded" || eventType === "session.next.step.idle") {
							clearTimeout(terminalTimer);
							if (blockOpened) yield {
								type: "block-end",
								index: 0,
								block: {
									type: "text",
									text: accumulatedText
								}
							};
							yield {
								type: "finish",
								reason: { kind: "stop" }
							};
							return;
						}
						if (eventType === "session.execution.failed" || eventType === "session.error" || eventType === "session.next.step.failed") {
							clearTimeout(terminalTimer);
							interruptSession(connection.baseURL, sessionId);
							if (blockOpened) yield {
								type: "block-end",
								index: 0,
								block: {
									type: "text",
									text: accumulatedText
								}
							};
							const errorData = event.data;
							yield {
								type: "finish",
								reason: {
									kind: "error",
									failure: {
										message: errorData?.message ?? (typeof errorData?.error === "string" ? errorData.error : void 0) ?? (typeof errorData?.error === "object" && errorData.error !== null ? errorData.error.message : void 0) ?? `OpenCode session ${eventType}`,
										code: ERROR_CODE_MAP[eventType] ?? "PROVIDER_ERROR"
									}
								}
							};
							return;
						}
					}
				}
				clearTimeout(terminalTimer);
			} catch (error) {
				clearTimeout(terminalTimer);
				interruptSession(connection.baseURL, sessionId);
				if (error instanceof LlmError) throw error;
				if (options.signal?.aborted) throw new LlmError("OpenCode request aborted by caller", "ABORTED", { cause: error });
				throw new LlmError(`OpenCode event stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			}
		} finally {
			eventController.abort();
		}
		if (blockOpened) yield {
			type: "block-end",
			index: 0,
			block: {
				type: "text",
				text: accumulatedText
			}
		};
		yield {
			type: "finish",
			reason: { kind: "stop" }
		};
	}
};
//#endregion
//#region src/index.ts
const name = "llm-opencode";
const inject = ["llm"];
/** The single provider route this plugin owns. */
const PROVIDER = "opencode-local";
/** Resolve, validate, and return the connection facts. */
function resolveConnection(config) {
	const { baseURL = DEFAULT_BASE_URL, defaultContextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS, retryPolicy } = config ?? {};
	if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) throw new Error("llm-opencode: defaultContextWindow must be a positive integer");
	if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error("llm-opencode: maxTokens must be a positive safe integer");
	return {
		baseURL,
		retryPolicy: resolveRetryPolicy(retryPolicy, "llm-opencode: retryPolicy")
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveConnection(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-opencode: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const adapter = new OpenCodeAdapter({ options });
	ctx.llm.registerAdapter([PROVIDER], adapter);
}
//#endregion
export { DEFAULT_BASE_URL, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, OPENCODE_PROVIDER_ID, OpenCodeAdapter, apply, inject, name };
