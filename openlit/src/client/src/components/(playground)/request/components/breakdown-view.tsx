"use client";

// BreakdownView — per-run composition view: where a session's tokens, cost, and
// output actually went. Three tagged breakdowns, all computed client-side from
// the already-fetched hierarchy tree (no new endpoint), mirroring
// SubagentBreakdownTable:
//   1. Token composition — fresh input / cache read / cache write / output,
//      with token share and an estimated per-tier cost.
//   2. Tool use — calls per tool name + the I/O volume each moved.
//   3. Code & content output — lines added/removed, edit decisions, response
//      text volume, output tokens, git artifacts.
//
// Token accounting (same correction as SubagentBreakdownTable):
// gen_ai.usage.input_tokens ALREADY INCLUDES cache_read + cache_creation, so
// fresh = input - cache_read - cache_creation and run total = input + output.
// We sum only `coding_agent.llm.turn` leaves so the duplicate aggregate on the
// `coding_agent.session` root never enters the totals.

import { useMemo } from "react";
import { TraceHeirarchySpan } from "@/types/trace";
import getMessage from "@/constants/messages";

function num(v: string | number | undefined | null): number {
	if (v == null) return 0;
	const n = typeof v === "number" ? v : parseFloat(v);
	return Number.isFinite(n) ? n : 0;
}

function flatten(span: TraceHeirarchySpan, out: TraceHeirarchySpan[]) {
	out.push(span);
	(span.children || []).forEach((c) => flatten(c, out));
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

function fmtBytes(chars: number): string {
	if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}MB`;
	if (chars >= 1_000) return `${Math.round(chars / 1_000)}KB`;
	return `${chars}B`;
}

function pct(part: number, whole: number): string {
	if (whole <= 0) return "-";
	return `${((100 * part) / whole).toFixed(1)}%`;
}

// Per-1M list rates for the Claude family, mirroring
// cli/internal/coding/pricing/pricing.go (Anthropic: cache read ~0.1x input,
// cache write ~1.25x input). Used only to ESTIMATE the per-tier cost split for
// display; the authoritative run cost is the summed stored gen_ai.usage.cost in
// the header. Keep in sync with pricing.go / cc_pricing.py. Unknown models
// contribute 0 to the per-tier estimate (their tokens still show).
type TierRate = { input: number; cacheRead: number; cacheWrite: number; output: number };
function ratesForModel(model: string): TierRate {
	const m = (model || "").toLowerCase();
	if (/(opus-4-8|opus-4-7|opus-4-6|opus-4-5)-fast/.test(m))
		return { input: 30, cacheRead: 3, cacheWrite: 37.5, output: 150 };
	if (/opus-4-8|opus-4-7|opus-4-6|opus-4-5|opus-4/.test(m))
		return { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 };
	if (/opus-4-0|opus-4-1|opus-3|3-opus/.test(m))
		return { input: 15, cacheRead: 1.5, cacheWrite: 18.75, output: 75 };
	if (/sonnet-4|4-sonnet|3-7-sonnet|3-5-sonnet|3-sonnet/.test(m))
		return { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 };
	if (/haiku-4|4-haiku/.test(m)) return { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };
	if (/3-5-haiku/.test(m)) return { input: 0.8, cacheRead: 0.08, cacheWrite: 1, output: 4 };
	return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

// Sum the lengths of assistant text parts in a gen_ai.output.messages payload.
// Falls back to the raw string length when the shape is unexpected.
function responseTextChars(raw: string | undefined): number {
	if (!raw) return 0;
	try {
		const msgs = JSON.parse(raw);
		let total = 0;
		for (const msg of Array.isArray(msgs) ? msgs : []) {
			for (const part of msg?.parts || []) {
				if (part?.type === "text" && typeof part.content === "string") total += part.content.length;
			}
		}
		return total || raw.length;
	} catch {
		return raw.length;
	}
}

export default function BreakdownView({ record }: { record: TraceHeirarchySpan }) {
	const m = getMessage();

	const data = useMemo(() => {
		const spans: TraceHeirarchySpan[] = [];
		flatten(record, spans);

		// Token tiers + estimated tier cost.
		let fresh = 0, cacheRead = 0, cacheWrite = 0, output = 0, storedCost = 0, turns = 0;
		const tierCost = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		// Output content.
		let responseChars = 0;
		// Tools.
		const tools = new Map<string, { calls: number; io: number }>();
		let toolCalls = 0, toolIO = 0;
		// Code output.
		let linesAdded = 0, linesRemoved = 0, edits = 0, editsAccepted = 0, editsRejected = 0;
		const langs = new Map<string, number>();
		// Git artifacts.
		let commits = 0, prs = 0;

		for (const s of spans) {
			const a = s.SpanAttributes || {};
			switch (s.SpanName) {
				case "coding_agent.llm.turn": {
					const inTok = num(a["gen_ai.usage.input_tokens"]);
					const out = num(a["gen_ai.usage.output_tokens"]);
					const cr = num(a["gen_ai.usage.cache.read_input_tokens"]);
					const cc = num(a["gen_ai.usage.cache.creation_input_tokens"]);
					const fr = Math.max(0, inTok - cr - cc);
					if (inTok + out > 0) turns += 1; // skip zero-token user_prompt markers
					fresh += fr; cacheRead += cr; cacheWrite += cc; output += out;
					storedCost += num(a["gen_ai.usage.cost"]);
					const r = ratesForModel(String(a["gen_ai.response.model"] ?? a["gen_ai.request.model"] ?? ""));
					tierCost.fresh += (fr * r.input) / 1e6;
					tierCost.cacheRead += (cr * r.cacheRead) / 1e6;
					tierCost.cacheWrite += (cc * r.cacheWrite) / 1e6;
					tierCost.output += (out * r.output) / 1e6;
					responseChars += responseTextChars(a["gen_ai.output.messages"] as string | undefined);
					break;
				}
				case "coding_agent.tool.call": {
					const name = String(a["gen_ai.tool.name"] ?? "tool");
					const io = String(a["gen_ai.tool.call.arguments"] ?? "").length +
						String(a["gen_ai.tool.call.result"] ?? "").length;
					const t = tools.get(name) || { calls: 0, io: 0 };
					t.calls += 1; t.io += io;
					tools.set(name, t);
					toolCalls += 1; toolIO += io;
					break;
				}
				case "coding_agent.edit.decision": {
					edits += 1;
					linesAdded += num(a["coding_agent.edit.lines.added"]);
					linesRemoved += num(a["coding_agent.edit.lines.removed"]);
					const decision = String(a["coding_agent.edit.decision"] ?? "");
					if (decision === "reject") editsRejected += 1; else editsAccepted += 1;
					const lang = String(a["coding_agent.edit.language"] ?? "");
					if (lang) langs.set(lang, (langs.get(lang) || 0) + 1);
					break;
				}
				case "coding_agent.git.commit":
					commits += 1; break;
				case "coding_agent.git.pull_request":
					prs += 1; break;
			}
		}

		const totalTokens = fresh + cacheRead + cacheWrite + output;
		const inputTokens = fresh + cacheRead + cacheWrite;
		const tierCostTotal = tierCost.fresh + tierCost.cacheRead + tierCost.cacheWrite + tierCost.output;

		const tokenRows = [
			{ key: m.OBSERVABILITY_BREAKDOWN_TIER_FRESH, tokens: fresh, cost: tierCost.fresh },
			{ key: m.OBSERVABILITY_BREAKDOWN_TIER_CACHE_READ, tokens: cacheRead, cost: tierCost.cacheRead },
			{ key: m.OBSERVABILITY_BREAKDOWN_TIER_CACHE_WRITE, tokens: cacheWrite, cost: tierCost.cacheWrite },
			{ key: m.OBSERVABILITY_BREAKDOWN_TIER_OUTPUT, tokens: output, cost: tierCost.output },
		];

		const toolRows = Array.from(tools.entries())
			.map(([name, t]) => ({ name, ...t }))
			.sort((a, b) => b.calls - a.calls);

		const topLangs = Array.from(langs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);

		return {
			turns, totalTokens, inputTokens, storedCost,
			cacheHit: inputTokens > 0 ? (100 * cacheRead) / inputTokens : 0,
			tokenRows, tierCostTotal,
			toolRows, toolCalls, toolIO,
			linesAdded, linesRemoved, edits, editsAccepted, editsRejected, topLangs,
			responseChars, outputTokens: output, commits, prs,
		};
	}, [record, m]);

	if (data.totalTokens === 0 && data.toolCalls === 0) {
		return <div className="px-3 py-8 text-sm text-stone-400">{m.OBSERVABILITY_BREAKDOWN_EMPTY}</div>;
	}

	const stat = (label: string, value: string) => (
		<div className="flex flex-col gap-0.5">
			<span className="text-[10px] uppercase tracking-wide text-stone-400 dark:text-stone-500">{label}</span>
			<span className="font-mono text-sm font-semibold text-stone-700 dark:text-stone-200">{value}</span>
		</div>
	);

	const sectionTitle = (t: string) => (
		<div className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">{t}</div>
	);

	return (
		<div className="min-w-fit p-3">
			{/* Header strip */}
			<div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-500 dark:text-stone-400">
				<span>{data.turns} {m.OBSERVABILITY_BREAKDOWN_TURNS}</span>
				<span>{m.OBSERVABILITY_BREAKDOWN_TOKENS}: <span className="font-mono font-semibold text-stone-700 dark:text-stone-200">{fmtTokens(data.totalTokens)}</span></span>
				<span>{m.OBSERVABILITY_BREAKDOWN_CACHE_HIT}: <span className="font-mono font-semibold text-stone-700 dark:text-stone-200">{data.cacheHit.toFixed(0)}%</span></span>
				<span>{m.OBSERVABILITY_BREAKDOWN_COST}: <span className="font-mono font-semibold text-stone-700 dark:text-stone-200">{fmtCost(data.storedCost)}</span></span>
			</div>

			{/* 1. Token composition */}
			{sectionTitle(m.OBSERVABILITY_BREAKDOWN_TOKENS_TITLE)}
			<div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
				<table className="w-full border-collapse text-xs">
					<thead>
						<tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500 dark:bg-stone-900 dark:text-stone-400">
							<th className="px-2 py-1.5 font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_KIND}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_TOKENS}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_PCT_TOK}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_COST}</th>
							<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_PCT_COST}</th>
						</tr>
					</thead>
					<tbody>
						{data.tokenRows.map((r) => (
							<tr key={r.key} className="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-900/50">
								<td className="px-2 py-1.5 text-stone-700 dark:text-stone-300">{r.key}</td>
								<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtTokens(r.tokens)}</td>
								<td className="px-2 py-1.5 text-right font-mono tabular-nums">{pct(r.tokens, data.totalTokens)}</td>
								<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(r.cost)}</td>
								<td className="px-2 py-1.5 text-right font-mono tabular-nums text-stone-500 dark:text-stone-400">{pct(r.cost, data.tierCostTotal)}</td>
							</tr>
						))}
					</tbody>
					<tfoot>
						<tr className="border-t border-stone-200 bg-stone-50 font-semibold dark:border-stone-700 dark:bg-stone-900">
							<td className="px-2 py-1.5">{m.OBSERVABILITY_BREAKDOWN_TOTAL_ROW}</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtTokens(data.totalTokens)}</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">100%</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtCost(data.tierCostTotal)}</td>
							<td className="px-2 py-1.5 text-right font-mono tabular-nums">100%</td>
						</tr>
					</tfoot>
				</table>
			</div>

			{/* 2. Tool use */}
			{data.toolRows.length > 0 && (
				<>
					{sectionTitle(m.OBSERVABILITY_BREAKDOWN_TOOLS_TITLE)}
					<div className="overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
						<table className="w-full border-collapse text-xs">
							<thead>
								<tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500 dark:bg-stone-900 dark:text-stone-400">
									<th className="px-2 py-1.5 font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_TOOL}</th>
									<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_CALLS}</th>
									<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_PCT_CALLS}</th>
									<th className="px-2 py-1.5 text-right font-medium">{m.OBSERVABILITY_BREAKDOWN_COL_IO}</th>
								</tr>
							</thead>
							<tbody>
								{data.toolRows.map((t) => (
									<tr key={t.name} className="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-900/50">
										<td className="px-2 py-1.5 font-mono text-stone-700 dark:text-stone-300">{t.name}</td>
										<td className="px-2 py-1.5 text-right font-mono tabular-nums">{t.calls}</td>
										<td className="px-2 py-1.5 text-right font-mono tabular-nums">{pct(t.calls, data.toolCalls)}</td>
										<td className="px-2 py-1.5 text-right font-mono tabular-nums text-stone-500 dark:text-stone-400">{fmtBytes(t.io)}</td>
									</tr>
								))}
							</tbody>
							<tfoot>
								<tr className="border-t border-stone-200 bg-stone-50 font-semibold dark:border-stone-700 dark:bg-stone-900">
									<td className="px-2 py-1.5">{m.OBSERVABILITY_BREAKDOWN_TOTAL_ROW}</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">{data.toolCalls}</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">100%</td>
									<td className="px-2 py-1.5 text-right font-mono tabular-nums">{fmtBytes(data.toolIO)}</td>
								</tr>
							</tfoot>
						</table>
					</div>
				</>
			)}

			{/* 3. Code & content output */}
			{sectionTitle(m.OBSERVABILITY_BREAKDOWN_OUTPUT_TITLE)}
			<div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border border-stone-200 p-3 sm:grid-cols-4 dark:border-stone-800">
				{stat(m.OBSERVABILITY_BREAKDOWN_LINES_ADDED, `+${data.linesAdded.toLocaleString()}`)}
				{stat(m.OBSERVABILITY_BREAKDOWN_LINES_REMOVED, `-${data.linesRemoved.toLocaleString()}`)}
				{stat(m.OBSERVABILITY_BREAKDOWN_LINES_NET, (data.linesAdded - data.linesRemoved).toLocaleString())}
				{stat(m.OBSERVABILITY_BREAKDOWN_EDITS, `${data.edits} (${data.editsAccepted}/${data.editsRejected})`)}
				{stat(m.OBSERVABILITY_BREAKDOWN_OUTPUT_TOKENS, fmtTokens(data.outputTokens))}
				{stat(m.OBSERVABILITY_BREAKDOWN_RESPONSE_CHARS, fmtBytes(data.responseChars))}
				{stat(m.OBSERVABILITY_BREAKDOWN_TOOL_IO, fmtBytes(data.toolIO))}
				{stat(m.OBSERVABILITY_BREAKDOWN_COMMITS, `${data.commits} / ${data.prs}`)}
			</div>
			{data.topLangs.length > 0 && (
				<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone-500 dark:text-stone-400">
					<span className="uppercase tracking-wide">{m.OBSERVABILITY_BREAKDOWN_LANGS}:</span>
					{data.topLangs.map(([lang, n]) => (
						<span key={lang} className="font-mono">{lang} {n}</span>
					))}
				</div>
			)}
			<p className="mt-2 text-[10px] text-stone-400 dark:text-stone-500">{m.OBSERVABILITY_BREAKDOWN_COST_NOTE}</p>
		</div>
	);
}
