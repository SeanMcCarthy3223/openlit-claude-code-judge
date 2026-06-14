"use client";

// SubagentBreakdownTable — per-run "who did what" view for multi-agent
// (Workflow / Task subagent) Claude Code runs. One row per
// coding_agent.agent.id (empty id == the main loop), computed entirely
// client-side from the already-fetched hierarchy tree — no new endpoint.
//
// Token accounting (IMPORTANT, verified against the canonical run totals):
// gen_ai.usage.input_tokens ALREADY INCLUDES cache_read + cache_creation,
// so the run total is input + output (NOT input + cache + output, which
// double-counts). Cache-hit % is cache_read / input_tokens. We sum only
// `coding_agent.llm.turn` leaves so the duplicate aggregates carried on
// the `coding_agent.session` root span never enter the totals.

import { useMemo } from "react";
import { TraceHeirarchySpan } from "@/types/trace";
import getMessage from "@/constants/messages";

type AgentRow = {
	rawId: string; // "" for the main loop
	label: string; // "(main)" or a shortened agent id
	isSubagent: boolean;
	subagentType: string;
	models: string[];
	turns: number;
	toolCalls: number;
	inputTokens: number; // inclusive of cache (Anthropic convention)
	cacheRead: number;
	cacheCreate: number;
	outputTokens: number;
	cost: number;
	minTs: number;
	maxTs: number;
};

function num(v: string | number | undefined | null): number {
	if (v == null) return 0;
	const n = typeof v === "number" ? v : parseFloat(v);
	return Number.isFinite(n) ? n : 0;
}

function flatten(span: TraceHeirarchySpan, out: TraceHeirarchySpan[]) {
	out.push(span);
	(span.children || []).forEach((c) => flatten(c, out));
}

function shortId(id: string): string {
	if (!id) return "(main)";
	return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function fmtDuration(ms: number): string {
	if (!ms || ms <= 0) return "-";
	const s = ms / 1000;
	if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	return `${(s / 60).toFixed(1)}m`;
}

function shortModel(m: string): string {
	const lo = m.toLowerCase();
	if (lo.includes("opus")) return "opus";
	if (lo.includes("sonnet")) return "sonnet";
	if (lo.includes("haiku")) return "haiku";
	return m || "—";
}

export default function SubagentBreakdownTable({
	record,
}: {
	record: TraceHeirarchySpan;
}) {
	const m = getMessage();

	const { rows, totals, modelMix } = useMemo(() => {
		const spans: TraceHeirarchySpan[] = [];
		flatten(record, spans);

		const byAgent = new Map<string, AgentRow>();
		const ensure = (rawId: string): AgentRow => {
			let r = byAgent.get(rawId);
			if (!r) {
				r = {
					rawId,
					label: shortId(rawId),
					isSubagent: rawId !== "",
					subagentType: "",
					models: [],
					turns: 0,
					toolCalls: 0,
					inputTokens: 0,
					cacheRead: 0,
					cacheCreate: 0,
					outputTokens: 0,
					cost: 0,
					minTs: Number.POSITIVE_INFINITY,
					maxTs: 0,
				};
				byAgent.set(rawId, r);
			}
			return r;
		};

		const stampWindow = (r: AgentRow, ts?: string) => {
			if (!ts) return;
			const t = Date.parse(ts);
			if (!Number.isFinite(t)) return;
			if (t < r.minTs) r.minTs = t;
			if (t > r.maxTs) r.maxTs = t;
		};

		for (const s of spans) {
			const attrs = s.SpanAttributes || {};
			const agentId = String(attrs["coding_agent.agent.id"] ?? "");

			if (s.SpanName === "coding_agent.llm.turn") {
				const r = ensure(agentId);
				r.turns += 1;
				r.inputTokens += num(attrs["gen_ai.usage.input_tokens"]);
				r.outputTokens += num(attrs["gen_ai.usage.output_tokens"]);
				r.cacheRead += num(attrs["gen_ai.usage.cache.read_input_tokens"]);
				r.cacheCreate += num(attrs["gen_ai.usage.cache.creation_input_tokens"]);
				r.cost += num(attrs["gen_ai.usage.cost"]);
				const subType = String(attrs["coding_agent.subagent.type"] ?? "");
				if (subType && !r.subagentType) r.subagentType = subType;
				if (String(attrs["coding_agent.agent.type"] ?? "") === "subagent") r.isSubagent = true;
				const model = String(attrs["gen_ai.request.model"] ?? "");
				if (model && !r.models.includes(model)) r.models.push(model);
				stampWindow(r, s.Timestamp);
			} else if (s.SpanName === "coding_agent.tool.call") {
				const r = ensure(agentId);
				r.toolCalls += 1;
				stampWindow(r, s.Timestamp);
			}
		}

		const all = Array.from(byAgent.values());
		// Sort: main first, then subagents by cost desc.
		all.sort((a, b) => {
			if (a.rawId === "" && b.rawId !== "") return -1;
			if (b.rawId === "" && a.rawId !== "") return 1;
			return b.cost - a.cost;
		});

		const totals = all.reduce(
			(acc, r) => {
				acc.cost += r.cost;
				acc.inputTokens += r.inputTokens;
				acc.outputTokens += r.outputTokens;
				acc.cacheRead += r.cacheRead;
				acc.turns += r.turns;
				acc.toolCalls += r.toolCalls;
				if (r.isSubagent) acc.subagents += 1;
				return acc;
			},
			{ cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, turns: 0, toolCalls: 0, subagents: 0 }
		);

		// Model mix by cost (subagents + main), for the header strip.
		const mix = new Map<string, number>();
		for (const r of all) {
			for (const model of r.models.length ? r.models : ["—"]) {
				// Attribute the row's whole cost to its (usually single) model.
				if (r.models.length <= 1) {
					mix.set(shortModel(model), (mix.get(shortModel(model)) || 0) + r.cost);
				}
			}
		}
		const modelMix = Array.from(mix.entries())
			.filter(([k]) => k !== "—")
			.sort((a, b) => b[1] - a[1]);

		return { rows: all, totals, modelMix };
	}, [record]);

	if (!rows.length) {
		return (
			<div className="px-3 py-8 text-sm text-stone-400">
				{m.OBSERVABILITY_SUBAGENTS_EMPTY}
			</div>
		);
	}

	const runCost = totals.cost || 1; // guard div-by-zero
	const runCacheHit =
		totals.inputTokens > 0 ? (100 * totals.cacheRead) / totals.inputTokens : 0;

	return (
		<div className="min-w-fit p-3">
			{/* Header strip: run totals + model mix */}
			<div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-500 dark:text-stone-400">
				<span>
					<span className="font-semibold text-stone-700 dark:text-stone-200">
						{totals.subagents}
					</span>{" "}
					{m.OBSERVABILITY_SUBAGENTS_COUNT_LABEL}
				</span>
				<span>
					{m.OBSERVABILITY_SUBAGENTS_TOTAL_TOKENS}:{" "}
					<span className="font-mono font-semibold text-stone-700 dark:text-stone-200">
						{fmtTokens(totals.inputTokens + totals.outputTokens)}
					</span>
				</span>
				<span>
					{m.OBSERVABILITY_SUBAGENTS_CACHE_HIT}:{" "}
					<span className="font-mono font-semibold text-stone-700 dark:text-stone-200">
						{runCacheHit.toFixed(0)}%
					</span>
				</span>
				<span>
					{m.OBSERVABILITY_SUBAGENTS_TOTAL_COST}:{" "}
					<span className="font-mono font-semibold text-stone-700 dark:text-stone-200">
						{fmtCost(totals.cost)}
					</span>
				</span>
				{modelMix.length > 0 && (
					<span className="flex items-center gap-2">
						{modelMix.map(([model, cost]) => (
							<span key={model} className="font-mono">
								{model} {fmtCost(cost)}
							</span>
						))}
					</span>
				)}
			</div>

			<div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
				<table className="w-full border-collapse text-xs">
					<thead>
						<tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500 dark:bg-stone-900 dark:text-stone-400">
							<th className="px-2 py-1.5 font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_AGENT}</th>
							<th className="px-2 py-1.5 font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_TYPE}</th>
							<th className="px-2 py-1.5 font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_MODEL}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_TURNS}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_TOOLS}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_TOKENS}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_CACHE}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_COST}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_PCT}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_SUBAGENTS_COL_DURATION}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const total = r.inputTokens + r.outputTokens;
							const cacheHit = r.inputTokens > 0 ? (100 * r.cacheRead) / r.inputTokens : 0;
							const pct = (100 * r.cost) / runCost;
							const dur = r.maxTs > r.minTs ? r.maxTs - r.minTs : 0;
							return (
								<tr
									key={r.rawId || "(main)"}
									className="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-900/50"
								>
									<td className="px-2 py-1.5 font-mono text-stone-700 dark:text-stone-300">{r.label}</td>
									<td className="px-2 py-1.5 text-stone-600 dark:text-stone-400">
										{r.isSubagent ? r.subagentType || m.OBSERVABILITY_SUBAGENTS_TYPE_SUBAGENT : m.OBSERVABILITY_SUBAGENTS_TYPE_MAIN}
									</td>
									<td className="px-2 py-1.5 text-stone-600 dark:text-stone-400">
										{r.models.map(shortModel).join(", ") || "—"}
									</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.turns}</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">{r.toolCalls}</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtTokens(total)}</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">
										{r.inputTokens > 0 ? `${cacheHit.toFixed(0)}%` : "-"}
									</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums font-semibold text-stone-800 dark:text-stone-200">
										{fmtCost(r.cost)}
									</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums text-stone-500 dark:text-stone-400">
										{pct.toFixed(1)}%
									</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums text-stone-500 dark:text-stone-400">
										{fmtDuration(dur)}
									</td>
								</tr>
							);
						})}
					</tbody>
					<tfoot>
						<tr className="border-t border-stone-200 bg-stone-50 font-semibold dark:border-stone-700 dark:bg-stone-900">
							<td className="px-2 py-1.5" colSpan={3}>
								{m.OBSERVABILITY_SUBAGENTS_TOTAL_ROW}
							</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">{totals.turns}</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">{totals.toolCalls}</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">
								{fmtTokens(totals.inputTokens + totals.outputTokens)}
							</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">{runCacheHit.toFixed(0)}%</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(totals.cost)}</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">100%</td>
							<td className="px-2 py-1.5" />
						</tr>
					</tfoot>
				</table>
			</div>
		</div>
	);
}
