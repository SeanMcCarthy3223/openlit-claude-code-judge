# OpenLIT Local Observability — Setup Status & Handoff

**Date:** 2026-06-13 · **Status:** ✅ **OPERATIONAL** — Claude Code capture + cost are working end-to-end. Only the local-judge **eval config (UI)** and a one-time **browser login** remain.

Executed from the plan `openlit-implementation-plan.md` (autopilot). Pinned upstream commit: `a689421` (see `openlit-pinned-commit.txt`).

---

## What is running right now

| Component | State | Detail |
|---|---|---|
| OpenLIT platform | ✅ Up (healthy) | Built **from source**; containers `openlit` + `clickhouse`, `restart: always` |
| UI | ✅ http://127.0.0.1:3000 (HTTP 200) | `/coding-agents` dashboard |
| OTLP ingest | ✅ :4317 (gRPC) / :4318 (HTTP) | OpAMP-supervised `otelcontribcol` → ClickHouse `otel_traces` |
| Ollama judge | ✅ `qwen3:30b-a3b` | **100% GPU** on RX 7900 XTX (Vulkan), ~75 tok/s, ctx 16384, keep-alive 30m |
| OpenLIT CLI | ✅ `%USERPROFILE%\.openlit\bin\openlit.exe` (cli-0.0.1) | endpoint=`http://127.0.0.1:4318`, content-capture=`full` |
| Claude Code plugin | ✅ `openlit-cc@openlit` **enabled** | 7 hooks wired; **hooks.json bug fixed** (see below) |

## Verified end-to-end (data layer)

A real headless `claude -p` session produced spans in ClickHouse:
- `coding_agent.session`, `coding_agent.llm.turn` ×2, `coding_agent.session.loop.stop` — service = `claude-code`
- **Model:** `claude-opus-4-8` · **tokens:** in 33,517 / out 4 · **cost: $0.1985 (already non-zero)**
- **Prompt/completion text captured** via `gen_ai.input.messages` / `gen_ai.output.messages` (content-capture `full`)

> Cost is computed **by the CLI at hook time** (it already prices `claude-opus-4-8`), so the plan's "cost shows $0 until you add pricing in the UI" does **not** apply to the hook path. Phase 7 UI pricing is **optional**.

---

## Two bugs found & fixed during execution

1. **hooks.json invalid JSON (Windows).** The CLI wrote hook commands with raw single backslashes (`'C:\Users\...'`), making invalid JSON escapes (`\U`, `\s`, …) → plugin failed to load (`JSON Parse error: Invalid escape character U`). **Fixed** by rewriting the command paths to double-quoted **forward-slash** form (`"C:/Users/<you>/.openlit/bin/openlit.exe"`) in all 3 copies:
   - `~/.claude/plugins/openlit-cc/hooks/hooks.json`
   - `~/.claude/plugins/cache/openlit/openlit-cc/0.1.0/hooks/hooks.json` (the loaded copy)
   - `~/.local/share/openlit/claude-marketplace/plugins/claude-code/hooks/hooks.json` (source)
   - ⚠️ **Re-running `openlit coding install --vendor=claude-code` will reintroduce this bug** — re-apply the fix if you reinstall. (Upstream bug worth reporting.)
2. **`openlit coding install` silent exit-1.** The CLI resolves its own path via `exec.LookPath("openlit")`; on Windows the binary is `openlit.exe`, so it isn't found unless `~/.openlit\bin` is on PATH. **Workaround used:** prepend that dir to PATH before running install. (A new terminal also fixes it.)

---

## Deviations from the original plan (all intentional)

- **GPU is AMD RX 7900 XTX (24 GB), not NVIDIA.** Ollama runs the judge on GPU via its **Vulkan** backend (ROCm logged "driver too old", but Vulkan works great). If you want the ROCm path, update AMD Adrenalin drivers — not required.
- **`OLLAMA_KEEP_ALIVE=30m`** (not the plan's `-1`) so the 20 GB model **unloads when idle and frees VRAM for VR/3D work**. Persisted as a user env var (+ `OLLAMA_HOST=0.0.0.0:11434`, `OLLAMA_CONTEXT_LENGTH=16384`).
- **Secrets live in `openlit/src/.env`** (not repo root) — that's where the compose `env_file` resolves. `TELEMETRY_ENABLED=false` set **inline in the compose** (it overrides `.env`). `.env` is git-ignored and excluded from the Docker build context.
  - ⚠️ **Back up `openlit/src/.env`** — losing `OPENLIT_VAULT_ENCRYPTION_KEY` makes stored Vault secrets unrecoverable.
- **`core.autocrlf`** handled per-clone (`git clone -c core.autocrlf=input`) instead of mutating global git config.
- Firewall rule for :11434 was **not needed** — the container reaches the host Ollama via `host.docker.internal` without it (verified).

---

## Remaining steps (require you — browser/UI)

1. **Log in & change password** — http://127.0.0.1:3000 → **`user@openlit.io` / `openlituser`** → Settings → Profile → change password.
2. **View your traces** — open `/coding-agents`; the test session above should already be visible.
3. **Phase 8 — local-judge evals (air-gapped):**
   - `/vault` → new secret, value = `ollama` (non-empty key is required; Ollama ignores it).
   - `/evaluations/settings` → Provider = **ollama** (if not listed, add via Manage Models; fallback = seed `default-models.ts` + rebuild), Model = **`qwen3-judge`** (see below), Secret = the vault secret. Enable auto + a `recurringTime` cron.
   - Run a **manual eval** on a captured trace and confirm a verdict appears.
   - ⚠️ **qwen3 thinking-mode.** `qwen3:30b-a3b` emits `<think>…</think>` that can break JSON parsing — use the non-thinking **`qwen3-judge`** variant as the eval model. **Note (learned later):** the Modelfile `SYSTEM "/no_think"` is *overridden* once a caller sends its own system message (as the eval/analysis prompts do), and Ollama's OpenAI-compat `/v1` endpoint ignores `think:false` / `chat_template_kwargs`, so on `/v1` the model can still think. The **AI trace-analysis** path was therefore moved to Ollama's **native `/api/chat`** with `think:false` + a JSON `format` schema (schema-valid output regardless of thinking). The eval path still relies on `qwen3-judge`; apply the same native-`/api/chat` treatment if you hit thinking-related parse issues there. It was built with:
     ```
     # Modelfile (already applied)
     FROM qwen3:30b-a3b
     SYSTEM "/no_think"
     ```
     `ollama create qwen3-judge -f Modelfile`. Both `qwen3:30b-a3b` and `qwen3-judge` share the same on-disk weights (no extra VRAM/disk).
   - **Air-gap check:** while an eval runs, confirm the only judge traffic is to `host.docker.internal:11434`.
4. *(Optional)* Phase 7 UI pricing — not needed; cost already populates from the CLI.

---

## Operating commands (PowerShell)

```powershell
$src = "C:\Users\<you>\Documents\VR_Development\utils\observability\openlit\src"
# status / stop / start
docker compose -p openlit -f "$src\dev-docker-compose.yml" --project-directory "$src" ps
docker compose -p openlit -f "$src\dev-docker-compose.yml" --project-directory "$src" stop
docker compose -p openlit -f "$src\dev-docker-compose.yml" --project-directory "$src" start
# health
openlit doctor
# query telemetry directly
$ch="http://localhost:8123/?user=default&password=OPENLIT"
Invoke-RestMethod -Uri $ch -Method Post -Body "SELECT SpanName,count() FROM openlit.otel_traces GROUP BY SpanName FORMAT TSV"
```

**Backup (stop stack first for consistency):**
```powershell
docker run --rm -v openlit_clickhouse-data:/data -v ${PWD}:/backup alpine tar czf /backup/clickhouse-backup.tgz /data
# also back up openlit\src\.env  (esp. OPENLIT_VAULT_ENCRYPTION_KEY)
```

**Local-judge patch reuse:** `openlit-implementation-plan.md` Phase 9 + `0001-Add-local-Ollama-judge-provider-for-air-gapped-evals.patch` (branch `local-ollama-judge`).

**NEVER** `docker compose ... down -v` (destroys all telemetry + vault).

---

## Note for the next session (verification nuance)

Synthetic hook invocations from a plain shell do **not** produce spans (the CLI's `claude-code` adapter no-ops unless `CLAUDECODE=1`, and a single fake `SessionEnd` without a real transcript yields nothing storable). **The authoritative test is a real `claude` session** (done above). Don't be misled by `openlit coding hook ... < fake.json` returning "shut down successfully" with no row — that's expected.
