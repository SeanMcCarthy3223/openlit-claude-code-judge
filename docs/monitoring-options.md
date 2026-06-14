# Capturing & Monitoring Claude Code CLI Trace Data Locally â€” Options & Recommendation

**Date:** 2026-06-13
**Goal:** Best free / open-source way to capture and monitor **Claude Code CLI** trace data on a **local Windows 11** machine.
**Requirements (locked):** rich spans/traces (prompt â†’ completion â†’ tool-call waterfalls) Â· cost/token tracking Â· searchable audit history Â· **built-in eval/scoring of outputs** Â· fully local (data never leaves the machine) Â· Docker OK Â· free/OSS.

> Research method: a 30-agent fan-out across the 5 capture *mechanisms* and 10 candidate *platforms*, with an adversarial verification pass on every load-bearing claim against primary sources (Anthropic docs, GitHub LICENSE/README files). Verdicts below reflect the verified findings.

---

## 0. The finding that reframes everything

**Claude Code's CLI now has OpenTelemetry built directly into the binary, and as of a 2025/2026 beta it emits genuine rich nested *spans* â€” not just metrics and logs.** With three env vars you get a real waterfall, verified against the official docs:

```
claude_code.interaction              (root: one per user turn)
â”œâ”€ claude_code.llm_request           (one per Claude API call; latency ttft_ms/duration_ms, input/output/cache tokens, model, stop_reason)
â””â”€ claude_code.tool                  (one per tool call; tool_name, duration_ms, tool_use_id)
   â”œâ”€ claude_code.tool.blocked_on_user   (permission-wait span; accept/reject decision)
   â””â”€ claude_code.tool.execution         (actual execution; success/error)
        â””â”€ (subagent llm_request + tool spans nest here for Agent/Task delegation)
```

**Consequence:** for the *CLI*, you usually do **not** need a proxy or a wrapper to get rich spans. You point Claude Code's built-in exporter at a **local OTLP backend** and you're done. So "which tool is best" largely becomes **"which local backend do I run, and does it also give me evals + cost + search?"**

**The quick-start recipe (PowerShell) â€” foundation for several options below:**
```powershell
$env:CLAUDE_CODE_ENABLE_TELEMETRY="1"
$env:CLAUDE_CODE_ENHANCED_TELEMETRY_BETA="1"   # REQUIRED for spans (beta, off by default)
$env:OTEL_TRACES_EXPORTER="otlp"
$env:OTEL_METRICS_EXPORTER="otlp"
$env:OTEL_LOGS_EXPORTER="otlp"
$env:OTEL_EXPORTER_OTLP_PROTOCOL="grpc"        # or http/protobuf (then use :4318)
$env:OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
# Optional â€” capture actual prompt/tool text (REDACTED by default):
$env:OTEL_LOG_USER_PROMPTS="1"; $env:OTEL_LOG_TOOL_DETAILS="1"; $env:OTEL_LOG_TOOL_CONTENT="1"
claude
```
Tip: persist these in `%USERPROFILE%\.claude\settings.json` under the `"env"` key so every `claude` session inherits them.

### Five caveats that apply to the *native OTel* path (true regardless of backend)
1. **Traces are BETA, off by default** (need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`). Span names/attributes may change between releases.
2. **Everything redacted by default** â€” prompt text, tool inputs/outputs, API bodies. Opt in with the `OTEL_LOG_*` flags above (real PII/secret exposure; fine locally, redact if you ever ship it).
3. **Cost (USD) is NOT a span attribute.** It lives in the metric `claude_code.cost.usage` and the `api_request` log event (`cost_usd`). Per-span *token counts* ARE present; a backend can compute cost from tokens, or you join metricsâ†’traces by `session.id`.
4. **No evals at this layer.** Native OTel is pure capture. Eval/scoring is a *backend* feature â€” this is the requirement that discriminates between the tools below.
5. **Data is split across 3 signals** (traces + metrics + logs). A single backend that ingests all three gives the most coherent picture. Short `claude -p` runs can drop spans on a fast exit â€” lower `OTEL_*_EXPORT_INTERVAL` to ~1000ms. (Verified non-issue for your case: the full span tree emits correctly in interactive `claude` and `claude -p`; a known bug, anthropics/claude-code #53954, only drops `interaction`/`tool` spans when driven through the *Agent SDK / ACP streaming* path â€” not the interactive CLI.)

### The auth gotcha that kills the proxy options
Proxy-based tools (Helicone, LiteLLM, Future AGI gateway, mitmproxy) require pointing `ANTHROPIC_BASE_URL` at a local proxy. **Setting that disables OAuth subscription login** â€” so if you run Claude Code on a **Claude Pro/Max subscription**, the proxy approach fails with a 401 and forces you onto a **metered API key** (Console billing). The **native-OTel** and **hook-based** approaches have *no such problem* â€” they work no matter how you authenticate. This is the single biggest reason the proxy tools are deprioritized below.

---

## 1. Comparison matrix

| Tool | Free & local? (license) | Rich CC spans | Cost tracking | Search | **Built-in evals** | CC-CLI integration | Windows | Bottom line |
|---|---|---|---|---|---|---|---|---|
| **Langfuse** â­ | âœ… MIT (whole product) | âœ… (hook plugin) | âœ… | âœ… | âœ… free | **Official CC plugin** (hooks) | âœ… | **Best overall** â€” only option nailing all 4 reqs with an official CC integration |
| **OpenLIT** â­ | âœ… Apache-2.0 | âœ… (native + CC plugin) | âœ… | âœ… | âœ… (needs judge LLM key) | **Dedicated CC CLI/plugin** | âœ… (PS installer) | Best OTel-native + turnkey Windows path |
| **Arize Phoenix** | âœ… ELv2 (free self-host) | âš ï¸ degradedÂ¹ | âœ… (OpenInference) | âœ… | âœ… strongest eval lib | none native; proxy or SDK glue | âœ… (pip/docker) | Best *evals*, but CLI rendering is degraded without a proxy |
| **SigNoz** | âœ… MIT core | âœ… (renders beta trace) | âœ… strong | âœ… | âŒ none | Official docs (metrics+logs); traces DIY | âš ï¸ unofficial (WSL2) | Great APM + cost; **no evals** |
| **Grafana + Tempo + Prometheus + Loki** | âœ… AGPL/Apache | âœ… (Tempo) | âœ… best dashboards | âœ… TraceQL | âŒ none (cloud-only) | Native OTel; you wire Tempo yourself | âœ… (Docker) | Canonical stack; **no evals**, highest assembly |
| **Jaeger** | âœ… Apache-2.0 | âœ… clean waterfall | âŒ none | âœ… | âŒ none | **Native OTel, 1 container** (Anthropic-blessed) | âœ… | Simplest "just see the waterfall"; nothing else |
| **Laminar (lmnr)** | âœ… Apache-2.0 | âœ… (native OTLP) | âš ï¸ partial | âœ… fast | âœ… (DIY framework) | Native OTLP glue (no recipe) | âœ… | Solid all-rounder; younger (pre-1.0) |
| **Helicone** | âœ… Apache-2.0 core | âš ï¸ session viewÂ² | âœ… strong | âœ… | âš ï¸ partial | Proxy (OAuth blocker) | âœ… | **Maintenance mode** since Mar 2026; proxy auth issue |
| **Traceloop OpenLLMetry** | âš ï¸ SDK free; backend paid | n/a (SDK only) | âš ï¸ | âŒ | âŒ (paid/cloud) | **Can't instrument the CLI** | âš ï¸ | Wrong tool for the CLI; skip |
| **future-agi/traceAI** (your start) | âœ… Apache-2.0 (platform nightly) | âš ï¸ genericÂ³ | âš ï¸ partial | âš ï¸ partial | âœ… | **Category mismatch**; only proxy path | âœ… (PS installer) | Interesting, but immature + wrong fit (see Â§3) |

Â¹ Phoenix's rich LLM UI keys off **OpenInference** conventions; the CLI emits **OTel `claude_code.*`/`gen_ai.*`** spans, so native CLI spans render as *generic* spans (no prompt panes / auto-cost / 1-click evals) unless you run a traceAI/OpenInference proxy in front (â†’ OAuth blocker).
Â² Helicone groups requests into header-path "sessions," not true OTel auto-nested tool-call spans.
Â³ Same OpenInference-vs-OTel mismatch as Phoenix; plus its self-host platform is a nightly `v0.5.8` "expect rough edges" build.

---

## 2. The three integration philosophies (why the table splits the way it does)

1. **Native OTel exporter â†’ any OTLP backend** (Jaeger, Tempo/Grafana, SigNoz, Laminar, Phoenix, OpenLIT). Zero glue beyond env vars. Beta, redacted-by-default, **no evals at this layer**. Spans use Anthropic's `claude_code.*` schema â€” fine for generic OTel viewers (Jaeger/Tempo/SigNoz render the waterfall perfectly), degraded for OpenInference-tuned UIs (Phoenix, Future AGI).
2. **Hook-based bridge** (Langfuse plugin, OpenLIT CC CLI). A Claude Code hook reads each turn/transcript and emits proper platform traces **with full prompt/completion text captured by design** (no redaction-flag fiddling), and the platform adds evals + cost + search. Works on any auth. *This is the sweet spot for your requirements.*
3. **Proxy** (Helicone, LiteLLM, Future AGI gateway, mitmproxy). Captures full request/response text, but sees a **flat** sequence of HTTP calls (not a nested tool waterfall â€” tools run locally between API turns, invisible to the proxy) and hits the **OAuth blocker**. Best only when you run on a metered API key and chiefly want exact cost + raw payloads.

---

## 3. Verdict on your starting point: `future-agi/traceAI`

**It's a category mismatch for the CLI use case.** `traceAI` is a collection of OpenInference-style **instrumentation libraries** that wrap the Anthropic SDK *inside your own Python/TS code* (`AnthropicInstrumentor().instrument()`). The Claude Code CLI is a standalone Node binary â€” it never imports your instrumentation, so traceAI **does not instrument the CLI**.

The companion `future-agi/future-agi` **platform** *is* a self-hostable Apache-2.0 stack with 50+ eval metrics, and Future AGI published a Jan 2026 blog showing a Claude Code path â€” but that path is the **gateway/proxy pattern** (`ANTHROPIC_BASE_URL` â†’ their gateway builds OpenInference spans), which carries the OAuth blocker, and the self-host platform is a **nightly `v0.5.8`** build. Net: a real local rich-span path exists, but it's immature and uses the least-favorable mechanism. **Not recommended as your primary.** Its genuine home is when *you* build your own Anthropic-SDK app â€” not for the CLI.

---

## 4. Recommendation

Because you want **all four** capabilities â€” and evals + fully-local + free + *the CLI specifically* is the hard combination â€” the field narrows to two front-runners:

### ðŸ¥‡ Primary: **Langfuse** (via the official Claude Code plugin)
- **Why:** the only option that delivers rich text-bearing waterfalls **+ free built-in LLM-as-judge evals + datasets/annotation + cost + search**, with an **official** Claude Code integration, all **MIT** and fully local. The entire product (evals, playground, datasets) was relicensed MIT in June 2025; only narrow enterprise-admin features are gated.
- **Install:** `claude plugin marketplace add langfuse/Claude-Observability-Plugin` â†’ `claude plugin install langfuse@langfuse-observability`; self-host via docker-compose and **set `LANGFUSE_BASE_URL=http://localhost:3000`** (critical â€” otherwise data goes to Langfuse Cloud).
- **Watch out:** *not* native OTel â€” you **must** use the hook plugin (naive `otelâ†’langfuse` does not render; confirmed by maintainers). The plugin is **new (June 2026)**, pins `langfuse>=4.0,<5` and uses SDK internals, so an SDK v5 bump could break it. Heavy footprint (Postgres + ClickHouse + Redis + MinIO; guidance ~4 cores/16 GB). To keep evals 100% local, point the judge at a local model (e.g., Ollama) rather than a cloud LLM. Requires Python 3.10+.

### ðŸ¥ˆ Runner-up: **OpenLIT** (OTel-native, smoothest Windows install)
- **Why:** Apache-2.0 with **no feature gating**, a **dedicated Claude Code plugin** (`openlit coding install --vendor=claude-code`, installs 7 hooks emitting OTel spans), the **only project with a documented Windows PowerShell installer**, plus 11 built-in evals, cost/token tracking, and ClickHouse-backed search.
- **Watch out:** the built-in evals call an **external judge LLM** (no documented local/Ollama option) â€” that one feature leaves the machine unless you wire a local model. Coding-agent CLI is new (2026), thinner docs. ClickHouse dependency.

### Pick a different option if your priorities shift:
- **Just want to *see* the waterfall today, minimal setup, evals not required â†’** native CLI OTel â†’ **Jaeger** (one Docker container; Anthropic's own docs name Jaeger as the local target). Add Prometheus+Grafana later for cost dashboards.
- **You want this to double as a full APM and don't need evals â†’** **SigNoz** (official CC monitoring docs, all-three-signals, great cost dashboards) or the **Grafana+Tempo+Prometheus+Loki** stack (best dashboards, most assembly).
- **Evals are your #1 priority and you'll build your own agent code (or run a local proxy) â†’** **Arize Phoenix** (strongest eval library, lightest to start via `pip install arize-phoenix`).

### Avoid for this specific goal:
- **Helicone** â€” acquired by Mintlify, in **maintenance mode** since Mar 2026; proxy OAuth blocker; AI Gateway is GPL-3.0 (not Apache as its README claims).
- **Traceloop OpenLLMetry** â€” in-process SDK that **can't instrument the CLI**; self-host backend + evals are paid/cloud.

---

## 5. Suggested path

1. **Today (10 min):** run the Â§0 recipe â†’ **Jaeger** all-in-one container. Confirm you see the `claude_code.interaction â†’ llm_request / tool` waterfall for your real sessions. This validates the native exporter works on your Windows box before you invest in a heavier stack.
2. **This week:** stand up **Langfuse** locally + install the official CC plugin. You now have waterfalls **with prompt/completion text**, cost, searchable history, and free LLM-as-judge evals â€” the full requirement set.
3. **If Langfuse's footprint or the new-plugin risk bothers you:** fall back to **OpenLIT** (lighter, OTel-native, first-class Windows installer), accepting that evals call out to a judge model unless you point it at a local one.

---

### Primary sources (selection)
- Claude Code Monitoring (env vars, metrics, events, Traces beta span tree): https://code.claude.com/docs/en/monitoring-usage
- Claude Code Agent SDK Observability (span hierarchy, Jaeger note): https://code.claude.com/docs/en/agent-sdk/observability
- Langfuse Claude Code integration + plugin: https://langfuse.com/integrations/developer-tools/claude-code Â· https://github.com/langfuse/Claude-Observability-Plugin
- OpenLIT (Apache-2.0, coding-agents CLI): https://github.com/openlit/openlit Â· https://docs.openlit.io/latest/openlit/coding-agents
- Arize Phoenix (ELv2, evals, OpenInference): https://github.com/Arize-ai/phoenix Â· https://arize.com/docs/phoenix/tracing/concepts-tracing/translating-conventions
- SigNoz CC monitoring: https://signoz.io/docs/claude-code-monitoring/
- Grafana CC dashboards: https://grafana.com/grafana/dashboards/25255-claude-code-metrics-prometheus/
- Jaeger: https://www.jaegertracing.io
- Laminar: https://github.com/lmnr-ai/lmnr
- Helicone (maintenance-mode note): https://www.helicone.ai/blog/joining-mintlify Â· OAuth limit: https://github.com/anthropics/claude-code/issues/48011
- future-agi/traceAI + platform: https://github.com/future-agi/traceAI Â· https://github.com/future-agi/future-agi Â· https://futureagi.com/blog/claude-code-observability-openinference-opentelemetry-2026/
- Community stacks: https://github.com/anthropics/claude-code-monitoring-guide Â· https://github.com/ColeMurray/claude-code-otel
