import getMessage from "@/constants/messages";
import { getCurrentUser } from "@/lib/session";
import { throwIfError } from "@/utils/error";
import { dataCollector, OTEL_TRACES_TABLE_NAME } from "@/lib/platform/common";
import {
	getTraceMappingKeyFullPath,
	getTraceMappingKeyFullPaths,
} from "@/helpers/server/trace";
import { SUPPORTED_EVALUATION_OPERATIONS } from "@/constants/traces";
import { getDBConfigById } from "@/lib/db-config";
import { getRequestViaSpanId } from "@/lib/platform/request";
import { ProviderRegistry } from "@/lib/platform/providers/provider-registry";
import { getPricingConfigById } from "./config";
import { getLastRunCronLogByCronId, insertCronLog } from "@/lib/platform/cron-log";
import { CronRunStatus, CronType } from "@/types/cron";
import { differenceInSeconds } from "date-fns";
import Sanitizer from "@/utils/sanitizer";
import asaw from "@/utils/asaw";

const COST_KEY = getTraceMappingKeyFullPath("cost") as string; // gen_ai.usage.cost
// Present ONLY on the coding-agent session ROOT span. That span carries a
// whole-session aggregate (its gen_ai.usage.* totals are the sum of every
// turn across all agents) priced against a single gen_ai.request.model, so
// it must never be (re)priced — see computeCostForTrace.
const SESSION_AGGREGATE_KEY = "coding_agent.session.cost_usd";
const MODEL_KEY = getTraceMappingKeyFullPath("model") as string; // gen_ai.request.model
const PROVIDER_KEY = getTraceMappingKeyFullPath("provider") as string; // gen_ai.system
const TYPE_KEY = getTraceMappingKeyFullPath("type") as string; // gen_ai.operation.name
const PROMPT_TOKENS_KEYS = getTraceMappingKeyFullPaths("promptTokens") as string[];
const COMPLETION_TOKENS_KEYS = getTraceMappingKeyFullPaths(
	"completionTokens"
) as string[];
// Cache-token attribute keys vary by span source: the coding-agent CLI (and the
// verified ClickHouse store) write the dotted "cache." form, while the OpenLIT
// SDK trace-mapping uses "cache_read.". We read both, plus the raw Anthropic
// field name, so cache pricing works regardless of who produced the span.
const CACHE_READ_TOKENS_KEYS = [
	"gen_ai.usage.cache.read_input_tokens", // coding-agent CLI / store (verified live)
	"gen_ai.usage.cache_read.input_tokens", // openlit SDK trace-mapping form
	"cache_read_input_tokens", // raw Anthropic usage field
];
const CACHE_CREATION_TOKENS_KEYS = [
	"gen_ai.usage.cache.creation_input_tokens",
	"gen_ai.usage.cache_creation.input_tokens",
	"cache_creation_input_tokens",
];
// Anthropic's published prompt-cache multipliers, used only when a model record
// has no explicit per-tier cache rate configured. Reads are ~0.1x input, writes
// ~1.25x input. (cli/internal/coding/pricing/pricing.go encodes the same ratios
// as absolute rates, e.g. opus-4-8 input $5 -> cache-read $0.50, cache-write $6.25.)
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

interface TraceRow {
	SpanId: string;
	Timestamp: string;
	SpanAttributes: Record<string, string>;
}

function getAttr(trace: TraceRow, key: string): string {
	return (trace.SpanAttributes || {})[key] ?? "";
}

function getNumericAttr(trace: TraceRow, keys: string[]): number {
	const attributes = trace.SpanAttributes || {};

	for (const key of keys) {
		const value = attributes[key];
		if (value === undefined || value === null || value === "") {
			continue;
		}

		const numericValue = Number(value);
		if (Number.isFinite(numericValue)) {
			return numericValue;
		}
	}

	return 0;
}

/**
 * Compute the cost for a single trace by looking up the model in
 * openlit_provider_models and applying token-based pricing.
 * Returns null if pricing can't be determined (missing model/tokens).
 */
async function computeCostForTrace(
	trace: TraceRow,
	databaseConfigId: string
): Promise<{ cost: number | null; reason?: string }> {
	// Never (re)price the coding-agent session ROOT span. Its tokens are the
	// sum of every turn across all agents, priced against a single model, so
	// pricing it values a mixed-model run (e.g. an Opus orchestrator + Haiku
	// subagents) at one model's rate AND duplicates the per-turn leaves. The
	// individual `coding_agent.llm.turn` spans are the priceable units; the
	// session span already carries an authoritative coding_agent.session.cost_usd.
	if (getAttr(trace, SESSION_AGGREGATE_KEY) !== "") {
		return {
			cost: null,
			reason:
				"Span is a coding-agent session aggregate (carries coding_agent.session.cost_usd); only per-turn spans are priced.",
		};
	}

	const provider = getAttr(trace, PROVIDER_KEY);
	const model = getAttr(trace, MODEL_KEY);
	const promptTokens = getNumericAttr(trace, PROMPT_TOKENS_KEYS);
	const completionTokens = getNumericAttr(trace, COMPLETION_TOKENS_KEYS);

	if (!provider || !model) {
		const reason = `Missing ${!provider ? "provider" : ""}${
			!provider && !model ? " and " : ""
		}${!model ? "model" : ""} attribute on the trace (provider='${provider}', model='${model}')`;
		return { cost: null, reason };
	}
	if (promptTokens === 0 && completionTokens === 0) {
		const reason = `Trace has zero tokens (prompt=${promptTokens}, completion=${completionTokens})`;
		return { cost: null, reason };
	}

	const modelMeta = await ProviderRegistry.getModel(
		provider,
		model,
		databaseConfigId
	);
	if (!modelMeta) {
		const reason = `Model '${model}' not found under provider '${provider}' in openlit_provider_models. Add it in Manage Models.`;
		return { cost: null, reason };
	}

	// promptTokens (gen_ai.usage.input_tokens) is the TOTAL input the model saw
	// and INCLUDES cache reads + cache writes — the coding-agent CLI sums them
	// in at capture (see handle.go: ti += fresh + creation + read). Pricing the
	// whole thing at the input rate over-bills cache-heavy turns by up to ~5x,
	// because Anthropic cache reads cost ~0.1x input and cache writes ~1.25x.
	// Split the tiers and price each, mirroring the CLI oracle pricing.go Cost().
	const cacheReadTokens = getNumericAttr(trace, CACHE_READ_TOKENS_KEYS);
	const cacheCreationTokens = getNumericAttr(trace, CACHE_CREATION_TOKENS_KEYS);
	const freshInput = Math.max(
		0,
		promptTokens - cacheReadTokens - cacheCreationTokens
	);

	const inputRate = modelMeta.inputPricePerMToken;
	const isAnthropic = provider.toLowerCase().includes("anthropic");
	// Use the explicit per-model cache rate when configured (Manage Models);
	// otherwise fall back to the provider's published cache multiplier so cache
	// pricing is correct even before per-model rates are entered. For non-cache
	// vendors this collapses to the input rate (a no-op when cache tokens are 0).
	const cacheReadRate =
		modelMeta.cacheReadPricePerMToken && modelMeta.cacheReadPricePerMToken > 0
			? modelMeta.cacheReadPricePerMToken
			: isAnthropic
				? inputRate * ANTHROPIC_CACHE_READ_MULTIPLIER
				: inputRate;
	const cacheCreationRate =
		modelMeta.cacheCreationPricePerMToken &&
		modelMeta.cacheCreationPricePerMToken > 0
			? modelMeta.cacheCreationPricePerMToken
			: isAnthropic
				? inputRate * ANTHROPIC_CACHE_WRITE_MULTIPLIER
				: inputRate;

	const cost =
		(freshInput * inputRate +
			cacheReadTokens * cacheReadRate +
			cacheCreationTokens * cacheCreationRate +
			completionTokens * modelMeta.outputPricePerMToken) /
		1_000_000;

	return { cost };
}

/**
 * Update the gen_ai.usage.cost attribute on a specific span in otel_traces.
 * Uses ClickHouse's mapUpdate (adds/replaces a key in a Map column).
 */
async function writeCostToTrace(
	spanId: string,
	cost: number,
	databaseConfigId: string
): Promise<{ err?: string }> {
	const sanitizedSpanId = Sanitizer.sanitizeValue(spanId);
	// toString keeps the attribute format consistent with how SDKs write it
	const costString = cost.toFixed(10);
	const query = `
		ALTER TABLE ${OTEL_TRACES_TABLE_NAME}
		UPDATE SpanAttributes = mapUpdate(SpanAttributes, map('${COST_KEY}', '${costString}'))
		WHERE SpanId = '${sanitizedSpanId}'
	`;

	const { err } = await dataCollector({ query }, "exec", databaseConfigId);
	return { err: err as string | undefined };
}

/**
 * Manually recalculate + persist cost for a single span.
 * Exposed via POST /api/pricing/[spanId].
 */
export async function setPricingForSpanId(spanId: string) {
	const user = await getCurrentUser();
	throwIfError(!user, getMessage().UNAUTHORIZED_USER);

	const sanitizedSpanId = Sanitizer.sanitizeValue(spanId);
	const { record: spanData, err: traceErr } = await getRequestViaSpanId(
		sanitizedSpanId
	);
	throwIfError(!!traceErr, getMessage().TRACE_NOT_FOUND);
	throwIfError(
		!(spanData as any)?.SpanId,
		getMessage().TRACE_NOT_FOUND
	);

	const trace = spanData as TraceRow;

	// Defense-in-depth: never overwrite an authoritative captured cost.
	// Coding-agent CLIs (Claude Code / Cursor / Codex) stamp gen_ai.usage.cost
	// at ingest using CACHE-AWARE pricing (Anthropic cache reads ~0.1x input,
	// cache writes ~1.25x input). Recomputing here from the Manage-Models rates
	// would silently replace that — and because the model schema currently
	// carries only input+output rates (no cache tiers), the recompute is
	// CACHE-BLIND and over-bills cache-heavy turns by up to ~5x. So we refuse
	// to re-price a span that already has a non-zero captured cost, mirroring
	// the autoUpdatePricing backfill guard (see that function's comment).
	const existingCost = getAttr(trace, COST_KEY);
	if (existingCost !== "" && Number(existingCost) > 0) {
		return {
			success: false,
			err: `Span already carries an authoritative captured cost ($${Number(
				existingCost
			).toFixed(
				6
			)}). Vendor/CLI cost is cache-aware and treated as the source of truth; refusing to overwrite it with a recomputed value.`,
		};
	}

	// The trace itself doesn't tell us the dbConfig; fall back to the default
	const { default: prisma } = await import("@/lib/prisma");
	const pricingConfig = await prisma.pricingConfigs.findFirst();
	const dbConfigId =
		pricingConfig?.databaseConfigId ||
		(await (async () => {
			const { getDBConfigByUser } = await import("@/lib/db-config");
			const [, dbc] = await asaw(getDBConfigByUser(true));
			return dbc?.id;
		})());

	if (!dbConfigId) {
		return { success: false, err: getMessage().DATABASE_CONFIG_NOT_FOUND };
	}

	const { cost, reason } = await computeCostForTrace(trace, dbConfigId);
	if (cost === null) {
		return {
			success: false,
			err:
				reason ||
				"Could not compute cost — missing provider/model/tokens or model not in openlit_provider_models",
		};
	}

	const { err } = await writeCostToTrace(trace.SpanId, cost, dbConfigId);
	if (err) return { success: false, err };

	return { success: true, data: { spanId: trace.SpanId, cost } };
}

interface AutoPricingPayload {
	pricingConfigId: string;
	cronId: string;
}

/**
 * Auto pricing: fetch traces in the window since last cron run and
 * recompute + persist cost for each. Called by the /api/pricing/auto cron.
 */
export async function autoUpdatePricing(payload: AutoPricingPayload) {
	const startedAt = new Date();
	const cronLogObject = {
		cronId: payload.cronId,
		cronType: CronType.SPAN_PRICING,
		metaProperties: { ...payload },
		startedAt,
	};

	const pricingConfig = await getPricingConfigById(payload.pricingConfigId);
	if (!pricingConfig) {
		return { success: false, err: "Pricing config not found" };
	}

	const [dbConfigErr, dbConfig] = await asaw(
		getDBConfigById({ id: pricingConfig.databaseConfigId })
	);

	if (dbConfigErr || !dbConfig?.id) {
		return { success: false, err: getMessage().DATABASE_CONFIG_NOT_FOUND };
	}

	const lastRunTime = await getLastRunCronLogByCronId(payload.cronId);

	// Only LLM-type spans with tokens recorded. Crucially, we skip
	// any span that already carries a `gen_ai.usage.cost` from the
	// instrumentation/hook. Vendor-emitted cost is authoritative
	// (Cursor / Codex / Claude Code stamp the provider's actual
	// billed price, which may differ from list pricing for enterprise
	// tiers); recomputing would silently overwrite that with our
	// pricing-table estimate. This makes auto-pricing a true *backfill*
	// path — it only writes when nothing was captured at ingest.
	const typeKeyPath = `SpanAttributes['${TYPE_KEY}']`;
	const costKeyPath = `SpanAttributes['${COST_KEY}']`;
	const operationList = SUPPORTED_EVALUATION_OPERATIONS.map(
		(op) => `'${op}'`
	).join(", ");

	const query = `
		SELECT SpanId, Timestamp, SpanAttributes
		FROM ${OTEL_TRACES_TABLE_NAME}
		WHERE ${typeKeyPath} IN (${operationList})
			AND (${costKeyPath} = '' OR toFloat64OrZero(${costKeyPath}) = 0)
		${
			lastRunTime
				? `AND Timestamp >= parseDateTimeBestEffort('${lastRunTime}')`
				: ""
		}
		ORDER BY Timestamp
	`;

	const { data, err } = await dataCollector({ query }, "query", dbConfig.id);

	if (err) {
		const finishedAt = new Date();
		await insertCronLog(
			{
				...cronLogObject,
				runStatus: CronRunStatus.FAILURE,
				errorStacktrace: {
					error: `${getMessage().TRACE_FETCHING_ERROR} : ${err}`,
				},
				finishedAt,
				duration: differenceInSeconds(finishedAt, startedAt),
			},
			dbConfig.id
		);
		return { success: false, err: err as string };
	}

	const traces = (data as TraceRow[]) || [];
	let errorCount = 0;
	let updatedCount = 0;
	const errorObject: Record<string, string> = {};

	// Run sequentially to avoid hammering ClickHouse with many ALTER mutations
	for (const trace of traces) {
		try {
			const { cost } = await computeCostForTrace(trace, dbConfig.id);
			if (cost === null) {
				// Skip traces we can't price (no counting as error)
				continue;
			}
			const { err: writeErr } = await writeCostToTrace(
				trace.SpanId,
				cost,
				dbConfig.id
			);
			if (writeErr) {
				errorCount++;
				errorObject[trace.SpanId] = writeErr;
			} else {
				updatedCount++;
			}
		} catch (e: any) {
			errorCount++;
			errorObject[trace.SpanId] = e.message || String(e);
		}
	}

	const finishedAt = new Date();
	const totalProcessed = updatedCount + errorCount;
	const runStatus =
		totalProcessed === 0
			? CronRunStatus.SUCCESS
			: errorCount === 0
				? CronRunStatus.SUCCESS
				: errorCount === totalProcessed
					? CronRunStatus.FAILURE
					: CronRunStatus.PARTIAL_SUCCESS;

	const { err: cronLogErr } = await insertCronLog(
		{
			...cronLogObject,
			runStatus,
			errorStacktrace: errorObject,
			meta: {
				totalSpans: traces.length,
				totalUpdated: updatedCount,
				totalFailed: errorCount,
				totalSkipped: traces.length - totalProcessed,
			},
			finishedAt,
			duration: differenceInSeconds(finishedAt, startedAt),
		},
		dbConfig.id
	);

	return { success: true, err: cronLogErr };
}
