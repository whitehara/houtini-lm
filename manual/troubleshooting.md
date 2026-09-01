# Troubleshooting

Symptoms first, because that's what you've got. Each entry: what you're seeing, what's actually happening, what to do. Most of these we've hit ourselves - several are the reason a given fix exists in the codebase at all.

## The response is empty, or just a footer

**Usually: a thinking model spent the whole reply reasoning.** The model produced output, but all of it was `<think>` content (or landed in the backend's `reasoning_content` field) and there was nothing left after stripping. The footer flags `think-strip-empty` when the server had to fall back.

Three fixes, in order:

1. Upgrade - v3.2.1 fixed the big one: vLLM only honours the no-think toggle when it's nested inside `chat_template_kwargs`, and older versions sent it top-level, where vLLM silently ignored it.
2. If your backend serves the model under an alias (`coder-next` instead of the real Qwen id), detection can't recognise it as a thinking model. Set `HOUTINI_LM_THINKING=off` to force no-think on every call.
3. If you set a small `max_tokens` yourself with `HOUTINI_LM_MIN_TOKENS=0` active, the thinking ate your budget before any visible output. Remove the cap.

## `include_reasoning: true` returns no reasoning block, even though it's a thinking model

**The opposite symptom to the one above — and the expected default.** By design, houtini-lm suppresses a thinking model's reasoning automatically once it's detected (`auto`, the default for `HOUTINI_LM_THINKING`): the model never gets asked to think in the first place, so there's no reasoning to surface regardless of `include_reasoning`. This isn't a bug — the whole point of suppression is that Claude does the reasoning and the local model only executes.

If you actually want the local model's own reasoning surfaced:

1. Set `HOUTINI_LM_THINKING=on` in the MCP server's `env`. For models with a known thinking toggle (Qwen3, Nemotron, DeepSeek R1, GLM-4, gpt-oss, ...) this forces `enable_thinking: true` instead of suppressing it.
2. Pass `include_reasoning: true` on the call. Without it, the reasoning is still generated but stripped from the response as usual.
3. Non-thinking models, or thinking models without a known toggle, still won't produce anything to surface — `include_reasoning: true` is a no-op there, not an error.

`off` always overrides `on` — if both are somehow in play (e.g. a shared config), `off` wins and reasoning stays suppressed.

## Timeouts - the call dies around a minute

**The MCP client's ~60s request timeout, not the server's.** houtini-lm streams progress notifications from the moment the call is acknowledged - per-chunk during generation, heartbeats every 10s during prefill, even before the backend's HTTP headers arrive - and clients that honour `resetTimeoutOnProgress` (Claude Desktop does) will happily sit through multi-minute calls. Clients that ignore the keepalives will kill the request at their timeout regardless of what the server does.

If your client is the ignoring kind: split the work into smaller calls ([micro-chunking](delegation.md#micro-chunking-on-slow-hardware)), trim the input, or submit the call with `async: true` on `custom_prompt`/`code_task_files` instead and poll for the result with the `jobs` tool - see [Async jobs](../README.md#async-jobs) in the README. The `code_task_files` pre-flight estimator exists precisely to refuse synchronous calls that would die this death - a refusal with a diagnostic beats sixty silent seconds and an error (the estimator doesn't fire on `async` calls, since there's no client timeout to protect there).

## code_task_files refuses with "estimated prefill time exceeds the ~60s MCP client timeout"

**The estimator thinks your hardware can't prefill this input in time.** It learns from measured (prompt_tokens, TTFT) pairs per model, weights recent samples over stale ones, and only refuses on a fit it trusts (R² ≥ 0.5).

- If the input really is big: split the file list, or trim the largest file. The diagnostic tells you the estimated tokens and seconds.
- If you've just changed your backend's performance settings (or moved to faster hardware), a few successful smaller calls teach it the new reality quickly - the recency weighting means stale slow samples wash out within about half a dozen calls.
- If it keeps refusing something you know your machine can handle, that's a bug worth reporting with the diagnostic text.

## 400 errors about context length from vLLM

**Strict backends reject `prompt + max_tokens > context` instead of clamping.** houtini-lm caps its budgets to the context window it's told about - but when a proxy (a LiteLLM router, say) advertises a generic window over a model actually loaded smaller, the arithmetic is right and the premise is wrong. Since v3.2.3 the server parses the *real* limit out of the backend's own error message and retries once with a corrected budget, so you should only ever see this fail if the retry also fails. If it does, check what the model is actually loaded with (`--max-model-len` on vLLM) versus what your proxy claims.

## Responses are slow, and the token counts look inflated

Look at the footer: `107→2229 tokens` on a short answer means ~2,100 tokens of hidden reasoning. That's inference time you're paying wall-clock for. Fix the thinking configuration (first entry above) and both the speed and the counts come right. `stats` tracks the reasoning-token ratio over time - low single-digit percentages mean suppression is working.

## Everything queues - parallel calls stack up

**Serialisation is on by default,** in-process and cross-process (an advisory file lock), because most local backends hold one model on one GPU and interleaved requests just thrash it. If your backend batches properly - vLLM, TGI, SGLang - set `HOUTINI_LM_SERIALISE=0` and let it. `HOUTINI_LM_CROSS_PROCESS_LOCK=0` disables just the file lock if you want in-process politeness only.

## discover says the endpoint is offline

- The URL is the **base**, no `/v1` - houtini-lm appends it. `http://localhost:8000`, not `http://localhost:8000/v1`.
- vLLM takes minutes to load a model; the port accepts connections before `/v1/models` answers. Wait for the model-loaded log line.
- On LM Studio, the server has to be started (Developer tab) - the app running isn't the server running.

## embed fails

The backend needs an actual embedding model loaded. A chat model doesn't serve `/v1/embeddings`, and single-model servers (typical vLLM) can't hold both - this is expected, not broken. Run embeddings on a backend that has one loaded, or skip the tool.

## The model gives mangled or truncated-feeling output on big inputs

Check the model's real context window in `discover`, not the family's advertised one - a 128k-family model loaded at 32k on a small GPU is a 32k model, and everything past the window is silently gone from its view. The dynamic output budget follows the *loaded* window, but your prompt still has to fit in what's left.

## Stats look wrong after switching backends

Per-model stats key on the model id the backend reports. Serve the same weights under two ids (or through a router that renames them) and you get two histories. Cosmetic, but worth knowing before you conclude the model got slower - check which id the footer names.

## conversation_id fails with "this conversation has expired or is not available to you"

**One of five things happened to that conversation, and the tool deliberately won't say which** - telling them apart would let a caller probe for other owners' conversations, so `chat`, `custom_prompt`, and the `conversations` tool's `delete` action all give this same "expired or is not available to you" wording regardless of the cause (chat/custom_prompt add a reminder to start a new one; `delete` doesn't need to):

- It sat idle past `HOUTINI_LM_CONVERSATION_TTL_MIN` (default 60 minutes) and was swept away.
- It was evicted by the LRU cap - `HOUTINI_LM_CONVERSATION_MAX` (default 50) conversations total, across every owner, and this one was the oldest when a new one pushed past the limit.
- The server process restarted or was redeployed - conversations are in-memory only, nothing survives that.
- You're on the HTTP transport and reconnected, landing on a new `mcp-session-id` - conversations are scoped to the MCP session that created them, and a fresh session can't see the old one's (including one you deliberately or accidentally `DELETE`d). **This does not apply on a server running with `HOUTINI_LM_CONVERSATION_OWNER_HEADER` set** - there, conversations are scoped to an authenticated caller identity instead of the session, so a new session from the same caller can still see them.
- The id belongs to a different owner entirely.

There's nothing to recover - start a new conversation with `start_conversation: true` rather than retrying the old id. See [Server-side conversations](../README.md#server-side-conversations) in the README for how the lifecycle works.

## jobs get fails with "not found or is not available to you"

**Same deliberate non-disclosure as the conversation error above, for the same reason** - `jobs`' `get` and `delete` give this identical wording regardless of cause, so the error can't be used to probe for other owners' job ids:

- It sat past `HOUTINI_LM_JOB_TTL_MIN` (default 60 minutes, measured from submission) and was swept away.
- It was evicted by the LRU cap - `HOUTINI_LM_JOB_MAX` (default 50) job records total, across every owner.
- The server process restarted or was redeployed - jobs are in-memory only, including ones that were still `running`, nothing survives that.
- You're on the HTTP transport and reconnected, landing on a new `mcp-session-id` - jobs are scoped to the MCP session that submitted them, same as conversations when `HOUTINI_LM_CONVERSATION_OWNER_HEADER` is unset. **This does not apply when that variable is set** - jobs are then scoped to an authenticated caller identity instead, so a new session from the same caller can still see them.
- You (or something else with access) already called `delete` on it.
- The id belongs to a different owner entirely.

There's nothing to recover - submit a new job with `async: true` rather than retrying the old id.

## A job stays pending and never starts running

**`HOUTINI_LM_JOB_CONCURRENCY` (default `1`) is already saturated.** Only that many jobs actually run inference at once, server-wide - everything past it queues as `pending` until a slot frees up. Check `jobs list` for other `running` jobs (yours or, if you can't see them, ask whoever else is using this server instance); a `pending` job with nothing else `running` anywhere is a bug worth reporting, not this.

## async can't be combined with start_conversation or conversation_id

**Deliberate scope limit, not a missing feature.** A background job and a server-side conversation turn are two different lifecycles with different ownership and expiry rules, and combining them (an async call that also reads or extends conversation history) isn't supported yet. Use one or the other on a given call: `async: true` alone for a one-off background job, or `start_conversation`/`conversation_id` alone for a synchronous conversational turn.

## Where to look when none of this fits

The server logs everything interesting to **stderr** (stdout is the MCP transport and stays clean - any log line you see mixed into responses is a bug, report it). In Claude Desktop, the MCP log files capture stderr per server: look for `[houtini-lm]` lines - budget overrides, thinking-mode decisions, retry attempts and lock waits are all narrated there. Failing that, the [issues page](https://github.com/houtini-ai/houtini-lm/issues) - a footer, the stderr lines, and your backend's version is usually enough to diagnose anything.
