/**
 * Intelligent Multi-Model Router
 * Provider-independent model registry, capability-based task routing,
 * seamless fallback cascade, token/latency tracking, and budget safeguards.
 */
import { privacyLog } from './privacy.js';

export const TASK_TYPES = Object.freeze({
  CHAT: 'chat',
  REASONING: 'reasoning',
  CODING: 'coding',
  VISION: 'vision',
  DOCUMENT: 'document',
  AUDIO: 'audio',
});

export const SPEED_TIERS = Object.freeze({
  FAST: 'fast',
  STANDARD: 'standard',
  SLOW: 'slow',
});

export const COST_TIERS = Object.freeze({
  FREE: 'free',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

export const PROVIDERS = Object.freeze({
  GOOGLE: 'google',
  GROQ: 'groq',
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  MOCK: 'mock',
});

/**
 * Standard Built-in Model Registry Definitions
 */
const DEFAULT_MODELS = [
  {
    id: 'gemini-3.1-flash-lite',
    provider: PROVIDERS.GOOGLE,
    displayName: 'Gemini 3.1 Flash Lite',
    capabilities: [
      TASK_TYPES.CHAT,
      TASK_TYPES.REASONING,
      TASK_TYPES.CODING,
      TASK_TYPES.VISION,
      TASK_TYPES.DOCUMENT,
      TASK_TYPES.AUDIO,
    ],
    flags: {
      vision: true,
      audio: true,
      document: true,
      tools: true,
      structuredOutput: true,
    },
    contextWindow: 1_000_000,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.FREE,
    maxOutputTokens: 8192,
    priority: 10,
    costPer1kInput: 0.0,
    costPer1kOutput: 0.0,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: PROVIDERS.GOOGLE,
    displayName: 'Gemini 3.5 Flash Lite',
    capabilities: [TASK_TYPES.CHAT, TASK_TYPES.REASONING, TASK_TYPES.CODING, TASK_TYPES.VISION, TASK_TYPES.DOCUMENT],
    flags: {
      vision: true,
      audio: false,
      document: true,
      tools: true,
      structuredOutput: true,
    },
    contextWindow: 1_000_000,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.LOW,
    maxOutputTokens: 8192,
    priority: 9,
    costPer1kInput: 0.000075,
    costPer1kOutput: 0.0003,
  },
  {
    id: 'gemini-3.8-flash',
    provider: PROVIDERS.GOOGLE,
    displayName: 'Gemini 3.8 Flash',
    capabilities: [
      TASK_TYPES.CHAT,
      TASK_TYPES.REASONING,
      TASK_TYPES.CODING,
      TASK_TYPES.VISION,
      TASK_TYPES.DOCUMENT,
      TASK_TYPES.AUDIO,
    ],
    flags: {
      vision: true,
      audio: true,
      document: true,
      tools: true,
      structuredOutput: true,
    },
    contextWindow: 1_000_000,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.LOW,
    maxOutputTokens: 8192,
    priority: 8,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
  },
  {
    id: 'gemini-2.5-pro',
    provider: PROVIDERS.GOOGLE,
    displayName: 'Gemini 2.5 Pro',
    capabilities: [TASK_TYPES.CHAT, TASK_TYPES.REASONING, TASK_TYPES.CODING, TASK_TYPES.DOCUMENT],
    flags: {
      vision: true,
      audio: false,
      document: true,
      tools: true,
      structuredOutput: true,
    },
    contextWindow: 2_000_000,
    speedTier: SPEED_TIERS.STANDARD,
    costTier: COST_TIERS.MEDIUM,
    maxOutputTokens: 8192,
    priority: 7,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.005,
  },
  {
    id: 'llama-3.3-70b-versatile',
    provider: PROVIDERS.GROQ,
    displayName: 'Llama 3.3 70B Versatile',
    capabilities: [TASK_TYPES.CHAT, TASK_TYPES.REASONING, TASK_TYPES.CODING],
    flags: {
      vision: false,
      audio: false,
      document: false,
      tools: true,
      structuredOutput: true,
    },
    contextWindow: 128_000,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.LOW,
    maxOutputTokens: 4096,
    priority: 6,
    costPer1kInput: 0.00059,
    costPer1kOutput: 0.00079,
  },
  {
    id: 'qwen-2.5-coder-32b',
    provider: PROVIDERS.OLLAMA,
    displayName: 'Qwen 2.5 Coder 32B Local',
    capabilities: [TASK_TYPES.CODING, TASK_TYPES.REASONING, TASK_TYPES.CHAT],
    flags: {
      vision: false,
      audio: false,
      document: false,
      tools: true,
      structuredOutput: true,
    },
    contextWindow: 32_768,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.FREE,
    maxOutputTokens: 8192,
    priority: 6,
    costPer1kInput: 0.0,
    costPer1kOutput: 0.0,
  },
  {
    id: 'whisper-large-v3',
    provider: PROVIDERS.GROQ,
    displayName: 'Whisper Large v3',
    capabilities: [TASK_TYPES.AUDIO],
    flags: {
      vision: false,
      audio: true,
      document: false,
      tools: false,
      structuredOutput: false,
    },
    contextWindow: 16_000,
    speedTier: SPEED_TIERS.FAST,
    costTier: COST_TIERS.FREE,
    maxOutputTokens: 448,
    priority: 8,
    costPer1kInput: 0.0,
    costPer1kOutput: 0.0,
  },
];

export class ModelRouter {
  constructor(options = {}) {
    this.models = new Map();
    this.modelHealth = new Map(); // Map<modelId, { failures: number, cooldownUntil: number, lastError: string }>
    this.usage = {
      global: {
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalLatencyMs: 0,
        totalCost: 0,
        totalFailures: 0,
      },
      byModel: new Map(),
      byUser: new Map(), // Map<userId, { dailyTokens: number, dailyRequests: number, date: string }>
      byTask: new Map(),
    };
    this.budgets = new Map(); // Map<userId | 'global', { maxTokensPerDay, maxRequestsPerDay, maxLatencyMs }>
    this.defaultCooldownMs = options.defaultCooldownMs || 30_000;

    this.initDefaultModels();
  }

  /**
   * Initializes the registry with default models.
   */
  initDefaultModels() {
    this.models.clear();
    for (const m of DEFAULT_MODELS) {
      this.registerModel(m.id, m);
    }
  }

  /**
   * Registers or updates a model in the registry.
   * @param {string} modelId
   * @param {object} metadata
   */
  registerModel(modelId, metadata) {
    if (!modelId || typeof modelId !== 'string') {
      throw new Error('Model ID must be a non-empty string');
    }
    const entry = {
      id: modelId,
      provider: metadata.provider || PROVIDERS.GOOGLE,
      displayName: metadata.displayName || modelId,
      capabilities: Array.isArray(metadata.capabilities) ? [...metadata.capabilities] : [TASK_TYPES.CHAT],
      flags: {
        vision: Boolean(metadata.flags?.vision),
        audio: Boolean(metadata.flags?.audio),
        document: Boolean(metadata.flags?.document),
        tools: metadata.flags?.tools !== false,
        structuredOutput: metadata.flags?.structuredOutput !== false,
      },
      contextWindow: Number(metadata.contextWindow) || 128_000,
      speedTier: metadata.speedTier || SPEED_TIERS.STANDARD,
      costTier: metadata.costTier || COST_TIERS.LOW,
      maxOutputTokens: Number(metadata.maxOutputTokens) || 4096,
      priority: Number(metadata.priority) || 5,
      costPer1kInput: Number(metadata.costPer1kInput) || 0.0,
      costPer1kOutput: Number(metadata.costPer1kOutput) || 0.0,
    };
    this.models.set(modelId, entry);
  }

  /**
   * Unregisters a model from the registry.
   * @param {string} modelId
   * @returns {boolean}
   */
  unregisterModel(modelId) {
    return this.models.delete(modelId);
  }

  /**
   * Retrieves model metadata by ID.
   * @param {string} modelId
   * @returns {object|null}
   */
  getModel(modelId) {
    return this.models.get(modelId) || null;
  }

  /**
   * Lists models matching optional filter criteria.
   * @param {object} filter
   * @returns {object[]}
   */
  listModels(filter = {}) {
    let result = Array.from(this.models.values());

    if (filter.capability) {
      result = result.filter((m) => m.capabilities.includes(filter.capability));
    }
    if (filter.provider) {
      result = result.filter((m) => m.provider === filter.provider);
    }
    if (filter.speedTier) {
      result = result.filter((m) => m.speedTier === filter.speedTier);
    }
    if (filter.costTier) {
      result = result.filter((m) => m.costTier === filter.costTier);
    }
    if (filter.minContextWindow) {
      result = result.filter((m) => m.contextWindow >= filter.minContextWindow);
    }
    if (filter.requireTools) {
      result = result.filter((m) => m.flags.tools);
    }
    if (filter.requireVision) {
      result = result.filter((m) => m.flags.vision);
    }
    if (filter.requireAudio) {
      result = result.filter((m) => m.flags.audio);
    }

    return result.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Automatically detects task type from prompt content and request context.
   * @param {string} input - User message text
   * @param {object} context - Request context (media, attachments, mimeType)
   * @returns {string} One of TASK_TYPES
   */
  detectTaskType(input = '', context = {}) {
    const text = String(input || '')
      .trim()
      .toLowerCase();

    // 1. Audio check
    if (
      context.mimeType?.startsWith('audio/') ||
      context.media?.type === 'audio' ||
      context.media?.mimeType?.startsWith('audio/')
    ) {
      return TASK_TYPES.AUDIO;
    }

    // 2. Vision check
    if (
      context.mimeType?.startsWith('image/') ||
      context.media?.type === 'image' ||
      context.media?.mimeType?.startsWith('image/') ||
      context.hasImage
    ) {
      return TASK_TYPES.VISION;
    }

    // 3. Document check
    if (
      context.isDocument ||
      context.media?.type === 'document' ||
      context.mimeType === 'application/pdf' ||
      context.mimeType?.includes('officedocument') ||
      context.mimeType?.includes('text/plain')
    ) {
      return TASK_TYPES.DOCUMENT;
    }

    // 4. Coding patterns
    const codePatterns = [
      /```[\s\S]*```/,
      /\b(function|def|class|const|let|var|return|import|export|from|async|await)\b/,
      /\b(syntaxerror|typeerror|referenceerror|traceback|uncaught exception)\b/i,
      /\b(git commit|git push|docker|kubectl|npm test|npm run|sql select|regex)\b/i,
      /[{}()[\]];\n/,
    ];
    if (codePatterns.some((pattern) => pattern.test(text))) {
      return TASK_TYPES.CODING;
    }

    // 5. Reasoning / Math / Logic puzzles
    const reasoningPatterns = [
      /\b(prove that|derive|calculate step by step|step-by-step reasoning|logic puzzle)\b/i,
      /\b(solve equation|integral of|differential equation|matrix multiplication)\b/i,
      /\b(game theory|deductive logic|formal proof)\b/i,
    ];
    if (reasoningPatterns.some((pattern) => pattern.test(text))) {
      return TASK_TYPES.REASONING;
    }

    // 6. Large document summarization request
    if ((text.includes('summarize this document') || text.includes('extract key points from')) && text.length > 1500) {
      return TASK_TYPES.DOCUMENT;
    }

    // Default: chat
    return TASK_TYPES.CHAT;
  }

  /**
   * Health / Circuit Breaker tracking
   */
  recordModelSuccess(modelId) {
    this.modelHealth.delete(modelId);
  }

  recordModelFailure(modelId, error = null, cooldownMs = null) {
    const now = Date.now();
    const duration = cooldownMs || this.defaultCooldownMs;
    const existing = this.modelHealth.get(modelId) || { failures: 0, cooldownUntil: 0, lastError: '' };
    const failures = existing.failures + 1;
    const cooldownUntil = now + duration * Math.min(failures, 5);

    this.modelHealth.set(modelId, {
      failures,
      cooldownUntil,
      lastError: error ? String(error.message || error) : 'Unknown error',
    });

    privacyLog('warn', 'MODEL_ROUTER_FAILURE_RECORDED', {
      modelId,
      failures,
      cooldownUntil: new Date(cooldownUntil).toISOString(),
      error: error?.message,
    });
  }

  isModelAvailable(modelId) {
    const health = this.modelHealth.get(modelId);
    if (!health) return true;
    if (Date.now() >= health.cooldownUntil) {
      // Cooldown expired, tentatively available
      return true;
    }
    return false;
  }

  resetModelHealth() {
    this.modelHealth.clear();
  }

  /**
   * Routes a task to the optimal model based on task type and requirements.
   * @param {string} taskType - Member of TASK_TYPES
   * @param {object} requirements - Filtering and preference options
   * @returns {{ modelId: string, model: object, score: number, reason: string }}
   */
  routeTask(taskType = TASK_TYPES.CHAT, requirements = {}) {
    const validTask = Object.values(TASK_TYPES).includes(taskType) ? taskType : TASK_TYPES.CHAT;
    const candidates = this.listModels({
      capability: validTask,
      minContextWindow: requirements.minContextWindow,
      requireTools: requirements.requireTools,
      requireVision: requirements.requireVision,
      requireAudio: requirements.requireAudio,
      provider: requirements.preferredProvider,
    });

    if (candidates.length === 0) {
      // Fallback: search any model supporting the capability ignoring strict provider
      const fallbackCandidates = this.listModels({ capability: validTask });
      if (fallbackCandidates.length === 0) {
        // Last resort: return primary default model
        const defaultModel = this.models.get('gemini-3.1-flash-lite') || this.models.values().next().value;
        return {
          modelId: defaultModel?.id || 'gemini-3.1-flash-lite',
          model: defaultModel,
          score: 1,
          reason: 'Fallback to default model (no candidates found for task)',
        };
      }
      return {
        modelId: fallbackCandidates[0].id,
        model: fallbackCandidates[0],
        score: 10,
        reason: 'Best match without strict provider constraint',
      };
    }

    // Score candidates
    const scored = candidates.map((model) => {
      let score = model.priority * 10;

      // Availability boost / penalty
      if (this.isModelAvailable(model.id)) {
        score += 20;
      } else {
        score -= 50; // In cooldown
      }

      // Cost tier preference
      if (requirements.prefersCost === COST_TIERS.FREE) {
        if (model.costTier === COST_TIERS.FREE) score += 25;
        else if (model.costTier === COST_TIERS.LOW) score += 10;
        else score -= 20;
      }

      // Speed tier preference
      if (requirements.prefersSpeed === SPEED_TIERS.FAST) {
        if (model.speedTier === SPEED_TIERS.FAST) score += 20;
        else if (model.speedTier === SPEED_TIERS.SLOW) score -= 15;
      }

      // Task affinity bonus
      if (validTask === TASK_TYPES.CODING && model.id.includes('coder')) {
        score += 30;
      }
      if (validTask === TASK_TYPES.DOCUMENT && model.contextWindow >= 1_000_000) {
        score += 15;
      }
      if (validTask === TASK_TYPES.REASONING && model.id.includes('pro')) {
        score += 15;
      }

      return { model, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0];

    return {
      modelId: chosen.model.id,
      model: chosen.model,
      score: chosen.score,
      reason: `Optimal model for task '${validTask}' with score ${chosen.score}`,
    };
  }

  /**
   * Generates a smart fallback cascade list for a task.
   * @param {string} primaryModelId
   * @param {string} taskType
   * @param {object} options
   * @returns {string[]} Ordered list of model IDs
   */
  getFallbackChain(primaryModelId, taskType = TASK_TYPES.CHAT, options = {}) {
    const primary = this.getModel(primaryModelId);
    const chain = [];

    if (primary && primary.capabilities.includes(taskType)) {
      chain.push(primary.id);
    }

    const viable = this.listModels({
      capability: taskType,
      requireTools: options.requireTools,
      requireVision: options.requireVision,
      requireAudio: options.requireAudio,
    });

    for (const m of viable) {
      if (!chain.includes(m.id)) {
        chain.push(m.id);
      }
    }

    // Always ensure at least one model exists in chain
    if (chain.length === 0) {
      chain.push(primaryModelId || 'gemini-3.1-flash-lite');
    }

    return chain;
  }

  /**
   * Executes a task with seamless fallback cascade across providers and models.
   * @param {string} taskType - Task type
   * @param {Function} executeFn - Function receiving (modelId, attemptContext)
   * @param {object} options - Execution options (preferredModel, userId, timeoutMs)
   * @returns {Promise<{ result: any, modelUsed: string, attempts: number, latencyMs: number, fallbackOccurred: boolean }>}
   */
  async executeWithFallback(taskType, executeFn, options = {}) {
    const { preferredModel, userId = 'default_user', maxAttempts = 3 } = options;
    const primaryId = preferredModel || this.routeTask(taskType, options).modelId;
    const chain = this.getFallbackChain(primaryId, taskType, options).slice(0, maxAttempts);

    const startTime = Date.now();
    const errors = [];
    let attempts = 0;

    for (const modelId of chain) {
      attempts++;
      const isFallback = modelId !== primaryId;

      // Budget check before attempting model
      const budgetCheck = this.checkBudget(userId);
      if (!budgetCheck.allowed) {
        throw new Error(`Budget exceeded for user '${userId}': ${budgetCheck.reason}`);
      }

      const attemptStart = Date.now();
      try {
        const result = await executeFn(modelId, {
          attempt: attempts,
          isFallback,
          taskType,
          model: this.getModel(modelId),
        });

        const attemptLatency = Date.now() - attemptStart;
        const totalLatency = Date.now() - startTime;

        this.recordModelSuccess(modelId);

        // Usage tracking
        const promptTokens = result?.tokens?.prompt || 0;
        const completionTokens = result?.tokens?.completion || 0;
        this.trackUsage({
          model: modelId,
          taskType,
          promptTokens,
          completionTokens,
          latencyMs: attemptLatency,
          userId,
        });

        return {
          result,
          modelUsed: modelId,
          attempts,
          latencyMs: totalLatency,
          fallbackOccurred: isFallback,
        };
      } catch (err) {
        const attemptLatency = Date.now() - attemptStart;
        errors.push({ modelId, error: err.message, latencyMs: attemptLatency });
        this.recordModelFailure(modelId, err);
        this.usage.global.totalFailures++;

        privacyLog('warn', 'MODEL_EXECUTION_ATTEMPT_FAILED', {
          modelId,
          attempt: attempts,
          error: err.message,
        });
      }
    }

    const totalLatency = Date.now() - startTime;
    const failureSummary = errors.map((e) => `[${e.modelId}: ${e.error}]`).join(', ');
    throw new Error(
      `All fallback models failed for task '${taskType}' after ${attempts} attempts in ${totalLatency}ms. Errors: ${failureSummary}`
    );
  }

  /**
   * Budget Safeguard configuration
   * @param {string} target - 'global' or userId
   * @param {object} limits - { maxTokensPerDay, maxRequestsPerDay, maxLatencyMs }
   */
  setBudget(target = 'global', limits = {}) {
    this.budgets.set(target, {
      maxTokensPerDay: Number(limits.maxTokensPerDay) || Infinity,
      maxRequestsPerDay: Number(limits.maxRequestsPerDay) || Infinity,
      maxLatencyMs: Number(limits.maxLatencyMs) || Infinity,
    });
  }

  /**
   * Verifies whether a request fits within configured budget safeguards.
   * @param {string} userId
   * @param {number} estimatedTokens
   * @returns {{ allowed: boolean, remainingTokens: number, remainingRequests: number, reason: string|null }}
   */
  checkBudget(userId = 'default_user', estimatedTokens = 0) {
    const today = new Date().toISOString().slice(0, 10);
    const userUsage = this.usage.byUser.get(userId) || { dailyTokens: 0, dailyRequests: 0, date: today };

    // Reset daily counter if date shifted
    if (userUsage.date !== today) {
      userUsage.dailyTokens = 0;
      userUsage.dailyRequests = 0;
      userUsage.date = today;
      this.usage.byUser.set(userId, userUsage);
    }

    const userBudget = this.budgets.get(userId);
    const globalBudget = this.budgets.get('global');

    // 1. Check user budget
    if (userBudget) {
      if (userUsage.dailyRequests + 1 > userBudget.maxRequestsPerDay) {
        return {
          allowed: false,
          remainingTokens: Math.max(0, userBudget.maxTokensPerDay - userUsage.dailyTokens),
          remainingRequests: 0,
          reason: `Daily request limit of ${userBudget.maxRequestsPerDay} reached`,
        };
      }
      if (userUsage.dailyTokens + estimatedTokens > userBudget.maxTokensPerDay) {
        return {
          allowed: false,
          remainingTokens: 0,
          remainingRequests: Math.max(0, userBudget.maxRequestsPerDay - userUsage.dailyRequests),
          reason: `Daily token limit of ${userBudget.maxTokensPerDay} reached`,
        };
      }
    }

    // 2. Check global budget
    if (globalBudget) {
      if (this.usage.global.totalRequests + 1 > globalBudget.maxRequestsPerDay) {
        return {
          allowed: false,
          remainingTokens: Math.max(0, globalBudget.maxTokensPerDay - this.usage.global.totalTokens),
          remainingRequests: 0,
          reason: `Global daily request budget of ${globalBudget.maxRequestsPerDay} reached`,
        };
      }
    }

    const remainingTokens = userBudget ? Math.max(0, userBudget.maxTokensPerDay - userUsage.dailyTokens) : Infinity;
    const remainingRequests = userBudget
      ? Math.max(0, userBudget.maxRequestsPerDay - userUsage.dailyRequests)
      : Infinity;

    return {
      allowed: true,
      remainingTokens,
      remainingRequests,
      reason: null,
    };
  }

  /**
   * Tracks token consumption, latency, and cost for models and users.
   */
  trackUsage(entry) {
    const {
      model,
      taskType = 'chat',
      promptTokens = 0,
      completionTokens = 0,
      latencyMs = 0,
      userId = 'default_user',
    } = entry;
    const totalTokens = promptTokens + completionTokens;
    const modelMeta = this.getModel(model);

    const cost = modelMeta
      ? (promptTokens / 1000) * modelMeta.costPer1kInput + (completionTokens / 1000) * modelMeta.costPer1kOutput
      : 0;

    // 1. Global updates
    this.usage.global.totalRequests++;
    this.usage.global.promptTokens += promptTokens;
    this.usage.global.completionTokens += completionTokens;
    this.usage.global.totalTokens += totalTokens;
    this.usage.global.totalLatencyMs += latencyMs;
    this.usage.global.totalCost += cost;

    // 2. Model updates
    const modelStat = this.usage.byModel.get(model) || {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      totalCost: 0,
    };
    modelStat.requests++;
    modelStat.promptTokens += promptTokens;
    modelStat.completionTokens += completionTokens;
    modelStat.totalTokens += totalTokens;
    modelStat.totalLatencyMs += latencyMs;
    modelStat.avgLatencyMs = Math.round(modelStat.totalLatencyMs / modelStat.requests);
    modelStat.totalCost += cost;
    this.usage.byModel.set(model, modelStat);

    // 3. User updates
    const today = new Date().toISOString().slice(0, 10);
    const userStat = this.usage.byUser.get(userId) || { dailyTokens: 0, dailyRequests: 0, date: today };
    if (userStat.date !== today) {
      userStat.dailyTokens = 0;
      userStat.dailyRequests = 0;
      userStat.date = today;
    }
    userStat.dailyRequests++;
    userStat.dailyTokens += totalTokens;
    this.usage.byUser.set(userId, userStat);

    // 4. Task updates
    const taskCount = this.usage.byTask.get(taskType) || 0;
    this.usage.byTask.set(taskType, taskCount + 1);
  }

  /**
   * Returns complete usage snapshot.
   * @returns {object}
   */
  getUsageMetrics() {
    return {
      global: {
        ...this.usage.global,
        avgLatencyMs:
          this.usage.global.totalRequests > 0
            ? Math.round(this.usage.global.totalLatencyMs / this.usage.global.totalRequests)
            : 0,
      },
      models: Object.fromEntries(this.usage.byModel),
      users: Object.fromEntries(this.usage.byUser),
      tasks: Object.fromEntries(this.usage.byTask),
    };
  }

  /**
   * Resets usage counters.
   */
  resetUsageMetrics() {
    this.usage.global = {
      totalRequests: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalLatencyMs: 0,
      totalCost: 0,
      totalFailures: 0,
    };
    this.usage.byModel.clear();
    this.usage.byUser.clear();
    this.usage.byTask.clear();
  }
}

// Export singleton instance
export const modelRouter = new ModelRouter();
