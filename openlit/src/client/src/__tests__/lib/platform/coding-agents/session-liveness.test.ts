import {
	deriveSessionLiveState,
	shouldShowLiveState,
	SESSION_IDLE_AFTER_MS,
	SESSION_COMPLETE_AFTER_MS,
} from "@/lib/platform/coding-agents/session-liveness";

describe("deriveSessionLiveState", () => {
	// Fixed reference "now" so boundary assertions are deterministic and
	// don't depend on the wall clock.
	const NOW = Date.parse("2026-06-16T12:00:00Z");
	// ended_at = `ms` milliseconds before NOW, formatted UTC like the query.
	const ago = (ms: number) => new Date(NOW - ms).toISOString();

	it("treats recent activity as still running, right up to the idle threshold", () => {
		expect(deriveSessionLiveState(ago(0), NOW)).toBe("running");
		expect(deriveSessionLiveState(ago(60_000), NOW)).toBe("running");
		expect(deriveSessionLiveState(ago(SESSION_IDLE_AFTER_MS - 1), NOW)).toBe(
			"running"
		);
	});

	it("flips to idle at exactly the 30-minute threshold and stays idle until 48h", () => {
		expect(deriveSessionLiveState(ago(SESSION_IDLE_AFTER_MS), NOW)).toBe(
			"idle"
		);
		expect(deriveSessionLiveState(ago(3 * 60 * 60 * 1000), NOW)).toBe("idle");
		expect(
			deriveSessionLiveState(ago(SESSION_COMPLETE_AFTER_MS - 1), NOW)
		).toBe("idle");
	});

	it("flips to completed at exactly the 48-hour threshold and beyond", () => {
		expect(deriveSessionLiveState(ago(SESSION_COMPLETE_AFTER_MS), NOW)).toBe(
			"completed"
		);
		expect(
			deriveSessionLiveState(ago(SESSION_COMPLETE_AFTER_MS * 10), NOW)
		).toBe("completed");
	});

	it("falls back to running when ended_at is missing or unparseable (never hides a row)", () => {
		expect(deriveSessionLiveState(null, NOW)).toBe("running");
		expect(deriveSessionLiveState(undefined, NOW)).toBe("running");
		expect(deriveSessionLiveState("", NOW)).toBe("running");
		expect(deriveSessionLiveState("not-a-date", NOW)).toBe("running");
	});

	it("treats a future timestamp (client clock skew) as running, not negative-idle", () => {
		expect(deriveSessionLiveState(ago(-60_000), NOW)).toBe("running");
	});

	it("treats a not-yet-mounted clock (null/undefined nowMs) as running", () => {
		// Before the client tick mounts the parent passes null; the row must
		// fall back to the original "running" so SSR and first paint agree.
		expect(deriveSessionLiveState(ago(SESSION_COMPLETE_AFTER_MS * 5), null)).toBe(
			"running"
		);
		expect(
			deriveSessionLiveState(ago(SESSION_IDLE_AFTER_MS), undefined)
		).toBe("running");
		expect(deriveSessionLiveState(ago(SESSION_IDLE_AFTER_MS), NaN)).toBe(
			"running"
		);
	});

	it("compares in absolute UTC regardless of the offset notation", () => {
		// 31 minutes ago, written with a +00:00 offset instead of a 'Z'.
		const thirtyOneMinAgo = new Date(NOW - 31 * 60 * 1000)
			.toISOString()
			.replace("Z", "+00:00");
		expect(deriveSessionLiveState(thirtyOneMinAgo, NOW)).toBe("idle");
	});
});

describe("shouldShowLiveState", () => {
	it("shows the liveness fallback only when there is no real outcome", () => {
		expect(shouldShowLiveState(undefined)).toBe(true);
		expect(shouldShowLiveState(null)).toBe(true);
		expect(shouldShowLiveState("")).toBe(true);
		expect(shouldShowLiveState("unknown")).toBe(true);
	});

	it("suppresses the liveness fallback when a genuine outcome is present", () => {
		expect(shouldShowLiveState("completed")).toBe(false);
		expect(shouldShowLiveState("merged")).toBe(false);
		expect(shouldShowLiveState("committed")).toBe(false);
		expect(shouldShowLiveState("abandoned_with_change")).toBe(false);
	});
});
