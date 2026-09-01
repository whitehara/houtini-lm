<div align="center">
  <img src="https://raw.githubusercontent.com/houtini-ai/houtini-lm/main/assets/logo.png" width="120" height="120" alt="Houtini LM" />
</div>

# @houtini/lm Houtini LM - Save Tokens by Offloading Tasks from Claude Code to Your Local LLM Server (LM Studio / Ollama), Openrouter or a Cloud API

[![npm version](https://img.shields.io/npm/v/@houtini/lm.svg?style=flat-square)](https://www.npmjs.com/package/@houtini/lm)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue?style=flat-square)](https://registry.modelcontextprotocol.io)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Known Vulnerabilities](https://snyk.io/test/github/houtini-ai/houtini-lm/badge.svg)](https://snyk.io/test/github/houtini-ai/houtini-lm)

<p align="center">
  <a href="https://glama.ai/mcp/servers/@houtini-ai/lm">
    <img width="380" height="200" src="https://glama.ai/mcp/servers/@houtini-ai/lm/badge" alt="Houtini LM MCP server" />
  </a>
</p>

> **Quick Navigation**
>
> [How it works](#how-it-works) | [Quick start](#quick-start) | [What gets offloaded](#what-gets-offloaded) | [Tools](#tools) | [Performance tracking](#performance-tracking) | [Structured JSON output](#structured-json-output) | [Model routing](#model-routing) | [Self-test (shakedown)](#self-test-shakedown) | [Configuration](#configuration) | [Compatible endpoints](#compatible-endpoints) | [Developer guide](./DEVELOPER.md)

I built this because I kept leaving Claude Code running overnight on big refactors and the token bill was painful. A huge chunk of that spend goes on bounded tasks any decent model handles fine - generating boilerplate, code review, commit messages, format conversion. Stuff that doesn't need Claude's reasoning or tool access.

Houtini LM connects Claude Code to a local LLM on your network - or any OpenAI-compatible API (LM Studio, Ollama, vLLM, DeepSeek, Groq, Cerebras, and OpenRouter's 300+ models through one endpoint). Claude keeps doing the hard work - architecture, planning, multi-file changes - and offloads the grunt work to whatever cheaper model you've got running. No Claude quota burn. No rate limits. Private if local, cheap if cloud. The trade is wall-clock time: local inference is typically 3-30× slower than frontier models, so delegation wins on bounded, self-contained tasks rather than everything.

I wrote a [full walkthrough of why I built this and how I use it day to day](https://houtini.com/how-to-cut-your-claude-code-bill-with-houtini-lm/).

## The manual

This README is the overview. The depth lives in focused pages:

| Page | What's in it |
|---|---|
| [Getting started](./docs/GETTING-STARTED.md) | Local models from zero: LM Studio or Docker, what small models are good at, which fit your VRAM |
| [The tools, in depth](./manual/tools.md) | All nine tools: the parameters that matter, reading the footer, the max_tokens floor |
| [The craft of delegation](./manual/delegation.md) | What to hand off and how to brief it - the verbatim-echo pattern, micro-chunking, reasoning-model budgets |
| [Troubleshooting](./manual/troubleshooting.md) | Symptom → cause → fix: empty responses, timeouts, context-length 400s, queuing |
| [LM Studio setup](./docs/SETUP-LMSTUDIO.md) · [Ollama setup](./docs/SETUP-OLLAMA.md) · [vLLM setup](./docs/SETUP-VLLM.md) | Backend guides, each with the traps that cause silent failures |
| [vLLM backend notes](./docs/VLLM-BACKEND.md) | The deeper operational record: router topology, thinking toggles, token budgets |
| [CLI mode](./docs/CLI-MODE.md) | Running houtini-lm as a command, not just an MCP server |
| [Shakedown test](./docs/SHAKEDOWN.md) | The canonical end-to-end check - `npm run shakedown`, or paste the prompt into Claude and watch the seven-tool sequence run |
| [Developer guide](./DEVELOPER.md) | Architecture, contributing, release process |

## How it works

```
Claude Code (orchestrator)
   |
   |-- Complex reasoning, planning, architecture --> Claude API (your tokens)
   |
   +-- Bounded grunt work --> houtini-lm --HTTP/SSE--> Your local LLM (free)
       . Boilerplate & test stubs          Qwen, Llama, Nemotron, GLM...
       . Code review & explanations        LM Studio, Ollama, vLLM, llama.cpp
       . Commit messages & docs            DeepSeek, Groq, Cerebras (cloud)
       . Format conversion
       . Mock data & type definitions
       . Embeddings for RAG pipelines
```

Claude's the architect. Your local model's the drafter. Claude QAs everything.

## Quick start

> New to local models? See **[docs/GETTING-STARTED.md](./docs/GETTING-STARTED.md)** — installing LM Studio or a Docker endpoint, getting an OpenAI-compatible URL for houtini, what the smaller models are good at, and which models fit on 16/32/64/96/128 GB of VRAM.
>
> Setting up a specific backend? Step-by-step guides, each with the traps that cause silent failures:
> **[LM Studio](./docs/SETUP-LMSTUDIO.md)** (easiest, desktop) · **[Ollama](./docs/SETUP-OLLAMA.md)** (two commands, CLI) · **[vLLM](./docs/SETUP-VLLM.md)** (throughput, tool-calling, long context).

### Claude Code

```bash
claude mcp add houtini-lm -- npx -y @houtini/lm
```

That's it. If LM Studio's running on `localhost:1234` (the default), Claude can start delegating straight away.

### Run in Docker

Prebuilt images are published to GHCR when a `vX.Y.Z` tag is pushed (or via manual `workflow_dispatch`) — pushes to `main` alone don't trigger a build. **`:latest` only exists once the first `v*.*.*` tag has been pushed**; until then, build locally or use a commit-SHA tag from the Actions run:

```bash
docker run --rm -i \
  -e HOUTINI_LM_ENDPOINT_URL=http://host.docker.internal:1234 \
  ghcr.io/whitehara/houtini-lm:latest
```

Register it with Claude Code the same way, swapping `command`/`args` for `docker`:

```json
{
  "mcpServers": {
    "houtini-lm": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "HOUTINI_LM_ENDPOINT_URL=http://host.docker.internal:1234",
        "-v", "houtini-lm-state:/home/node/.houtini-lm",
        "ghcr.io/whitehara/houtini-lm:latest"
      ]
    }
  }
}
```

- Pass any `HOUTINI_LM_*` environment variable with `-e`, same as the npm setup above.
- `-v houtini-lm-state:/home/node/.houtini-lm` persists the model cache and inference lock across container restarts (skip it and each run starts from a cold cache).
- **`code_task_files` can only read paths visible inside the container.** Mount the code you want reviewed and point the tool at the mounted path:
  ```bash
  docker run --rm -i \
    -e HOUTINI_LM_ENDPOINT_URL=http://host.docker.internal:1234 \
    -v /path/to/your/project:/workspace:ro \
    ghcr.io/whitehara/houtini-lm:latest
  ```
  Then pass `/workspace/...` paths to `code_task_files`, not the host paths.

### Remote / HTTP transport

By default houtini-lm speaks MCP over stdio — one process per client, as shown above. Set `HOUTINI_LM_TRANSPORT=http` to switch it to Streamable HTTP instead, for a container that stays running and serves multiple clients/sessions:

```bash
docker run -d -p 3000:3000 \
  -e HOUTINI_LM_TRANSPORT=http \
  -e HOUTINI_LM_ENDPOINT_URL=http://host.docker.internal:1234 \
  -v houtini-lm-state:/home/node/.houtini-lm \
  ghcr.io/whitehara/houtini-lm:latest
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOUTINI_LM_TRANSPORT` | `stdio` | `stdio` (default) or `http`. Any other value fails fast at startup. |
| `HOUTINI_LM_HTTP_PORT` | `3000` | Port the HTTP server listens on. |
| `HOUTINI_LM_HTTP_HOST` | `0.0.0.0` | Bind address — `0.0.0.0` so it's reachable from outside the container. |
| `HOUTINI_LM_HTTP_PATH` | `/mcp` | Path MCP clients POST/DELETE to. |

The server also answers `GET /healthz` with `200 {"status":"ok"}`, independent of `HOUTINI_LM_HTTP_PATH`, for container orchestrator health checks.

Each new session is a `POST` to `HOUTINI_LM_HTTP_PATH` with no `mcp-session-id` header; the response carries the session id in that same header, which the client then sends on every subsequent request. Send `DELETE` with the session id to end a session explicitly — there's currently no idle-session timeout, so a client that never deletes its session leaks it for the life of the process. When `HOUTINI_LM_CONVERSATION_OWNER_HEADER` is unset (the default), deleting a session also immediately discards any server-side conversations it owned (see [Server-side conversations](#server-side-conversations)) — there's no separate cleanup step for those. When that variable is set, conversations are owned by an authenticated caller identity instead of the session, so a session `DELETE` no longer discards them.

**This server does not authenticate HTTP requests.** Don't expose it directly to the internet — put an authenticating reverse proxy (e.g. [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy)) in front of it, and keep the container itself reachable only from that proxy.

#### Docker Swarm

`compose.swarm.yml` in this repo deploys houtini-lm alongside [mcp-auth-proxy](https://github.com/sigbit/mcp-auth-proxy) as a sidecar in front of it, terminating OIDC authentication before traffic reaches the MCP server — mcp-auth-proxy is pointed at the backend via its `--` positional argument, not an environment variable. mcp-auth-proxy's URL-backend mode expects the backend to serve MCP at its root path, so the compose file sets `HOUTINI_LM_HTTP_PATH=/` and points the backend argument at the bare `http://houtini-lm:3000` (no `/mcp` suffix) — leaving the default `/mcp` path breaks OAuth protected-resource metadata and token resource/audience matching, surfacing as a 401 on every MCP request even after a successful login. Deploy it as its own stack; the file expects deployment-specific values (public hostname, backend endpoint/API key, OIDC client credentials) to be supplied as stack environment variables rather than edited into the compose file itself — see the variable list in the file's header comment. On a large-catalogue backend like OpenRouter, also set `HOUTINI_LM_MODEL` to pin a specific model — leaving it unset falls back to auto-routing, which on a 300+-model catalogue just picks whichever model happens to sort first, silently, and that can change without warning.

When houtini-lm runs remotely like this, `code_task_files` can only see the container's own filesystem — it has no access to whatever machine the MCP client is running on. `compose.swarm.yml` works around this by mounting a shared NFS volume read-only into the container and pointing `HOUTINI_LM_FILE_ROOTS` at that mount path. A client that mounts the same NFS export at the *same absolute path* on its own host can write a file there and then pass that exact path to `code_task_files`, with no path translation needed. Keep the container-side mount read-only, keep `HOUTINI_LM_FILE_ROOTS` scoped to that mount only, and remember that anything placed there is readable by every user `OIDC_ALLOWED_USERS_GLOB` allows through and gets sent to whatever backend LLM is configured — don't put secrets in it.

### LLM on a different machine

I've got a GPU box on my local network running Qwen 3 Coder Next in LM Studio. If you've got a similar setup, point the URL at it:

```bash
claude mcp add houtini-lm -e HOUTINI_LM_ENDPOINT_URL=http://192.168.1.50:1234 -- npx -y @houtini/lm
```

### Cloud APIs

Works with anything speaking the OpenAI format. DeepSeek at twenty-eight cents per million tokens, Groq for speed, Cerebras if you want three thousand tokens per second - whatever you fancy:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=https://api.deepseek.com \
  -e HOUTINI_LM_API_KEY=your-key-here \
  -- npx -y @houtini/lm
```

### OpenRouter

OpenRouter gives you 300+ models through one endpoint. Auto-detected from the URL — attribution headers, `reasoning.exclude`, and retry-with-backoff all kick in automatically:

```bash
claude mcp add houtini-lm \
  -e HOUTINI_LM_ENDPOINT_URL=https://openrouter.ai/api \
  -e HOUTINI_LM_API_KEY=sk-or-v1-... \
  -e HOUTINI_LM_MODEL=nvidia/nemotron-3-nano-30b-a3b:free \
  -- npx -y @houtini/lm
```

### Claude Desktop

Drop this into your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "houtini-lm": {
      "command": "npx",
      "args": ["-y", "@houtini/lm"],
      "env": {
        "HOUTINI_LM_ENDPOINT_URL": "http://localhost:1234"
      }
    }
  }
}
```

## Model discovery

This is where things get interesting. At startup, houtini-lm queries your LLM server for every model available - loaded and downloaded - then looks each one up on HuggingFace's free API to pull metadata: architecture, licence, download count, pipeline type. All of that gets cached in a local SQLite database (`~/.houtini-lm/model-cache.db`) so subsequent startups are instant.

The result is that houtini-lm actually knows what your models are good at. Not just the name - the capabilities, the strengths, what tasks to send where. If you've got Nemotron loaded but a Qwen Coder sitting idle, it'll flag that. If someone on a completely different setup loads a Mistral model houtini-lm has never seen before, the HuggingFace lookup auto-generates a profile for it.

Run `list_models` and you get the full picture:

```
Loaded models (ready to use):

  nvidia/nemotron-3-nano
    type: llm, arch: nemotron_h_moe, quant: Q4_K_M, format: gguf
    context: 200,082 (max 1,048,576), by: nvidia
    Capabilities: tool_use
    NVIDIA Nemotron: compact reasoning model optimised for step-by-step logic
    Best for: analysis tasks, code bug-finding, math/science questions
    HuggingFace: text-generation, 1.7M downloads, MIT licence

Available models (downloaded, not loaded):

  qwen3-coder-30b-a3b-instruct
    type: llm, arch: qwen3moe, quant: BF16, context: 262,144
    Qwen3 Coder: code-specialised model with agentic capabilities
    Best for: code generation, code review, test stubs, refactoring
    HuggingFace: text-generation, 12.9K downloads, Apache-2.0
```

For models we know well - Qwen, Nemotron, Granite, LLaMA, GLM, GPT-OSS - there's a curated profile built in with specific strengths and weaknesses. For everything else, the HuggingFace lookup fills the gaps. Cache refreshes every 7 days. Zero friction - the cache uses `node:sqlite` (Node's built-in SQLite, so no third-party native dependency and no build tools) in WAL mode, which lets several houtini-lm processes share one cache safely. Requires Node ≥ 22.5.

## What gets offloaded

**Delegate to the local model** - bounded, well-defined tasks:

| Task | Why it works locally |
|------|---------------------|
| Generate test stubs | Clear input (source), clear output (tests) |
| Explain a function | Summarisation doesn't need tool access |
| Draft commit messages | Diff in, message out |
| Code review | Paste full source, ask for bugs |
| Convert formats | JSON to YAML, snake_case to camelCase |
| Generate mock data | Schema in, data out |
| Write type definitions | Source in, types out |
| Structured JSON output | Grammar-constrained, guaranteed valid |
| Text embeddings | Semantic search, RAG pipelines |
| Brainstorm approaches | Doesn't commit to anything |

**Keep on Claude** - anything that needs reasoning, tool access, or multi-step orchestration:

- Architectural decisions
- Reading/writing files
- Running tests and interpreting results
- Multi-file refactoring plans
- Anything that needs to call other tools

The tool descriptions are written to nudge Claude into planning delegation at the start of large tasks, not just using it when it happens to think of it.

## Performance tracking

Every response includes a footer with real performance data — computed from the SSE stream, not from any proprietary API:

```
---
Model: nvidia/nemotron-3-nano | 279→303 tokens (12 reasoning / 291 visible) | TTFT: 485ms, 58.0 tok/s, 5.2s
📊 First measured call on nvidia/nemotron-3-nano: 58.0 tok/s, 485ms to first token — use this to gauge whether to delegate longer tasks.
💰 Claude quota saved — this session: 4,283 tokens / 7 calls · lifetime: 147,432 tokens / 213 calls
```

The 📊 line only appears on the first measured call per model per session — it's a real benchmark from a genuine task, not a synthetic warmup. The 💰 line updates every call.

When the active model returns `completion_tokens_details.reasoning_tokens` (DeepSeek R1, LM Studio with "Separate reasoning_content" enabled, OpenAI reasoning models), the token block splits into `reasoning / visible` so you can see when a thinking model is burning its output budget on hidden reasoning.

### Lifetime persistence

Per-model performance and token counts persist across Claude Desktop restarts in `~/.houtini-lm/model-cache.db`. This means:

- From call 1 of a new session, `discover` shows **historical** tok/s and TTFT for the loaded model — not "not yet benchmarked".
- The 💰 counter shows both session and lifetime totals.
- The `code_task_files` pre-flight estimator uses measured per-model prefill rate to refuse obviously-too-large inputs with a clear diagnostic, instead of letting them silently hang against the MCP client timeout.

The data is workstation-specific — that's intentional. Routing decisions should reflect your actual hardware, not a synthetic benchmark.

The `discover` tool shows per-model averages across both scopes:

```
Measured speed (session):  58.0 tok/s · TTFT 485ms (1 call)
Measured speed (lifetime on this workstation): 46.9 tok/s · TTFT 2641ms (214 calls, last used 2026-04-20)
```

In practice, Claude delegates more aggressively the longer a session runs. After about 5,000 offloaded tokens, it starts hunting for more work to push over. Reinforcing loop.

## Model routing

If you've got multiple models loaded (or downloaded), houtini-lm picks the best one for each task automatically. Each model family has per-family prompt hints - temperature, output constraints, and think-block flags - so GLM gets told "no preamble, no step-by-step reasoning" while Qwen Coder gets a low temperature for focused code output.

The routing scores loaded models against the task type (code, chat, analysis, embedding). If the best loaded model isn't ideal for the task, you'll see a suggestion in the response footer pointing to a better downloaded model. No runtime model swapping - model loading takes minutes, so houtini-lm suggests rather than blocks.

Supported model families with curated prompt hints: GLM-4, Qwen3 Coder, Qwen3, LLaMA 3, Nemotron, Granite, GPT-OSS, Nomic Embed. Unknown models get sensible defaults.

### Overriding the router

Scoring works well when there are a handful of loaded models. On providers with large catalogues (OpenRouter lists 300+ models, all reporting as routable) unknown models all score zero and ties break on iteration order, so you probably want to pin explicitly. Two ways, in precedence order:

1. **Per-call** — pass `model: "nvidia/nemotron-3-nano-30b-a3b:free"` to any of `chat` / `custom_prompt` / `code_task` / `code_task_files`. Overrides everything else.
2. **Per-process** — set `HOUTINI_LM_MODEL` in the environment. Applies to every tool call from that server process. Overridden by the per-call parameter.

Leave both unset and the router picks.

## Tools

### `chat`

The workhorse. Send a task, get an answer. The description includes planning triggers that nudge Claude to identify offloadable work when it's starting a big task.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `message` | yes | - | The task. Be specific about output format. |
| `system` | no | - | Persona - "Senior TypeScript dev" not "helpful assistant" |
| `temperature` | no | 0.3 | 0.1 for code, 0.3 for analysis, 0.7 for creative |
| `max_tokens` | no | *auto* | Defaults to 25% of the loaded model's context window (fallback 16,384). Pass a number to cap it. |
| `json_schema` | no | - | Force structured JSON output conforming to a schema |
| `model` | no | *auto-route* | Pin a specific model id (e.g. `nvidia/nemotron-3-nano-30b-a3b:free` on OpenRouter). Overrides routing and `HOUTINI_LM_MODEL`. Useful on providers with many candidates. |
| `include_reasoning` | no | `false` | When `true` and the model produced reasoning, append it after the answer, delimited from the final response. Only effective when the backend actually returns reasoning — see [Think-block handling](#think-block-handling). Combining with `json_schema` means the response is no longer pure JSON, same as the footer already does. |
| `force_thinking` | no | `false` | Disables the server's automatic thinking suppression for this one call so the model actually thinks — costs latency and generated tokens. Pair with `include_reasoning: true` to see the result. Ignored when the server runs with `HOUTINI_LM_THINKING=off`. No effect on OpenRouter-routed calls yet. |
| `start_conversation` | no | `false` | Start a new server-side conversation — its id comes back on the response's last line. Pass that id as `conversation_id` on every following call and send only the new message; the server keeps the history for you. Not present in the schema at all when `HOUTINI_LM_CONVERSATIONS` is disabled. See [Server-side conversations](#server-side-conversations). |
| `conversation_id` | no | - | Continue a conversation started with `start_conversation: true` — send only the new message, the server prepends the stored history automatically. Wins over `start_conversation` when both are given (the latter is then ignored). Not present in the schema at all when `HOUTINI_LM_CONVERSATIONS` is disabled. See [Server-side conversations](#server-side-conversations). |

### `custom_prompt`

Three-part prompt: system, context, instruction. Keeping them separate prevents context bleed - consistently outperforms stuffing everything into one message, especially with local models. I tested this properly one weekend - took the same batch of review tasks and ran them both ways. Splitting things into three parts won every round.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `instruction` | yes | - | What to produce. Under 50 words works best. |
| `system` | no | - | Persona + constraints, under 30 words |
| `context` | no | - | Complete data to analyse. Never truncate. |
| `temperature` | no | 0.3 | 0.1 for review, 0.3 for analysis |
| `max_tokens` | no | *auto* | Defaults to 25% of the loaded model's context window (fallback 16,384). |
| `json_schema` | no | - | Force structured JSON output |
| `model` | no | *auto-route* | Pin a specific model id. Overrides routing and `HOUTINI_LM_MODEL`. |
| `include_reasoning` | no | `false` | When `true` and the model produced reasoning, append it after the answer, delimited from the final response. Only effective when the backend actually returns reasoning — see [Think-block handling](#think-block-handling). Combining with `json_schema` means the response is no longer pure JSON, same as the footer already does. |
| `force_thinking` | no | `false` | Disables the server's automatic thinking suppression for this one call so the model actually thinks — costs latency and generated tokens. Pair with `include_reasoning: true` to see the result. Ignored when the server runs with `HOUTINI_LM_THINKING=off`. No effect on OpenRouter-routed calls yet. |
| `start_conversation` | no | `false` | Start a new server-side conversation — its id comes back on the response's last line. Pass that id as `conversation_id` on every following call and send only the new instruction; the server keeps the history for you. Not present in the schema at all when `HOUTINI_LM_CONVERSATIONS` is disabled. See [Server-side conversations](#server-side-conversations). |
| `conversation_id` | no | - | Continue a conversation started with `start_conversation: true` — send only the new instruction, the server prepends the stored history automatically. Wins over `start_conversation` when both are given (the latter is then ignored). Not present in the schema at all when `HOUTINI_LM_CONVERSATIONS` is disabled. See [Server-side conversations](#server-side-conversations). |

### `code_task`

Built for code analysis. Pre-configured system prompt with temperature and output constraints tuned per model family via the routing layer.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `code` | yes | - | Complete source code. Never truncate. |
| `task` | yes | - | "Find bugs", "Explain this", "Write tests" |
| `language` | no | - | "typescript", "python", "rust", etc. |
| `max_tokens` | no | *auto* | Defaults to 25% of the loaded model's context window (fallback 16,384). |
| `model` | no | *auto-route* | Pin a specific model id. Overrides routing and `HOUTINI_LM_MODEL`. |
| `include_reasoning` | no | `false` | When `true` and the model produced reasoning, append it after the answer, delimited from the final response. Only effective when the backend actually returns reasoning — see [Think-block handling](#think-block-handling). |
| `force_thinking` | no | `false` | Disables the server's automatic thinking suppression for this one call so the model actually thinks — costs latency and generated tokens. Pair with `include_reasoning: true` to see the result. Ignored when the server runs with `HOUTINI_LM_THINKING=off`. No effect on OpenRouter-routed calls yet. |

### `code_task_files`

Like `code_task`, but the local LLM reads files directly from disk — source never passes through the MCP client's context window. Use this when reviewing multiple related files, or a single large file that's awkward to paste. Files are read in parallel with `Promise.allSettled`, so one unreadable file doesn't sink the call; failures are surfaced inline with the reason.

Includes a **pre-flight prefill estimator**: if measured per-model data from the SQLite cache shows the input would exceed the MCP client's ~60s request-timeout during prompt processing, the call is refused early with a concrete diagnostic (estimated prefill seconds, tokens, and sample-count) instead of letting it silently hang. First-time callers are never refused — the estimator only fires after ≥2 measured samples.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `paths` | yes | - | Array of absolute file paths. Relative paths are rejected. |
| `task` | yes | - | "Find bugs across these files", "Audit this module" |
| `language` | no | - | "typescript", "python", "rust", etc. |
| `max_tokens` | no | *auto* | Defaults to 25% of the loaded model's context window (fallback 16,384). |
| `model` | no | *auto-route* | Pin a specific model id. Overrides routing and `HOUTINI_LM_MODEL`. |
| `include_reasoning` | no | `false` | When `true` and the model produced reasoning, append it after the answer, delimited from the final response. Only effective when the backend actually returns reasoning — see [Think-block handling](#think-block-handling). |
| `force_thinking` | no | `false` | Disables the server's automatic thinking suppression for this one call so the model actually thinks — costs latency and generated tokens. Pair with `include_reasoning: true` to see the result. Ignored when the server runs with `HOUTINI_LM_THINKING=off`. No effect on OpenRouter-routed calls yet. |

### `embed`

Generate text embeddings via the OpenAI-compatible `/v1/embeddings` endpoint. Requires an embedding model to be available - Nomic Embed is a solid choice. Returns the vector, dimension count, and usage stats.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `input` | yes | - | Text to embed |
| `model` | no | auto | Embedding model ID |

### `discover`

Health check and speed readout. Returns model name, context window, capability profile, connection latency (labelled explicitly — this is the `/v1/models` fetch round-trip, *not* inference speed), and the active model's measured tok/s and TTFT averaged over the session. Before any real call has run, measured speed shows as "not yet benchmarked — will be captured on the first real call" rather than inventing a number from a synthetic probe. Call before delegating if you're not sure the LLM's available, or when deciding whether a longer task is worth offloading.

### `list_models`

Lists everything on the LLM server - loaded and downloaded - with full metadata: architecture, quantisation, context window, capabilities, and HuggingFace enrichment data. Shows capability profiles describing what each model is best at, so Claude can make informed delegation decisions.

### `stats`

Compact markdown dump of your offload stats — session and lifetime totals, per-model performance history, reasoning-token overhead — without the model catalog that `discover` prints. Cheap to call repeatedly to watch the 💰 counter climb.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `model` | no | - | Filter output to a single model ID. Omit for all models ever used on this workstation. |

Example output:

```
## Houtini LM stats
**Endpoint**: http://gpu-box:1234 (LM Studio)
**First call on this workstation**: 2026-04-14

### Totals
| Scope    | Calls | Prompt tokens | Completion tokens | Total tokens |
| Session  |     7 |         3,100 |             1,183 |        4,283 |
| Lifetime |   213 |             — |                 — |      147,432 |

### Per-model performance
| Model                    | Scope    | Calls | Avg TTFT | Avg tok/s | Prompt tokens | Last used  |
| nvidia/nemotron-3-nano   | session  |     7 |    485   |      58.0 | —             | —          |
| nvidia/nemotron-3-nano   | lifetime |   213 |   2641   |      46.9 |       89,320  | 2026-04-20 |

### Reasoning-token overhead (lifetime)
124 / 47,183 completion tokens spent on hidden reasoning (0.3%). Low — reasoning is effectively suppressed.
```

The reasoning-token overhead line is the canary for "is `reasoning_effort` actually being honoured on this model and this backend?" — above ~30% is a signal to investigate.

### `conversations`

Manage server-side conversations started with `chat` or `custom_prompt`'s `start_conversation`. Scoped strictly to the conversations you own — this tool can never see, list, or touch another owner's conversations, and never reveals whether one exists elsewhere. What "owner" means depends on `HOUTINI_LM_CONVERSATION_OWNER_HEADER` — see [Isolation boundary](#server-side-conversations) below. Not listed in `tools/list` at all when `HOUTINI_LM_CONVERSATIONS` is disabled.

| Parameter | Required | Default | What it does |
|-----------|----------|---------|-------------|
| `action` | yes | - | `list`, `delete`, or `clear`. |
| `conversation_id` | required for `delete` | - | Which conversation to remove. Ignored for `list` and `clear`. |

- **`list`** — a markdown table of your conversations: id, turn count, chars retained, idle time, time to expiry. Metadata only — message content is never returned, and structurally can't be, since `list` works from a summary type that has no content field.
- **`delete`** — removes one conversation by `conversation_id`. An id that never existed and an id owned by someone else return the *exact same* error, deliberately — distinguishing them would let a caller probe for other owners' conversations.
- **`clear`** — removes every conversation you own in one call. There's no confirmation step; call `list` first if you need to know what's about to go.

See [Server-side conversations](#server-side-conversations) below for the full picture.

## Server-side conversations

`chat` and `custom_prompt` can remember a conversation across calls entirely server-side, so the caller stops resending the whole transcript on every turn. This is fully opt-in: leave `start_conversation` and `conversation_id` unset on both tools and nothing changes — the server behaves exactly as it did before this feature existed.

**Starting one** — pass `start_conversation: true` to `chat` or `custom_prompt`. The response gets a trailing line like:

```
💬 Conversation a1b2c3d4-5678-... — 2 turns, 340 chars retained. Idle-expires in 60min. Continue with conversation_id: "a1b2c3d4-5678-...".
```

**Continuing one** — pass that id back as `conversation_id` on the next call and send *only* the new input (the new `message` for `chat`, the new `instruction` for `custom_prompt`). Never resend prior turns — the server already has them and prepends the stored history itself.

**Cross-tool continuation** — `chat` and `custom_prompt` share the same store. Start a conversation with one and continue it with the other; only `conversation_id` identifies it, not which tool created it.

**`custom_prompt`'s `context` gets special handling** — it's recorded into the conversation history only the first time it's sent for a given `conversation_id`. Resending the identical `context` string on every call is safe and won't duplicate it in the stored history — that's actually the recommended habit, because if `context` is ever trimmed out of the retained history as the conversation grows (see limits below), resending it re-adds it automatically on the next call. Omitting it after the first call also works, as long as it's still within the retained history.

**Isolation boundary** — two modes, selected by whether `HOUTINI_LM_CONVERSATION_OWNER_HEADER` is set:

- **Unset (default)** — a conversation is bound to the MCP *connection* that created it, never to a fixed or shared key. Over stdio that's the single local process for that client. Over HTTP it's the `mcp-session-id`; if a call arrives over HTTP with no session established yet, server-side conversations refuse outright rather than silently falling back to a shared key — that fallback would leak history across unrelated callers.
- **Set** — a conversation is bound to the value of the named HTTP request header instead, so the same caller can continue it across MCP sessions/connections (useful behind a gateway that reconnects on every call — see [Troubleshooting](manual/troubleshooting.md)). This server never falls back to the MCP session key when the header is missing or unusable; it fails the call outright. **Only set this if the front-end proxy in front of this server replaces any client-supplied header of the same name on every request rather than appending to it** — an appending proxy would let a client spoof another user's identity. mcp-auth-proxy's `--header-mapping`/`HEADER_MAPPING` option is one way to produce such a header from an OIDC claim; consult its docs/source for the version you run to confirm it replaces rather than appends. As a second layer of defense, this server rejects the call outright if it ever sees more than one value for the header (a sign the header wasn't replaced) — but that check is not a substitute for a correctly configured proxy, only a way to fail loudly instead of silently trusting an ambiguous value.

**Discarding conversations** — the [`conversations`](#conversations) tool's `delete` (one) or `clear` (all you own); the idle timeout (`HOUTINI_LM_CONVERSATION_TTL_MIN`, default 60 minutes, measured from the conversation's last use); and, over HTTP, **only when `HOUTINI_LM_CONVERSATION_OWNER_HEADER` is unset**, sending `DELETE` on the MCP session itself — that immediately discards every conversation owned by that session (see [Remote / HTTP transport](#remote--http-transport)). When the owner header is set, a session `DELETE` no longer discards conversations — they outlive the session that created them by design, and are discarded only via `delete`/`clear`/idle TTL.

**Known limitations** — this is a lightweight, in-memory feature, not a durable chat log:
- Everything is lost on a process restart or redeploy. Nothing is persisted to disk.
- `deploy.replicas` must stay at `1`. The store is in-memory and per-process, not shared between replicas — a client bounced onto a different replica would find its conversation gone.
- Concurrent calls appending to the *same* `conversation_id` at the same time have no guaranteed ordering.
- `custom_prompt`'s "don't duplicate this context" check is an exact string match — whitespace or formatting differences between calls mean it won't be recognised as the same context, and will be recorded again.
- Long conversations quietly shrink the output budget: `max_tokens` is capped against the whole prompt, retained history included, to fit the model's context window — so a long-running conversation can end up with less room for the answer than a fresh call would get, with no separate warning beyond the usual quality flags (e.g. `TRUNCATED`).
- With `HOUTINI_LM_CONVERSATION_OWNER_HEADER` set, a conversation is no longer discarded when its creating MCP session ends — it stays in process memory until the idle TTL (`HOUTINI_LM_CONVERSATION_TTL_MIN`, default 60 minutes) expires, or until `delete`/`clear` is called.

**Sizing note** — a single very long `context` passed to `custom_prompt` can by itself consume most or all of `HOUTINI_LM_CONVERSATION_MAX_CHARS` (default 48,000 characters) in one call. If you plan to lean on `context` heavily inside a conversation, consider raising that variable — see [Configuration](#configuration).

**Turning it off** — set `HOUTINI_LM_CONVERSATIONS=0` (also accepts `false`/`no`/`off`) and both parameters disappear from `chat`'s and `custom_prompt`'s schemas entirely, and the `conversations` tool itself stops appearing in `tools/list` — rather than being present and erroring on every call.

## Structured JSON output

Both `chat` and `custom_prompt` accept a `json_schema` parameter that forces the response to conform to a JSON Schema. LM Studio uses grammar-based sampling to guarantee valid output - no hoping the model remembers to close its brackets.

```json
{
  "json_schema": {
    "name": "code_review",
    "schema": {
      "type": "object",
      "properties": {
        "issues": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "line": { "type": "number" },
              "severity": { "type": "string" },
              "description": { "type": "string" }
            },
            "required": ["line", "severity", "description"]
          }
        }
      },
      "required": ["issues"]
    }
  }
}
```

## Getting good results from local models

Qwen, Llama, Nemotron, GLM - they score brilliantly on coding benchmarks now. The gap between a good and bad result is almost always prompt quality, not model capability. I've spent a fair bit of time on this.

**Send complete code.** Local models hallucinate details when you give them truncated input. If a file's too large, send the relevant function - not a snippet with `...` in the middle.

**Be explicit about output format.** "Return a JSON array" or "respond in bullet points" - don't leave it open-ended. Smaller models need this.

**Set a specific persona.** "Expert Rust developer who cares about memory safety" gets noticeably better results than "helpful assistant."

**State constraints.** "No preamble", "reference line numbers", "max 5 bullet points" - tell the model what *not* to do as well as what to do.

**Include surrounding context.** For code generation, send imports, types, and function signatures - not just the function body.

**One call at a time.** As of v2.8.0, houtini-lm enforces this automatically with a request semaphore. Parallel calls queue up and run one at a time, so each gets the full timeout budget instead of stacking.

## Self-test (shakedown)

The canonical way to verify an install and get an honest read on what the loaded model can do on your hardware:

```bash
npm run shakedown
```

This runs [`scripts/shakedown.mjs`](./scripts/shakedown.mjs) — an end-to-end test that exercises seven of the nine tools (`discover` → `list_models` → `chat` → `custom_prompt` → `code_task` → `code_task_files` → `embed`; `stats` and `conversations` are not covered) and prints a summary table with real TTFT, tok/s, token counts, and reasoning-token split for each call. Takes under a minute on a decent rig.

Sample output tail:

```
Summary

   7/7 steps passed on LM Studio, model=nvidia/nemotron-3-nano

| Tool              | OK  | TTFT (ms) | tok/s  | Tokens in→out        | Reasoning | Notes
| chat              | ✅  |      891  |   36.9 | 48→104               |        —  | answered
| custom_prompt     | ✅  |      872  |   43.9 | 170→333              |        —  | 5 valid items
| code_task         | ✅  |      857  |   41.6 | 180→189              |        —  | tests generated
| code_task_files   | ✅  |   11028   |   39.5 | 6891→3000            |        —  | cross-referenced
| embed             | ✅  |      —    |     —  | —                    |        —  | 768-dim vector

   Tokens offloaded: 10,915 (prompt: 7,289, completion: 3,626, reasoning: 0)
```

Want a human-readable quality review rather than just latency numbers? Paste [SHAKEDOWN.md](./docs/SHAKEDOWN.md) into a Claude session that has houtini-lm attached — Claude will drive the seven steps and write you a report on output quality as well as performance.

## Think-block handling

Thinking models burn part of their output budget on invisible reasoning before producing an answer. Left alone, small models at default `max_tokens` will happily spend the whole budget reasoning and return an empty body. How houtini-lm handles this depends on whether the provider exposes reasoning as a separate channel or in-band.

**Local backends (LM Studio, Ollama, vLLM)** — reasoning arrives inline on the content channel or via `delta.reasoning_content` / `delta.reasoning`:

1. **Suppression at source** — at startup, houtini-lm checks each model's HuggingFace chat template for thinking support. Models that support the `enable_thinking` toggle (Qwen3, Gemma 4, Nemotron, DeepSeek R1, GLM-4, gpt-oss) get thinking disabled at inference time. Detection is automatic via chat-template inspection plus arch/id heuristics, so Ollama tags like `qwen3:4b` are recognised too.
2. **Budget inflation** — `max_tokens` is silently inflated (×4 or +2000, whichever is bigger) so reasoning can't starve the content channel. Essential for backends like Ollama where the Qwen3 Jinja template hardcodes `enable_thinking=true` and ignores the API flag.
3. **Reasoning capture + stripping** — reasoning is captured from both `delta.reasoning_content` (LM Studio, DeepSeek R1, Nemotron) and `delta.reasoning` (Ollama). Inline `<think>...</think>` blocks on the content channel are stripped after assembly — balanced pairs, orphan openers, and orphan closers are all handled. When reasoning exhausts the budget entirely, the captured reasoning text is returned as a last-ditch fallback so the caller sees *something* rather than a silent empty body.

**OpenRouter** — handles reasoning as a structured per-request parameter and a separate `message.reasoning` response field. Houtini-lm sends `reasoning: { exclude: true }` on every OpenRouter call so thinking models (Nemotron, DeepSeek R1, Qwen3, Claude thinking, gpt-oss, etc.) are normalised to text-only output at the provider level. Budget inflation still fires because some upstream providers bill reasoning tokens against the cap before `exclude` filtering. No stripping is needed — the provider never sends the reasoning in the first place.

The quality footer flags `think-blocks-stripped` when stripping occurred, `reasoning-only` when the fallback fired, and `hit-max-tokens` when the budget ran out — so you know exactly what happened even when the output looks clean.

**Surfacing reasoning on demand** — `chat`, `custom_prompt`, `code_task`, and `code_task_files` accept an `include_reasoning` boolean (default `false`). When `true` and the model produced reasoning, it's appended after the answer, delimited with `---` and a heading, so the caller can verify how a conclusion was reached — useful for review/bug-finding tasks where you want to check the model's reasoning, not just trust the answer. This works with both reasoning delivery shapes: a separate channel (`delta.reasoning_content` / `delta.reasoning` — LM Studio, DeepSeek R1, Nemotron, Ollama) and inline `<think>...</think>` blocks on the content channel (captured before being stripped from the visible answer, same as step 3 above) — so it surfaces reasoning on local backends (LM Studio, vLLM, Ollama) either way. If a model somehow emits both, the separate channel wins and the captured think-block text is discarded rather than duplicated. OpenRouter sends `reasoning: { exclude: true }` on every call regardless of this flag, so `include_reasoning` has no effect there yet.

Toggle-capable models (Qwen3, Nemotron, DeepSeek R1, GLM-4, gpt-oss, ...) have their thinking suppressed automatically by default (see [Think-block handling](#think-block-handling)) — so `include_reasoning: true` alone gets you nothing to show on those models; there's no reasoning generated in the first place. Pass `force_thinking: true` alongside it to disable suppression for that one call. `HOUTINI_LM_THINKING=off` always wins over `force_thinking` — an operator running the server with thinking locked off (e.g. a vLLM alias deployment that depends on it) can't have that overridden per call. When `include_reasoning: true` is set but no reasoning comes back, the response explains why instead of silently returning nothing extra — e.g. "houtini-lm suppressed its thinking automatically. Pass `force_thinking: true`...".

## Quality metadata

Every response includes structured quality signals in the footer so Claude (or any orchestrator) can make informed trust decisions:

```
---
Model: qwen3-coder-30b-a3b | 413→81 tokens | TTFT: 2355ms, 15.0 tok/s, 5.4s | Quality: think-blocks-stripped, tokens-estimated
💰 Claude quota saved this session: 494 tokens across 1 offloaded call
```

Flags include: `TRUNCATED` (partial result), `think-blocks-stripped`, `tokens-estimated` (usage data was missing, estimated from content length), `hit-max-tokens`. When no flags fire, the quality line is omitted — clean output, nothing to report.

## Session metrics resource

The `houtini://metrics/session` MCP resource exposes cumulative offload stats as JSON. Claude can read this proactively to make smarter delegation decisions based on actual session performance:

```json
{
  "session": {
    "totalCalls": 14,
    "promptTokens": 3200,
    "completionTokens": 5250,
    "totalTokensOffloaded": 8450
  },
  "perModel": {
    "qwen3-coder-30b-a3b": {
      "calls": 14,
      "avgTtftMs": 2100,
      "avgTokPerSec": 15.2
    }
  }
}
```

## Request serialisation

On **local** providers (LM Studio, Ollama, vLLM, llama.cpp) parallel MCP tool calls are automatically queued and run one at a time. A single-GPU host can only serve one request at a time anyway — without the semaphore, parallel calls stack timeouts and waste the generation budget.

On **remote** providers (OpenRouter, DeepSeek, Groq, Cerebras, and anything detected as a non-local backend) the semaphore is skipped — the upstream handles parallelism natively and serialising artificially would throttle you. This is automatic; you don't need to configure it.

## Configuration

| Variable | Default | What it does |
|----------|---------|-------------|
| `HOUTINI_LM_ENDPOINT_URL` | `http://localhost:1234` | Base URL of the OpenAI-compatible API. Legacy alias: `LM_STUDIO_URL`. |
| `HOUTINI_LM_API_KEY` | *(none)* | Bearer token for authenticated endpoints. Legacy aliases: `LM_STUDIO_PASSWORD`, `LM_PASSWORD`, `OPENROUTER_API_KEY`. |
| `HOUTINI_LM_MODEL` | *(auto-detect)* | Model identifier — leave blank to use whatever's loaded. Legacy alias: `LM_STUDIO_MODEL`. |
| `HOUTINI_LM_PROVIDER` | *(auto-detect)* | Force provider-specific handling. Set to `openrouter` for OpenRouter attribution headers, `reasoning.exclude`, and no inference serialisation. Otherwise auto-detected from the endpoint URL. |
| `HOUTINI_LM_CONTEXT_WINDOW` | `100000` | Fallback context window if the API doesn't report it. Legacy alias: `LM_CONTEXT_WINDOW`. |
| `HOUTINI_LM_FILE_ROOTS` | *(unset)* | Optional `:`/`,`-separated allowlist of directory roots `code_task_files` may read from (symlink-resolved). Unset = any absolute path. On a remote deployment this should point at a mount shared with clients — see [Docker Swarm](#docker-swarm) above. |
| `HOUTINI_LM_MAX_FILE_MB` | `10` | Per-file size cap for `code_task_files`. |
| `HOUTINI_LM_CROSS_PROCESS_LOCK` | `1` | Set to `0` to disable just the cross-process inference lock (keeps the in-process semaphore). |
| `HOUTINI_LM_SERIALISE` | `1` | Set to `0` to disable inference serialisation entirely (both the in-process semaphore and the cross-process lock). Use for backends that batch natively (vLLM, TGI, SGLang) where one-at-a-time only throttles throughput. |
| `HOUTINI_LM_MIN_TOKENS` | `4096` | Floor for caller-supplied `max_tokens`. Values below the floor are ignored and the dynamic budget (25% of the model's context window) applies — MCP clients habitually pass tiny caps like 256 that strangle reasoning models. Set to `0` to honour any value (e.g. deliberate micro-chunking on slow hardware). |
| `HOUTINI_LM_THINKING` | `auto` | Thinking control: `auto` detects thinking support from the model and suppresses it when detected, `off` forces the no-think path for every call, `on` forces thinking on for models known to support a toggle (sends `enable_thinking: true`, skips `reasoning_effort`, and inflates `max_tokens` the same way suppression does). `off` always wins — it overrides both `on` and a per-call `force_thinking: true`. Use `off` when an orchestrator (e.g. Claude) does the reasoning and the local model only executes — and **required for vLLM served under an alias** (e.g. `coder-next`), where HF-metadata detection can't identify the real model so the no-think toggle would otherwise never fire and the answer would come back empty (in `reasoning_content`). Use `on` (server-wide) or `force_thinking: true` (per call) when you want the local model's own reasoning surfaced via `include_reasoning: true`. |
| `HOUTINI_LM_CONVERSATIONS` | `1` (on) | Enables `start_conversation`/`conversation_id` on `chat` and `custom_prompt`, and the `conversations` tool. Set to `0` (also accepts `false`/`no`/`off`) to disable — both parameters and the `conversations` tool disappear from the schema entirely rather than being present and erroring. See [Server-side conversations](#server-side-conversations). |
| `HOUTINI_LM_CONVERSATION_TTL_MIN` | `60` | Idle-expiry window for a server-side conversation, in minutes, measured from its last use. |
| `HOUTINI_LM_CONVERSATION_MAX` | `50` | Max conversations held at once, across all owners. Oldest by last use is evicted on overflow. |
| `HOUTINI_LM_CONVERSATION_MAX_TURNS` | `40` | Max user/assistant turns retained per conversation before the oldest are trimmed. |
| `HOUTINI_LM_CONVERSATION_MAX_CHARS` | `48000` | Max total characters retained per conversation before the oldest turns are trimmed. A single very long `custom_prompt` `context` can consume most of this budget in one call — raise it if you lean on `context` heavily inside conversations. See [Server-side conversations](#server-side-conversations). |
| `HOUTINI_LM_CONVERSATION_OWNER_HEADER` | unset | Name of an HTTP request header carrying an authenticated caller identity; when set, conversations are scoped to that identity instead of the MCP session. See [Server-side conversations § Isolation boundary](#server-side-conversations). |

**Per-request sampling** — `chat`, `custom_prompt`, `code_task`, and `code_task_files` also accept optional `seed`, `stop`, `top_p`, `top_k`, `repeat_penalty`, `frequency_penalty`, and `presence_penalty`. Out-of-range values are ignored; the backend default applies.

> **Requires Node ≥ 22.5** (≥ 22.13 recommended) — the model cache uses Node's built-in `node:sqlite`. On older Node the server still runs, without the cache.

## Compatible endpoints

Works with anything that speaks the OpenAI `/v1/chat/completions` API:

| What | URL | Notes |
|------|-----|-------|
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234` | Default, zero config. Rich metadata via v0 API. **[Setup guide →](./docs/SETUP-LMSTUDIO.md)** |
| [Ollama](https://ollama.com) | `http://localhost:11434` | Set `HOUTINI_LM_ENDPOINT_URL`. Thinking models (qwen3, deepseek-r1) handled transparently — reasoning is captured from Ollama's `delta.reasoning` channel and the output budget is inflated automatically so small thinking models don't return empty bodies. |
| [OpenRouter](https://openrouter.ai) | `https://openrouter.ai/api` | 300+ models from one endpoint. Auto-detected — sends attribution headers, uses `reasoning.exclude` for thinking models, retries 429/5xx with jittered backoff, parallel requests allowed. |
| [vLLM](https://docs.vllm.ai) | `http://localhost:8000` | Native OpenAI API. **[Setup guide →](./docs/SETUP-VLLM.md)** |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `http://localhost:8080` | Server mode |
| [DeepSeek](https://platform.deepseek.com) | `https://api.deepseek.com` | 28c/M input tokens |
| [Groq](https://groq.com) | `https://api.groq.com/openai` | ~750 tok/s |
| [Cerebras](https://cerebras.ai) | `https://api.cerebras.ai` | ~3000 tok/s |
| Any OpenAI-compatible API | Any URL | Set URL + password |

## Streaming and timeouts

All inference uses Server-Sent Events streaming. Tokens arrive incrementally. Since v2.9.0, houtini-lm sends MCP progress notifications on every streamed chunk — including during the thinking phase for reasoning models — which resets the SDK's 60-second client timeout. A 5-minute soft timeout acts as a safety net so a wedged connection can't hold a tool call open indefinitely; as long as tokens keep flowing, the per-chunk progress keeps the client side alive up to that ceiling.

If the connection stalls (no new tokens for an extended period), you get a partial result instead of a timeout error. The footer shows `TRUNCATED` when this happens, and the quality metadata flags it so Claude knows to treat the output with appropriate caution.

## Architecture

```
index.ts          Main MCP server - tools, streaming, session tracking
model-cache.ts    SQLite-backed model profile cache (node:sqlite, WAL)
                  Auto-profiles models via HuggingFace API at startup
                  Persists to ~/.houtini-lm/model-cache.db

Inference:        POST /v1/chat/completions  (OpenAI-compatible, works everywhere)
Model metadata:   GET  /api/v0/models        (LM Studio, falls back to /v1/models)
Embeddings:       POST /v1/embeddings        (OpenAI-compatible)
```

## Development

```bash
git clone https://github.com/houtini-ai/lm.git
cd lm
npm install
npm run build
npm run shakedown    # end-to-end self-test + benchmark
```

See [DEVELOPER.md](./DEVELOPER.md) for architecture, internals, the reasoning-model pipeline, backend detection, the SQLite performance cache, and instructions for adding new tools or backends.

## Licence

Apache-2.0
