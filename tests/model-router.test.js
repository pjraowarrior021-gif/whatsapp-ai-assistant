import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, TASK_TYPES, SPEED_TIERS, COST_TIERS, PROVIDERS } from '../src/model-router.js';

test('ModelRouter: initializes with standard built-in models', () => {
  const router = new ModelRouter();
  const models = router.listModels();
  assert.ok(models.length >= 6);

  const modelIds = models.map((m) => m.id);
  assert.ok(modelIds.includes('gemini-3.1-flash-lite'));
  assert.ok(modelIds.includes('gemini-3.5-flash-lite'));
  assert.ok(modelIds.includes('gemini-3.8-flash'));
  assert.ok(modelIds.includes('llama-3.3-70b-versatile'));
  assert.ok(modelIds.includes('qwen-2.5-coder-32b'));
  assert.ok(modelIds.includes('whisper-large-v3'));
});

test('ModelRouter: registers, queries, filters, and unregisters custom models', () => {
  const router = new ModelRouter();

  router.registerModel('test-custom-agent-model', {
    provider: PROVIDERS.OPENAI,
    displayName: 'Test Custom Model',
    capabilities: [TASK_TYPES.CODING, TASK_TYPES.CHAT],
    flags: { vision: false, tools: true },
    contextWindow: 64_000,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.FREE,
    priority: 15,
  });

  const custom = router.getModel('test-custom-agent-model');
  assert.ok(custom);
  assert.strictEqual(custom.provider, PROVIDERS.OPENAI);
  assert.strictEqual(custom.contextWindow, 64_000);
  assert.strictEqual(custom.flags.vision, false);
  assert.strictEqual(custom.flags.tools, true);

  // Filter by provider
  const openaiModels = router.listModels({ provider: PROVIDERS.OPENAI });
  assert.strictEqual(openaiModels.length, 1);
  assert.strictEqual(openaiModels[0].id, 'test-custom-agent-model');

  // Filter by capability
  const codingModels = router.listModels({ capability: TASK_TYPES.CODING });
  assert.ok(codingModels.some((m) => m.id === 'test-custom-agent-model'));

  // Filter by minContextWindow
  const largeContext = router.listModels({ minContextWindow: 500_000 });
  assert.ok(largeContext.every((m) => m.contextWindow >= 500_000));

  // Unregister
  const deleted = router.unregisterModel('test-custom-agent-model');
  assert.strictEqual(deleted, true);
  assert.strictEqual(router.getModel('test-custom-agent-model'), null);
});

test('ModelRouter: detects task type accurately from prompt and context', () => {
  const router = new ModelRouter();

  // Audio
  assert.strictEqual(router.detectTaskType('', { mimeType: 'audio/ogg' }), TASK_TYPES.AUDIO);
  assert.strictEqual(router.detectTaskType('', { media: { type: 'audio' } }), TASK_TYPES.AUDIO);

  // Vision
  assert.strictEqual(router.detectTaskType('', { mimeType: 'image/jpeg' }), TASK_TYPES.VISION);
  assert.strictEqual(router.detectTaskType('Look at this', { hasImage: true }), TASK_TYPES.VISION);

  // Document
  assert.strictEqual(router.detectTaskType('', { mimeType: 'application/pdf' }), TASK_TYPES.DOCUMENT);
  assert.strictEqual(router.detectTaskType('', { isDocument: true }), TASK_TYPES.DOCUMENT);

  // Coding
  assert.strictEqual(router.detectTaskType('```js\nconst x = 10;\n```'), TASK_TYPES.CODING);
  assert.strictEqual(
    router.detectTaskType('Help fix this TypeError: cannot read properties of undefined'),
    TASK_TYPES.CODING
  );
  assert.strictEqual(router.detectTaskType('Write a function to reverse a linked list in python'), TASK_TYPES.CODING);

  // Reasoning
  assert.strictEqual(
    router.detectTaskType('Prove that the square root of 2 is irrational step by step'),
    TASK_TYPES.REASONING
  );
  assert.strictEqual(
    router.detectTaskType('Solve equation 3x^2 + 5x - 2 = 0 step-by-step reasoning'),
    TASK_TYPES.REASONING
  );

  // Conversational chat
  assert.strictEqual(router.detectTaskType('Good morning, how are you?'), TASK_TYPES.CHAT);
  assert.strictEqual(router.detectTaskType('Tell me a fun joke about space'), TASK_TYPES.CHAT);
});

test('ModelRouter: routes tasks to optimal models based on capability & scoring', () => {
  const router = new ModelRouter();

  // Chat task prefers fast/free
  const chatRoute = router.routeTask(TASK_TYPES.CHAT, { prefersSpeed: SPEED_TIERS.FAST });
  assert.ok(chatRoute.modelId);
  assert.ok(chatRoute.model.capabilities.includes(TASK_TYPES.CHAT));

  // Coding task prioritizes coder models
  const codingRoute = router.routeTask(TASK_TYPES.CODING);
  assert.ok(codingRoute.model.capabilities.includes(TASK_TYPES.CODING));

  // Audio task routes to audio-capable model
  const audioRoute = router.routeTask(TASK_TYPES.AUDIO);
  assert.ok(audioRoute.model.capabilities.includes(TASK_TYPES.AUDIO));

  // Vision requirement filters strictly
  const visionRoute = router.routeTask(TASK_TYPES.VISION, { requireVision: true });
  assert.strictEqual(visionRoute.model.flags.vision, true);
});

test('ModelRouter: constructs fallback chain correctly', () => {
  const router = new ModelRouter();
  const chain = router.getFallbackChain('gemini-3.1-flash-lite', TASK_TYPES.CHAT);

  assert.ok(Array.isArray(chain));
  assert.strictEqual(chain[0], 'gemini-3.1-flash-lite');
  assert.ok(chain.length >= 2);
  // Ensure no duplicates
  const set = new Set(chain);
  assert.strictEqual(set.size, chain.length);
});

test('ModelRouter: executeWithFallback succeeds on primary model without fallback', async () => {
  const router = new ModelRouter();
  let executedModel = null;

  const result = await router.executeWithFallback(
    TASK_TYPES.CHAT,
    async (modelId) => {
      executedModel = modelId;
      return { output: 'Hello from model', tokens: { prompt: 10, completion: 20 } };
    },
    { preferredModel: 'gemini-3.1-flash-lite', userId: 'user_test_1' }
  );

  assert.strictEqual(executedModel, 'gemini-3.1-flash-lite');
  assert.strictEqual(result.fallbackOccurred, false);
  assert.strictEqual(result.attempts, 1);
  assert.strictEqual(result.modelUsed, 'gemini-3.1-flash-lite');
  assert.strictEqual(result.result.output, 'Hello from model');
});

test('ModelRouter: executeWithFallback seamlessly cascades when primary fails', async () => {
  const router = new ModelRouter();
  const attempts = [];

  const result = await router.executeWithFallback(
    TASK_TYPES.CHAT,
    async (modelId) => {
      attempts.push(modelId);
      if (modelId === 'gemini-3.1-flash-lite') {
        throw new Error('429 Resource has been exhausted (rate limit)');
      }
      return { output: 'Cascade succeeded', tokens: { prompt: 15, completion: 25 } };
    },
    { preferredModel: 'gemini-3.1-flash-lite', userId: 'user_test_2' }
  );

  assert.strictEqual(result.fallbackOccurred, true);
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(attempts[0], 'gemini-3.1-flash-lite');
  assert.notStrictEqual(attempts[1], 'gemini-3.1-flash-lite');
  assert.strictEqual(result.result.output, 'Cascade succeeded');

  // Verify primary was placed in cooldown
  assert.strictEqual(router.isModelAvailable('gemini-3.1-flash-lite'), false);
});

test('ModelRouter: executeWithFallback throws error when all models fail', async () => {
  const router = new ModelRouter();

  await assert.rejects(
    async () => {
      await router.executeWithFallback(
        TASK_TYPES.CHAT,
        async (modelId) => {
          throw new Error(`Connection timeout on ${modelId}`);
        },
        { maxAttempts: 2, userId: 'user_test_fail' }
      );
    },
    (err) => {
      assert.ok(err.message.includes('All fallback models failed'));
      assert.ok(err.message.includes('Connection timeout'));
      return true;
    }
  );
});

test('ModelRouter: tracks usage, latency, tokens and costs across models and users', () => {
  const router = new ModelRouter();
  router.resetUsageMetrics();

  router.trackUsage({
    model: 'gemini-3.5-flash-lite',
    taskType: TASK_TYPES.CODING,
    promptTokens: 1000,
    completionTokens: 500,
    latencyMs: 150,
    userId: 'u_alice',
  });

  router.trackUsage({
    model: 'gemini-3.5-flash-lite',
    taskType: TASK_TYPES.CHAT,
    promptTokens: 2000,
    completionTokens: 1000,
    latencyMs: 250,
    userId: 'u_bob',
  });

  const metrics = router.getUsageMetrics();
  assert.strictEqual(metrics.global.totalRequests, 2);
  assert.strictEqual(metrics.global.totalTokens, 4500);
  assert.strictEqual(metrics.global.promptTokens, 3000);
  assert.strictEqual(metrics.global.completionTokens, 1500);
  assert.strictEqual(metrics.global.totalLatencyMs, 400);
  assert.strictEqual(metrics.global.avgLatencyMs, 200);

  // Model metrics
  assert.ok(metrics.models['gemini-3.5-flash-lite']);
  assert.strictEqual(metrics.models['gemini-3.5-flash-lite'].requests, 2);

  // User metrics
  assert.strictEqual(metrics.users['u_alice'].dailyTokens, 1500);
  assert.strictEqual(metrics.users['u_bob'].dailyTokens, 3000);

  // Task metrics
  assert.strictEqual(metrics.tasks[TASK_TYPES.CODING], 1);
  assert.strictEqual(metrics.tasks[TASK_TYPES.CHAT], 1);
});

test('ModelRouter: enforces budget safeguards per user and globally', () => {
  const router = new ModelRouter();
  router.resetUsageMetrics();

  // Set user budget: max 2 requests or 2000 tokens
  router.setBudget('u_restricted', {
    maxRequestsPerDay: 2,
    maxTokensPerDay: 2000,
  });

  // Request 1: allowed
  let check1 = router.checkBudget('u_restricted', 500);
  assert.strictEqual(check1.allowed, true);

  router.trackUsage({
    model: 'gemini-3.1-flash-lite',
    promptTokens: 500,
    completionTokens: 500,
    userId: 'u_restricted',
  });

  // Request 2: allowed
  let check2 = router.checkBudget('u_restricted', 500);
  assert.strictEqual(check2.allowed, true);

  router.trackUsage({
    model: 'gemini-3.1-flash-lite',
    promptTokens: 500,
    completionTokens: 500,
    userId: 'u_restricted',
  });

  // Request 3: blocked by request count
  let check3 = router.checkBudget('u_restricted', 100);
  assert.strictEqual(check3.allowed, false);
  assert.ok(check3.reason.includes('request limit'));

  // Test token limit breach
  router.setBudget('u_token_capped', {
    maxRequestsPerDay: 10,
    maxTokensPerDay: 100,
  });
  let checkToken = router.checkBudget('u_token_capped', 150);
  assert.strictEqual(checkToken.allowed, false);
  assert.ok(checkToken.reason.includes('token limit'));
});
