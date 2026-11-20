/**
 * Multi-provider AI gateway used by the group agents.
 *
 * Responsibilities:
 *  - choose a provider/model per task,
 *  - apply the optional free-model filter where provider metadata allows it,
 *  - enforce per-provider request rate limits,
 *  - fall back automatically when a model is missing, rate-limited or down,
 *  - record token usage and cost without ever persisting API keys.
 *
 * The existing personal-assistant Gemini pipeline is untouched; this gateway is
 * used only for group work.
 */
import { getProvider, listProviderIds, providerRuntime, redactSecrets } from './providers.js';

/** @typedef {'chat'|'moderation'|'summary'|'report'|'memory'} AITask */

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

export class AIGatewayError extends Error {
  constructor(message, { attempts = [], code = 'gateway_error' } = {}) {
    super(message);
    this.name = 'AIGatewayError';
    this.attempts = attempts;
    this.code = code;
  }
}

export class AIGateway {
  /**
   * @param {{ config: object, usageStore?: object, logger?: object, fetchImpl?: Function, clock?: () => number }} options
   */
  constructor({ config, usageStore = null, logger = console, fetchImpl = null, clock = () => Date.now() }) {
    this.config = config;
    this.usageStore = usageStore;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.modelCache = new Map();
    this.rateWindows = new Map();
    this.providerOrder = String(config.AI_PROVIDER_ORDER || '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => listProviderIds().includes(p));
    if (this.providerOrder.length === 0) this.providerOrder = listProviderIds();
  }

  secrets() {
    const c = this.config;
    return [c.GEMINI_API_KEY, c.OPENROUTER_API_KEY, c.QWEN_API_KEY, c.OPENAI_COMPAT_API_KEY].filter(Boolean);
  }

  describe() {
    return {
      providerOrder: this.providerOrder,
      freeOnly: Boolean(this.config.AI_FREE_ONLY),
      rateLimitPerMinute: Number(this.config.AI_RATE_LIMIT_PER_MINUTE) || 30,
      maxFallbacks: Number(this.config.AI_MAX_FALLBACKS) || 3,
      providers: this.providerOrder.map((id) => {
        const provider = getProvider(id);
        const runtime = providerRuntime(id, this.config);
        return {
          id,
          label: provider.label,
          configured: runtime.configured,
          supportsFreeFilter: provider.supportsFreeFilter,
          defaultModel: runtime.defaultModel,
        };
      }),
    };
  }

  /**
   * @param {string} providerId
   * @param {{ refresh?: boolean, freeOnly?: boolean }} [options]
   */
  async listModels(providerId, { refresh = false, freeOnly = false } = {}) {
    const provider = getProvider(providerId);
    if (!provider) throw new AIGatewayError(`Unknown provider: ${providerId}`, { code: 'unknown_provider' });
    const runtime = providerRuntime(providerId, this.config);
    if (!runtime.configured)
      return { provider: providerId, configured: false, models: [], error: 'No API key configured' };

    const cacheKey = `${providerId}:${runtime.baseUrl}`;
    const cached = this.modelCache.get(cacheKey);
    const now = this.clock();
    if (!refresh && cached && now - cached.at < MODEL_CACHE_TTL_MS) {
      return filterModels(cached.value, freeOnly);
    }

    try {
      const models = await provider.listModels({
        providerId,
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.config.AI_REQUEST_TIMEOUT_MS,
        appName: this.config.OPENROUTER_APP_NAME,
      });
      const value = { provider: providerId, configured: true, models };
      this.modelCache.set(cacheKey, { at: now, value });
      return filterModels(value, freeOnly);
    } catch (err) {
      const message = redactSecrets(err.message, this.secrets());
      if (this.usageStore) {
        await this.usageStore.recordError({ provider: providerId, error: message }).catch(() => {});
      }
      return { provider: providerId, configured: true, models: [], error: message };
    }
  }

  /**
   * Lists models for every provider. Free filtering only applies to providers
   * whose metadata exposes pricing (OpenRouter today).
   */
  async listAllModels({ refresh = false, freeOnly = false } = {}) {
    const results = await Promise.all(
      this.providerOrder.map((id) => this.listModels(id, { refresh, freeOnly: freeOnly && modelFilterSupported(id) }))
    );
    return {
      freeOnly: Boolean(freeOnly),
      providers: results,
    };
  }

  /**
   * @param {object} input
   * @param {AITask} input.task
   * @param {string} [input.groupJid]
   * @param {Array<{role: string, content: string}>} input.messages
   * @param {string} [input.system]
   * @param {string} [input.model] explicit override ("provider:model" or plain)
   * @param {object} [input.taskModels] group settings.models map
   * @param {number} [input.maxTokens]
   * @param {number} [input.temperature]
   * @param {boolean} [input.freeOnly]
   */
  async complete({
    task = 'chat',
    groupJid = '',
    messages = [],
    system = '',
    model = '',
    taskModels = {},
    maxTokens = 900,
    temperature = 0.6,
    freeOnly = false,
  } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AIGatewayError('No messages supplied', { code: 'invalid_input' });
    }
    const candidates = await this.#buildCandidates({ task, model, taskModels, freeOnly });
    if (candidates.length === 0) {
      throw new AIGatewayError('No configured AI provider/model is available', { code: 'no_candidates' });
    }

    const maxAttempts = Math.max(1, Math.min(Number(this.config.AI_MAX_FALLBACKS) || 3, 8));
    const attempts = [];
    let attempted = 0;

    for (const candidate of candidates) {
      if (attempted >= maxAttempts) break;
      const provider = getProvider(candidate.provider);
      const runtime = providerRuntime(candidate.provider, this.config);
      if (!runtime.configured) continue;
      if (!this.#allow(candidate.provider)) {
        attempts.push({ provider: candidate.provider, model: candidate.model, error: 'rate_limited_local', status: 0 });
        continue;
      }

      attempted += 1;
      const started = this.clock();
      try {
        const result = await provider.chat({
          providerId: candidate.provider,
          apiKey: runtime.apiKey,
          baseUrl: runtime.baseUrl,
          model: candidate.model,
          messages,
          system,
          maxTokens,
          temperature,
          fetchImpl: this.fetchImpl,
          timeoutMs: this.config.AI_REQUEST_TIMEOUT_MS,
          appName: this.config.OPENROUTER_APP_NAME,
        });
        const latencyMs = this.clock() - started;
        const usage = result.usage || { promptTokens: 0, completionTokens: 0 };
        const costMicroUsd = estimateCostMicroUsd(candidate.pricing, usage);

        if (this.usageStore) {
          await this.usageStore
            .record({
              provider: candidate.provider,
              model: candidate.model,
              task,
              groupJid,
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              costMicroUsd,
              latencyMs,
            })
            .catch(() => {});
        }

        return {
          text: result.text,
          provider: candidate.provider,
          model: result.rawModel || candidate.model,
          usage,
          costMicroUsd,
          latencyMs,
          attempts: attempts.length + 1,
          fallbackUsed: attempts.length > 0,
          attemptLog: attempts,
        };
      } catch (err) {
        const message = redactSecrets(err.message, this.secrets());
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: message,
          status: err.status || 0,
          code: err.code || 'provider_error',
        });
        if (this.usageStore && candidate === candidates[candidates.length - 1]) {
          await this.usageStore
            .recordError({ provider: candidate.provider, model: candidate.model, error: message })
            .catch(() => {});
        }
      }
    }

    throw new AIGatewayError('All AI providers failed', { attempts, code: 'all_providers_failed' });
  }

  /**
   * Builds an ordered, de-duplicated candidate list. Explicit models win; a
   * per-task model beats the global default; otherwise provider defaults are
   * used in the configured provider order.
   */
  async #buildCandidates({ task, model, taskModels = {}, freeOnly = false }) {
    const explicit =
      parseModelRef(model) || parseModelRef(taskModels?.[task]) || parseModelRef(this.#configModelForTask(task));
    const result = [];

    if (explicit) {
      result.push({ provider: explicit.provider || this.providerOrder[0], model: explicit.model });
    }

    for (const providerId of this.providerOrder) {
      const runtime = providerRuntime(providerId, this.config);
      if (!runtime.configured) continue;
      if (!result.some((c) => c.provider === providerId && c.model === runtime.defaultModel)) {
        result.push({ provider: providerId, model: runtime.defaultModel });
      }
    }

    // Validate/prune models against provider metadata when we can, and attach
    // pricing so cost estimates are accurate.
    const shouldFilterFree = freeOnly || Boolean(this.config.AI_FREE_ONLY);
    const validated = [];
    for (const candidate of result) {
      if (candidate.provider === 'gemini' || !modelFilterSupported(candidate.provider)) {
        validated.push(candidate);
        continue;
      }
      const listing = await this.listModels(candidate.provider, {
        freeOnly: shouldFilterFree && modelFilterSupported(candidate.provider),
      });
      const match = (listing.models || []).find((m) => m.id === candidate.model);
      if (match) {
        if (shouldFilterFree && match.free === false) continue;
        validated.push({ ...candidate, pricing: match.pricing });
      } else if (!shouldFilterFree) {
        // Metadata may be unavailable; keep the configured default.
        validated.push(candidate);
      }
    }

    // De-duplicate while preserving order.
    const seen = new Set();
    return validated.filter((c) => {
      const key = `${c.provider}:${c.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  #configModelForTask(task) {
    const key = `AI_MODEL_${String(task).toUpperCase()}`;
    return this.config[key] || '';
  }

  #allow(providerId) {
    const limit = Math.max(1, Number(this.config.AI_RATE_LIMIT_PER_MINUTE) || 30);
    const now = this.clock();
    const window = (this.rateWindows.get(providerId) || []).filter((t) => now - t < 60000);
    if (window.length >= limit) {
      this.rateWindows.set(providerId, window);
      return false;
    }
    window.push(now);
    this.rateWindows.set(providerId, window);
    return true;
  }
}

function parseModelRef(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes('::') ? '::' : trimmed.includes(':') ? ':' : null;
  if (separator) {
    const [maybeProvider, ...rest] = trimmed.split(separator);
    const model = rest.join(separator);
    if (listProviderIds().includes(maybeProvider) && model) {
      return { provider: maybeProvider, model };
    }
  }
  return { provider: null, model: trimmed };
}

function modelFilterSupported(providerId) {
  return providerId === 'openrouter';
}

function filterModels(value, freeOnly) {
  if (!freeOnly) return value;
  return { ...value, models: (value.models || []).filter((m) => m.free === true) };
}

function estimateCostMicroUsd(pricing, usage) {
  if (!pricing) return 0;
  const prompt = (Number(usage.promptTokens) || 0) * (Number(pricing.prompt) || 0);
  const completion = (Number(usage.completionTokens) || 0) * (Number(pricing.completion) || 0);
  return Math.round((prompt + completion) * 1e6);
}
