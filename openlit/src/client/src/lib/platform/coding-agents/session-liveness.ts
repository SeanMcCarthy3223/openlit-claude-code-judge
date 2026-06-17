/**
 * Liveness derivation for the coding-agent Sessions list.
 *
 * "Running" is not a real telemetry state. A session shows the blue
 * "running" pill purely as a fallback for when no span ever stamped a
 * non-empty `coding_agent.session.outcome` (see SESSION_BASE_COLUMNS in
 * ./queries.ts for the `outcome` derivation, and the pill logic in
 * signal-records.tsx). That fallback latches forever when a graceful end
 * never fires: closing VS Code, starting a new chat, kill -9, a crash, or
 * sleep/reboot all skip Claude Code's `SessionEnd` hook, so the session
 * is stuck "running" with no end-of-session telemetry to clear it.
 *
 * Rather than claim such sessions are still running indefinitely, we age
 * them out from their last recorded activity (`ended_at`, the session's
 * max span Timestamp, formatted UTC):
 *
 *   - < IDLE_AFTER         : "running" (recent span activity)
 *   - IDLE_AFTER..COMPLETE : "idle"    (quiet, but possibly still alive —
 *                            if a fresh span lands, `ended_at` advances and
 *                            the row flips back to "running")
 *   - >= COMPLETE_AFTER     : "completed" (idle long enough that the
 *                            session is treated as finished)
 *
 * This only applies when the row carries no real outcome; a genuine
 * end-of-session verdict always wins over this inferred state.
 *
 * Time math is absolute-epoch on both sides — `ended_at` carries a
 * trailing 'Z' (or equivalent offset) so `Date.parse` yields a UTC epoch,
 * compared against a caller-supplied `nowMs` (Date.now() at render). It
 * therefore tolerates the client/server timezone gap; only gross client
 * clock skew (many minutes) could misbucket, which the coarse 30-minute /
 * 48-hour thresholds comfortably absorb.
 */

/** Quiet for at least this long → "idle" instead of "running". */
export const SESSION_IDLE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

/** Quiet for at least this long → treated as "completed". */
export const SESSION_COMPLETE_AFTER_MS = 48 * 60 * 60 * 1000; // 48 hours

export type SessionLiveState = "running" | "idle" | "completed";

/**
 * Whether the inferred liveness pill should be shown at all. A session
 * with a genuine end-of-session verdict (any non-empty outcome other than
 * the literal "unknown" the CLI emits when no signal is decisive) always
 * wins over the running/idle/completed fallback. Extracted so the gate is
 * unit-testable independent of the React render.
 */
export function shouldShowLiveState(
	outcome: string | null | undefined
): boolean {
	return !outcome || outcome === "unknown";
}

/**
 * Map a session's last-activity time to a liveness state. Used only as a
 * fallback when the session has no real `outcome` (see shouldShowLiveState).
 *
 * @param endedAt last-activity timestamp (max span Timestamp, UTC ISO);
 *                null/undefined/unparseable is treated as "running" so a
 *                row never disappears into "completed" on bad data.
 * @param nowMs   reference "now" in epoch ms (a ticking value from the
 *                caller). null/undefined (e.g. before the clock has
 *                mounted on the client) is treated as "running" so the
 *                server render and first client paint agree.
 */
export function deriveSessionLiveState(
	endedAt: string | null | undefined,
	nowMs: number | null | undefined
): SessionLiveState {
	if (!endedAt) return "running";
	if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return "running";
	const lastActivityMs = Date.parse(endedAt);
	if (!Number.isFinite(lastActivityMs)) return "running";

	const idleMs = nowMs - lastActivityMs;
	if (idleMs >= SESSION_COMPLETE_AFTER_MS) return "completed";
	if (idleMs >= SESSION_IDLE_AFTER_MS) return "idle";
	return "running";
}
