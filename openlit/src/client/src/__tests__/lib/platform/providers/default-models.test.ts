import { DEFAULT_MODELS_BY_PROVIDER } from '@/lib/platform/providers/default-models';

describe('default-models', () => {
  it('exports a non-empty record of providers', () => {
    expect(typeof DEFAULT_MODELS_BY_PROVIDER).toBe('object');
    const providers = Object.keys(DEFAULT_MODELS_BY_PROVIDER);
    expect(providers.length).toBeGreaterThan(0);
  });

  it('includes the expected core providers', () => {
    const expectedProviders = [
      'openai', 'anthropic', 'google', 'mistral', 'groq',
      'perplexity', 'azure', 'cohere', 'together', 'fireworks',
      'deepseek', 'xai', 'huggingface', 'replicate',
    ];
    for (const provider of expectedProviders) {
      expect(DEFAULT_MODELS_BY_PROVIDER).toHaveProperty(provider);
    }
  });

  // Regression: claude-fable-5 was absent from the Anthropic catalog, so
  // ProviderRegistry.getModel() (an exact model_id match) returned null and
  // computeCostForTrace could not price a single Fable 5 turn — the
  // dashboard summed the captured gen_ai.usage.cost of 0 and showed $0.00.
  it('prices claude-fable-5 at its own $10/$50 tier, not the Opus tier', () => {
    const fable = DEFAULT_MODELS_BY_PROVIDER.anthropic.find(
      (m) => m.id === 'claude-fable-5'
    );
    expect(fable).toBeDefined();
    expect(fable!.inputPricePerMToken).toBe(10.0);
    expect(fable!.outputPricePerMToken).toBe(50.0);

    // Fable is above Opus; a copy-paste of the Opus rate is the likely
    // regression, so pin the relationship explicitly.
    const opus = DEFAULT_MODELS_BY_PROVIDER.anthropic.find(
      (m) => m.id === 'claude-opus-4-8'
    );
    expect(opus).toBeDefined();
    expect(fable!.inputPricePerMToken).toBeGreaterThan(opus!.inputPricePerMToken);
    expect(fable!.outputPricePerMToken).toBeGreaterThan(opus!.outputPricePerMToken);
  });

  it('has no duplicate model ids within a provider', () => {
    for (const [provider, models] of Object.entries(DEFAULT_MODELS_BY_PROVIDER)) {
      const ids = models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('each provider has at least one model', () => {
    for (const [provider, models] of Object.entries(DEFAULT_MODELS_BY_PROVIDER)) {
      expect(models.length).toBeGreaterThan(0);
    }
  });

  it('each model has the required fields', () => {
    for (const [provider, models] of Object.entries(DEFAULT_MODELS_BY_PROVIDER)) {
      for (const model of models) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('displayName');
        expect(model).toHaveProperty('contextWindow');
        expect(typeof model.contextWindow).toBe('number');
        expect(model).toHaveProperty('inputPricePerMToken');
        expect(typeof model.inputPricePerMToken).toBe('number');
        expect(model).toHaveProperty('outputPricePerMToken');
        expect(typeof model.outputPricePerMToken).toBe('number');
      }
    }
  });

  it('model IDs are non-empty strings', () => {
    for (const models of Object.values(DEFAULT_MODELS_BY_PROVIDER)) {
      for (const model of models) {
        expect(typeof model.id).toBe('string');
        expect(model.id.length).toBeGreaterThan(0);
      }
    }
  });
});
