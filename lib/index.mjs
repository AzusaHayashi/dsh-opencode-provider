import { LlmAdapter, LlmError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
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
/** Default context window when a model entry does not declare one. */
const DEFAULT_CONTEXT_WINDOW = 128e3;
/** Default per-request output-token cap. */
const DEFAULT_MAX_TOKENS = 16384;
/**
* Wire provider ID inside OpenCode. The DSH route is `opencode-local`, but the
* model string handed to `opencode run` is `opencode/<model>`.
*/
const OPENCODE_PROVIDER_ID = "opencode";
/** Default CLI executable looked up on `PATH`. */
const DEFAULT_CLI_PATH = "opencode";
/** Default wall-clock cap for one CLI turn. */
const DEFAULT_TIMEOUT_MS = 6e5;
/**
* Free models that the CLI can drive today. Availability changes upstream; run
* `opencode models` to inspect the live catalogue.
*/
const DEFAULT_MODELS = [
	{
		id: "mimo-v2.6-flash-free",
		name: "MiMo V2.6 Flash (free)"
	},
	{
		id: "glm-5.3-flash-free",
		name: "GLM-5.3 Flash (free)"
	},
	{
		id: "deepseek-v4.1-flash-free",
		name: "DeepSeek V4.1 Flash (free)"
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning (free)"
	},
	{
		id: "qwen3.6-plus-free",
		name: "Qwen3.6 Plus (free)"
	}
];
/** Normalize one configured model entry into the DSH model description. */
function modelInfo(provider, entry) {
	return {
		provider,
		id: entry.id,
		name: entry.name ?? entry.id,
		description: entry.description ?? "OpenCode local agent (text output only)",
		inputModalities: ["text"]
	};
}
/**
* The OpenCode LLM adapter. One instance serves every model name it was
* registered under (the harness model name IS the wire model name).
*/
var OpenCodeAdapter = class extends LlmAdapter {
	config;
	spawnCli;
	constructor(config) {
		super();
		this.config = config;
		this.spawnCli = config.spawn ?? ((command, args) => spawn(command, [...args], {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: process.env,
			windowsHide: true
		}));
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "OpenCode (local CLI)"
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		const { models } = this.config.options();
		return Promise.resolve(models.map((entry) => modelInfo(provider, entry)));
	}
	resolveModel(provider, model, _signal) {
		const { models } = this.config.options();
		const entry = models.find((candidate) => candidate.id === model);
		return Promise.resolve({
			provider,
			id: model,
			name: entry?.name ?? model,
			description: entry?.description ?? "OpenCode local agent (text output only)",
			inputModalities: ["text"],
			context: { contextWindow: entry?.contextWindow ?? 128e3 },
			defaultMaxTokens: entry?.maxTokens ?? 16384
		});
	}
	async *stream(options) {
		const connection = this.config.options();
		const prompt = serializeConversation(options);
		const modelArg = `${OPENCODE_PROVIDER_ID}/${options.model}`;
		let child;
		try {
			child = this.spawnCli(connection.cliPath, [
				"run",
				"--format",
				"json",
				"-m",
				modelArg
			]);
		} catch (error) {
			throw new LlmError(`OpenCode CLI launch failed (${connection.cliPath}): ${String(error)}`, "TRANSPORT", { cause: error });
		}
		const stdin = child.stdin;
		const stdout = child.stdout;
		const stderr = child.stderr;
		let stderrText = "";
		stderr?.on("data", (chunk) => {
			stderrText += chunk.toString("utf8");
			if (stderrText.length > 4e3) stderrText = stderrText.slice(-4e3);
		});
		let exited = false;
		let exitCode = null;
		let spawnError;
		const killChild = () => {
			if (exited) return;
			try {
				child.kill();
			} catch {}
		};
		if (stdin === null || stdout === null) {
			killChild();
			throw new LlmError("OpenCode CLI was spawned without piped stdio", "TRANSPORT");
		}
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("close", (code) => {
			exited = true;
			exitCode = code;
		});
		const onAbort = () => killChild();
		if (options.signal !== void 0) {
			if (options.signal.aborted) {
				killChild();
				throw new LlmError("OpenCode request aborted by caller", "ABORTED");
			}
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
		const watchdog = setTimeout(() => killChild(), connection.timeoutMs);
		stdin.on("error", () => {});
		try {
			stdin.write(prompt);
			stdin.end();
		} catch {}
		let buffer = "";
		let accumulatedText = "";
		let blockOpened = false;
		let errorMessage;
		/**
		* Parse one stdout line.
		* @param line - raw line, possibly empty.
		* @returns the text delta to emit, or null for non-text events.
		*/
		const consumeLine = (line) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return null;
			let event;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return null;
			}
			if (event.type === "text") {
				const text = typeof event.part?.text === "string" ? event.part.text : "";
				return text.length === 0 ? null : text;
			}
			if (event.type === "error") {
				const dataMessage = event.error?.data?.message;
				const name = event.error?.name;
				errorMessage = typeof dataMessage === "string" && dataMessage.length > 0 ? dataMessage : typeof name === "string" && name.length > 0 ? name : "OpenCode CLI error";
			}
			return null;
		};
		try {
			for await (const chunk of stdout) {
				buffer += chunk.toString("utf8");
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const delta = consumeLine(line);
					if (delta === null) continue;
					if (!blockOpened) {
						blockOpened = true;
						yield {
							type: "block-start",
							index: 0,
							blockType: "text"
						};
					}
					accumulatedText += delta;
					yield {
						type: "text-delta",
						index: 0,
						text: delta
					};
				}
			}
			const tail = consumeLine(buffer);
			if (tail !== null) {
				if (!blockOpened) {
					blockOpened = true;
					yield {
						type: "block-start",
						index: 0,
						blockType: "text"
					};
				}
				accumulatedText += tail;
				yield {
					type: "text-delta",
					index: 0,
					text: tail
				};
			}
		} finally {
			clearTimeout(watchdog);
			options.signal?.removeEventListener("abort", onAbort);
			killChild();
		}
		await new Promise((resolve) => {
			if (exited) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, 2e3);
			child.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
		if (options.signal?.aborted) throw new LlmError("OpenCode request aborted by caller", "ABORTED");
		if (spawnError !== void 0) throw new LlmError(`OpenCode CLI could not run (${connection.cliPath}): ${spawnError.message}`, "TRANSPORT", { cause: spawnError });
		if (errorMessage !== void 0) {
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
				reason: {
					kind: "error",
					failure: {
						message: errorMessage,
						code: "PROVIDER_ERROR"
					}
				}
			};
			return;
		}
		if (exitCode !== null && exitCode !== 0 && accumulatedText.length === 0) throw new LlmError(`OpenCode CLI exited with code ${String(exitCode)}${stderrText.length > 0 ? `: ${stderrText.slice(0, 500)}` : ""}`, "TRANSPORT");
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
/** Normalize configured models, applying the context/max-token defaults. */
function resolveModels(models, defaultContextWindow, maxTokens) {
	return (models !== void 0 && models.length > 0 ? models : DEFAULT_MODELS).map((entry) => ({
		...entry,
		contextWindow: entry.contextWindow ?? defaultContextWindow,
		maxTokens: entry.maxTokens ?? maxTokens
	}));
}
/** Resolve, validate, and return the connection facts. */
function resolveConnection(config) {
	const { cliPath = process.env.OPENCODE_CLI_PATH ?? "opencode", defaultContextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS, models, retryPolicy } = config ?? {};
	if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) throw new Error("llm-opencode: defaultContextWindow must be a positive integer");
	if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error("llm-opencode: maxTokens must be a positive safe integer");
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("llm-opencode: timeoutMs must be a positive integer");
	if (typeof cliPath !== "string" || cliPath.length === 0) throw new Error("llm-opencode: cliPath must be a non-empty string");
	return {
		cliPath,
		timeoutMs,
		models: resolveModels(models, defaultContextWindow, maxTokens),
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
export { DEFAULT_CLI_PATH, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_MODELS, DEFAULT_TIMEOUT_MS, OPENCODE_PROVIDER_ID, OpenCodeAdapter, apply, inject, name };
