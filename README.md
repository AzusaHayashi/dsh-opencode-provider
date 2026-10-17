# dsh-opencode-provider (fork: CLI transport)

Use models available through the local [OpenCode](https://github.com/anomalyco/opencode) client inside DeepSeek Harness — **no DeepSeek API key, and no OpenCode API key required for the free catalogue**.

> **Authorship disclosure**
>
> This fork's changes were **written by an AI agent** (DeepSeek Harness, model
> `deepseek-official/deepseek-flash`), working at the request and direction of the
> repository owner ([@AzusaHayashi](https://github.com/AzusaHayashi)). The owner
> specified the goal, ran the machine, and reviewed the result — **but did not
> hand-write the diff**. The upstream project is
> [goku54477/dsh-opencode-provider](https://github.com/goku54477/dsh-opencode-provider).
> Review the code before trusting it.

## Why this fork exists

Upstream talks to the OpenCode **HTTP server** (`opencode serve` on
`127.0.0.1:4096`). On OpenCode v1.19.x that transport cannot drive the free
model catalogue:

| Transport | Free models (`opencode/*-free`) | Result |
| --- | --- | --- |
| `opencode serve` + HTTP/SSE | runtime `native` | `SessionRunnerModel.UnsupportedApiError: Unsupported API for opencode/<model>: native` |
| `opencode serve` + HTTP/SSE | runtime `aisdk` | accepted by the server, but the upstream free catalogue is currently unavailable (`Model is unavailable`) |
| Direct `https://opencode.ai/inference/...` | any free model | `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode` |
| **`opencode run --format json` (this fork)** | runtime `native` | **works** — the CLI is a first-party client |

In other words: the free tier only accepts requests from a first-party OpenCode
client, and only `opencode run` exposes the `native` runtime that those models
need. So this fork **spawns the CLI** instead of calling the server.

## What changed vs. upstream

| Area | Upstream | This fork |
| --- | --- | --- |
| Transport | HTTP + SSE to `opencode serve` | spawns `opencode run --format json -m opencode/<model>` |
| Prompt delivery | `POST /api/session/{id}/prompt` | full conversation written to **stdin** (no argv length ceiling) |
| Output parsing | SSE events (`session.next.*`) | one JSON object per stdout line (`{"type":"text","part":{"text":…}}`) |
| Default model | `mimo-v2.5-free` (no longer usable) | `mimo-v2.6-flash-free` + a small free catalogue |
| Model picker | one hard-coded model | configurable `models` list (finally actually used) |
| Cancellation | abort SSE + interrupt session | abort → kill child process |
| Timeout | three SSE-specific timeouts | one `timeoutMs` wall-clock cap per turn (default 600 s) |
| `baseURL` config | required, used | **removed** — replaced by `cliPath` |
| Tests | HTTP mock server | injected fake child process (no external services) |

Also added:

- `cliPath` config field, defaulting to `$OPENCODE_CLI_PATH` or `opencode` on `PATH`.
- `OPENCODE_CLI_PATH` environment-variable override.
- A `spawn` test seam on the adapter so the transport can be unit-tested.
- `tests/adapter.spec.ts` rewritten; `mock-server.ts` and `live-smoke.mjs` removed.

## Requirements

- **Node.js** ≥ 22
- **OpenCode CLI** ≥ 1.19.3 on `PATH` (or pointed to by `OPENCODE_CLI_PATH`/`cliPath`)
- **DeepSeek Harness** runtime compatible with the installed plugin
- The CLI must be logged in (`opencode auth login`) or have `OPENCODE_API_KEY` set
  in its environment

## Install

```bash
# from this fork
dsh plugin --profile web add github:AzusaHayashi/dsh-opencode-provider
```

or vendor it and use a local path.

## Quick start

1. Make sure the CLI works on its own:

```bash
opencode run --format json -m opencode/mimo-v2.6-flash-free "Say OK"
```

2. Point DSH at the executable if `opencode` is not on `PATH`:

```yaml
# DSH profile patch (cordis.patch.yml)
- id: llm-opencode
  name: dsh-opencode-provider
  config:
    cliPath: 'D:\Tools\opencode\opencode.exe'
    models:
      - id: mimo-v2.6-flash-free
        name: MiMo V2.6 Flash (free)
      - id: glm-5.3-flash-free
        name: GLM-5.3 Flash (free)
```

3. Pick the **`opencode-local`** provider in DSH's model picker. Do **not** pick
   the native `opencode` provider — that route calls the hosted API directly and
   is rejected by the free tier.

## Recommended hardening

The CLI is a full agent: by default it may want to read files or run commands.
Because free-tier requests must look like a first-party *default* client, custom
agents (`tools:` / `permission:` on the agent) break the native runtime and are
not an option. Use **global** permissions in `~/.config/opencode/opencode.jsonc`
instead — those do not affect runtime selection:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "edit": "deny",
    "bash": "deny",
    "task": "deny",
    "webfetch": "deny",
    "external_directory": "deny"
  }
}
```

## Known limitations

- **Text only.** OpenCode runs its own agent loop, so structured DSH tool calls
  are not advertised.
- **Per-turn process cost.** Each DSH turn spawns a fresh CLI process (≈1–3 s of
  startup overhead) and loses CLI-side conversation memory; the full DSH
  conversation is re-serialized into every prompt, so the model still sees the
  history.
- **Free-model availability is upstream-controlled.** Model ids come and go; run
  `opencode models` to check the live catalogue and update `models`.
- **Windows-first defaults.** `cliPath` defaults to `opencode` on `PATH`; the
  examples use a Windows path.

## Development

```bash
npm install
npm run typecheck
npm test          # 8 tests, fake child process, no network
npm run build
```

## License

MIT — same as upstream. See `LICENSE`.
