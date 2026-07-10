/**
 * POST /api/coding-agents/sessions
 *
 * Offset/limit listing used by the unified telemetry primitive
 * `<ObservabilitySignalList>`. Accepts the standard filter body
 * (timeLimit, selectedConfig, sorting, offset, limit, runFilters)
 * and returns `{ records, total }` so the table and count badge
 * render with one round-trip.
 *
 * Gates through `requireCodingAgentAuth` so the org-scoped privacy
 * floor still applies to `gen_ai.user.name`.
 *
 * F5: the legacy GET cursor handler (used by the deprecated
 * `coding-sessions-tab.tsx`) was removed in 1.5 — the tab now
 * renders via `<ObservabilitySignalList>` and only speaks POST.
 */

import {
	listSessions,
	type ListSessionsOptions,
} from "@/lib/platform/coding-agents/queries";
import {
	requireCodingAgentAuth,
	CodingAgentUnauthorizedError,
} from "@/lib/platform/coding-agents/auth";
import { isCodingAgentClassification } from "@/lib/platform/coding-agents/classifier";

export const dynamic = "force-dynamic";

interface SessionsListBody {
	timeLimit?: { start?: string | Date; end?: string | Date };
	selectedConfig?: Record<string, unknown>;
	sorting?: { type?: string; direction?: string };
	offset?: number;
	limit?: number;
	runFilters?: Record<string, unknown>;
}

const VALID_SESSIONS_SORT_BY: ReadonlyArray<string> = [
	"latest",
	"duration",
	"cost",
	"tokens",
	"tool_calls",
];

function asSessionsSortBy(
	value: unknown
): ListSessionsOptions["sortBy"] | undefined {
	if (typeof value !== "string") return undefined;
	return VALID_SESSIONS_SORT_BY.includes(value)
		? (value as ListSessionsOptions["sortBy"])
		: undefined;
}

function asSortDir(value: unknown): "asc" | "desc" | undefined {
	if (value === "asc" || value === "desc") return value;
	return undefined;
}

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asDate(value: unknown): Date | null {
	if (!value) return null;
	const date = new Date(value as string | number | Date);
	return Number.isNaN(date.getTime()) ? null : date;
}

// No implicit lower bound. A caller that omits `timeLimit.start` means
// "every retained session", and we honour that.
//
// This used to default to a 24h window, on the reasoning that an
// unbounded `otel_traces` scan could time out. In practice it silently
// hid every session older than a day — a developer's last coding
// session is routinely days or weeks old — while the UI's "ALL" range
// already issues the same unbounded scan explicitly, so the floor bought
// no protection and cost correctness. Callers that want a window send
// one.

export async function POST(request: Request) {
	let auth;
	try {
		auth = await requireCodingAgentAuth();
	} catch (err) {
		if (err instanceof CodingAgentUnauthorizedError) {
			return Response.json({ error: err.message }, { status: 401 });
		}
		throw err;
	}

	let body: SessionsListBody = {};
	try {
		body = (await request.json()) as SessionsListBody;
	} catch {
		// fall through with defaults — empty body is OK, signals
		// "give me everything you can" within the cohort floor.
	}

	const runFilters = (body.runFilters || {}) as Record<string, unknown>;
	const limitRaw = Number(body.limit);
	const offsetRaw = Number(body.offset);
	const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25;
	const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

	const opts: ListSessionsOptions = {
		limit,
		offset,
		withTotal: true,
		vendor: asString(runFilters.vendor),
		user: asString(runFilters.user),
		classification: isCodingAgentClassification(
			asString(runFilters.classification)
		)
			? (asString(runFilters.classification) as ListSessionsOptions["classification"])
			: null,
		// Unbounded when the caller sends no start — all retained sessions.
		since: asDate(body.timeLimit?.start),
		until: asDate(body.timeLimit?.end),
		sortBy: asSessionsSortBy(body.sorting?.type),
		sortDir: asSortDir(body.sorting?.direction),
	};

	try {
		const { rows, total } = await listSessions(auth, opts);
		return Response.json({
			records: rows,
			total: total ?? rows.length,
		});
	} catch (err) {
		console.error("coding_agent.sessions.list_failed", err);
		return Response.json({ error: "Internal error" }, { status: 500 });
	}
}
