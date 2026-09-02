# The tools, in depth

Eleven tools. Five do inference, three tell you about the setup, one manages server-side conversations, one manages background jobs, and one manages chunked payload uploads. This page is the reference for all of them - what each one's for, the parameters that matter, and how to read what comes back. If you want the philosophy of *what to hand off and how to brief it*, that's [delegation.md](delegation.md).

## chat

The general-purpose tool. One message in, one response out, routed to the best loaded model.

> Ask the local model to summarise this changelog

**Parameters worth knowing:**

- `message` - the task. Include everything: the local model can't read files, can't browse, can't see your conversation. If the answer depends on code, paste the code.
- `system` - persona. Specific beats generic every time. "Senior TypeScript developer reviewing for correctness" gets sharper output than "helpful assistant" (which is roughly a request for waffle).
- `temperature` - 0.1 for factual and code work, 0.3 for analysis, 0.7 when you want ideas. Local models get weird above 0.5 on code.
- `max_tokens` - **leave it unset.** The server checks the loaded model's real context window and allocates 25% of it as the output budget. Values below 4,096 are ignored entirely (see [the floor](#the-max_tokens-floor), below).
- `json_schema` - force structured output. Pass a JSON Schema and the response is guaranteed-valid JSON conforming to it. The reliable way to get parseable data out of a small model - much better than asking nicely in the prompt.
- `seed` + `temperature: 0` - byte-identical output across calls. Deterministic (we've tested it): same seed, same prompt, same bytes. Useful for regression-testing prompts.
- `stop`, `top_p`, `top_k`, `repeat_penalty`, `frequency_penalty`, `presence_penalty` - the full sampling set, range-validated server-side, forwarded only when you set them.
- `include_reasoning` - default `false`. Set `true` to append the model's reasoning after the answer (delimited, so you can check how it got there) when the backend actually returns reasoning. No effect, no error, if the model didn't produce any — and by default it usually won't have any, because thinking-capable models get suppressed automatically (see below).
- `force_thinking` - default `false`. Set `true` to disable that automatic suppression for this one call, so the model actually thinks. Costs latency and generated tokens; pair with `include_reasoning: true` to see the result. A no-op if the server's running with `HOUTINI_LM_THINKING=off` — that setting always wins.
- `start_conversation` - default `false`. Set `true` to have the server remember this conversation for you - the id comes back on the response's last line, ready to pass as `conversation_id` next time. See [Server-side conversations](../README.md#server-side-conversations) in the README for the full picture. Not in the schema at all if the server's running with `HOUTINI_LM_CONVERSATIONS=0`.
- `conversation_id` - continue a conversation started with `start_conversation: true`. Send only the new message; the server prepends the stored history for you. Wins over `start_conversation` if both are set.

## custom_prompt

Same engine as `chat`, different shape: explicit `system` / `context` / `instruction` separation. The three-part structure exists because small models bleed context into instructions when everything arrives as one blob - the server has the model acknowledge the context in a staged turn before the instruction lands.

Reach for it when the material and the ask are separate things:

- Code review - full source as `context`, "list bugs as JSON {line, issue, fix}" as `instruction`
- Comparing two implementations
- Analysing a document for structure or tone

Field discipline: `system` under 30 words, `context` complete and untruncated, `instruction` under 50 words with the output format stated. The narrower the instruction, the better a small model follows it.

Also accepts `include_reasoning` and `force_thinking` (both default `false`) - same as `chat`, plus `start_conversation`/`conversation_id` - also same as `chat`, sending only the new `instruction` on continuation calls.

When you're continuing a conversation, `context` gets special treatment: it's only recorded into the stored history the first time you send it for that `conversation_id`, so resending the same block on every call is safe and won't duplicate it. That's the recommended habit, in fact - if a long conversation ever trims `context` out of its retained history, resending it puts it straight back.

Also accepts `async` (default `false`) - submit as a background job instead of waiting inline; see [Async jobs](../README.md#async-jobs) in the README. Cannot be combined with `start_conversation`/`conversation_id`.

Also accepts `context_blob_id` - use a sealed blob (created with the `blobs` tool) as `context` instead of pasting it inline, for input too large to send in one MCP call. Substituted verbatim for `context`; sending both in the same call is an error, and it cannot currently be combined with `start_conversation`/`conversation_id` either. Pairing it with `async: true` is the intended way to submit input too large or too slow to process synchronously. See [Large payloads (blobs)](../README.md#large-payloads-blobs) in the README.

## code_task

`chat` wrapped in a code-review system prompt with temperature locked low (0.2, or the routed model's own hint). Two required fields - `code` and `task` - plus an optional `language` that shapes the system prompt and measurably improves accuracy. Set it.

Good tasks: explain this function, find bugs, write tests for the error paths, add error handling, convert this pattern. The usual caveat applies double for generated code: it compiles on the model's optimism, not your machine. Read it before you commit it.

Also accepts `include_reasoning` and `force_thinking` (both default `false`) - same as `chat`.

## code_task_files

The one that changes the economics. Same pipeline as `code_task`, but you pass **absolute file paths** and the server reads them from disk - the source goes straight to the local model and never enters Claude's context window. On a multi-file review that's thousands of tokens of Claude quota that simply don't get spent.

- Paths must be absolute. Relative paths are rejected outright.
- Files are read in parallel; one unreadable file doesn't sink the call - the failure is noted inline and the model reasons over the rest.
- Files are concatenated with `=== filename ===` headers, so you can ask the model to reference files by name.
- A pre-flight estimator checks whether the input's prefill time would blow the MCP client's ~60s request timeout, and refuses early with a diagnostic instead of hanging. It learns your hardware's real speed from measured calls, weights recent samples over stale ones, and won't refuse on a low-confidence estimate. If it fires, split the file list.

Two env vars scope it: `HOUTINI_LM_FILE_ROOTS` confines reads to an allowlist of directories (symlink-resolved), and `HOUTINI_LM_MAX_FILE_MB` caps per-file size (default 10).

Also accepts `include_reasoning` and `force_thinking` (both default `false`) - same as `chat` - plus `async` (default `false`): submit as a background job instead of waiting inline. Paths are still read and validated *before* the call returns, whether or not `async` is set - a bad path fails synchronously either way. See [Async jobs](../README.md#async-jobs) in the README.

## embed

Text in, vector out, via the backend's `/v1/embeddings` endpoint. Needs an embedding model loaded (Nomic Embed, for instance) - a chat model won't answer this endpoint, and on single-model backends like vLLM this tool will simply report that no embedding model is available. For semantic search, similarity, RAG experiments.

## discover

The "is anyone home?" tool - and the model catalogue. Returns whether the endpoint is up, which model is active, its real context window, a capability profile (what this model family is good and bad at), and - after the first measured call - its actual speed on your hardware: TTFT and tokens/sec. Fast: sub-second when the server's up, bounded at five seconds when it isn't.

Call it at the start of a delegation-heavy session. The measured-speed line is the honest answer to "should I delegate this 3,000-token job or just do it myself?"

## list_models

Everything the backend has, loaded and merely downloaded, with per-model metadata: type (llm / vlm / embeddings), architecture, quantisation, context length, capability profile. The profiles come from a local SQLite cache that enriches itself from the HuggingFace API at startup (7-day TTL), so even a model the server's never seen gets a useful description by the second session.

## stats

Just the numbers, no catalogue: tokens offloaded, calls made, per-model TTFT and tok/s - session and lifetime, persisted in `~/.houtini-lm/model-cache.db` across restarts. Also reports the reasoning-token overhead ratio, which is worth glancing at: if a big share of your completion tokens are going on hidden thinking, your no-think configuration isn't landing (see [troubleshooting](troubleshooting.md#responses-are-slow-and-the-token-counts-look-inflated)).

The 💰 line is cumulative Claude quota kept in your pocket. It climbs quickly once `code_task_files` is in play.

## conversations

Housekeeping for the server-side conversations `chat` and `custom_prompt` can start with `start_conversation: true` - see [Server-side conversations](../README.md#server-side-conversations) in the README for how those work, including its two ownership modes. This tool never shows or touches anything you don't own.

Three actions, chosen with the `action` parameter: `list` returns a table of your conversations - id, turn count, chars retained, idle time, expiry - metadata only, never message content. `delete` removes one by `conversation_id`; an id that never existed and one owned by someone else get the identical error, on purpose, so the error can't be used to probe for other owners' ids. `clear` removes everything you own at once, with no confirmation step - call `list` first if you want to know what you're about to lose.

Not in the tool list at all if the server's running with `HOUTINI_LM_CONVERSATIONS=0`.

## jobs

Housekeeping for the background jobs `custom_prompt` and `code_task_files` can start with `async: true` - see [Async jobs](../README.md#async-jobs) in the README for how those work, including the same ownership boundary `conversations` uses. This tool never shows or touches anything you don't own.

Three actions, chosen with the `action` parameter: `list` returns a table of your jobs - id, tool, state, submitted time, result size in chars - metadata only, never the result body. `get` (needs `job_id`) returns the full state, and once `completed` or `failed`, the result or error itself; pass `wait_ms` (up to 30,000) to block for the job to finish instead of polling in a tight loop. `delete` (needs `job_id`) forgets the record - it does not cancel a `running` job, which keeps executing against the backend regardless.

`get` also accepts `offset`/`limit` to page through a large result instead of getting it all at once. A `completed` result past `HOUTINI_LM_JOB_RESULT_INLINE_MAX_CHARS` (default 50,000 chars) is automatically chunked this way even without asking - the response carries a `Next` footer telling you exactly what to pass on the following call. Copy it verbatim rather than computing the next offset yourself. A `failed` job's `error` is always returned whole, never chunked.

Not in the tool list at all if the server's running with `HOUTINI_LM_JOBS=0`.

## blobs

Housekeeping for chunked payload uploads - the input-side counterpart to `jobs`' output-side chunking above. Lets you send a prompt too large for one MCP call in ordered pieces, then reference the assembled result by id instead of pasting it inline. See [Large payloads (blobs)](../README.md#large-payloads-blobs) in the README for the full workflow.

Five actions, chosen with the `action` parameter: `create` starts a new blob, optionally with `data` as its first chunk. `append` (needs `blob_id`, `seq`, `data`) adds the next chunk - chunks must arrive in order starting at `seq: 0`, or the call is rejected and the blob is left unchanged. `seal` (needs `blob_id`) closes the blob to further appends and computes its sha256 over the full assembled body - optionally pass `sha256` to verify it against your own digest. `list` returns a table of your blobs - id, state (`open`/`sealed`), chunk count, chars, idle time, expiry - metadata only, never the body. `delete` (needs `blob_id`) removes the record.

50,000 characters per chunk is the recommended `append` size - measured safe over the production MCP path. A sealed blob's id becomes `custom_prompt`'s `context_blob_id`.

Not in the tool list at all if the server's running with `HOUTINI_LM_BLOBS=0`.

## Reading the footer

Every inference response ends with a footer. It's worth learning to read:

```
Model: qwen3.6-27b | 353→2829 tokens | TTFT: 126ms, 18.8 tok/s, 150.3s | typescript · 1 file(s) read
💰 Claude quota saved — this session: 3,809 tokens / 2 calls · lifetime: 150,158 tokens / 197 calls
```

- `353→2829` - prompt tokens in, completion tokens out. If the output number dwarfs the visible text, the difference went on hidden reasoning.
- `TTFT` - time to first token. Prefill cost, roughly proportional to input size on your hardware.
- `tok/s` - decode speed, measured over generation only (prefill excluded, so it's honest).
- Quality flags appear here too: `TRUNCATED` (hit the token budget - the budget logic makes this rare), `UPSTREAM ERROR`, `content_filter` (a refusal, not a length problem - don't retry it bigger), `think-strip-empty` (the whole response was reasoning; see troubleshooting).

## The max_tokens floor

Worth its own heading because it's deliberate and it surprises people. Caller-supplied `max_tokens` below 4,096 is **ignored** - the dynamic budget applies instead. MCP clients habitually pass tiny caps like 256, and on a reasoning model that budget is gone before the first visible word: the model thinks, hits the cap, and returns nothing. You paid full inference time for an empty string.

The budget is headroom, not consumption - an unused ceiling costs nothing. So the server is generous by default (25% of the model's real context), caps the result so prompt + output always fits the context window (strict backends like vLLM reject the request outright otherwise, and if a proxy misreports the window, the server parses the real limit from the backend's own error and retries once), and refuses to let a client starve the model.

If you're doing deliberate micro-chunking on slow hardware - small budgets to stay inside client timeouts - set `HOUTINI_LM_MIN_TOKENS=0` and the server honours whatever you send.
