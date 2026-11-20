/**
 * Multi-provider AI gateway tests. All HTTP is a local fake; no vendor is
 * contacted and no real key is present in the fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway, AIGatewayError } from '../src/ai-gateway/index.js';
import { redactSecrets, providerRuntime } from '../src/ai-gateway/providers.js';
import { AIUsageStore } from '../src/ai-gateway/usage-store.js';
import { makeConfig, makeTempDir, cleanupDir } from './helpers/group-fixtures.js';

function json(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function geminiSuccess(text = 'Hello from Gemini') {
  return json(200, {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
  });
}

test('a Gemini completion is normalized and usage is returned', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /:generateContent/);
    return geminiSuccess();
  };
  const gateway = new AIGateway({ config: makeConfig(), fetchImpl });

  const result = await gateway.complete({ task: 'chat', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.text, 'Hello from Gemini');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.usage.promptTokens, 11);
  assert.equal(result.usage.completionTokens, 7);
  assert.equal(result.fallbackUsed, false);
});

test('a failed provider falls through to the next configured provider', async () => {
  const config = makeConfig({
    AI_PROVIDER_ORDER: 'gemini,openrouter',
    GEMINI_API_KEY: 'gemini-key-value',
    OPENROUTER_API_KEY: 'openrouter-key-value',
    AI_MODEL_CHAT: '',
  });
  const fetchImpl = async (url) => {
    if (url.includes('gemini.test')) return json(500, { error: { message: 'upstream exploded' } });
    if (url.endsWith('/models')) {
      return json(200, {
        data: [{ id: 'meta-llama/llama-3.3-70b-instruct:free', pricing: { prompt: '0', completion: '0' } }],
      });
    }
    if (url.endsWith('/chat/completions')) {
      return json(200, {
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        choices: [{ message: { content: 'Hello from OpenRouter' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const gateway = new AIGateway({ config, fetchImpl });

  const result = await gateway.complete({ task: 'chat', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.text, 'Hello from OpenRouter');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.attemptLog[0].provider, 'gemini');
});

test('a per-task model override wins over the provider default', async () => {
  let requestedUrl = '';
  const fetchImpl = async (url) => {
    requestedUrl = url;
    return geminiSuccess('custom answer');
  };
  const gateway = new AIGateway({ config: makeConfig(), fetchImpl });

  const result = await gateway.complete({
    task: 'chat',
    taskModels: { chat: 'gemini:custom-model' },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.match(requestedUrl, /custom-model/);
  assert.equal(result.model, 'custom-model');
});

test('the local rate limit stops further provider calls in the window', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return geminiSuccess();
  };
  const gateway = new AIGateway({ config: makeConfig({ AI_RATE_LIMIT_PER_MINUTE: 1 }), fetchImpl });

  await gateway.complete({ task: 'chat', messages: [{ role: 'user', content: 'one' }] });
  await assert.rejects(
    () => gateway.complete({ task: 'chat', messages: [{ role: 'user', content: 'two' }] }),
    (err) => {
      assert.equal(err instanceof AIGatewayError, true);
      assert.equal(err.code, 'all_providers_failed');
      assert.equal(err.attempts[0].error, 'rate_limited_local');
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('free-model filtering only removes priced models for OpenRouter', async () => {
  const config = makeConfig({
    AI_PROVIDER_ORDER: 'openrouter',
    OPENROUTER_API_KEY: 'openrouter-key-value',
  });
  const fetchImpl = async (url) => {
    assert.match(url, /\/models$/);
    return json(200, {
      data: [
        { id: 'free/model', pricing: { prompt: '0', completion: '0' } },
        { id: 'paid/model', pricing: { prompt: '0.001', completion: '0.002' } },
      ],
    });
  };
  const gateway = new AIGateway({ config, fetchImpl });

  const all = await gateway.listAllModels({ freeOnly: false });
  assert.equal(all.providers[0].models.length, 2);

  const free = await gateway.listAllModels({ freeOnly: true });
  assert.equal(free.providers[0].models.length, 1);
  assert.equal(free.providers[0].models[0].id, 'free/model');
});

test('secrets are redacted from provider errors and never appear in status', async () => {
  const secret = 'sk-super-secret-value-123';
  const config = makeConfig({ GEMINI_API_KEY: secret, AI_PROVIDER_ORDER: 'gemini' });
  const gateway = new AIGateway({
    config,
    fetchImpl: async () => {
      throw new Error(`request rejected for ${secret}`);
    },
  });

  await assert.rejects(
    () => gateway.complete({ task: 'chat', messages: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      const serialized = JSON.stringify(err.attempts);
      assert.equal(serialized.includes(secret), false);
      assert.match(serialized, /\[redacted\]/);
      return true;
    }
  );

  const status = JSON.stringify(gateway.describe());
  assert.equal(status.includes(secret), false);
  assert.equal(redactSecrets(`key=${secret}`, [secret]), 'key=[redacted]');
});

test('an unconfigured provider is reported but never called', () => {
  const runtime = providerRuntime('openrouter', makeConfig({ OPENROUTER_API_KEY: '' }));
  assert.equal(runtime.configured, false);
  assert.equal(runtime.apiKey, '');
});

test('usage accounting is exact and secret-free', async (t) => {
  const dir = await makeTempDir();
  t.after(() => cleanupDir(dir));
  const store = await new AIUsageStore({ filePath: `${dir}/usage.json` }).init();

  await store.record({
    provider: 'gemini',
    model: 'gemini-test',
    task: 'chat',
    groupJid: '120363000000000001@g.us',
    promptTokens: 100,
    completionTokens: 50,
    costMicroUsd: 1234,
    latencyMs: 20,
  });
  await store.record({
    provider: 'openrouter',
    model: 'free/model',
    task: 'summary',
    promptTokens: 10,
    completionTokens: 5,
    costMicroUsd: 0,
  });

  const summary = store.getSummary({ days: 7 });
  assert.equal(summary.totals.requests, 2);
  assert.equal(summary.totals.promptTokens, 110);
  assert.equal(summary.totals.completionTokens, 55);
  assert.equal(summary.totals.costMicroUsd, 1234);
  assert.equal(summary.totalsUsd, 0.001234);
  assert.equal(JSON.stringify(summary).includes('apiKey'), false);
});
