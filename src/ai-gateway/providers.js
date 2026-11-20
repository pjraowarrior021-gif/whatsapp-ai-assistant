/* global AbortController */
/**
 * Provider adapters for the group AI gateway.
 *
 * Every adapter speaks the same normalized interface:
 *   listModels(ctx) -> [{ id, label, free, contextLength, pricing? }]
 *   chat(ctx)       -> { text, usage, rawModel }
 *
 * The group pipeline never talks to a vendor SDK directly, so models can be
 * swapped or failed over without changing agent code.
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ provider: string, status?: number, code?: string, retryable?: boolean }} meta
   */
  constructor(message, { provider, status = 0, code = 'provider_error', retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

function resolveFetch(ctx) {
  return ctx.fetchImpl || globalThis.fetch;
}

async function requestJson(ctx, url, options = {}) {
  const fetchImpl = resolveFetch(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    const raw = await res.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { raw };
    }
    if (!res.ok) {
      const detail = body?.error?.message || body?.message || body?.raw || `HTTP ${res.status}`;
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new ProviderError(String(detail).slice(0, 400), {
        provider: ctx.providerId,
        status: res.status,
        code: res.status === 429 ? 'rate_limited' : res.status === 404 ? 'model_not_found' : 'http_error',
        retryable,
      });
    }
    return body;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err.name === 'AbortError') {
      throw new ProviderError('Provider request timed out', {
        provider: ctx.providerId,
        code: 'timeout',
        retryable: true,
      });
    }
    throw new ProviderError(String(err.message || 'Network error').slice(0, 300), {
      provider: ctx.providerId,
      code: 'network_error',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

function approxTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function usageFrom(promptText, completionText, promptTokens, completionTokens) {
  return {
    promptTokens: Number(promptTokens) || approxTokens(promptText),
    completionTokens: Number(completionTokens) || approxTokens(completionText),
  };
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.content !== undefined)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content).slice(0, 24000),
    }));
}

/* -------------------------------------------------------------------------- */
/* Google Gemini                                                              */
/* -------------------------------------------------------------------------- */

const geminiProvider = {
  id: 'gemini',
  label: 'Google Gemini',
  envKey: 'GEMINI_API_KEY',
  supportsFreeFilter: false,
  supportsModelList: true,
  defaultModel: (config) => config.GEMINI_MODEL || 'gemini-2.0-flash',
  defaultBaseUrl: () => 'https://generativelanguage.googleapis.com/v1beta',

  async listModels(ctx) {
    const base = ctx.baseUrl || this.defaultBaseUrl();
    const body = await requestJson(ctx, `${base}/models?key=${encodeURIComponent(ctx.apiKey)}&pageSize=200`, {
      method: 'GET',
    });
    return (body?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || String(m.name || '').replace(/^models\//, ''),
        free: false,
        contextLength: Number(m.inputTokenLimit) || 0,
      }))
      .filter((m) => m.id);
  },

  async chat(ctx) {
    const base = ctx.baseUrl || this.defaultBaseUrl();
    const model = ctx.model;
    const system = ctx.system ? { parts: [{ text: String(ctx.system).slice(0, 20000) }] } : undefined;
    const contents = normalizeMessages(ctx.messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const body = await requestJson(
      ctx,
      `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ctx.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: system } : {}),
          generationConfig: {
            temperature: clampTemperature(ctx.temperature),
            maxOutputTokens: Math.max(64, Math.min(Number(ctx.maxTokens) || 1024, 8192)),
          },
        }),
      }
    );

    const candidate = body?.candidates?.[0];
    const text = (candidate?.content?.parts || [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
    if (!text) {
      throw new ProviderError('Gemini returned an empty response', {
        provider: 'gemini',
        code: 'empty_response',
        retryable: true,
      });
    }
    const promptText = [ctx.system, ...normalizeMessages(ctx.messages).map((m) => m.content)].join('\n');
    return {
      text,
      usage: usageFrom(
        promptText,
        text,
        body?.usageMetadata?.promptTokenCount,
        body?.usageMetadata?.candidatesTokenCount
      ),
      rawModel: model,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible providers (OpenRouter, Qwen, generic)                    */
/* -------------------------------------------------------------------------- */

function createOpenAICompatibleProvider({
  id,
  label,
  envKey,
  defaultBaseUrl,
  defaultModel,
  extraHeaders = () => ({}),
  supportsFreeFilter = false,
}) {
  return {
    id,
    label,
    envKey,
    supportsFreeFilter,
    supportsModelList: true,
    defaultModel,
    defaultBaseUrl,

    async listModels(ctx) {
      const base = (ctx.baseUrl || defaultBaseUrl()).replace(/\/+$/, '');
      const headers = { ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}), ...extraHeaders(ctx) };
      const body = await requestJson(ctx, `${base}/models`, { method: 'GET', headers });
      const list = body?.data || body?.models || [];
      return list
        .map((m) => {
          const pricing = m.pricing || m.pricing_detail || null;
          const prompt = Number(pricing?.prompt);
          const completion = Number(pricing?.completion);
          const hasPricing = Boolean(pricing) && Number.isFinite(prompt) && Number.isFinite(completion);
          return {
            id: String(m.id || ''),
            label: m.name || m.id || '',
            free: hasPricing ? prompt === 0 && completion === 0 : Boolean(m.free),
            contextLength: Number(m.context_length || m.context_window || 0) || 0,
            pricing: hasPricing ? { prompt, completion } : undefined,
          };
        })
        .filter((m) => m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async chat(ctx) {
      const base = (ctx.baseUrl || defaultBaseUrl()).replace(/\/+$/, '');
      const messages = normalizeMessages(ctx.messages);
      const body = await requestJson(ctx, `${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
          ...extraHeaders(ctx),
        },
        body: JSON.stringify({
          model: ctx.model,
          messages: [...(ctx.system ? [{ role: 'system', content: String(ctx.system) }] : []), ...messages],
          temperature: clampTemperature(ctx.temperature),
          max_tokens: Math.max(64, Math.min(Number(ctx.maxTokens) || 1024, 8192)),
        }),
      });

      const choice = body?.choices?.[0];
      const text = String(choice?.message?.content || choice?.text || '').trim();
      if (!text) {
        throw new ProviderError(`${label} returned an empty response`, {
          provider: id,
          code: 'empty_response',
          retryable: true,
        });
      }
      const promptText = [ctx.system, ...messages.map((m) => m.content)].join('\n');
      return {
        text,
        usage: usageFrom(promptText, text, body?.usage?.prompt_tokens, body?.usage?.completion_tokens),
        rawModel: body?.model || ctx.model,
      };
    },
  };
}

const openrouterProvider = createOpenAICompatibleProvider({
  id: 'openrouter',
  label: 'OpenRouter',
  envKey: 'OPENROUTER_API_KEY',
  supportsFreeFilter: true,
  defaultBaseUrl: (config) => config.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
  defaultModel: (config) => config.AI_MODEL_CHAT || 'meta-llama/llama-3.3-70b-instruct:free',
  extraHeaders: (ctx) => ({
    'HTTP-Referer': ctx.appUrl || 'https://localhost',
    'X-Title': ctx.appName || 'WhatsApp Group AI Administrator',
  }),
});

const qwenProvider = createOpenAICompatibleProvider({
  id: 'qwen',
  label: 'Qwen (DashScope compatible)',
  envKey: 'QWEN_API_KEY',
  supportsFreeFilter: false,
  defaultBaseUrl: (config) => config.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  defaultModel: () => 'qwen-plus',
});

const openaiCompatibleProvider = createOpenAICompatibleProvider({
  id: 'openai_compatible',
  label: 'OpenAI-compatible API',
  envKey: 'OPENAI_COMPAT_API_KEY',
  supportsFreeFilter: false,
  defaultBaseUrl: (config) => config.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com/v1',
  defaultModel: (config) => config.AI_MODEL_CHAT || 'gpt-4o-mini',
});

export const PROVIDERS = Object.freeze({
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  qwen: qwenProvider,
  openai_compatible: openaiCompatibleProvider,
});

export function listProviderIds() {
  return Object.keys(PROVIDERS);
}

export function getProvider(id) {
  return PROVIDERS[id] || null;
}

/**
 * Extracts provider credentials/base URL from config without ever exposing the
 * key to callers that only need readiness information.
 */
export function providerRuntime(providerId, config) {
  const provider = getProvider(providerId);
  if (!provider) return { configured: false };
  const apiKey = config[provider.envKey] || '';
  const baseUrl =
    providerId === 'gemini'
      ? config.GEMINI_API_BASE_URL || ''
      : providerId === 'openrouter'
        ? config.OPENROUTER_BASE_URL
        : providerId === 'qwen'
          ? config.QWEN_BASE_URL
          : config.OPENAI_COMPAT_BASE_URL;
  return {
    configured: Boolean(apiKey),
    apiKey,
    baseUrl: baseUrl || provider.defaultBaseUrl(config),
    defaultModel: provider.defaultModel(config),
  };
}

function clampTemperature(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0.6;
  return Math.min(2, Math.max(0, num));
}

/**
 * Removes known secrets from any string before it is logged or returned.
 * @param {string} text
 * @param {string[]} secrets
 */
export function redactSecrets(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}
