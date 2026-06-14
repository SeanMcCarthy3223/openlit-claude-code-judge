# OpenLIT Implementation Plan â€” Local, Air-Gapped Claude Code CLI Observability

**Date:** 2026-06-13 Â· **Status:** `pending approval` (plan only â€” no execution performed)
**Target machine:** Windows 11 Pro Â· Docker Desktop (WSL2) Â· PowerShell Â· NVIDIA GPU (for the local judge)
**Working dir:** `C:\Users\<you>\Documents\VR_Development\utils\observability`
**Companion doc:** `claude-code-trace-monitoring-options.md` (the options analysis that led here)

---

## Decision summary

| Aspect | Decision |
|---|---|
| Platform | **OpenLIT** (Apache-2.0), self-hosted, **built from source** |
| Capture mechanism | OpenLIT CLI **coding-agent plugin** (7 Claude Code hooks â†’ `coding_agent.*` + `gen_ai.*` OTel spans). Native CC OTel exporter is an optional secondary signal (Phase 10). |
| Eval strategy | **Local Ollama judge** â€” patch OpenLIT so its built-in 11 LLM-as-judge evals call a local Ollama model; runs in the native UI, **fully air-gapped** |
| Constraint | **Data never leaves the machine.** Every network hop is `localhost`/`host.docker.internal`. |
| Requirements satisfied | rich span waterfalls Â· cost/token tracking Â· searchable history Â· output-quality evals â€” all local |

### Why build from source (not the prebuilt image)
OpenLIT's built-in evals only support cloud judge providers; there is no Ollama/custom-URL config switch. To keep evals local we apply **one** small code patch (`run-evaluation.ts`), which requires building the app image from the cloned source. The prebuilt `ghcr.io/openlit/openlit:latest` image cannot be configured for a local judge.

---

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Windows 11 host (PowerShell) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                                                                                          â”‚
â”‚  claude (Claude Code CLI)                                                                â”‚
â”‚     â”‚  fires 7 hooks per session â†’  openlit.exe coding hook --vendor=cc --event=...      â”‚
â”‚     â–¼                                                                                    â”‚
â”‚  openlit.exe  â”€â”€OTLP/HTTP :4318â”€â”€â–º  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Docker Desktop (WSL2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”‚
â”‚  (%USERPROFILE%\.openlit\bin)       â”‚  openlit container                              â”‚   â”‚
â”‚                                     â”‚   â€¢ Next.js UI            :3000                  â”‚   â”‚
â”‚  Ollama (native, judge model)       â”‚   â€¢ in-container OTel collector :4317/:4318     â”‚   â”‚
â”‚   http://localhost:11434/v1   â—„â”€â”€â”€â”€â”€â”¼â”€â”€â”€(judge calls via host.docker.internal:11434)  â”‚   â”‚
â”‚   OLLAMA_HOST=0.0.0.0:11434         â”‚   â€¢ cost/eval engine                            â”‚   â”‚
â”‚                                     â”‚  clickhouse container :8123/:9000 (telemetry)   â”‚   â”‚
â”‚                                     â”‚   volumes: openlit_clickhouse-data, _openlit-dataâ”‚  â”‚
â”‚                                     â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜  â”‚
â”‚  UI:  http://127.0.0.1:3000/coding-agents                                                â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
   No outbound internet required at runtime. (Internet needed once: git clone, docker build, ollama pull.)
```

**Three moving parts:** (1) the OpenLIT platform (Next.js app + in-container OTel collector + ClickHouse), built from source; (2) the OpenLIT CLI `openlit.exe`, which installs the Claude Code plugin/hooks; (3) Ollama running natively on Windows as the local eval judge.

---

## Phase 0 â€” Prerequisites

| Item | Requirement | Verify |
|---|---|---|
| Docker Desktop | Installed, WSL2 backend, **â‰¥8 GB RAM** allocated (source build of the Next.js app + Prisma is memory-hungry; runtime needs ~4 GB) | `docker version`; Docker Desktop â†’ Settings â†’ Resources |
| Disk | ~25 GB free (image build layers + ClickHouse telemetry growth) | â€” |
| Git | Installed | `git --version` |
| Git line endings | **`git config --global core.autocrlf input`** *(run BEFORE cloning â€” protects `*.sh`/`*.yaml` from CRLF corruption)* | `git config --global core.autocrlf` â†’ `input` |
| GPU | NVIDIA GPU for the Ollama judge (CPU works but is slow/unreliable for judging) | `nvidia-smi` |
| Claude Code | Installed and working (`claude`) | `claude --version` |
| Ports free | 3000, 4317, 4318, 8123, 9000 (OpenLIT) and 11434 (Ollama) not in use | `netstat -ano | findstr /R "3000 4317 4318 8123 9000 11434"` (`/R` treats them as separate patterns) |
| Docker engine | **WSL2 backend** â€” NOT Hyper-V / Windows-containers (the Linux image build and `host.docker.internal` depend on it) | Docker Desktop â†’ Settings â†’ General â†’ "Use the WSL 2 based engine" is checked |
| WSL2 disk room | Build layers + ClickHouse live in the WSL2 vhdx, not directly on `C:` â€” make sure it has headroom | Docker Desktop â†’ Settings â†’ Resources â†’ Disk image size |

> **Note on the Traces beta:** the plugin/hook path does **not** depend on Claude Code's `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` flag â€” OpenLIT builds spans from hook events, so the beta caveat only applies to the optional native-OTel complement in Phase 10.

**Acceptance:** all commands above succeed; `core.autocrlf` returns `input`; â‰¥8 GB allotted to Docker.

---

## Phase 1 â€” Clone & configure for a local build

```powershell
cd C:\Users\<you>\Documents\VR_Development\utils\observability
git config --global core.autocrlf input      # if not already done
git clone https://github.com/openlit/openlit.git
cd openlit
```

**1a. Pin a known-good revision (reproducibility).** `main` moves; record the commit you build:
```powershell
git rev-parse HEAD | Tee-Object ..\openlit-pinned-commit.txt
# Optional: git checkout <that-commit>  to freeze
```

**1b. Harden `.env` (repo root).** Edit these keys:
- `TELEMETRY_ENABLED=false`  â†’ disables OpenLIT's own anonymous usage telemetry (air-gap).
- `NEXTAUTH_SECRET=<generate a long random string>`
- `OPENLIT_VAULT_ENCRYPTION_KEY=<generate a 32+ char random string>`  â†’ **back this up**; losing it makes stored Vault secrets unrecoverable.
- Leave `PORT`/`DOCKER_PORT` (3000) and ClickHouse creds default unless a port conflicts.

Generate secrets in PowerShell:
```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

**1c. Verify a `.dockerignore` excludes `node_modules` and `.next`** (avoids shipping a huge Windows build context). If absent under `src/`, create one:
```
node_modules
.next
**/node_modules
```

**Acceptance:** repo cloned; `.env` shows `TELEMETRY_ENABLED=false` and non-default secrets; pinned commit recorded.

---

## Phase 2 â€” Apply the local-judge patch (the only source edit)

**File:** `src/client/src/lib/platform/evaluation/run-evaluation.ts`

**Verify-then-act first** (the path/structure are verified against the pinned commit but `main` can drift): confirm the file and shape before editing â€”
```powershell
cd C:\Users\<you>\Documents\VR_Development\utils\observability\openlit
git grep -n "function getModel" -- src/client            # locate getModel if the path moved
git grep -n "createOpenAI" -- src/client/src/lib/platform/evaluation/run-evaluation.ts  # confirm the import exists
```
**Edit:** in the `getModel()` provider `switch`, add a case immediately **before** `default:`. `createOpenAI` (from `@ai-sdk/openai`) is already imported â€” confirm via the grep above; if absent, add the import.

```ts
    case "ollama":
        return createOpenAI({
            baseURL: process.env.OLLAMA_BASE_URL ?? "http://host.docker.internal:11434/v1",
            apiKey: apiKey || "ollama",
        })(model);
```

Save the patch so rebuilds/updates can re-apply it cleanly:
```powershell
git checkout -b local-ollama-judge
git add -A; git commit -m "Add local Ollama judge provider for air-gapped evals"
git format-patch -1 -o ..\   # writes 0001-...patch next to the plan for re-use after a git pull
```

> **Why only this one patch:** the eval **provider/model list**, **`claude-opus-4-8` pricing**, and the **judge Vault secret** all live in the **persistent ClickHouse volume** and are added through the UI after launch (Phases 7â€“8). They survive image rebuilds, so they are *not* source edits. (Fallback if the UI won't accept a new provider name: seed `ollama` into `DEFAULT_PROVIDERS` + `DEFAULT_MODELS_BY_PROVIDER` in `src/client/src/lib/platform/providers/default-models.ts` before first build, mirroring the existing `anthropic`/`openai` entries â€” see Phase 8 note.)

**Acceptance:** the `case "ollama":` block is present before `default:`; a `.patch` file exists for reuse.

---

## Phase 3 â€” Build & launch the platform

Use the repo's existing build compose (`src/dev-docker-compose.yml` already has a `build:` context), and add the judge endpoint env var to the `openlit` service.

**Verify-then-act:** confirm `src/dev-docker-compose.yml` exists and its `openlit` service has a `build:` context (not just `image:`). If it doesn't, use the root-compose fallback below.

**3a.** In `src/dev-docker-compose.yml`, under the `openlit` service, add the judge endpoint **and** an explicit host-gateway mapping (portable; harmless on Docker Desktop, required on some engines):
```yaml
    environment:
      - OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
    extra_hosts:
      - "host.docker.internal:host-gateway"
```
*(Root-compose fallback: replace the `openlit` service's `image: ghcr.io/openlit/openlit:latest` with `build: { context: ./src, dockerfile: Dockerfile }` and add the same two keys.)*

> **Project name convention:** every compose command in this plan uses `-p openlit` so the volumes are predictably named **`openlit_clickhouse-data`** and **`openlit_openlit-data`**. Without `-p`, running from `src/` names them `src_*` instead â€” which would break the Phase 9 backup command. Always pass `-p openlit`.

**3b. Build & start:**
```powershell
cd src
docker compose -p openlit -f dev-docker-compose.yml up -d --build
# (do NOT add --profile full â€” that pulls sample apps/litellm we don't want)
```

**3c. Verify:**
```powershell
docker compose -p openlit -f dev-docker-compose.yml ps           # openlit + clickhouse = Up
curl http://127.0.0.1:3000                              # UI responds
Test-NetConnection 127.0.0.1 -Port 4318                 # OTLP HTTP listening
```
Open `http://127.0.0.1:3000`, log in with the seeded default credentials (**`user@openlit.io` / `openlituser`** at the time of research â€” if they differ, check the repo README/`.env` for the current seed), then **immediately change the password** (Settings â†’ Profile).

**Acceptance:** both containers `Up`; UI loads; login works; password changed; `:4318` reachable.

**Rollback for this phase:** `docker compose -p openlit -f dev-docker-compose.yml down` (keeps data) â€” see Phase 9 for full teardown. **Never** use `down -v` unless you intend to destroy all telemetry.

---

## Phase 4 â€” Install Ollama (the local judge)

**4a. Install natively on Windows** (recommended over a container â€” direct GPU access, no WSL2 GPU plumbing): download & run `OllamaSetup.exe` from https://ollama.com/download/windows.

**4b. Bind beyond loopback so the container can reach it.** Set a **user environment variable** (Ollama tray â†’ Quit â†’ Windows "Edit environment variables for your account"):
- `OLLAMA_HOST=0.0.0.0:11434`
- `OLLAMA_KEEP_ALIVE=-1`  (keep the model resident so scheduled evals don't cold-start-timeout â€” note this pins the model in VRAM; on a shared GPU box use a finite value like `30m` instead)
- `OLLAMA_CONTEXT_LENGTH=16384`  (default 4096 will silently truncate long Claude Code prompt+completion pairs)

Allow inbound TCP 11434 in Windows Defender Firewall (private network). Restart Ollama after setting env vars.

**4c. Pull a judge model** sized to your VRAM (bigger = more reliable judge; small models are noisy):

| VRAM | Suggested judge model | Note |
|---|---|---|
| ~8 GB | `ollama pull qwen2.5:7b` (or `llama3.1:8b`) | usable floor; treat scores as directional |
| ~16 GB | `ollama pull qwen2.5:14b` (or `mistral-small`) | sweet spot |
| 24 GB+ | `ollama pull qwen2.5:32b` (or `llama3.1:70b` q4) | closest to cloud-judge quality |

**4d. Verify from inside the OpenLIT container** (proves the judge path works end-to-end):
```powershell
docker compose -p openlit -f dev-docker-compose.yml exec openlit sh -lc "wget -qO- http://host.docker.internal:11434/v1/models || curl -s http://host.docker.internal:11434/v1/models"
```
Should list your pulled model. (If neither `wget` nor `curl` is in the image, test from the host instead: `curl http://localhost:11434/v1/models`, then trust the `extra_hosts` mapping from Phase 3a.)

**Acceptance:** `ollama list` shows the model; the in-container `wget` returns the model list; `OLLAMA_HOST=0.0.0.0:11434` confirmed.

---

## Phase 5 â€” Install the CLI & instrument Claude Code

**5a. Install the OpenLIT CLI (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/openlit/openlit/main/cli/scripts/install.ps1 | iex
```
Installs `openlit.exe` to `%USERPROFILE%\.openlit\bin` and adds it to the **user PATH**.

> **Supply-chain note:** this pipes a remote script straight to `iex` (run-on-trust). If you'd rather inspect first: `iwr -useb <url> -OutFile install.ps1`, read it, then `.\install.ps1`. This is a one-time online step; the runtime stays air-gapped.

**5b. âš  Open a NEW terminal** (PATH only refreshes in new shells), then:
```powershell
openlit --version
openlit configure --endpoint http://127.0.0.1:4318 --content-capture full
openlit configure --show          # confirm endpoint + capture mode
```
*(Config stored at `%APPDATA%\openlit\config.env`, mode 0600. `full` captures prompt/tool bodies â€” built-in 2-tier secret redaction scrubs API keys/tokens/PEM/JWT first. Use `metadata_only` if you'd rather not store prompt text in ClickHouse.)*

**5c. Instrument Claude Code:**
```powershell
openlit coding install --vendor=claude-code
```
Writes a Claude Code plugin to `~/.claude/plugins/openlit-cc/` (hooks.json wiring **SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, SessionEnd**, each calling `openlit coding hook --vendor=cc --event=...`; hooks **exit 0 on failure** so they never block you). Auto-registers via the `claude` CLI; if that fails, the command prints the manual `/plugin marketplace add â€¦` + `/plugin install openlit-cc@openlit` fallback.

**5d. âš  CRITICAL: restart the terminal AND fully restart Claude Code** so hook subprocesses inherit the updated PATH â€” otherwise hooks silently no-op (they exit 0). Then:
```powershell
openlit doctor
```

**Acceptance:** `openlit --version` works in a fresh shell; `openlit configure --show` shows `endpoint=http://127.0.0.1:4318`, `content-capture=full`; `~/.claude/plugins/openlit-cc/hooks.json` exists; `openlit doctor` reports healthy.

---

## Phase 6 â€” Verify end-to-end capture

Run a **real, multi-tool Claude Code session** (read a file, run a command, maybe spawn a subagent) so several span types are produced.

In the UI at `http://127.0.0.1:3000/coding-agents`, confirm:
- [ ] The session appears (vendor = claude-code), with session outcome.
- [ ] A **trace waterfall**: `coding_agent.session` â†’ `coding_agent.llm.turn` â†’ `coding_agent.tool.requested` / `coding_agent.tool.call`, with latency per span.
- [ ] **Token usage** populated (`gen_ai.usage.*`) per turn.
- [ ] **Prompt/completion text** visible (because `--content-capture full`), with secrets redacted.
- [ ] Tool calls (Bash/Edit/Read), edit decisions, and any subagent (`coding_agent.subagent`) nesting.

**Troubleshooting if nothing appears:** (a) PATH â€” re-open terminal + Claude Code, re-run `openlit doctor`; (b) endpoint â€” confirm `openlit configure --show`; (c) container â€” `docker compose ... ps` and `docker compose ... logs openlit`.

**Acceptance:** all six boxes checked for a live session.

---

## Phase 7 â€” Cost validation (`claude-opus-4-8`)

Your model `claude-opus-4-8` is **not** in OpenLIT's seeded pricing, so cost shows **$0** until added.

**7a. Find the exact model-id string the hooks emit:** open a captured `llm.turn`/`session` span and read the `gen_ai.request.model` attribute (it may be `claude-opus-4-8`, a `[1m]`/long-context variant, or a dated id â€” use whatever string actually appears).

**7b. Add pricing in the UI:** *Manage Models* (under providers) â†’ provider `anthropic` â†’ add model:
- `model_id` = the exact string from 7a
- **input = `5.0`, output = `25.0`** â€” **per MILLION tokens** (mirrors Opus 4.5â€“4.7). Adjust to current Anthropic list price if different.
- Add a second entry for any long-context/`[1m]` variant id if the spans report one.

This entry persists in the ClickHouse volume (survives rebuilds).

**7c. Re-run a session and confirm cost > $0** on the new spans (pricing applies going forward; historical $0 spans won't retro-update unless re-priced).

**Acceptance:** a fresh opus session shows non-zero USD cost per turn and aggregated per session.

---

## Phase 8 â€” Local-judge evals (air-gapped) + guardrails note

**8a. Create the judge Vault secret.** UI â†’ `/vault` â†’ new secret, **value = `ollama`** (a non-empty key is mandatory â€” the eval engine returns early on an empty key, but Ollama ignores the value).

**8b. Make `ollama` selectable & configure the eval.** UI â†’ `/evaluations/settings`:
- Provider = **ollama** *(if it isn't listed: add it via Manage Models / providers â€” `requiresVault: true`; fallback = seed `default-models.ts` per the Phase 2 note and rebuild)*
- Model = your pulled judge tag (e.g. `qwen2.5:14b`)
- Secret = the Vault secret from 8a
- Enable **auto** + set a `recurringTime` cron to scan ingested traces (Claude Code hook traces are eligible).

**8c. Run a manual eval & view the result.** In the UI open a captured trace, trigger an evaluation (the "Run evaluation"/evaluations action on the trace or the `/evaluations` page), then view the verdict where scores surface â€” on the `/evaluations` results view and/or attached to the trace/span as scores (hallucination/bias/toxicity/relevance). Confirm a numeric/label score appears and that it was produced by the local model (cross-check Ollama received a request in 8d).

**8d. Air-gap verification (important):** while an eval runs, confirm the only outbound judge traffic is to `host.docker.internal:11434`. Quick checks:
```powershell
# watch Ollama receive the judge request (its log/tray), and:
docker compose -p openlit -f dev-docker-compose.yml logs -f openlit   # should show eval hitting the ollama base URL
```
No traffic should leave the machine. (If you ever switch a provider to a cloud one, evals WILL egress â€” keep provider = ollama.)

> **Honest framing â€” air-gap is by convention, not enforced.** Nothing in this setup *blocks* outbound traffic; the guarantee rests on "no component is configured to call the cloud" (telemetry off, eval provider = ollama, local OTLP). 8d *detects* egress, it doesn't *prevent* it. If you want a hard guarantee, add an OS/Docker egress firewall rule allowing the `openlit` container only `host.docker.internal:11434` + loopback, and deny the rest.

**8e. Guardrails (scope note, not a blocker).** OpenLIT's local guardrails (PII/prompt-injection/moderation/topic, zero-egress regex+callable) are a **Python SDK** feature that runs in *your own* code â€” they do **not** auto-scan CLI hook traces. For the Claude Code CLI, the local-Ollama **eval cron (8b)** is the quality layer. Revisit guardrails only if you later instrument your own Python agents.

> **Caveat â€” judge reliability & eval-field mapping:** (1) small local models are weaker, noisier judges than a cloud model â€” size up if scores look off; treat them as directional. (2) Verify the auto-eval actually extracts a prompt+response pair from the `coding_agent.*` span shape (vs a standard `gen_ai` LLM span). If evals don't populate for hook traces, fall back to evaluating the optional native-OTel `llm_request` spans (Phase 10) or run a manual eval to confirm field mapping.

**Acceptance:** a manual eval produces a verdict using the local model; auto-eval cron is enabled; verified no off-machine traffic during evaluation.

---

## Phase 9 â€” Hardening & operations

| Concern | Action |
|---|---|
| **Persistence** | Telemetry lives in named volume `clickhouse-data`; app state in `openlit-data`. They survive `down`/restart. **Never** `docker compose down -v` (destroys both). |
| **Backups** | First confirm the real volume names (`docker volume ls | findstr clickhouse`). With `-p openlit` they are `openlit_clickhouse-data` / `openlit_openlit-data`. Then (stop the stack first for consistency): `docker run --rm -v openlit_clickhouse-data:/data -v ${PWD}:/backup alpine tar czf /backup/clickhouse-backup.tgz /data`. Also back up `.env` and especially `OPENLIT_VAULT_ENCRYPTION_KEY` (losing it makes Vault secrets unrecoverable). |
| **Retention** | ClickHouse telemetry grows unbounded â€” set a retention/TTL or periodically prune old traces (UI data-retention if available, or a ClickHouse TTL on the spans table). |
| **Secrets / redaction** | Keep `--content-capture full` only if you accept prompt/completion text stored locally (redaction scrubs common secrets). Switch to `metadata_only` to stop storing bodies. |
| **Start/stop** | `docker compose -p openlit -f dev-docker-compose.yml stop` / `start`. Enable Docker Desktop "start on login" + the compose `restart: unless-stopped` policy for always-on capture. |
| **Updates** | Re-base the patch branch onto the new upstream, don't `git am` onto the old branch (it'll fail "patch does not apply"): `git checkout main; git pull; git checkout -B local-ollama-judge main; git am ..\0001-*.patch` (on conflict: `git am --abort`, then just re-edit the one-line `case "ollama"` by hand). Then `docker compose -p openlit -f dev-docker-compose.yml up -d --build`. UI-added providers/models/pricing persist in the ClickHouse volume (one-shot seed migrations won't re-run â€” use the UI for additions on an existing DB). |

### Rollback / uninstall (clean)
```powershell
# 1. Remove Claude Code instrumentation
openlit coding uninstall --vendor=claude-code --purge   # --purge also drops config + session cache
# 2. Stop platform (keep data)         OR   destroy everything
docker compose -p openlit -f dev-docker-compose.yml down            #    docker compose -p openlit -f dev-docker-compose.yml down -v
# 3. Remove the CLI
Remove-Item -Recurse -Force "$env:USERPROFILE\.openlit"
#    (then remove %USERPROFILE%\.openlit\bin from user PATH via env-var editor)
# 4. Remove the Claude Code plugin dir if it lingers
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\plugins\openlit-cc"
# 5. (optional) uninstall Ollama via Windows "Apps & features"
```

**Acceptance:** documented backup command runs; `restart: unless-stopped` set; uninstall steps validated to remove hooks (re-run a Claude Code session â†’ no new spans).

---

## Phase 10 (optional) â€” Native Claude Code OTel complement

A secondary signal, **off by default** (some duplication with the plugin path; not normalized to `coding_agent.*` so it won't enrich the `/coding-agents` dashboards). Useful if you also want Anthropic's official metric/event semantics or want eval spans in the standard `gen_ai.llm_request` shape. Add to `%USERPROFILE%\.claude\settings.json` under `"env"`:
```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
  }
}
```
Caveat: Claude Code's trace export is **beta** (span names/attributes may change); content is redacted unless you add `OTEL_LOG_USER_PROMPTS=1` / `OTEL_LOG_TOOL_DETAILS=1` / `OTEL_LOG_TOOL_CONTENT=1`.

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Hooks silently no-op (`openlit` not on PATH for hook subprocess) | High | Restart terminal **and** Claude Code after install; `openlit doctor`; Phase 6 check |
| CRLF corrupts `*.sh`/`*.yaml` on Windows | Med | `git config --global core.autocrlf input` **before** clone |
| Source build OOMs | Med | Give Docker Desktop â‰¥8 GB; ensure `.dockerignore` excludes `node_modules`/`.next` |
| Cost shows $0 (unknown model id) | High (initially) | Phase 7: read exact `gen_ai.request.model`, add per-million pricing in UI |
| Eval accidentally egresses (cloud provider selected) | Med | Keep eval provider = `ollama`; Phase 8d traffic check; dummy Vault key |
| Judge patch lost on update | Med | Keep as a git branch + `.patch`; re-apply via `git am` |
| Local judge unreliable / noisy scores | Med | Use largest VRAM tier; raise `OLLAMA_CONTEXT_LENGTH`; treat scores as directional |
| Ollama cold-start timeouts on scheduled evals | Med | `OLLAMA_KEEP_ALIVE=-1`; pre-`ollama pull` |
| Eval field-mapping mismatch on `coding_agent.*` spans | Lowâ€“Med | Phase 8 caveat: confirm with a manual eval; fall back to native-OTel `llm_request` spans |
| `host.docker.internal` unreachable | Low | Set `OLLAMA_HOST=0.0.0.0:11434` + firewall allow; or run Ollama as sibling container |
| ClickHouse disk growth | Med (over time) | Phase 9 retention/TTL + periodic prune |

---

## Overall acceptance criteria (definition of done)

- [ ] OpenLIT platform built **from source** and running locally; default password changed; `TELEMETRY_ENABLED=false`.
- [ ] Claude Code instrumented; a live session produces a **rich span waterfall** with tokens, prompt/completion text (redacted secrets), tool calls, and subagent nesting at `/coding-agents`.
- [ ] **Cost > $0** for `claude-opus-4-8` sessions (pricing added per-million in UI).
- [ ] **Searchable history**: traces filterable in the UI; ClickHouse SQL available for advanced queries.
- [ ] **Local-judge evals** produce verdicts via Ollama with **verified zero off-machine traffic**.
- [ ] Backup command works; `restart: unless-stopped` set; uninstall path validated.

---

## Open items to verify during execution (flagged, low-risk)
1. Whether the eval **provider dropdown** accepts a newly-added `ollama` via the UI, or needs the `default-models.ts` seed + rebuild (Phase 2/8 fallback documented).
2. Whether **auto-eval** correctly maps prompt/response fields from `coding_agent.*` spans (Phase 8 caveat; manual-eval confirmation).
3. Exact `gen_ai.request.model` string(s) emitted for opus on the `[1m]` profile (Phase 7a).
4. Current Anthropic list price for Opus 4.8 (plan uses $5 / $25 per-million as a placeholder mirroring 4.7).

---

### Revision log (adversarial critic pass)
Applied after a critic review: (1) **[critical]** pinned Compose project name `-p openlit` everywhere and corrected the backup to the real volume `openlit_clickhouse-data` (the original `clickhouse-data` would have backed up nothing); (2) spelled out the `git am` re-base/re-apply flow with `--abort` recovery; (3) added `extra_hosts: host.docker.internal:host-gateway` to the service; (4) added a Phase 0 WSL2-backend + WSL2-disk check and fixed the port-scan `findstr /R`; (5) converted repo-internal assertions (file path, build context, login creds) to verify-then-act steps; (6) added the eval-result viewing walkthrough; (7) honest framing that the air-gap is by convention (with an optional enforced-egress-block note); (8) flagged the `iwr|iex` run-on-trust step; (9) `OLLAMA_KEEP_ALIVE` shared-GPU tradeoff and a `wget`/`curl` fallback. One sequencing question was cleared: building the platform (Phase 3) before Ollama is up (Phase 4) is fine â€” `OLLAMA_BASE_URL` is read at eval time, not boot.

### Provenance
Built on primary-source research verified by subagents against: official Claude Code docs (`code.claude.com/docs/en/monitoring-usage`, `/agent-sdk/observability`), the `openlit/openlit` repo source (`docker-compose.yml`, `src/dev-docker-compose.yml`, `src/Dockerfile`, `run-evaluation.ts`, `default-models.ts`, `cli/internal/coding/*`, `cli/scripts/install.ps1`), `docs.openlit.io`, and Ollama docs (`docs.ollama.com` OpenAI-compatibility / Windows / Docker). Full option comparison in `claude-code-trace-monitoring-options.md`.
