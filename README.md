# dsh-opencode-provider

Use models available through a local [OpenCode](https://github.com/anomalyco/opencode) server inside DeepSeek Harness without a DeepSeek API key.

## Architecture

```
DeepSeek Harness (DSH)
  └─ LLM Runtime
       └─ opencode-local provider route
            └─ OpenCodeAdapter (dsh-opencode-provider)
                 ├─ POST /api/session              → create session
                 ├─ POST /api/session/{id}/prompt   → serialized conversation
                 ├─ GET  /api/session/{id}/event    → SSE stream
                 └─ POST /api/session/{id}/interrupt → best-effort cancel
                          ↕ HTTP + SSE
                   OpenCode Server (127.0.0.1:4096)
                          ↕
                   Model (mimo-v2.5-free)
```

The adapter serializes the full DSH conversation (system prompt + messages) into a single prompt string, sends it to the OpenCode server, and translates the SSE event stream into DSH `StreamChunk` values. OpenCode runs its own internal agent/tool loop, so the adapter exposes **text output only** — structured DSH tool calling is not available.

## Verified Features

- **No API key required** — connects to a local OpenCode server over plain HTTP
- **Streaming** — text deltas are delivered as they arrive
- **Cancellation** — abort signal tears down the SSE stream and interrupts the session
- **Timeouts** — configurable SSE establishment (10 s), prompt admission (10 s), and terminal completion (120 s) limits
- **Retry policy** — provider-level retry config forwarded to DSH runtime
- **Live SSE event formats** — handles both legacy (`session.text.delta`, `session.execution.succeeded`) and current (`session.next.text.delta`, `session.next.step.ended`) event envelopes
- **Graceful fallback** — unknown SSE events are skipped; non-JSON lines are ignored; `data.wrapper` envelopes are unwrapped defensively

## Requirements

- **Node.js** ≥ 22
- **OpenCode server** running locally (default: `http://127.0.0.1:4096`)
- **DeepSeek Harness** ≥ 0.1.0-rc.8

## Installation

### Via DSH plugin command

```bash
dsh plugin --profile web add dsh-opencode-provider
```

### From source checkout

```bash
git clone https://github.com/goku54477/dsh-opencode-provider.git
cd dsh-opencode-provider
pnpm dsh
```

## Quick Start

1. Start the OpenCode server:

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

2. The adapter auto-configures with the default base URL (`http://127.0.0.1:4096`). No additional setup is needed.

3. In DeepSeek Harness, select the model:

```
opencode-local/mimo-v2.5-free
```

## Configuration

All fields are optional. Defaults work out of the box with a local OpenCode server.

```yaml
# Inside your DSH cordis.yml or plugin config
llm-opencode:
  # Endpoint of the OpenCode server
  baseURL: "http://127.0.0.1:4096"

  # Context window reported to the harness (default: 128000)
  defaultContextWindow: 128000

  # Max output tokens per request (default: 16384)
  maxTokens: 16384

  # Advisory model list for discovery consumers
  models:
    - id: mimo-v2.5-free
      name: mimo-v2.5-free
      description: "OpenCode local agent (text output only)"
      contextWindow: 128000

  # Retry policy
  retryPolicy:
    mode: always
    backoff:
      initialDelayMs: 100
      maxDelayMs: 5000
      jitterRatio: 0.2
```

## How It Works

1. **Session creation** — `POST /api/session` with `{ model: { id, providerID: "opencode" } }`
2. **Concurrent SSE + prompt** — the adapter fires the SSE subscription (`GET /api/session/{id}/event`) and prompt delivery (`POST /api/session/{id}/prompt`) concurrently. This avoids a deadlock where the OpenCode server withholds SSE headers until the session has activity.
3. **Conversation serialization** — the full DSH conversation is formatted as `[System]\n...\n\n[User]\n...\n\n[Assistant]\n...` and embedded in the prompt.
4. **Event translation** — SSE events (`session.text.delta`, `session.next.step.ended`, `session.execution.succeeded`, etc.) are mapped to DSH `StreamChunk` types (`block-start`, `text-delta`, `block-end`, `finish`).
5. **Cleanup** — on completion, error, or abort, the adapter sends a best-effort interrupt to the session.

## Development

```bash
# Build
npm run build

# Type-check
npm run typecheck

# Run tests
npm run test

# Build + test
npm run check

# Clean output
npm run clean
```

## Security Warning

This plugin communicates with a **local HTTP server** (no TLS by default). Do not expose the OpenCode server to untrusted networks. The default binding (`127.0.0.1`) restricts access to the local machine.

## Platform Compatibility

v0.1.0 has been tested on the following exact environment:

| Component | Version |
|-----------|---------|
| OS | Windows 11 |
| Node.js | 22.23.2 |
| DeepSeek Harness | 0.1.0-rc.8 |
| OpenCode | 1.18.19 |
| Model | opencode/mimo-v2.5-free |

Other platforms, Node versions, harness releases, OpenCode versions, and models have not been verified. The adapter may work elsewhere, but no guarantees are made.

## Limitations

- **Text output only** — OpenCode runs its own agent/tool loop. Structured tool calling exposed by DSH is not available through this adapter.
- **No multimodal support** — the adapter reports `inputModalities: ["text"]` only. Image/audio/video inputs are not forwarded.
- **Single model advertised** — the default catalog lists `mimo-v2.5-free`. Adding models requires manual config; the adapter does not dynamically discover available models from the server.
- **Prompt size** — the entire conversation is serialized into a single prompt string. Very long conversations may exceed the model's context window.
- **No persistent sessions** — each `stream()` call creates a fresh OpenCode session. Conversation state is not preserved across requests.
- **Local-only by default** — the adapter expects the OpenCode server on `127.0.0.1`. Remote servers require manual `baseURL` configuration and appropriate network access.

## License

[MIT](LICENSE)
