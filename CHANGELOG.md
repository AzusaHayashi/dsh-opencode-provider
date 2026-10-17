# Changelog

## 0.2.0 - 2026-10-17

Fork changes (written by an AI agent at the repository owner's direction; see
README authorship disclosure).

- **Breaking:** the transport is now the OpenCode **CLI**, not the HTTP server.
  `opencode run --format json -m opencode/<model>` is spawned per turn and the
  serialized DSH conversation is written to stdin.
- **Breaking:** the `baseURL` config field is removed. Use `cliPath` (or
  `OPENCODE_CLI_PATH`) instead.
- Fix free-tier support on OpenCode v1.19.x. The server transport cannot drive
  `native`-runtime models (`SessionRunnerModel.UnsupportedApiError`) and the
  hosted endpoint rejects non-first-party clients (`FreeTierError`); the CLI is
  a first-party client and keeps the free catalogue usable.
- Replace the hard-coded `mimo-v2.5-free` default with
  `mimo-v2.6-flash-free` plus a small free-model catalogue.
- The `models` config list is now honoured by `listModels`/`resolveModel`.
- Add `timeoutMs` for one wall-clock cap per turn (default 600000 ms).
- Add a `spawn` test seam on the adapter.
- Rewrite tests around an injected fake child process; drop the HTTP mock server
  and the live HTTP smoke script.

## 0.1.0 - 2026-08-20

- Initial public release.
- Connects DeepSeek Harness to a local OpenCode server.
- Verified with `opencode/mimo-v2.5-free`.
- Supports streaming, cancellation, timeouts, and live SSE event formats.
- Requires no DeepSeek API key.
