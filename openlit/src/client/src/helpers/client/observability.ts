import { DEFAULT_SORTING, DEFAULT_TIME_RANGE, TIME_RANGE_TYPE } from "@/store/filter";
import { FilterConfig, TIME_RANGES } from "@/types/store/filter";

export type UpdateFilterFn = (
	key: string,
	value: any,
	extraParams?: any
) => void;

export type UpdateConfigFn = (config?: FilterConfig) => void;

// Signals whose data is browsed historically rather than monitored live.
// Coding-agent telemetry is retained indefinitely and a developer's last
// session is routinely days or weeks old, so a 24h default renders these
// tabs empty on load even though the data is present. They default to the
// "ALL" range instead.
//
// "ALL" is scoped to these signals on purpose: traces / metrics / logs are
// high-cardinality and unbounded, so an all-time default there would turn
// every cold load into a full-table scan.
const HISTORICAL_SIGNALS: ReadonlySet<string> = new Set(["sessions", "users"]);

/**
 * Time range a signal should start from. Returns null when the signal has
 * no opinion, in which case the caller must leave the current range alone
 * (so a range the user picked by hand survives a tab switch).
 */
export function defaultTimeRangeForSignal(
	signalKey: string | undefined,
	currentRange: TIME_RANGES | undefined
): TIME_RANGES | null {
	if (signalKey && HISTORICAL_SIGNALS.has(signalKey)) {
		// Don't clobber an explicit narrower choice the user just made.
		return currentRange === TIME_RANGE_TYPE.CUSTOM ? null : "ALL";
	}
	// Leaving a historical signal: "ALL" must not leak onto the
	// high-cardinality signals, so fall back to the global default.
	if (currentRange === TIME_RANGE_TYPE.ALL) {
		return DEFAULT_TIME_RANGE as TIME_RANGES;
	}
	return null;
}

// E3: when the active observability signal/tab changes (traces ↔
// metrics ↔ logs ↔ coding-agent sessions), the previous tab's sort
// key (e.g. "Tokens") is almost never a valid column on the new tab.
// Leaving it set leaks ORDER BY clauses across signals and causes
// the new tab to fall back to an inappropriate default ordering at
// best — or a 500 at worst when the SQL column doesn't exist.
// Reset sort and pagination alongside the existing groupBy/config
// reset so each tab starts from a clean slate.
export function prepareObservabilitySignalChange(
	updateConfig: UpdateConfigFn,
	updateFilter: UpdateFilterFn,
	signalKey?: string,
	currentRange?: TIME_RANGES
) {
	updateConfig(undefined);
	updateFilter("groupBy", null);
	updateFilter("groupValue", null);
	updateFilter("sorting", DEFAULT_SORTING);
	updateFilter("offset", 0);

	// Apply the signal's time-range default only when it has one, so a
	// range the user picked by hand isn't reset just by switching tabs.
	const nextRange = defaultTimeRangeForSignal(signalKey, currentRange);
	if (nextRange && nextRange !== currentRange) {
		updateFilter("timeLimit.type", nextRange);
	}
}
