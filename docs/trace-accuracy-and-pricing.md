# Trace accuracy & cache-pricing — verification tooling + fixes

**Date:** 2026-06-14 · **Status:** reconciler shipped & proven; pricing recompute fixed (cache-aware) + guarded; one data-cleanup + one optional UI enhancement remain.

This work answers two questions:
1. *"Is the trace tool's token/cost capture correct, and how do I confirm it against Claude Code's own numbers?"* → **`reconcile_session.py`** (below).
2. *"Is the cache math right? When I added opus-4-8 in Manage Models it only asked for input + output cost."* → **Yes now** — the server recompute is cache-aware (fix below), and the everyday dashboard numbers were already correct (they sum the cache-aware cost the CLI stamps).

---

## TL;DR for the cache concern

- The **CLI hook** (`cli/internal/coding/pricing/pricing.go`) prices opus-4-8 correctly: input **$5**, output **$25**, cache-read **$0.50**, cache-write **$6.25** per 1M, **flat (no >200k premium)**. It stamps `gen_ai.usage.cost` on every turn at capture.
- The **dashboard** (chip, sessions list, subagent breakdown, hierarchy) **sums that stamped cost** — so the numbers you see were already cache-correct.
- The bug was only in the **server recompute** path (`src/client/.../lib/platform/pricing/index.ts`): it priced the cache-*inclusive* `input_tokens` entirely at the input rate, because the model schema only stores input+output rates (so Manage Models only asked you for two prices). On the big session that recompute would give **$202.45 vs the correct $41.58 (~4.9×)**.
- The recompute only fires via the manual **"Recalculate cost"** button or a cron backfill of an un-costed span — it does **not** affect normal display. **Until you rebuild, don't click Recalculate on opus-4-8 turns.** (After the rebuild it's safe.)

What was fixed (this session):
- **Guard:** `setPricingForSpanId` now refuses to overwrite a span that already carries a captured cost (the CLI/vendor cost is authoritative). Stops the only path that could corrupt data.
- **Cache-aware recompute:** `computeCostForTrace` now splits fresh / cache-read / cache-write and prices each tier. When a model has no explicit cache rates configured it falls back to Anthropic's published multipliers (read 0.1×, write 1.25× of input) — so opus-4-8 prices correctly **even though Manage Models only stored input+output**.
- Verified: `npm test` on `pricing.test.ts` → **20/20 pass** (3 new: guard no-op, cache-aware with explicit rates, cache-aware via fallback).

---

## `reconcile_session.py` — confirm capture is correct

Reads the **raw Claude Code transcript** (the same `usage` blocks `/context` and the per-turn cost line come from) as ground truth, recomputes the canonical 4-way token split + cost with the verified `cc_pricing.py` oracle, pulls what OpenLIT stored in ClickHouse, and prints **PASS/FAIL** with the arithmetic expanded. Read-only; never writes.

```bash
cd utils/observability
python reconcile_session.py --list                  # sessions in the store, by token volume
python reconcile_session.py --session-id <uuid>     # full reconciliation
python reconcile_session.py --session-id <uuid> --json   # machine-readable
```

Checks (each PASS/FAIL):
1. **token identity** — fresh+cache_read+cache_creation == input(incl cache); input+output == total (transcript *and* store).
2. **store cost identity** — every stored span's cost == a cache-aware recompute from its own tokens. **A mismatch = a span re-priced cache-blind by the UI** (the corruption scan). Currently clean on real sessions.
3. **truth vs store** — transcript totals vs stored totals (per-agent), within tolerance. Catches gross double-counts.
4. **coverage** — every transcript requestId has a captured span (catches a dropped post-workflow tail); flags orphans.
5. **no double-count** — confirms totals are leaf-sum and a `coding_agent.session` root (if any) is excluded.
6. **tool dedupe / async taxonomy** — `tool.requested` (PreToolUse markers) vs `tool.call` (real); main vs workflow-subagent vs user_prompt markers.
- Plus a non-gating **WARN** for duplicate stored rows (one API request stored >1×).

### Accounting conventions (the load-bearing traps)
- Transcript `usage.input_tokens` is **FRESH-ONLY**; combined = input + cache_read + cache_creation.
- Stored `gen_ai.usage.input_tokens` is **already cache-inclusive** — do NOT re-add cache.
- Stored cache keys are the **dotted** form: `gen_ai.usage.cache.read_input_tokens` / `…cache.creation_input_tokens`.
- Coalesce transcript fragments **globally by requestId, last-fragment-wins** (never sum — sum triple-counts).
- Session total = sum of `coding_agent.llm.turn` leaves; exclude the `coding_agent.session` root.

### What it found
- `cf434b8f` (the big NW-wave run): **ALL PASS** + 1 warning. True numbers: **39.18M input(incl cache) / 39.45M total / $41.58** (the reviewer's "~38M / ~$36" was a low estimate). Main agent reconciles to the cent; ~0.2% subagent drift (output undercount + 1 duplicate aa0ff turn = the CLI subagent-capture bug, see P4).
- `ec9f08dd` (historically backfilled): **FAIL** — 274 turn rows vs 137 distinct requests; the **backfill-inserted rows now coexist with forward-capture rows → this session is double-counted** (~$3.61 stored vs ~$2.03 true). Fix: delete the `coding_agent.backfill_source='subagent-transcript-v1'` rows (forward capture covers them now).

---

## `cc_pricing.py` — the pricing oracle

Faithful Python port of `pricing.go` with a self-test (`python cc_pricing.py`) that proves the opus-4-8 cache arithmetic and demonstrates the cache-blind over-bill. Single source of truth used by `reconcile_session.py`.

---

## Deploy the pricing fix

The recompute fix is in the Next.js client, which the docker image bakes (no hot reload):

```powershell
$src = "C:\Users\seanm\Documents\VR_Development\utils\observability\openlit\src"
docker compose -p openlit -f "$src\dev-docker-compose.yml" --project-directory "$src" up -d --build openlit
```

No ClickHouse migration is needed for this fix (it reads span attributes + optional model fields). Existing data is untouched and was never corrupted (the corruption scan is clean).

---

## Optional follow-up — let Manage Models capture explicit cache rates

The fix above makes opus-4-8 (and any Anthropic model) correct via the published-multiplier fallback, so this is **optional** — only needed if you want to set explicit/contract cache rates per model or fix cache pricing for non-Anthropic vendors. It is a coupled schema change (needs a ClickHouse `ALTER TABLE ADD COLUMN` migration + docker rebuild), so it was not shipped half-verified. Exact edits, in order:
1. **Migration** — new `add-provider-cache-rates-migration.ts` (model it on an existing `add-*-migration.ts`): `ALTER TABLE openlit_provider_models ADD COLUMN IF NOT EXISTS cache_read_price_per_m_token Float64 DEFAULT 0, ADD COLUMN IF NOT EXISTS cache_creation_price_per_m_token Float64 DEFAULT 0`; register it in `clickhouse/migrations/index.ts`.
2. **`create-providers-migration.ts`** — add the two columns to the fresh-install DDL (after `output_price_per_m_token`, ~line 85).
3. **`provider-registry.ts`** — add the two columns to the SELECT + map in `loadAllModelsFromDb` (~99-122) and `loadProviderModelsFromDb` (~137-155): `cache_read_price_per_m_token as cacheReadPricePerMToken`, etc.; map `Number(row.cacheReadPricePerMToken) || 0`.
4. **`models-service.ts`** — `createCustomModel` insert values + its SELECT (~107, 131), `updateCustomModel` fields (~179).
5. **`model-editor-panel.tsx`** — two inputs after `output-price` (~line 259) + `en.ts` labels ("Cache Read Price (per 1M tokens)", "Cache Write Price (per 1M tokens)").
6. **`default-models.ts`** — seed Anthropic models' cache rates (opus-4-8: 0.50 / 6.25; haiku-4-5: 0.10 / 1.25; sonnet-4: 0.30 / 3.75).
7. **types** — already done (`ModelMetadata` + `CustomModelInput` carry optional `cacheReadPricePerMToken` / `cacheCreationPricePerMToken`).

⚠️ Ship 1–6 together and run the migration **before** the new client serves traffic — the registry SELECT references the new columns, so the column must exist first.

---

## Known residual (CLI subagent capture — needs Go rebuild)

`reconcile_session.py` surfaces a ~0.2% stored-vs-truth drift localized to subagents on `cf434b8f`: the CLI subagent turn capture (a) sometimes records an interim streaming fragment's output (undercount) and (b) emitted one duplicate turn (`aa0ff`, same requestId twice). The main-agent path is exact. Fix in `cli/internal/coding/hook/claudecode/subagents.go`: take the final fragment's usage and dedupe by requestId. Use `reconcile_session.py` as the acceptance gate (it should then PASS to the cent on subagents too).

All span durations are 0 by construction (`StartedAt==EndedAt`); `reconcile_session.py` ignores `Duration`. If latency is ever wanted, capture real Pre/PostToolUse timestamps in the CLI.
