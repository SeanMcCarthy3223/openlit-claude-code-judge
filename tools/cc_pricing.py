"""Canonical Claude-Code / coding-agent pricing oracle.

This is a FAITHFUL, line-checked Python port of the Go pricing used by the
OpenLIT CLI hook at capture time:
    openlit/cli/internal/coding/pricing/pricing.go

Why this module exists
----------------------
There are TWO pricing code paths in this project and they must agree:

  1. CLI hook (Go, ``pricing.go``)  -> stamps ``gen_ai.usage.cost`` on every
     ``coding_agent.llm.turn`` span at capture time. VERIFIED CORRECT: it
     models Anthropic prompt-cache reads (~0.10x input) and cache writes
     (~1.25x input) as separate rates.

  2. UI / server (TypeScript, ``src/client/src/lib/platform/pricing``) used by
     "Manage Models" + any re-price. The user reports that adding
     ``claude-opus-4-8`` there only asked for INPUT and OUTPUT cost -> so a
     UI re-price prices cache-reads at the full input rate ($5/M instead of
     $0.50/M) and cache-writes at $5/M instead of $6.25/M. That is the
     suspected "cache math" bug.

This module is the single, testable source of truth the reconciliation tool
uses to check BOTH paths against the raw Claude Code transcript (the same
usage numbers Claude Code's own ``/context`` reflects).

Key accounting rule (matches pricing.go and the multi-agent architecture doc):
  ``input_tokens`` as reported by Anthropic / stored by OpenLIT is the TOTAL
  input the model saw and ALREADY INCLUDES cache_read + cache_creation.
  Fresh (uncached) input = input - cache_read - cache_creation.
  total_tokens = input_tokens + output_tokens.

All rates are USD per 1,000,000 tokens. Reference: pricing.go (Anthropic
pricing verified 2026-05; opus-4.5+ = $5/$25 flat, NO >200k premium).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Rate:
    """Input/output/cache rates for a model family, USD per 1M tokens."""

    input_per_m: float
    output_per_m: float
    cached_read_per_m: float = 0.0      # cache-read rate (~0.10x input for Anthropic)
    cache_creation_per_m: float = 0.0   # cache-write rate (~1.25x input for Anthropic)

    def cost(self, input_tokens: int, output_tokens: int,
             cache_read: int, cache_creation: int) -> float:
        """Realized USD cost. Mirrors ``Rate.Cost`` in pricing.go exactly.

        ``input_tokens`` is the TOTAL input (incl. cache); cache_read and
        cache_creation are subtracted before billing fresh input.
        """
        if self.input_per_m == 0 and self.output_per_m == 0:
            return 0.0
        # Fallback rules identical to pricing.go: a missing cache-read rate
        # bills cache reads at full input rate; a missing cache-write rate
        # bills cache writes at input rate ONLY when such tokens exist. This
        # is exactly the rule that makes the UI path WRONG when a model is
        # added with input+output only.
        cache_read_rate = self.cached_read_per_m or self.input_per_m
        cache_creation_rate = self.cache_creation_per_m
        if cache_creation_rate == 0 and cache_creation > 0:
            cache_creation_rate = self.input_per_m
        fresh_input = max(0, input_tokens - cache_read - cache_creation)
        return (
            fresh_input * self.input_per_m
            + cache_read * cache_read_rate
            + cache_creation * cache_creation_rate
            + output_tokens * self.output_per_m
        ) / 1_000_000.0

    def cost_breakdown(self, input_tokens: int, output_tokens: int,
                       cache_read: int, cache_creation: int) -> dict:
        """Per-tier dollar breakdown so the arithmetic is auditable.

        Returns the four billed components + total; sum(components)==total.
        This is what makes a reconciliation report "easy to confirm".
        """
        cache_read_rate = self.cached_read_per_m or self.input_per_m
        cache_creation_rate = self.cache_creation_per_m
        if cache_creation_rate == 0 and cache_creation > 0:
            cache_creation_rate = self.input_per_m
        fresh_input = max(0, input_tokens - cache_read - cache_creation)
        fresh_cost = fresh_input * self.input_per_m / 1_000_000.0
        read_cost = cache_read * cache_read_rate / 1_000_000.0
        create_cost = cache_creation * cache_creation_rate / 1_000_000.0
        out_cost = output_tokens * self.output_per_m / 1_000_000.0
        return {
            "fresh_input_tokens": fresh_input,
            "cache_read_tokens": cache_read,
            "cache_creation_tokens": cache_creation,
            "output_tokens": output_tokens,
            "fresh_input_rate_per_m": self.input_per_m,
            "cache_read_rate_per_m": cache_read_rate,
            "cache_creation_rate_per_m": cache_creation_rate,
            "output_rate_per_m": self.output_per_m,
            "fresh_input_cost": fresh_cost,
            "cache_read_cost": read_cost,
            "cache_creation_cost": create_cost,
            "output_cost": out_cost,
            "total_cost": fresh_cost + read_cost + create_cost + out_cost,
        }


# Order is load-bearing: first substring match wins, so versioned/specific
# patterns precede family prefixes (mirrors the Go `table` ordering exactly).
_TABLE: list[tuple[list[str], Rate]] = [
    # --- Anthropic Claude ---
    (["claude-opus-4-8-fast", "claude-opus-4-7-fast", "claude-opus-4-6-fast", "claude-opus-4-5-fast"],
     Rate(30.00, 150.00, 3.00, 37.50)),
    (["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
     Rate(5.00, 25.00, 0.50, 6.25)),
    (["claude-opus-4-0", "claude-opus-4-1", "claude-4-opus"],
     Rate(15.00, 75.00, 1.50, 18.75)),
    (["claude-opus-4"], Rate(5.00, 25.00, 0.50, 6.25)),
    (["claude-sonnet-4", "claude-4-sonnet", "claude-4.5-sonnet", "claude-4.6-sonnet", "claude-4.7-sonnet"],
     Rate(3.00, 15.00, 0.30, 3.75)),
    (["claude-haiku-4", "claude-4-haiku", "claude-4.5-haiku"],
     Rate(1.00, 5.00, 0.10, 1.25)),
    (["claude-3-7-sonnet", "claude-3.7-sonnet"], Rate(3.00, 15.00, 0.30, 3.75)),
    (["claude-3-5-haiku", "claude-3.5-haiku"], Rate(0.80, 4.00, 0.08, 1.00)),
    (["claude-3-5-sonnet", "claude-3.5-sonnet"], Rate(3.00, 15.00, 0.30, 3.75)),
    (["claude-3-haiku"], Rate(0.25, 1.25, 0.03, 0.30)),
    (["claude-3-sonnet"], Rate(3.00, 15.00, 0.30, 3.75)),
    (["claude-3-opus", "claude-3.0-opus"], Rate(15.00, 75.00, 1.50, 18.75)),
    # --- OpenAI ---
    (["gpt-5.5-pro", "gpt-5-5-pro"], Rate(30.00, 180.00)),
    (["gpt-5.5", "gpt-5-5"], Rate(5.00, 30.00, 0.50)),
    (["gpt-5.4-pro", "gpt-5-4-pro"], Rate(30.00, 180.00)),
    (["gpt-5.4-nano", "gpt-5-4-nano"], Rate(0.20, 1.25, 0.02)),
    (["gpt-5.4-mini", "gpt-5-4-mini"], Rate(0.75, 4.50, 0.075)),
    (["gpt-5.4", "gpt-5-4"], Rate(2.50, 15.00, 0.25)),
    (["gpt-5.3-codex", "codex-5.3", "gpt-5-3-codex"], Rate(1.75, 14.00, 0.175)),
    (["gpt-5.2-codex", "gpt-5-2-codex"], Rate(1.75, 14.00, 0.175)),
    (["gpt-5.2", "gpt-5-2"], Rate(1.75, 14.00, 0.175)),
    (["gpt-5.1-codex-max", "gpt-5-1-codex-max"], Rate(1.25, 10.00, 0.125)),
    (["gpt-5.1-codex-mini", "gpt-5-1-codex-mini"], Rate(0.25, 2.00, 0.025)),
    (["gpt-5.1-codex", "gpt-5-1-codex"], Rate(1.25, 10.00, 0.125)),
    (["gpt-5.1", "gpt-5-1"], Rate(1.25, 10.00, 0.125)),
    (["gpt-5-pro"], Rate(15.00, 120.00)),
    (["gpt-5-nano"], Rate(0.05, 0.40, 0.005)),
    (["gpt-5-mini"], Rate(0.25, 2.00, 0.025)),
    (["gpt-5-codex"], Rate(1.25, 10.00, 0.125)),
    (["gpt-5-fast"], Rate(2.50, 20.00, 0.25)),
    (["gpt-5"], Rate(1.25, 10.00, 0.125)),
    (["gpt-4o", "gpt-4-o"], Rate(2.50, 10.00, 1.25)),
    (["gpt-4-turbo", "gpt-4-1106", "gpt-4-0125"], Rate(10.00, 30.00)),
    (["o1-mini"], Rate(3.00, 12.00)),
    (["o1-preview", "o1-pro"], Rate(15.00, 60.00)),
    (["o3-mini"], Rate(1.10, 4.40)),
    (["o3"], Rate(2.00, 8.00)),
    (["o4-mini"], Rate(1.10, 4.40)),
    # --- Google Gemini ---
    (["gemini-3.1-pro", "gemini-3-1-pro"], Rate(2.00, 12.00)),
    (["gemini-3.1-flash-lite", "gemini-3-1-flash-lite"], Rate(0.25, 1.50)),
    (["gemini-3.5-flash", "gemini-3-5-flash"], Rate(1.50, 9.00)),
    (["gemini-3-pro-image-preview", "gemini-3-pro"], Rate(2.00, 12.00)),
    (["gemini-3-flash"], Rate(0.50, 3.00)),
    (["gemini-2.5-pro", "gemini-2-5-pro"], Rate(1.25, 10.00)),
    (["gemini-2.5-flash-lite", "gemini-2-5-flash-lite"], Rate(0.10, 0.40)),
    (["gemini-2.5-flash", "gemini-2-5-flash"], Rate(0.30, 2.50)),
    (["gemini-2.0-flash", "gemini-2-0-flash"], Rate(0.10, 0.40)),
    (["gemini-1.5-pro", "gemini-1-5-pro"], Rate(1.25, 5.00)),
    (["gemini-1.5-flash", "gemini-1-5-flash"], Rate(0.075, 0.30)),
    # --- xAI Grok ---
    (["grok-4-20", "grok-4.20"], Rate(2.00, 6.00, 0.20)),
    (["grok-4-3", "grok-4.3"], Rate(1.25, 2.50, 0.20)),
    (["grok-build-0-1", "grok-build-0.1", "grok-build"], Rate(1.00, 2.00, 0.20)),
    # --- Cursor Composer ---
    (["composer-2-5", "composer-2.5", "composer-2"], Rate(0.50, 2.50, 0.20)),
    (["composer-1-5", "composer-1.5"], Rate(3.50, 17.50, 0.35)),
    (["composer-1", "composer"], Rate(1.25, 10.00, 0.125)),
    # --- Moonshot Kimi ---
    (["kimi-k2-5", "kimi-k2.5", "kimi-2-5"], Rate(0.60, 3.00, 0.10)),
    (["kimi-k2", "kimi-2"], Rate(0.60, 3.00, 0.10)),
]

_ZERO = Rate(0.0, 0.0)


def lookup(model: str) -> Rate:
    """Best-effort rate for a model id (case-insensitive substring, first match wins).

    Returns the zero Rate (-> $0) when nothing matches, exactly like pricing.go.
    """
    low = (model or "").lower()
    for patterns, rate in _TABLE:
        for pat in patterns:
            if pat in low:
                return rate
    return _ZERO


def cost_usd(model: str, input_tokens: int, output_tokens: int,
             cache_read: int, cache_creation: int) -> float:
    """Convenience: realized USD cost for a turn, picking the rate by model id."""
    return lookup(model).cost(input_tokens, output_tokens, cache_read, cache_creation)


# --- self-test: PROVE the cache math, including the opus-4-8 example -----------
if __name__ == "__main__":
    import sys

    failures = []

    def check(name, got, want, tol=1e-9):
        ok = abs(got - want) <= tol
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}: got {got!r} want {want!r}")
        if not ok:
            failures.append(name)

    print("cc_pricing self-test (verifies the cache arithmetic)\n")

    # 1) opus-4-8 rate lookup is the modern $5/$25 + cache tiers (NOT legacy $15/$75).
    r = lookup("claude-opus-4-8")
    check("opus-4-8 input rate", r.input_per_m, 5.00)
    check("opus-4-8 output rate", r.output_per_m, 25.00)
    check("opus-4-8 cache-read rate", r.cached_read_per_m, 0.50)
    check("opus-4-8 cache-write rate", r.cache_creation_per_m, 6.25)
    check("opus-4-8[1m] still matches (substring)",
          lookup("claude-opus-4-8[1m]").input_per_m, 5.00)
    check("opus-4-8-fast is the 6x premium tier",
          lookup("claude-opus-4-8-fast").input_per_m, 30.00)

    # 2) Hand-worked cache arithmetic. A cache-read-dominated turn:
    #    1,000,000 fresh + 9,000,000 cache_read + 500,000 cache_create + 200,000 out
    #    input_tokens = fresh+read+create = 10,500,000 (input INCLUDES cache).
    fresh, read, create, out = 1_000_000, 9_000_000, 500_000, 200_000
    inp = fresh + read + create
    want = (fresh * 5.0 + read * 0.50 + create * 6.25 + out * 25.0) / 1_000_000.0
    check("opus-4-8 mixed-cache cost", cost_usd("claude-opus-4-8", inp, out, read, create), want)

    # 3) THE BUG DEMO: what the UI computes if opus-4-8 is added with input+output
    #    ONLY (no cache fields) -> cache tiers collapse to the input rate.
    cache_blind = Rate(5.00, 25.00)  # what "Manage Models" stores today
    blind = cache_blind.cost(inp, out, read, create)
    correct = lookup("claude-opus-4-8").cost(inp, out, read, create)
    print(f"\n  cache-blind (UI) cost = ${blind:.4f}  vs  correct (CLI) cost = ${correct:.4f}")
    print(f"  -> cache-blind OVER-bills by ${blind - correct:.4f} ({blind / correct:.2f}x) on this turn")
    check("cache-blind over-bills (demonstrates the UI bug)", blind > correct * 1.5, True)

    # 4) breakdown sums to total (the identity a reconcile report asserts).
    bd = lookup("claude-opus-4-8").cost_breakdown(inp, out, read, create)
    summed = bd["fresh_input_cost"] + bd["cache_read_cost"] + bd["cache_creation_cost"] + bd["output_cost"]
    check("breakdown components sum to total", summed, bd["total_cost"])
    check("breakdown total == cost()", bd["total_cost"], correct)

    # 5) no >200k long-context premium: doubling tokens exactly doubles cost.
    c1 = cost_usd("claude-opus-4-8", 300_000, 50_000, 0, 0)
    c2 = cost_usd("claude-opus-4-8", 600_000, 100_000, 0, 0)
    check("flat pricing (no >200k premium): 2x tokens == 2x cost", c2, c1 * 2)

    # 6) haiku-4-5 (subagent model) sanity.
    check("haiku-4-5 input rate", lookup("claude-haiku-4-5").input_per_m, 1.00)
    check("unknown model -> $0", cost_usd("totally-unknown", 1000, 1000, 0, 0), 0.0)

    print()
    if failures:
        print(f"FAILED: {failures}")
        sys.exit(1)
    print("ALL CHECKS PASSED")
