# Changelog

What this fork adds on top of upstream [OpenLIT CE](https://github.com/openlit/openlit) — a local, air-gapped Claude Code observability + LLM-judge setup. Newest first.

## 2026-07-10

### Added
- **Pricing for Claude Fable 5 and Opus 4.8** — the CLI pricing table (`cli/internal/coding/pricing/pricing.go`) and the server auto-pricer (`default-models.ts`) now carry `claude-fable-5` (plus Mythos 5 aliases) at $10/$50 and `claude-opus-4-8` at $5/$25, with cache-read/write rates. Turns on these models previously fell through to `$0` because neither pricing source recognised the id.
- **Indefinite trace retention by default** — removed the 730h (30-day) TTL from `otel_traces` (`assets/clickhouse-init.sh`) and set the OTel ClickHouse exporter to `ttl: 0` (`assets/otel-collector-config.yaml`). With `ttl_only_drop_parts` the old TTL dropped whole day-partitions, so coding-agent history (sessions, per-turn cost, edit decisions) silently aged out a month after capture and could never be recovered. Retention is now an explicit deployment choice rather than a silent 30-day default.

### Fixed
- **Idle coding vendors vanished from the Coding Agents hub** — vendor discovery was windowed to 24h (the width of the `*_24h` rollups), so a vendor idle for more than a day was never re-materialized: its `last_materialized_at` froze and the `listAgents` freshness gate hid the row forever while every one of its spans sat intact in ClickHouse. Discovery is now an unbounded all-time census independent of the rollup window, coding rows are exempt from the `last_seen` lower bound, and an idle vendor re-materializes every tick with honest zero `*_24h` stats. Adds materializer unit tests pinning the idle-vendor and census-merge behaviour.
- **Coding Sessions tab rendered empty on load** — the global 24h default hid every coding session older than a day even though the telemetry was retained. The Sessions tab now switches to the ALL time range, and the sessions API dropped its implicit 24h lower bound, so historically-browsed sessions (routinely days or weeks old) show up instead of an empty list.

## 2026-06-16

### Added
- **Idle / completed session states** — the coding-agent Sessions list no longer latches the blue "running" pill forever on sessions that never recorded an end-of-session outcome (closing VS Code, a crash, or starting a new chat skips the graceful end). It now ages each session by its last activity: `running` (< 30 min), `idle` (30 min–48 h), then `completed` (≥ 48 h). Applies only when there's no real outcome (a genuine verdict still wins), self-ages via a 60-second ticking clock with no hydration mismatch, and needs no schema or data change. Adds a `session-liveness` helper with 9 unit tests pinning the boundaries.

### Fixed
- **Coding Agents hub "Total Cost" double-count** — the `/agents` Coding Agents card summed `gen_ai.usage.cost` across *all* spans including the `coding_agent.session` rollup, so it read ~2× the per-agent detail page. It now prefers the authoritative session-end total and otherwise sums only non-root per-turn spans, matching the Sessions list and the dashboard cost widget. (Distinct surface from the dashboard "Total cost (USD)" card fixed on 2026-06-14.)

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
