# Local, Air-Gapped Claude Code Observability — OpenLIT + a Local Ollama LLM Judge

Capture **Claude Code CLI** traces locally with [OpenLIT](https://github.com/openlit/openlit) — rich span waterfalls, token + cost tracking, searchable history — and run **LLM-as-judge evaluations** and **AI trace analysis** using a **local Ollama model on your own GPU**. Nothing leaves your machine.

This repo bundles the OpenLIT CE source **with the local-Ollama-judge patches already applied**, so you can clone and build it directly. The standout piece is the **Ollama judge setup for NVIDIA, AMD, and Apple Silicon** below.

📋 **What's new:** see **[CHANGELOG.md](CHANGELOG.md)** for everything this fork adds over upstream.

> **Why patches?** OpenLIT's built-in evaluations/analysis only ship cloud judge providers (OpenAI, Anthropic, …). Two tiny patches add an `ollama` provider pointing at `http://host.docker.internal:11434/v1`, so the judge runs locally and air-gapped.

---

## What you get
- **Capture:** every Claude Code session → `coding_agent.*` / `gen_ai.*` OTel spans (sessions, LLM turns, tool calls, edits, subagents) with tokens, **USD cost**, and prompt/completion text.
- **Evaluate locally:** hallucination / bias / toxicity / relevance scoring by a local Ollama model.
- **Analyze locally:** AI "Analyze trace" summaries by the same local model.
- **Air-gapped by convention:** telemetry off, eval provider = `ollama`, OTLP on `localhost`.
- **Verifiable cost:** **cache-aware** pricing (Anthropic cache reads ~0.1×, writes ~1.25× input — opus-4-8 etc.), plus a reconciler that confirms the store matches Claude Code's own per-turn `usage` to the cent.

## Repo layout
```
openlit/                      OpenLIT CE source (Apache-2.0), pinned + patched, ready to build
patches/                      the two source patches (to apply on a fresh upstream clone instead)
  0001-run-evaluation-add-ollama-judge.patch     # Evaluations path
  0002-chat-stream-add-ollama-provider.patch     # Chat / Trace-Analysis / prompt-improve path
tools/                        accuracy + pricing utilities (Python, stdlib-only)
  reconcile_session.py        transcript (ground truth) <-> ClickHouse store: PASS/FAIL token + cost reconciliation
  cc_pricing.py               pricing oracle (port of the CLI pricing.go) + self-test
  fix_mojibake.py             repair UTF-8-double-encoded-as-CP1252 text
docs/                         implementation plan, options analysis, deployment notes, trace-accuracy & pricing
CHANGELOG.md                  what this fork adds over upstream (patch notes)
openlit-pinned-commit.txt     upstream commit the patches target
```

## Credits & license
- **OpenLIT** (`openlit/openlit`) — **Apache-2.0**; bundled under `openlit/` with its own `LICENSE`/`NOTICE`. The patches in this repo are derivative changes to that source.
- **Ollama** (local model runtime); **Anthropic Claude Code** (the agent being observed).
- This repo's own files (README, `docs/`, `patches/`): **MIT** (see `LICENSE`).

---

## Architecture
```
┌── your host ────────────────────────────────────────────────────────────┐
│  claude (Claude Code CLI)                                                 │
│    └─ hooks → openlit CLI → OTLP/HTTP :4318 ─┐                            │
│                                              ▼                            │
│   Docker:  openlit container (OTel collector + Next.js UI :3000)          │
│            └─ ClickHouse :8123/:9000  (traces, persisted in a volume)     │
│                       │ judge / analysis call                            │
│                       ▼ http://host.docker.internal:11434/v1             │
│   Ollama (native, on your GPU/Apple-Silicon)  :11434                      │
└──────────────────────────────────────────────────────────────────────────┘
```

## Prerequisites
- **Docker Desktop** (WSL2 backend on Windows), ≥ 8 GB allotted; ~25 GB free disk.
- **git**, **Claude Code** CLI.
- A GPU — **NVIDIA** or a recent **AMD** card — **or** an **Apple-Silicon Mac** with enough unified RAM.
- Free ports: `3000, 4317, 4318, 8123, 9000` (OpenLIT) and `11434` (Ollama).

---

## Quick start
```bash
git clone <this-repo> && cd <this-repo>

# 1. Build + run the OpenLIT platform (telemetry already disabled, ollama endpoint pre-wired)
cd openlit/src
docker compose -p openlit -f dev-docker-compose.yml up -d --build
# UI: http://127.0.0.1:3000   default login: user@openlit.io / openlituser  → CHANGE THE PASSWORD
```
Then: set up the **Ollama judge** for your hardware (below) → **instrument Claude Code** → **wire the judge into OpenLIT**.

> Don't have `src/.env`? That's expected — it's git-ignored (it holds secrets). The container auto-generates a `NEXTAUTH_SECRET` on first run. For anything beyond local experimentation, create `openlit/src/.env` with your own `NEXTAUTH_SECRET` and `OPENLIT_VAULT_ENCRYPTION_KEY` (and **back the latter up** — losing it makes stored Vault secrets unrecoverable).

---

## The Ollama judge — set up for your hardware

### 1) Pick a judge model (by GPU VRAM / Mac unified RAM)
| Memory | Suggested model | Notes |
|---|---|---|
| ~8 GB  | `qwen2.5:7b` or `llama3.1:8b` | usable floor; scores are directional |
| ~16 GB | `qwen2.5:14b` or `mistral-small` | sweet spot |
| 24 GB+ | `qwen3:30b-a3b` (MoE) or `qwen2.5:32b` | closest to cloud-judge quality |

> **MoE models (e.g. `qwen3:30b-a3b`, ~3B active params) are ideal on AMD and Apple Silicon** — they cut compute while keeping quality, so they're fast even where raw GPU compute is the bottleneck.

### 2) Install Ollama
- **Windows / macOS:** download from <https://ollama.com/download>.
- **Linux:** `curl -fsSL https://ollama.com/install.sh | sh`.

### 3) GPU acceleration per platform

**NVIDIA (Windows / Linux)** — CUDA is auto-detected; nothing to configure.
- Verify: `nvidia-smi` shows an `ollama` process during inference, and `ollama ps` reports **`100% GPU`**.

**AMD (Windows)** — Ollama uses ROCm or its **Vulkan** backend. RDNA3 cards (e.g. RX 7900 XTX/XT, `gfx1100`) work well.
- You may see `AMD driver is too old … GPU inference` in the serve log — on RDNA3 Ollama **falls back to Vulkan and still runs fully on the GPU**. The real test is `ollama ps` → **`100% GPU`** (not `CPU`).
- If `ollama ps` shows `CPU`: update **AMD Adrenalin** drivers; for some cards force ROCm with `HSA_OVERRIDE_GFX_VERSION` (e.g. `11.0.0` for RDNA3, `10.3.0` for RDNA2).

**AMD (Linux)** — install the ROCm build of Ollama and confirm your GPU is ROCm-supported. Verify with `ollama ps` → `100% GPU`.

**Apple Silicon Mac (M-series)** — Ollama uses **Metal automatically**; no config. The constraint is **unified memory** — the model must fit in RAM with headroom:
- 16 GB Mac → up to ~8B (`qwen2.5:7b`).
- 32 GB Mac → ~14B comfortably; `qwen3:30b-a3b` (MoE, ~18–20 GB) fits with care.
- 64 GB+ Mac → 32B dense / `qwen3:30b-a3b` easily.
- Verify GPU use: **Activity Monitor → Window → GPU History**, or `sudo powermetrics --samplers gpu_power` (GPU active during inference). `ollama ps` shows the model loaded.

### 4) Make Ollama reachable from the OpenLIT container
The judge runs on the **host**; the container reaches it via `host.docker.internal`. Ollama must listen beyond loopback — set `OLLAMA_HOST=0.0.0.0:11434`:
- **Windows:** add a **user environment variable** `OLLAMA_HOST=0.0.0.0:11434`, then restart Ollama. Allow inbound TCP 11434 (Private) in Windows Defender Firewall *only if* the container can't reach it (Docker Desktop usually works without it).
- **macOS:** `launchctl setenv OLLAMA_HOST "0.0.0.0:11434"` then restart the Ollama app.
- **Linux:** `systemctl edit ollama` → add `Environment=OLLAMA_HOST=0.0.0.0:11434`, then `systemctl restart ollama`.

Recommended extras (set the same way):
- `OLLAMA_KEEP_ALIVE=30m` — unload the model when idle to free VRAM (use `-1` to pin it resident).
- `OLLAMA_CONTEXT_LENGTH=16384` — the 4096 default silently truncates long Claude Code prompt+completion pairs.

The bundled `dev-docker-compose.yml` already sets `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1` and an `extra_hosts: host.docker.internal:host-gateway` mapping (required on Linux Docker). Verify container → host:
```bash
docker compose -p openlit -f dev-docker-compose.yml exec -T openlit \
  node -e "fetch('http://host.docker.internal:11434/v1/models').then(r=>r.text()).then(console.log)"
```

### 5) Pull the model + create the no-think variant (important for evals)
```bash
ollama pull qwen3:30b-a3b
```
**Qwen3 emits `<think>…</think>` reasoning that can break JSON parsing.** Create a non-thinking judge variant (shares the same weights — no extra disk):
```
# Modelfile
FROM qwen3:30b-a3b
SYSTEM "/no_think"
```
```bash
ollama create qwen3-judge -f Modelfile      # use `qwen3-judge` as the judge model
```
(Non-thinking models such as `qwen2.5:*` / `mistral-small` don't need this.)

> **AI trace analysis no longer depends on this.** The *Analyze trace* path calls Ollama's **native `/api/chat` with `think:false` + a JSON `format` schema**, so it returns schema-valid findings even when a model would otherwise emit `<think>` (qwen3's `/no_think` is ignored on the OpenAI-compat `/v1` endpoint once the analysis sends its own system prompt). The `qwen3-judge` variant is still recommended — it keeps the **Evaluations** path clean and avoids wasted reasoning tokens.

Verify GPU placement:
```bash
ollama run qwen3-judge "hi"
ollama ps        # PROCESSOR should read 100% GPU
```

---

## Wire the judge into OpenLIT (UI)
1. **Manage Models → Add Provider** → Provider ID = **`ollama`** (lowercase, exact — the runner matches `case "ollama"`). Add a **model** whose id equals your Ollama tag (e.g. `qwen3-judge`).
2. **`/vault`** → new secret. **Value = `ollama`** (any non-empty string — the eval engine rejects an empty key *before* it ever calls the model; Ollama itself ignores the value). The secret **name** is just a label.
3. **`/evaluations/settings`** → Provider = **Ollama** (it sorts to the **bottom** of the list because it isn't a built-in), Model = `qwen3-judge`, Secret = your vault secret. Optionally enable Auto + a cron.
4. **Run an eval**, or open a trace and click **Analyze**. Watch it on the GPU with `ollama ps`.

---

## Keep your trace data (disable the 30-day TTL)
OpenLIT's ClickHouse tables auto-delete data after **730h (~30 days)**. To retain everything:
```bash
for t in otel_traces otel_logs otel_metrics_gauge otel_metrics_sum \
         otel_metrics_histogram otel_metrics_summary \
         otel_metrics_exponential_histogram otel_traces_trace_id_ts; do
  curl -s "http://localhost:8123/?user=default&password=OPENLIT" \
       --data-binary "ALTER TABLE openlit.$t REMOVE TTL"
done
```
`REMOVE TTL` is metadata-only and persists in the volume. If you ever delete the `openlit_clickhouse-data` volume, also strip the `TTL … toIntervalHour(730)` lines from `openlit/assets/clickhouse-init.sh`. **Back up the volume:**
```bash
docker run --rm -v openlit_clickhouse-data:/data -v ${PWD}:/backup alpine \
  tar czf /backup/clickhouse-backup.tgz -C /data .
```

---

## Instrument Claude Code (the capture side)
```bash
# install the OpenLIT CLI:  Windows: iwr -useb .../install.ps1 | iex   |   mac/Linux: curl -fsSL .../install.sh | sh
openlit configure --endpoint http://127.0.0.1:4318 --content-capture full
openlit coding install --vendor=claude-code
```
**Windows gotchas (fixes in `docs/deployment-notes.md`):**
1. The generated `~/.claude/plugins/.../hooks.json` writes Windows paths with single backslashes → **invalid JSON** → plugin won't load. Fix the command paths to **forward slashes + double quotes**, e.g. `"C:/Users/<you>/.openlit/bin/openlit.exe" coding hook …`.
2. `openlit coding install` needs the `openlit` binary on **PATH** (open a new terminal, or prepend `%USERPROFILE%\.openlit\bin`).
3. **Fully restart Claude Code** after install — hooks load at startup, so already-running sessions are never captured.

---

## Verify capture accuracy & cost (`tools/`)

Confirm the stored numbers against **Claude Code's own ground truth** — the per-turn `usage` blocks in the session transcript (what `/context` is derived from):
```bash
python tools/reconcile_session.py --list                  # sessions in the store
python tools/reconcile_session.py --session-id <uuid>     # PASS/FAIL reconciliation
```
It reads the raw transcript (main + subagents), recomputes the canonical 4-way token split (fresh / cache-read / cache-write / output) and cost via `cc_pricing.py`, pulls the ClickHouse store, and prints PASS/FAIL with the arithmetic expanded — token identity, **cost identity (a scan that flags any span re-priced cache-blind)**, coverage (dropped tail / duplicates), no-double-count, and tool dedupe. Read-only.

> **Cache pricing note.** The CLI stamps a **cache-aware** cost at capture; the dashboard sums that, so everyday numbers are correct. The server *recompute* (the manual **"Recalculate"** button) is now also cache-aware and refuses to overwrite a captured cost. If you added a model in **Manage Models**, it only collected input+output rates — that's fine for Anthropic (the recompute falls back to published cache multipliers); see `docs/trace-accuracy-and-pricing.md` to add explicit per-model cache rates.

---

## Security notes (read before sharing a deployment)
- **Change defaults:** the seeded login `user@openlit.io` / `openlituser` and the ClickHouse password `OPENLIT`.
- **Never commit `openlit/src/.env`** — it holds `NEXTAUTH_SECRET` / `OPENLIT_VAULT_ENCRYPTION_KEY`. This repo's `.gitignore` excludes all `.env` files.
- **Air-gap is by convention, not enforced.** Nothing blocks egress; the guarantee rests on telemetry being off, the eval provider being `ollama`, and OTLP being local. For a hard guarantee, add an OS/Docker egress firewall rule allowing the container only `host.docker.internal:11434` + loopback.
- `--content-capture full` stores prompt/completion **text** locally (with built-in secret redaction). Use `metadata_only` if you'd rather not store bodies.

See `docs/` for the full implementation plan, the monitoring-options analysis, and detailed deployment notes (including exact verification steps and the bugs fixed during the original build).
