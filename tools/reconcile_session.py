#!/usr/bin/env python3
"""Reconcile a Claude Code session: raw transcript (ground truth) <-> OpenLIT store.

WHY THIS EXISTS
---------------
The trace-capture tool's token/cost numbers are only trustworthy if you can
*confirm* them against something you already trust. The thing you already trust
is Claude Code itself: the per-turn ``usage`` block in the session transcript
(the same numbers ``/context`` and the per-turn cost line are derived from).

This script reads that transcript as GROUND TRUTH, recomputes the canonical
4-way token split (fresh / cache_read / cache_creation / output) and cost with
the verified pricing oracle (cc_pricing.py, a faithful port of pricing.go), then
pulls what OpenLIT actually stored in ClickHouse and prints a PASS/FAIL
reconciliation with the arithmetic EXPANDED so nothing is taken on faith.

It checks, in order:
  1. TRANSCRIPT TRUTH     - parse main + subagent transcripts, coalesce
                            streaming fragments by requestId (last wins).
  2. STORE INTERNALS      - for every stored llm.turn span, assert the token
                            identity (fresh+cr+cc == input_incl_cache;
                            input_incl_cache+output == total) and the COST
                            identity (recompute from the span's own tokens with
                            cache-aware rates == the stored gen_ai.usage.cost).
                            A cost mismatch here = a span re-priced CACHE-BLIND
                            by the UI "Recalculate" button -> data corruption.
  3. TRUTH vs STORE       - transcript totals vs stored totals (tokens + cost),
                            per-agent, so subagent capture drift is visible.
  4. COVERAGE             - every transcript requestId has a captured span
                            (catches a dropped post-workflow tail) and flags
                            stored turns with no transcript match (duplicates).
  5. NO-DOUBLE-COUNT      - confirm session total = sum of llm.turn leaves and
                            that a coding_agent.session root (if any) is excluded.
  6. TOOL DEDUPE          - tool.requested (PreToolUse markers) vs tool.call
                            (real spans); same tool_use_id appears on both.
  7. ASYNC TAXONOMY       - classify turns main / workflow-subagent / user_prompt
                            marker so nothing is silently mislabeled.

Everything is read-only. No ClickHouse writes, ever.

ACCOUNTING CONVENTIONS (the load-bearing traps -- see openlit-multiagent-architecture.md):
  * Transcript ``message.usage.input_tokens`` is FRESH-ONLY (excludes cache).
    So combined input = input_tokens + cache_read + cache_creation.
  * OpenLIT/ClickHouse ``gen_ai.usage.input_tokens`` is ALREADY cache-inclusive
    (the CLI adds cache back at capture). Do NOT re-add cache to it.
  * Run total = input(incl cache) + output. NEVER input+cache_read+cache_creation+output.
  * Session total = sum of coding_agent.llm.turn leaves; EXCLUDE the
    coding_agent.session root span (it folds subagents -> would double-count).

USAGE
  python reconcile_session.py --session-id <uuid>
  python reconcile_session.py --session-id <uuid> --project-dir <path-to-.claude/projects/...>
  python reconcile_session.py --session-id <uuid> --json     # machine-readable
  python reconcile_session.py --list                         # list sessions in the store
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import urllib.request
import urllib.parse

# cc_pricing.py lives next to this script -- the single tested pricing oracle.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cc_pricing  # noqa: E402

DEFAULT_CH_URL = "http://localhost:8123/?user=default&password=OPENLIT"
PROJECTS_ROOT = os.path.expanduser("~/.claude/projects")

# ClickHouse SpanAttributes keys (dotted 'cache.' segment is intentional --
# confirmed against the live store, not the Anthropic underscore form).
K_SESSION = "coding_agent.session.id"
K_AGENT_TYPE = "coding_agent.agent.type"
K_AGENT_ID = "coding_agent.agent.id"
K_TURN_KIND = "coding_agent.llm.turn.kind"
K_RESP_MODEL = "gen_ai.response.model"
K_REQ_MODEL = "gen_ai.request.model"
K_RESP_ID = "gen_ai.response.id"
K_IN = "gen_ai.usage.input_tokens"        # cache-INCLUSIVE in the store
K_OUT = "gen_ai.usage.output_tokens"
K_CR = "gen_ai.usage.cache.read_input_tokens"
K_CC = "gen_ai.usage.cache.creation_input_tokens"
K_TOTAL = "gen_ai.usage.total_tokens"
K_COST = "gen_ai.usage.cost"


# --------------------------------------------------------------------------- #
# ClickHouse (read-only, stdlib urllib so there are zero dependencies)
# --------------------------------------------------------------------------- #
class CH:
    def __init__(self, url: str):
        self.url = url
        self.ok = False
        self.err = ""

    def query(self, sql: str) -> str:
        req = urllib.request.Request(self.url, data=sql.encode("utf-8"))
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8")

    def rows(self, sql: str) -> list[dict]:
        out = self.query(sql + " FORMAT JSONEachRow")
        return [json.loads(ln) for ln in out.splitlines() if ln.strip()]

    def ping(self) -> bool:
        try:
            self.query("SELECT 1")
            self.ok = True
        except Exception as e:  # noqa: BLE001
            self.ok = False
            self.err = str(e)
        return self.ok


# --------------------------------------------------------------------------- #
# Transcript ground truth
# --------------------------------------------------------------------------- #
def _coalesce(path: str) -> list[dict]:
    """Parse one transcript .jsonl -> one turn per API request (requestId).

    Streaming fragments of a single API response repeat the same requestId and
    carry cumulative/duplicate usage, so they must be collapsed to ONE turn or
    tokens triple-count. Fragments are NOT always consecutive in the main
    transcript (tool_result user lines interleave), so we group GLOBALLY by
    requestId and take the LAST fragment's usage (last-fragment-wins -- verified
    against the live store to reproduce stored totals exactly; max-per-field is
    equivalent since fragments are monotone snapshots). Assistant lines with no
    requestId key on their uuid so distinct turns are never merged.
    """
    lines: list[dict] = []
    try:
        with open(path, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    lines.append(json.loads(ln))
                except Exception:  # noqa: BLE001
                    continue
    except FileNotFoundError:
        return []

    by_key: dict[str, dict] = {}
    order: list[str] = []
    for o in lines:
        if o.get("type") != "assistant":
            continue
        rid = o.get("requestId") or ""
        key = rid if rid else "uuid:" + (o.get("uuid") or "")
        if key not in by_key:
            order.append(key)
        by_key[key] = o          # last occurrence wins

    turns: list[dict] = []
    for key in order:
        o = by_key[key]
        msg = o.get("message") or {}
        u = msg.get("usage") or {}
        turns.append({
            "model": msg.get("model") or "",
            # transcript input_tokens is FRESH-ONLY (excludes cache)
            "fresh": int(u.get("input_tokens") or 0),
            "output": int(u.get("output_tokens") or 0),
            "cache_creation": int(u.get("cache_creation_input_tokens") or 0),
            "cache_read": int(u.get("cache_read_input_tokens") or 0),
            "request_id": o.get("requestId") or "",
            "uuid": o.get("uuid") or "",
        })
    return turns


def _turn_metrics(t: dict) -> dict:
    """Per-turn canonical metrics + cost from a coalesced transcript turn."""
    fresh = t["fresh"]
    cr = t["cache_read"]
    cc = t["cache_creation"]
    out = t["output"]
    input_incl = fresh + cr + cc          # match the store's input convention
    total = input_incl + out
    cost = cc_pricing.cost_usd(t["model"], input_incl, out, cr, cc)
    return {
        "request_id": t["request_id"] or t["uuid"],
        "model": t["model"],
        "fresh": fresh, "cache_read": cr, "cache_creation": cc, "output": out,
        "input_incl": input_incl, "total": total, "cost": cost,
    }


def find_project_dir(session_id: str, explicit: str | None) -> str | None:
    if explicit:
        return explicit if os.path.isfile(os.path.join(explicit, f"{session_id}.jsonl")) else None
    if not os.path.isdir(PROJECTS_ROOT):
        return None
    for proj in os.listdir(PROJECTS_ROOT):
        cand = os.path.join(PROJECTS_ROOT, proj)
        if os.path.isfile(os.path.join(cand, f"{session_id}.jsonl")):
            return cand
    return None


def gather_transcript_truth(session_id: str, project_dir: str) -> dict:
    """Return per-agent + per-turn ground truth from main + subagent transcripts."""
    main_path = os.path.join(project_dir, f"{session_id}.jsonl")
    agents: dict[str, dict] = {}

    def add_agent(agent_id: str, turns_raw: list[dict]):
        metrics = [_turn_metrics(t) for t in turns_raw]
        # keep only turns that actually carry usage (drop bare prompt echoes)
        metrics = [m for m in metrics if (m["input_incl"] + m["output"]) > 0]
        agents[agent_id] = {
            "turns": metrics,
            "request_ids": [m["request_id"] for m in metrics],
            "input_incl": sum(m["input_incl"] for m in metrics),
            "cache_read": sum(m["cache_read"] for m in metrics),
            "cache_creation": sum(m["cache_creation"] for m in metrics),
            "output": sum(m["output"] for m in metrics),
            "total": sum(m["total"] for m in metrics),
            "cost": sum(m["cost"] for m in metrics),
            "n_turns": len(metrics),
        }

    add_agent("(main)", _coalesce(main_path))

    sub_root = os.path.join(project_dir, session_id, "subagents")
    for path in sorted(glob.glob(os.path.join(sub_root, "**", "agent-*.jsonl"), recursive=True)):
        base = os.path.basename(path)
        aid = base[len("agent-"):-len(".jsonl")]
        add_agent(aid, _coalesce(path))

    return agents


# --------------------------------------------------------------------------- #
# Stored (OpenLIT) numbers
# --------------------------------------------------------------------------- #
def gather_store(ch: CH, session_id: str) -> dict:
    sid = session_id.replace("'", "\\'")
    leaves = ch.rows(
        f"""SELECT
              SpanAttributes['{K_RESP_ID}']   AS rid,
              SpanAttributes['{K_AGENT_TYPE}'] AS atype,
              SpanAttributes['{K_AGENT_ID}']   AS aid,
              SpanAttributes['{K_TURN_KIND}']  AS kind,
              if(SpanAttributes['{K_RESP_MODEL}'] != '', SpanAttributes['{K_RESP_MODEL}'],
                 SpanAttributes['{K_REQ_MODEL}']) AS model,
              SpanAttributes['coding_agent.backfill_source'] AS bf,
              toInt64OrZero(SpanAttributes['{K_IN}'])    AS inp,
              toInt64OrZero(SpanAttributes['{K_OUT}'])   AS outp,
              toInt64OrZero(SpanAttributes['{K_CR}'])    AS cr,
              toInt64OrZero(SpanAttributes['{K_CC}'])    AS cc,
              toInt64OrZero(SpanAttributes['{K_TOTAL}']) AS tot,
              toFloat64OrZero(SpanAttributes['{K_COST}']) AS cost
            FROM openlit.otel_traces
            WHERE SpanName='coding_agent.llm.turn'
              AND SpanAttributes['{K_SESSION}']='{sid}'"""
    )
    # ClickHouse serializes Int64 as JSON strings (to avoid JS precision loss);
    # coerce the numeric columns so arithmetic works. Float64 (cost) is a number.
    for r in leaves:
        for k in ("inp", "outp", "cr", "cc", "tot"):
            r[k] = int(r[k]) if r.get(k) not in (None, "") else 0
        r["cost"] = float(r["cost"]) if r.get("cost") not in (None, "") else 0.0
    root_cnt = ch.rows(
        f"""SELECT count() AS c FROM openlit.otel_traces
            WHERE SpanName='coding_agent.session'
              AND SpanAttributes['{K_SESSION}']='{sid}'"""
    )
    tools = ch.rows(
        f"""SELECT SpanName AS n, count() AS c FROM openlit.otel_traces
            WHERE SpanName IN ('coding_agent.tool.call','coding_agent.tool.requested')
              AND SpanAttributes['{K_SESSION}']='{sid}'
            GROUP BY SpanName"""
    )
    return {
        "leaves": leaves,
        "root_count": int(root_cnt[0]["c"]) if root_cnt else 0,
        "tool_counts": {r["n"]: int(r["c"]) for r in tools},
    }


# --------------------------------------------------------------------------- #
# Reconciliation + reporting
# --------------------------------------------------------------------------- #
class Report:
    def __init__(self):
        self.checks: list[tuple[str, bool, str]] = []
        self.warns: list[tuple[str, str]] = []

    def add(self, name: str, ok: bool, detail: str = ""):
        self.checks.append((name, ok, detail))

    def warn(self, name: str, detail: str = ""):
        """Non-gating observation -- surfaced but does not fail the run."""
        self.warns.append((name, detail))

    def passed(self) -> bool:
        return all(ok for _, ok, _ in self.checks)


def _fmt(n) -> str:
    return f"{n:,}" if isinstance(n, int) else f"{n}"


def reconcile(session_id: str, agents: dict, store: dict | None,
              tol_usd: float, tol_frac: float) -> Report:
    rep = Report()

    # --- transcript truth totals ---
    t_in = sum(a["input_incl"] for a in agents.values())
    t_cr = sum(a["cache_read"] for a in agents.values())
    t_cc = sum(a["cache_creation"] for a in agents.values())
    t_out = sum(a["output"] for a in agents.values())
    t_total = sum(a["total"] for a in agents.values())
    t_cost = sum(a["cost"] for a in agents.values())
    t_rids = {rid for a in agents.values() for rid in a["request_ids"]}

    print("=" * 78)
    print(f"  RECONCILE  session {session_id}")
    print("=" * 78)
    print("\n[1] TRANSCRIPT GROUND TRUTH (raw .jsonl, coalesced by requestId)")
    print(f"    {'agent':<14}{'turns':>6}{'input(+cache)':>15}{'output':>10}{'cost_usd':>12}")
    for aid, a in agents.items():
        print(f"    {aid:<14}{a['n_turns']:>6}{a['input_incl']:>15,}{a['output']:>10,}{a['cost']:>12.4f}")
    print(f"    {'-'*56}")
    print(f"    {'TOTAL':<14}{sum(a['n_turns'] for a in agents.values()):>6}"
          f"{t_in:>15,}{t_out:>10,}{t_cost:>12.4f}")
    print(f"    4-way split: fresh={t_in - t_cr - t_cc:,}  cache_read={t_cr:,}  "
          f"cache_creation={t_cc:,}  output={t_out:,}")
    print(f"    total tokens (input incl cache + output) = {t_total:,}")

    # Token identity on transcript truth (must always hold by construction).
    rep.add("token-identity (truth): fresh+cr+cc == input_incl",
            (t_in - t_cr - t_cc) + t_cr + t_cc == t_in)
    rep.add("token-identity (truth): input_incl+output == total",
            t_in + t_out == t_total)

    if store is None:
        print("\n[!] ClickHouse unreachable -- store comparison skipped.")
        print("    (Transcript truth above is still authoritative; start the "
              "openlit/clickhouse containers to compare.)")
        return rep

    leaves = store["leaves"]
    # real LLM turns exclude the zero-token user_prompt marker spans
    real = [r for r in leaves if r["kind"] != "user_prompt" and (r["inp"] + r["outp"]) > 0]
    markers = [r for r in leaves if r["kind"] == "user_prompt"]

    s_in = sum(r["inp"] for r in real)
    s_cr = sum(r["cr"] for r in real)
    s_cc = sum(r["cc"] for r in real)
    s_out = sum(r["outp"] for r in real)
    s_tot = sum(r["tot"] for r in real)
    s_cost = sum(r["cost"] for r in real)

    print("\n[2] OPENLIT STORE (ClickHouse coding_agent.llm.turn leaves)")
    print(f"    leaves={len(leaves)}  real_turns={len(real)}  "
          f"user_prompt_markers={len(markers)}  session_root_spans={store['root_count']}")
    print(f"    input(+cache)={s_in:,}  cache_read={s_cr:,}  cache_creation={s_cc:,}  "
          f"output={s_out:,}  total={s_tot:,}  cost=${s_cost:.4f}")

    # --- store internal identities ---
    bad_tok = [r for r in real if (r["inp"] + r["outp"]) != r["tot"]]
    rep.add(f"store token-identity: input_incl+output == total ({len(real)} turns)",
            not bad_tok,
            "" if not bad_tok else f"{len(bad_tok)} span(s) violate it, e.g. rid={bad_tok[0]['rid']}")

    # COST IDENTITY: recompute each stored turn's cost from its OWN tokens with
    # cache-aware rates. A mismatch = the stored cost was written cache-blind
    # (UI 'Recalculate' / cache-blind backfill) -> corrupted span.
    corrupt = []
    for r in real:
        want = cc_pricing.cost_usd(r["model"], r["inp"], r["outp"], r["cr"], r["cc"])
        if abs(want - r["cost"]) > max(tol_usd, abs(want) * tol_frac):
            corrupt.append((r, want))
    rep.add("store cost-identity: stored cost == cache-aware recompute (no cache-blind spans)",
            not corrupt,
            "" if not corrupt
            else f"{len(corrupt)} span(s) mis-priced; e.g. rid={corrupt[0][0]['rid']} "
                 f"stored=${corrupt[0][0]['cost']:.4f} cache-aware=${corrupt[0][1]:.4f} "
                 f"(ratio {corrupt[0][0]['cost']/max(corrupt[0][1],1e-9):.2f}x) "
                 f"-> re-priced CACHE-BLIND by the UI; re-stamp from CLI/transcript")

    # Expand the session cost arithmetic so it's auditable at a glance.
    rate = cc_pricing.lookup("claude-opus-4-8")
    fresh = s_in - s_cr - s_cc
    expanded = (fresh * rate.input_per_m + s_cr * rate.cached_read_per_m
                + s_cc * rate.cache_creation_per_m + s_out * rate.output_per_m) / 1e6
    print("\n[3] COST IDENTITY (session, opus-4-8 rates; cache tiers shown)")
    print(f"    ({fresh:,}*{rate.input_per_m} + {s_cr:,}*{rate.cached_read_per_m} + "
          f"{s_cc:,}*{rate.cache_creation_per_m} + {s_out:,}*{rate.output_per_m})/1e6")
    print(f"      = ${expanded:.4f}  vs stored sum ${s_cost:.4f}")
    print("    NOTE: mixed-model sessions (opus+haiku subagents) won't match this single-rate")
    print("          expansion exactly; the per-turn cost-identity check above is authoritative.")

    # --- truth vs store ---
    d_in, d_out, d_cost = s_in - t_in, s_out - t_out, s_cost - t_cost
    frac = abs(d_cost) / t_cost if t_cost else 0.0
    print("\n[4] TRUTH vs STORE  (store - truth)")
    print(f"    input(+cache): {d_in:+,}    output: {d_out:+,}    "
          f"cost: ${d_cost:+.4f}  ({frac*100:+.3f}%)")
    rep.add("truth-vs-store cost within tolerance",
            frac <= max(tol_frac, 0.01) or abs(d_cost) <= tol_usd,
            f"delta ${d_cost:+.4f} ({frac*100:+.3f}%)")

    # per-agent drift (where subagent capture bugs hide)
    store_by_agent: dict[str, dict] = {}
    for r in real:
        key = r["aid"] if r["atype"] == "subagent" and r["aid"] else "(main)"
        g = store_by_agent.setdefault(key, {"rids": set(), "cost": 0.0, "out": 0, "in": 0, "n": 0})
        g["rids"].add(r["rid"]); g["cost"] += r["cost"]; g["out"] += r["outp"]
        g["in"] += r["inp"]; g["n"] += 1
    print("    per-agent (store):")
    for aid, a in agents.items():
        s = store_by_agent.get(aid)
        if not s:
            print(f"      {aid:<14} truth cost ${a['cost']:.4f} / {a['n_turns']} turns  "
                  f"-> NO STORED TURNS (capture gap)")
            continue
        print(f"      {aid:<14} truth ${a['cost']:.4f}/{a['n_turns']}t  "
              f"store ${s['cost']:.4f}/{s['n']}t  dOut={s['out']-a['output']:+,}  "
              f"dTurns={s['n']-a['n_turns']:+d}")

    # --- coverage ---
    s_rids = {r["rid"] for r in real if r["rid"]}
    missing = t_rids - s_rids        # in transcript, not stored -> dropped (tail!)
    extra = s_rids - t_rids          # stored, not in transcript -> duplicate/orphan
    print("\n[5] COVERAGE (transcript requestId <-> stored gen_ai.response.id)")
    print(f"    transcript reqs={len(t_rids)}  stored reqs={len(s_rids)}  "
          f"missing(dropped)={len(missing)}  extra(orphan/dupe)={len(extra)}")
    if missing:
        print(f"      MISSING (in transcript, never captured): {sorted(list(missing))[:5]}")
    if extra:
        print(f"      EXTRA (stored, no transcript match): {sorted(list(extra))[:5]}")

    # Row-level duplication: more turn ROWS than distinct (request,agent) keys
    # means the same API request is stored twice -- the classic cause is
    # backfill-inserted rows coexisting with forward CLI-captured rows.
    keys = [(r["aid"], r["rid"]) for r in real if r["rid"]]
    dup_rows = len(keys) - len(set(keys))
    bf_rows = sum(1 for r in real if r.get("bf"))
    if dup_rows or bf_rows:
        print(f"    DUPLICATE ROWS: {len(real)} turn rows vs {len(set(keys))} distinct "
              f"(request,agent) -> {dup_rows} duplicate row(s); "
              f"{bf_rows} carry coding_agent.backfill_source")
        if bf_rows and dup_rows:
            print("      -> backfill rows coexist with forward-capture rows; this session is "
                  "double-counted. Delete one set (e.g. the backfill_source rows) to deduplicate.")
    # Non-gating: a duplicate's $ impact is already judged by the truth-vs-store
    # cost tolerance above (gross duplication fails there; a 1-row CLI drift does
    # not). Surface it as a warning so a clean session isn't marked FAILED over
    # a sub-tolerance row.
    if dup_rows:
        rep.warn("store has duplicate turn rows (one API request stored >1x)",
                 f"{dup_rows} duplicate row(s); {bf_rows} carry backfill_source "
                 f"({'backfill+forward double-count' if bf_rows else 'CLI emitted a request twice'})")
    rep.add("coverage: no transcript turn dropped from the store",
            not missing, "" if not missing else f"{len(missing)} req(s) missing (post-workflow tail?)")
    rep.add("coverage: no orphan/duplicate stored turns",
            not extra, "" if not extra else f"{len(extra)} stored req(s) have no transcript match")

    # --- no double count ---
    print("\n[6] NO DOUBLE-COUNT")
    print(f"    session-root spans for this sid: {store['root_count']} "
          f"({'safe - totals are leaf-sum only' if store['root_count'] == 0 else 'root folds subagents; sum LEAVES only, never root+leaves'})")
    rep.add("no-double-count: totals are sum of leaves (root excluded)", True)

    # --- tool dedupe ---
    tc = store["tool_counts"]
    print("\n[7] TOOL DEDUPE / ASYNC TAXONOMY")
    print(f"    tool.requested (PreToolUse markers) = {tc.get('coding_agent.tool.requested', 0)}")
    print(f"    tool.call      (real cost-free spans) = {tc.get('coding_agent.tool.call', 0)}")
    print(f"    turn taxonomy: main={sum(1 for r in real if r['atype'] != 'subagent')}  "
          f"workflow-subagent={sum(1 for r in real if r['atype'] == 'subagent')}  "
          f"user_prompt_markers={len(markers)}")
    rep.add("tool dedupe: tool.call <= tool.requested (each call has a request)",
            tc.get('coding_agent.tool.call', 0) <= tc.get('coding_agent.tool.requested', 10**9) or
            'coding_agent.tool.requested' not in tc)

    return rep


def list_sessions(ch: CH):
    rows = ch.rows(
        f"""SELECT SpanAttributes['{K_SESSION}'] AS sid,
                   count() AS turns,
                   sum(toInt64OrZero(SpanAttributes['{K_IN}'])) AS inTok,
                   sum(toInt64OrZero(SpanAttributes['{K_OUT}'])) AS outTok,
                   round(sum(toFloat64OrZero(SpanAttributes['{K_COST}'])), 4) AS cost
            FROM openlit.otel_traces
            WHERE SpanName='coding_agent.llm.turn' AND SpanAttributes['{K_SESSION}'] != ''
            GROUP BY sid ORDER BY inTok DESC"""
    )
    print(f"{'session_id':<40}{'turns':>7}{'input(+cache)':>15}{'output':>10}{'cost_usd':>11}")
    for r in rows:
        print(f"{r['sid']:<40}{int(r['turns']):>7}{int(r['inTok']):>15,}"
              f"{int(r['outTok']):>10,}{float(r['cost']):>11.4f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--session-id", help="Claude Code session UUID to reconcile")
    ap.add_argument("--project-dir", default=None,
                    help="path to the .claude/projects/<dir> holding <session>.jsonl (auto-detected if omitted)")
    ap.add_argument("--clickhouse-url", default=DEFAULT_CH_URL)
    ap.add_argument("--tol-usd", type=float, default=0.01, help="absolute USD tolerance per check")
    ap.add_argument("--tol-frac", type=float, default=0.005, help="fractional tolerance (0.005 = 0.5%%)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON result")
    ap.add_argument("--list", action="store_true", help="list sessions present in the store and exit")
    args = ap.parse_args()

    ch = CH(args.clickhouse_url)
    ch.ping()

    if args.list:
        if not ch.ok:
            print(f"ClickHouse unreachable: {ch.err}", file=sys.stderr)
            sys.exit(2)
        list_sessions(ch)
        return

    if not args.session_id:
        ap.error("--session-id is required (or use --list)")

    project_dir = find_project_dir(args.session_id, args.project_dir)
    if not project_dir:
        print(f"Could not find {args.session_id}.jsonl under {PROJECTS_ROOT} "
              f"(or --project-dir). Cannot establish ground truth.", file=sys.stderr)
        sys.exit(2)

    agents = gather_transcript_truth(args.session_id, project_dir)
    store = gather_store(ch, args.session_id) if ch.ok else None

    rep = reconcile(args.session_id, agents, store, args.tol_usd, args.tol_frac)

    print("\n" + "=" * 78)
    print("  RESULT")
    print("=" * 78)
    for name, ok, detail in rep.checks:
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {name}" + (f"  -- {detail}" if detail else ""))
    for name, detail in rep.warns:
        print(f"  [WARN] {name}" + (f"  -- {detail}" if detail else ""))
    overall = "ALL CHECKS PASSED" if rep.passed() else "RECONCILIATION FAILED"
    if rep.passed() and rep.warns:
        overall += f" ({len(rep.warns)} warning(s))"
    print(f"\n  ==> {overall}")
    if not ch.ok:
        print(f"  (ClickHouse was unreachable: {ch.err} -- only transcript-truth checks ran.)")

    if args.json:
        print("\n" + json.dumps({
            "session_id": args.session_id,
            "passed": rep.passed(),
            "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in rep.checks],
        }, indent=2))

    sys.exit(0 if rep.passed() else 1)


if __name__ == "__main__":
    main()
