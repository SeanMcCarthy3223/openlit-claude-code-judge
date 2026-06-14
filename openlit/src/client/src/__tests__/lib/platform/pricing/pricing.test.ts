jest.mock('@/constants/messages', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    UNAUTHORIZED_USER: 'Unauthorized',
    TRACE_NOT_FOUND: 'Trace not found',
    DATABASE_CONFIG_NOT_FOUND: 'DB config not found',
    TRACE_FETCHING_ERROR: 'Trace fetching error',
  })),
}));
jest.mock('@/lib/session', () => ({
  getCurrentUser: jest.fn(),
}));
jest.mock('@/lib/platform/common', () => ({
  dataCollector: jest.fn(),
  OTEL_TRACES_TABLE_NAME: 'otel_traces',
}));
jest.mock('@/lib/platform/request', () => ({
  getRequestViaSpanId: jest.fn(),
}));
jest.mock('@/lib/platform/providers/provider-registry', () => ({
  ProviderRegistry: {
    getModel: jest.fn(),
  },
}));
jest.mock('@/helpers/server/trace', () => ({
  getTraceMappingKeyFullPath: jest.fn((key: string) => {
    const map: Record<string, string> = {
      cost: 'gen_ai.usage.cost',
      model: 'gen_ai.request.model',
      provider: 'gen_ai.system',
      promptTokens: 'gen_ai.usage.input_tokens',
      completionTokens: 'gen_ai.usage.output_tokens',
      type: 'gen_ai.operation.name',
    };
    return map[key] || key;
  }),
  getTraceMappingKeyFullPaths: jest.fn((key: string) => {
    const map: Record<string, string[]> = {
      promptTokens: ['gen_ai.usage.input_tokens', 'input_tokens', 'prompt_tokens'],
      completionTokens: ['gen_ai.usage.output_tokens', 'output_tokens', 'completion_tokens'],
    };
    return map[key] || [key];
  }),
}));
jest.mock('@/constants/traces', () => ({
  SUPPORTED_EVALUATION_OPERATIONS: ['chat'],
}));
jest.mock('@/utils/sanitizer', () => ({
  __esModule: true,
  default: { sanitizeValue: jest.fn((v: string) => v) },
}));
jest.mock('@/utils/error', () => ({
  throwIfError: jest.fn((condition: boolean, msg: string) => {
    if (condition) throw new Error(msg);
  }),
}));
jest.mock('@/utils/asaw', () => jest.fn());
jest.mock('@/lib/platform/pricing/config', () => ({
  getPricingConfigById: jest.fn(),
}));
jest.mock('@/lib/platform/cron-log', () => ({
  getLastRunCronLogByCronId: jest.fn().mockResolvedValue(null),
  insertCronLog: jest.fn().mockResolvedValue({ err: null }),
}));
jest.mock('@/lib/db-config', () => ({
  getDBConfigById: jest.fn(),
  getDBConfigByUser: jest.fn(),
}));
jest.mock('date-fns', () => ({
  differenceInSeconds: jest.fn(() => 1),
}));
// Mock dynamic import of prisma used inside setPricingForSpanId
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    pricingConfigs: {
      findFirst: jest.fn().mockResolvedValue({ databaseConfigId: 'db-1' }),
    },
  },
}));

import { setPricingForSpanId, autoUpdatePricing } from '@/lib/platform/pricing';
import { getCurrentUser } from '@/lib/session';
import { dataCollector } from '@/lib/platform/common';
import { getRequestViaSpanId } from '@/lib/platform/request';
import { ProviderRegistry } from '@/lib/platform/providers/provider-registry';
import { getPricingConfigById } from '@/lib/platform/pricing/config';
import { getDBConfigById } from '@/lib/db-config';
import { insertCronLog } from '@/lib/platform/cron-log';
import getMessage from '@/constants/messages';
import { throwIfError } from '@/utils/error';
import asaw from '@/utils/asaw';

beforeEach(() => {
  jest.resetAllMocks();

  (getMessage as jest.Mock).mockReturnValue({
    UNAUTHORIZED_USER: 'Unauthorized',
    TRACE_NOT_FOUND: 'Trace not found',
    DATABASE_CONFIG_NOT_FOUND: 'DB config not found',
    TRACE_FETCHING_ERROR: 'Trace fetching error',
  });

  (throwIfError as jest.Mock).mockImplementation((condition: boolean, msg: string) => {
    if (condition) throw new Error(msg);
  });

  // Re-apply insertCronLog mock
  (insertCronLog as jest.Mock).mockResolvedValue({ err: null });

  // Re-apply prisma mock for setPricingForSpanId's dynamic import
  const prisma = require('@/lib/prisma').default;
  prisma.pricingConfigs.findFirst.mockResolvedValue({ databaseConfigId: 'db-1' });
});

describe('setPricingForSpanId', () => {
  const mockTrace = {
    SpanId: 'span-1',
    Timestamp: '2026-01-01',
    SpanAttributes: {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': '100',
      'gen_ai.usage.output_tokens': '200',
    },
  };

  it('computes and writes cost successfully', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({ record: mockTrace });
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });
    (dataCollector as jest.Mock).mockResolvedValue({ err: null });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.cost).toBeCloseTo(
      (100 / 1_000_000) * 2.5 + (200 / 1_000_000) * 10.0
    );
    // Should call ALTER TABLE to update the trace
    expect(dataCollector).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('mapUpdate'),
      }),
      'exec',
      expect.any(String)
    );
  });

  it('computes cost from direct input and output token attributes', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          'gen_ai.system': 'openai',
          'gen_ai.request.model': 'gpt-4o',
          input_tokens: '300',
          output_tokens: '400',
        },
      },
    });
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });
    (dataCollector as jest.Mock).mockResolvedValue({ err: null });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(true);
    expect(result.data!.cost).toBeCloseTo(
      (300 / 1_000_000) * 2.5 + (400 / 1_000_000) * 10.0
    );
  });

  it('keeps canonical gen_ai token attributes ahead of direct fallback keys', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          'gen_ai.system': 'openai',
          'gen_ai.request.model': 'gpt-4o',
          'gen_ai.usage.input_tokens': '100',
          'gen_ai.usage.output_tokens': '200',
          input_tokens: '300',
          output_tokens: '400',
        },
      },
    });
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });
    (dataCollector as jest.Mock).mockResolvedValue({ err: null });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(true);
    expect(result.data!.cost).toBeCloseTo(
      (100 / 1_000_000) * 2.5 + (200 / 1_000_000) * 10.0
    );
  });

  it('returns error when model not found', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({ record: mockTrace });
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue(null);

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(false);
    expect(result.err).toContain('not found');
  });

  it('returns error when trace has no provider', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {},
      },
    });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(false);
    expect(result.err).toContain('Missing');
  });

  it('throws when user is not authenticated', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue(null);

    await expect(setPricingForSpanId('span-1')).rejects.toThrow('Unauthorized');
  });

  it('skips the coding-agent session aggregate span (does not re-price it)', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'session-root',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          // Aggregate session root: single model + summed tokens, plus the
          // tell-tale session.cost_usd. Must NOT be priced (would value a
          // mixed-model run at Opus rates → the $20 inflation bug).
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-opus-4-8',
          'gen_ai.usage.input_tokens': '3844025',
          'gen_ai.usage.output_tokens': '37143',
          'coding_agent.session.cost_usd': '20.1487',
        },
      },
    });

    const result = await setPricingForSpanId('session-root');

    expect(result.success).toBe(false);
    expect(result.err).toContain('session aggregate');
    // Crucially: never reached the provider registry or wrote a cost.
    expect(ProviderRegistry.getModel).not.toHaveBeenCalled();
    expect(dataCollector).not.toHaveBeenCalled();
  });

  it('returns error when zero tokens', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          'gen_ai.system': 'openai',
          'gen_ai.request.model': 'gpt-4o',
          'gen_ai.usage.input_tokens': '0',
          'gen_ai.usage.output_tokens': '0',
        },
      },
    });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(false);
    expect(result.err).toContain('zero tokens');
  });

  it('returns error when writeCostToTrace fails', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({ record: mockTrace });
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });
    (dataCollector as jest.Mock).mockResolvedValue({ err: 'write failed' });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(false);
    expect(result.err).toBe('write failed');
  });

  it('returns DB config not found when no config + no fallback', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({ record: mockTrace });
    const prisma = require('@/lib/prisma').default;
    prisma.pricingConfigs.findFirst.mockResolvedValue(null);
    // The fallback uses asaw(getDBConfigByUser(true)) — return null dbConfig
    (asaw as jest.Mock).mockResolvedValue([null, null]);

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(false);
    expect(result.err).toBe('DB config not found');
  });

  it('refuses to overwrite a span that already has an authoritative captured cost', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-opus-4-8',
          'gen_ai.usage.input_tokens': '3844025',
          'gen_ai.usage.output_tokens': '37143',
          // CLI already stamped a cache-aware cost; manual Recalculate must NOT
          // clobber it (the cache-blind recompute would be ~5x higher).
          'gen_ai.usage.cost': '41.5789',
        },
      },
    });

    const result = await setPricingForSpanId('span-1');

    expect(result.success).toBe(false);
    expect(result.err).toContain('authoritative');
    // Must short-circuit before touching the registry or writing anything.
    expect(ProviderRegistry.getModel).not.toHaveBeenCalled();
    expect(dataCollector).not.toHaveBeenCalled();
  });

  it('prices cache tiers separately with explicit per-model cache rates', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-opus-4-8',
          // input_tokens INCLUDES cache (CLI convention); no captured cost so
          // the guard allows pricing.
          'gen_ai.usage.input_tokens': '3844025',
          'gen_ai.usage.output_tokens': '37143',
          'gen_ai.usage.cache.read_input_tokens': '3000000',
          'gen_ai.usage.cache.creation_input_tokens': '500000',
        },
      },
    });
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'claude-opus-4-8',
      inputPricePerMToken: 5.0,
      outputPricePerMToken: 25.0,
      cacheReadPricePerMToken: 0.5,
      cacheCreationPricePerMToken: 6.25,
    });
    (dataCollector as jest.Mock).mockResolvedValue({ err: null });

    const result = await setPricingForSpanId('span-1');

    const fresh = 3844025 - 3000000 - 500000;
    const expected =
      (fresh * 5.0 + 3000000 * 0.5 + 500000 * 6.25 + 37143 * 25.0) / 1_000_000;
    expect(result.success).toBe(true);
    expect(result.data!.cost).toBeCloseTo(expected, 6);
    // Sanity: must be far below the cache-blind value (entire input at $5/M).
    const cacheBlind = (3844025 * 5.0 + 37143 * 25.0) / 1_000_000;
    expect(result.data!.cost).toBeLessThan(cacheBlind / 2);
  });

  it('falls back to Anthropic cache multipliers when no per-model cache rates are set', async () => {
    (getCurrentUser as jest.Mock).mockResolvedValue({ id: 'user-1' });
    (getRequestViaSpanId as jest.Mock).mockResolvedValue({
      record: {
        SpanId: 'span-1',
        Timestamp: '2026-01-01',
        SpanAttributes: {
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': 'claude-opus-4-8',
          'gen_ai.usage.input_tokens': '3844025',
          'gen_ai.usage.output_tokens': '37143',
          'gen_ai.usage.cache.read_input_tokens': '3000000',
          'gen_ai.usage.cache.creation_input_tokens': '500000',
        },
      },
    });
    // Model added with ONLY input+output (exactly what Manage Models collects today).
    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'claude-opus-4-8',
      inputPricePerMToken: 5.0,
      outputPricePerMToken: 25.0,
    });
    (dataCollector as jest.Mock).mockResolvedValue({ err: null });

    const result = await setPricingForSpanId('span-1');

    // 5 * 0.1 = 0.50 (read), 5 * 1.25 = 6.25 (write) -> same as explicit rates.
    const fresh = 3844025 - 3000000 - 500000;
    const expected =
      (fresh * 5.0 + 3000000 * 0.5 + 500000 * 6.25 + 37143 * 25.0) / 1_000_000;
    expect(result.success).toBe(true);
    expect(result.data!.cost).toBeCloseTo(expected, 6);
  });
});

describe('autoUpdatePricing', () => {
  it('processes traces and writes costs', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue({
      id: 'pc-1',
      databaseConfigId: 'db-1',
    });
    (asaw as jest.Mock).mockResolvedValue([null, { id: 'db-1' }]);
    (dataCollector as jest.Mock)
      // First call: SELECT traces
      .mockResolvedValueOnce({
        data: [
          {
            SpanId: 'span-1',
            Timestamp: '2026-01-01',
            SpanAttributes: {
              'gen_ai.system': 'openai',
              'gen_ai.request.model': 'gpt-4o',
              'gen_ai.usage.input_tokens': '100',
              'gen_ai.usage.output_tokens': '200',
            },
          },
        ],
      })
      // Second call: ALTER TABLE UPDATE
      .mockResolvedValueOnce({ err: null });

    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });

    const result = await autoUpdatePricing({
      pricingConfigId: 'pc-1',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(true);
    expect(insertCronLog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ totalUpdated: 1 }),
      }),
      'db-1'
    );
  });

  it('auto pricing supports direct token attributes', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue({
      id: 'pc-1',
      databaseConfigId: 'db-1',
    });
    (asaw as jest.Mock).mockResolvedValue([null, { id: 'db-1' }]);
    (dataCollector as jest.Mock)
      .mockResolvedValueOnce({
        data: [
          {
            SpanId: 'span-1',
            Timestamp: '2026-01-01',
            SpanAttributes: {
              'gen_ai.system': 'openai',
              'gen_ai.request.model': 'gpt-4o',
              input_tokens: '100',
              output_tokens: '200',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ err: null });

    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });

    const result = await autoUpdatePricing({
      pricingConfigId: 'pc-1',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(true);
    expect(insertCronLog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ totalUpdated: 1 }),
      }),
      'db-1'
    );
  });

  it('returns error when pricing config not found', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue(null);

    const result = await autoUpdatePricing({
      pricingConfigId: 'nonexistent',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(false);
    expect(result.err).toContain('not found');
  });

  it('returns error when DB config not found', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue({
      id: 'pc-1',
      databaseConfigId: 'db-missing',
    });
    (asaw as jest.Mock).mockResolvedValue([null, null]);

    const result = await autoUpdatePricing({
      pricingConfigId: 'pc-1',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(false);
    expect(result.err).toBe('DB config not found');
  });

  it('logs FAILURE on trace fetch error', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue({
      id: 'pc-1',
      databaseConfigId: 'db-1',
    });
    (asaw as jest.Mock).mockResolvedValue([null, { id: 'db-1' }]);
    (dataCollector as jest.Mock).mockResolvedValueOnce({ err: 'fetch failed' });

    const result = await autoUpdatePricing({
      pricingConfigId: 'pc-1',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(false);
    expect(insertCronLog).toHaveBeenCalledWith(
      expect.objectContaining({
        runStatus: 'FAILURE',
      }),
      'db-1'
    );
  });

  it('counts errors when writeCostToTrace fails', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue({
      id: 'pc-1',
      databaseConfigId: 'db-1',
    });
    (asaw as jest.Mock).mockResolvedValue([null, { id: 'db-1' }]);
    (dataCollector as jest.Mock)
      .mockResolvedValueOnce({
        data: [
          {
            SpanId: 'span-1',
            Timestamp: '2026-01-01',
            SpanAttributes: {
              'gen_ai.system': 'openai',
              'gen_ai.request.model': 'gpt-4o',
              'gen_ai.usage.input_tokens': '100',
              'gen_ai.usage.output_tokens': '200',
            },
          },
        ],
      })
      .mockResolvedValueOnce({ err: 'write failed' });

    (ProviderRegistry.getModel as jest.Mock).mockResolvedValue({
      id: 'gpt-4o',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10.0,
    });

    const result = await autoUpdatePricing({
      pricingConfigId: 'pc-1',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(true);
    expect(insertCronLog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          totalUpdated: 0,
          totalFailed: 1,
        }),
      }),
      'db-1'
    );
  });

  it('skips traces without provider/model', async () => {
    (getPricingConfigById as jest.Mock).mockResolvedValue({
      id: 'pc-1',
      databaseConfigId: 'db-1',
    });
    (asaw as jest.Mock).mockResolvedValue([null, { id: 'db-1' }]);
    (dataCollector as jest.Mock).mockResolvedValueOnce({
      data: [
        {
          SpanId: 'span-no-model',
          Timestamp: '2026-01-01',
          SpanAttributes: {},
        },
      ],
    });

    const result = await autoUpdatePricing({
      pricingConfigId: 'pc-1',
      cronId: 'cron-1',
    });

    expect(result.success).toBe(true);
    // No ALTER TABLE calls — trace was skipped
    expect(insertCronLog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ totalSkipped: 1, totalUpdated: 0 }),
      }),
      'db-1'
    );
  });
});
