# Changelog

What this fork adds on top of upstream [OpenLIT CE](https://github.com/openlit/openlit) — a local, air-gapped Claude Code observability + LLM-judge setup. Newest first.

## 2026-06-14

### Added
- **Structured local trace analysis** — AI "Analyze trace" now calls Ollama's native `/api/chat` with a JSON `format` schema and `think:false`, so the local judge returns schema-valid findings (a summary + per-dimension findings) instead of prose. The grader/refinement pass also runs for the local judge via the same native path, enriching and pruning findings.
- **Breakdown tab** (per trace) — token composition (fresh / cache-read / cache-write / output, with share + estimated per-tier cost), a tool-use table, and code/content output (lines ±, edits, languages, response volume, commits).
- **Subagent Breakdown tab** (per trace) — one row per agent in a Workflow/Task fan-out: turns, tools, tokens, cache %, cost, % of run.
- **Cache-aware cost** — the cost recompute now prices Anthropic cache reads (~0.1×) and writes (~1.25×) separately instead of billing every cache token at the full input rate. Falls back to published multipliers when a model has no cache rates set.
- **Reconcile tooling** (`tools/`) — `reconcile_session.py` checks captured tokens/cost against the raw transcript (the numbers Claude Code's `/context` shows); `cc_pricing.py` pricing oracle with self-test; `fix_mojibake.py` text repair.

### Fixed
- **AI trace analysis "could not be parsed"** — qwen3's `<think>` output (which the OpenAI-compat `/v1` endpoint can't disable once the analysis sends its own system prompt) no longer breaks JSON parsing; analysis is reliable on local models.
- **`/clear` session outcome** — ending a session with `/clear` now reports `completed` (a graceful end) instead of `cancelled`.
- **`/clear` cost double-count (CLI)** — `tailTranscript` now coalesces streaming usage fragments by request id, so the SessionEnd rollup written on `/clear` no longer multiplies a session's tokens/cost (~2.4×).
- **"Total cost (USD)" dashboard card** — excludes the `coding_agent.session` rollup span from the per-turn sum (was ~2× for ended sessions); distinct from the per-trace cost chip below.
- **Trace-analysis timeout** — raised the UI request timeout to 300s for longer local-judge runs; the analysis also saves server-side even if the browser disconnects.
- **Subagent token capture** — multi-agent runs were capturing ~2% of tokens; per-subagent turns are now drained and attributed to the right agent.
- **Cost double-count** — the trace "Total cost" chip no longer adds the session-root aggregate on top of the per-turn rows.
- **Recalculate guard** — manual cost recalculation no longer overwrites an accurate captured cost.
- **Docs rendering** — repaired UTF-8 mojibake in `docs/` so the architecture diagrams render.

## 2026-06-13

### Added
- **Local Ollama judge** — evaluations and trace analysis run on a local Ollama model (`patches/`), no cloud provider, fully air-gapped.
- **Build-from-source + local config** — telemetry off, OTLP on localhost, Ollama endpoint pre-wired; setup for NVIDIA / AMD / Apple-Silicon GPUs.
- **Claude Code capture** — sessions become `coding_agent.*` / `gen_ai.*` spans with tokens, USD cost, and prompt/completion text.
