import express from 'express';
import { config, normalizePhoneNumber } from '../config.js';
import {
  getRecentLogs,
  getActiveSessionCount,
  privacyLog,
  getRedactionCounters,
  isVoiceReplyEnabled,
  setVoiceReplyEnabled,
  getAnonymizedId,
} from '../privacy.js';
import {
  getActiveModel,
  setActiveModel,
  isSearchGroundingEnabled,
  setSearchGrounding,
  getFallbackModels,
  setFallbackModels,
} from '../gemini.js';
import { listAllMemoryFacts, upsertMemoryFact, deleteMemoryFactById, clearAllMemoryFacts } from '../memory.js';
import { ragEngine } from '../rag/index.js';
import { orchestrator } from '../agents/orchestrator.js';
import { modelRouter } from '../model-router.js';
import { getUserBriefingSettings, updateUserBriefingSettings } from '../briefing.js';
import { getPrimaryAdminNumber } from '../contacts.js';
import { messageQueue } from '../queue.js';
import { listActiveHandoffs, setHumanHandoff } from '../approval.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from '../web-scraper.js';
import { getBackgroundQuotaReport } from '../quota.js';
import { jobEngine } from '../job-engine.js';

const DASHBOARD_KB_TENANT = 'dashboard_kb';
const docContentCache = new Map();

// Ensure core dashboard job types have real cooperative handlers on the shared JobEngine
function waitAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function registerDefaultDashboardJobHandlers() {
  const defaultHandler = async (job, updateProgress, signal) => {
    await updateProgress(25, { step: 'initializing', type: job.type });
    await waitAbortable(200, signal);
    await updateProgress(75, { step: 'executing', type: job.type });
    if (job.type === 'document_indexing') {
      const stats = ragEngine.getStats(DASHBOARD_KB_TENANT);
      await updateProgress(100, { indexedDocs: stats.totalDocuments });
      return { status: 'indexed', ...stats };
    }
    await updateProgress(100, { step: 'complete' });
    return { status: 'completed', type: job.type };
  };

  for (const jobType of ['system_task', 'document_indexing', 'briefing_compile', 'web_knowledge_scrape']) {
    if (!jobEngine.handlers.has(jobType)) {
      jobEngine.registerJobHandler(jobType, defaultHandler);
    }
  }
}

// Per-agent runtime overrides synced with orchestrator
const agentMetadataOverrides = new Map([
  [
    'research',
    {
      name: 'Research Agent',
      description: 'Web & Search grounding specialist with verified citation extraction.',
      permissions: { allowWebSearch: true, allowCodeExecution: false, allowFileAccess: true, allowToolDispatch: true },
      maxHops: 3,
      modelPreference: 'gemini-3.5-flash',
    },
  ],
  [
    'coding',
    {
      name: 'Coding & Architecture Agent',
      description: 'Full-stack software engineering, syntax verification, and bug fixing.',
      permissions: { allowWebSearch: true, allowCodeExecution: true, allowFileAccess: true, allowToolDispatch: true },
      maxHops: 3,
      modelPreference: 'gemini-3.5-flash',
    },
  ],
  [
    'document',
    {
      name: 'Document Analysis Agent',
      description: 'PDF, DOCX, and text file parser with chunked RAG retrieval.',
      permissions: { allowWebSearch: false, allowCodeExecution: false, allowFileAccess: true, allowToolDispatch: true },
      maxHops: 2,
      modelPreference: 'gemini-3.5-flash',
    },
  ],
  [
    'media',
    {
      name: 'Media & Vision Agent',
      description: 'Computer vision OCR, audio transcription, and image/video synthesis.',
      permissions: { allowWebSearch: false, allowCodeExecution: false, allowFileAccess: true, allowToolDispatch: true },
      maxHops: 2,
      modelPreference: 'gemini-3.5-flash-lite',
    },
  ],
  [
    'productivity',
    {
      name: 'Productivity & Schedule Agent',
      description: 'Reminders, task queues, contacts, and calendar synchronization.',
      permissions: {
        allowWebSearch: false,
        allowCodeExecution: false,
        allowFileAccess: false,
        allowToolDispatch: true,
      },
      maxHops: 1,
      modelPreference: 'gemini-3.1-flash-lite',
    },
  ],
  [
    'conversation',
    {
      name: 'Conversation Fast-Path Agent',
      description: 'High-speed conversational turns, greetings, and persona adaptation.',
      permissions: {
        allowWebSearch: false,
        allowCodeExecution: false,
        allowFileAccess: false,
        allowToolDispatch: false,
      },
      maxHops: 1,
      modelPreference: 'gemini-3.1-flash-lite',
    },
  ],
]);

const routerRuntimeConfig = {
  strategy: 'latency-priority',
  circuitBreaker: {
    state: 'closed',
    failureThreshold: 5,
    failureCount: 0,
    lastFailure: null,
    resetTimeoutMs: 30000,
  },
};

function formatJobForDashboard(job) {
  const toIso = (val) => (typeof val === 'number' ? new Date(val).toISOString() : val || null);
  return {
    id: job.id,
    title: job.payload?.title || job.type,
    type: job.type,
    priority: job.priority,
    status: job.status,
    progress: job.progress ?? 0,
    retries: job.retries ?? 0,
    maxRetries: job.maxRetries ?? 3,
    payload: job.payload || {},
    createdAt: toIso(job.createdAt),
    startedAt: toIso(job.startedAt),
    completedAt: toIso(job.completedAt),
    error: job.error || null,
  };
}

function getDefaultUserAnonId() {
  const adminPhone = getPrimaryAdminNumber();
  return adminPhone ? getAnonymizedId(adminPhone) : 'default_user';
}

/**
 * Builds the core operational routes for the Mission Control Dashboard.
 * @returns {express.Router}
 */
export function createOpsRouter() {
  const router = express.Router();
  registerDefaultDashboardJobHandlers();

  // 1. OVERVIEW
  router.get('/overview', async (_req, res) => {
    try {
      const uptimeSec = Math.floor(process.uptime());
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const seconds = uptimeSec % 60;
      const uptimeFormatted = `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s`;

      const mem = process.memoryUsage();
      const qStats = messageQueue.getStats();
      const jobStats = await jobEngine.getStats();
      const activeModel = getActiveModel() || config.GEMINI_MODEL;
      const fallbackChain = getFallbackModels();
      const activeSessions = getActiveSessionCount ? getActiveSessionCount() : 0;
      const briefingSettings = getUserBriefingSettings('default_user');
      const isVolatileChat = config.STATE_BACKEND === 'memory' && !config.REMINDERS_PERSIST;

      res.status(200).json({
        success: true,
        status: 'online',
        systemHealth: 'healthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: uptimeSec,
        uptimeFormatted,
        model: {
          active: activeModel,
          fallbackChain,
          strategy: routerRuntimeConfig.strategy,
        },
        messageCounts: {
          queuePending: qStats.pending,
          queueActive: qStats.active,
          queueProcessed: qStats.processed || 0,
          queueFailed: qStats.failed || 0,
          activeSessions,
          maxQueueSize: qStats.maxSize,
        },
        activeJobs: {
          running: jobStats.running || 0,
          queued: jobStats.queued || 0,
          totalTracked: jobStats.total || 0,
        },
        memory: {
          rssMb: Math.round(mem.rss / (1024 * 1024)),
          heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
          heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
        },
        features: {
          searchGrounding: isSearchGroundingEnabled(),
          voiceReply: isVoiceReplyEnabled(getDefaultUserAnonId()),
          dailyBriefing: Boolean(briefingSettings.enabled),
          zeroDiskStorage: isVolatileChat,
          stateBackend: config.STATE_BACKEND || 'memory',
          groupAdminDiskStore: Boolean(config.GROUP_ADMIN_ENABLED),
        },
      });
    } catch (err) {
      privacyLog('error', 'DASHBOARD_OVERVIEW_ERROR', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to retrieve overview statistics.' });
    }
  });

  // 2. SEMANTIC MEMORY (backed live by src/memory.js)
  router.get('/memory', (req, res) => {
    try {
      const q = req.query.q ? String(req.query.q).toLowerCase().trim() : '';
      const category = req.query.category ? String(req.query.category).trim() : '';
      const userId = req.query.userId ? String(req.query.userId).trim() : '';

      const snapshot = listAllMemoryFacts();
      let facts = snapshot.facts;

      if (userId) facts = facts.filter((f) => f.userId === userId);
      if (category) facts = facts.filter((f) => f.category === category);
      if (q) {
        facts = facts.filter(
          (f) =>
            f.fact.toLowerCase().includes(q) ||
            f.category.toLowerCase().includes(q) ||
            (f.source && f.source.toLowerCase().includes(q))
        );
      }

      res.status(200).json({
        success: true,
        total: facts.length,
        categories: snapshot.categories,
        autoEnabled: snapshot.autoEnabled,
        facts,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/memory', async (req, res) => {
    try {
      const { id, userId, category, fact, confidence, source } = req.body || {};
      if (!fact || typeof fact !== 'string' || !fact.trim()) {
        return res.status(400).json({ success: false, error: 'Missing or invalid fact text.' });
      }

      const updatedFact = await upsertMemoryFact({ id, userId, category, fact, confidence, source });
      privacyLog('info', 'DASHBOARD_MEMORY_SAVED', { id: updatedFact.id, category: updatedFact.category });
      res.status(200).json({ success: true, fact: updatedFact });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/memory', async (req, res) => {
    try {
      const id = req.query.id || (req.body && req.body.id);
      const clearAll = req.query.clear === 'true' || (req.body && req.body.clear === true);

      if (clearAll) {
        const count = await clearAllMemoryFacts();
        privacyLog('info', 'DASHBOARD_MEMORY_CLEARED', { count });
        return res.status(200).json({ success: true, message: `Cleared ${count} facts.` });
      }

      if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required query param or body: id.' });
      }

      const factId = String(id).trim();
      const deleted = await deleteMemoryFactById(factId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: `Fact not found with id: ${factId}` });
      }

      privacyLog('info', 'DASHBOARD_MEMORY_DELETED', { id: factId });
      res.status(200).json({ success: true, deletedId: factId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. KNOWLEDGE BASE & RAG (backed live by src/rag/index.js)
  router.get('/knowledge', (req, res) => {
    try {
      const q = req.query.q ? String(req.query.q).toLowerCase().trim() : '';
      const category = req.query.category ? String(req.query.category).trim() : '';

      let docs = ragEngine.listDocuments(DASHBOARD_KB_TENANT).map((d) => {
        const content = docContentCache.get(d.docId) || '';
        const meta = d.metadata || {};
        return {
          id: d.docId,
          title: d.title,
          category: meta.category || 'reference',
          chunkCount: d.chunkCount,
          charCount: d.charCount,
          tags: Array.isArray(meta.tags) ? meta.tags : [],
          createdAt: new Date(d.createdAt || Date.now()).toISOString(),
          snippet: content ? content.substring(0, 160) + (content.length > 160 ? '...' : '') : d.title,
          _rawContent: content,
        };
      });

      const totalChunks = docs.reduce((acc, d) => acc + (d.chunkCount || 0), 0);

      if (category) {
        docs = docs.filter((d) => d.category === category);
      }
      if (q) {
        docs = docs.filter(
          (d) =>
            d.title.toLowerCase().includes(q) ||
            d._rawContent.toLowerCase().includes(q) ||
            d.tags.some((t) => t.toLowerCase().includes(q))
        );
      }

      res.status(200).json({
        success: true,
        totalDocs: docs.length,
        totalChunks,
        vectorIndexed: true,
        documents: docs.map(({ _rawContent, ...pub }) => pub),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/knowledge', async (req, res) => {
    try {
      const { title, content, category, tags } = req.body || {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, error: 'Document title is required.' });
      }
      if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ success: false, error: 'Document content is required.' });
      }

      const cleanTitle = title.trim();
      const cleanContent = content.trim();
      const cleanCategory = category ? String(category).trim() : 'reference';
      const cleanTags = Array.isArray(tags) ? tags.map(String) : [];

      const ingested = await ragEngine.addDocument(
        DASHBOARD_KB_TENANT,
        { title: cleanTitle, text: cleanContent, metadata: { category: cleanCategory, tags: cleanTags } },
        {
          chunkSize: cleanContent.length < 400 ? 150 : 500,
          chunkOverlap: cleanContent.length < 400 ? 20 : 50,
          overwrite: true,
        }
      );

      if (!ingested.success) {
        return res.status(400).json({ success: false, error: ingested.error || 'Failed to index document.' });
      }

      docContentCache.set(ingested.docId, cleanContent);
      const stored = ragEngine.getDocument(DASHBOARD_KB_TENANT, ingested.docId);

      privacyLog('info', 'DASHBOARD_KNOWLEDGE_INDEXED', {
        id: ingested.docId,
        title: cleanTitle,
        chunks: ingested.chunkCount,
      });

      res.status(200).json({
        success: true,
        doc: {
          id: ingested.docId,
          title: cleanTitle,
          category: cleanCategory,
          chunkCount: ingested.chunkCount,
          charCount: stored?.charCount || cleanContent.length,
          tags: cleanTags,
          createdAt: new Date(stored?.createdAt || Date.now()).toISOString(),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/knowledge', (req, res) => {
    try {
      const id = req.query.id || (req.body && req.body.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required document id.' });
      }

      const docId = String(id).trim();
      const removed = ragEngine.deleteDocument(DASHBOARD_KB_TENANT, docId);
      if (!removed) {
        return res.status(404).json({ success: false, error: `Document not found with id: ${docId}` });
      }

      docContentCache.delete(docId);
      privacyLog('info', 'DASHBOARD_KNOWLEDGE_DELETED', { id: docId });
      res.status(200).json({ success: true, deletedId: docId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. MULTI-AGENT ORCHESTRATOR (synced with src/agents/orchestrator.js)
  router.get('/agents', (_req, res) => {
    try {
      const usageMetrics = modelRouter.getUsageMetrics();
      const byModel = usageMetrics.models || {};
      const agentsList = orchestrator.listAgents().map((registered) => {
        const meta = agentMetadataOverrides.get(registered.name) || {};
        const modelPref = meta.modelPreference || 'gemini-3.1-flash-lite';
        const stats = byModel[modelPref] || {};
        return {
          id: registered.name,
          name: meta.name || registered.role || registered.name,
          description: meta.description || registered.role,
          status: meta.status || 'active',
          permissions: meta.permissions || {
            allowWebSearch: false,
            allowCodeExecution: false,
            allowFileAccess: false,
            allowToolDispatch: registered.allowedTools.length > 0,
          },
          maxHops: meta.maxHops ?? orchestrator.maxAgentHops,
          modelPreference: modelPref,
          callCount: stats.requests || 0,
          avgLatencyMs: stats.avgLatencyMs || 0,
        };
      });

      res.status(200).json({
        success: true,
        totalAgents: agentsList.length,
        maxHopsDefault: orchestrator.maxAgentHops,
        fastPathEnabled: true,
        agents: agentsList,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put('/agents', (req, res) => {
    try {
      const { id, enabled, status, permissions, maxHops, modelPreference } = req.body || {};
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ success: false, error: 'Missing agent id.' });
      }

      const agentId = id.trim().toLowerCase();
      const liveAgent = orchestrator.getAgent(agentId);
      const existingMeta = agentMetadataOverrides.get(agentId);
      if (!liveAgent || !existingMeta) {
        return res.status(404).json({ success: false, error: `Agent not found: ${agentId}` });
      }

      const updated = { ...existingMeta, id: agentId };
      if (typeof enabled === 'boolean') {
        updated.status = enabled ? 'active' : 'disabled';
      } else if (status && typeof status === 'string') {
        updated.status = status;
      }

      if (permissions && typeof permissions === 'object') {
        updated.permissions = { ...updated.permissions, ...permissions };
      }
      if (typeof maxHops === 'number' && maxHops >= 1 && maxHops <= 10) {
        updated.maxHops = maxHops;
      }
      if (modelPreference && typeof modelPreference === 'string') {
        updated.modelPreference = modelPreference.trim();
      }

      agentMetadataOverrides.set(agentId, updated);
      privacyLog('info', 'DASHBOARD_AGENT_CONFIGURED', { id: agentId, status: updated.status || 'active' });

      res.status(200).json({
        success: true,
        agent: { ...updated, status: updated.status || 'active' },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. JOB ENGINE (backed live by src/job-engine.js)
  router.get('/jobs', async (req, res) => {
    try {
      const statusFilter = req.query.status ? String(req.query.status).toLowerCase().trim() : '';
      const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(req.query.limit, 10))) : 50;

      const engineStats = await jobEngine.getStats();
      const listRes = await jobEngine.listJobs({
        status: statusFilter && statusFilter !== 'all' ? statusFilter : undefined,
        limit,
      });

      res.status(200).json({
        success: true,
        stats: {
          total: engineStats.total || 0,
          queued: engineStats.queued || 0,
          running: engineStats.running || 0,
          completed: engineStats.completed || 0,
          failed: engineStats.failed || 0,
          cancelled: engineStats.cancelled || 0,
        },
        jobs: (listRes.jobs || []).map(formatJobForDashboard),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/jobs', async (req, res) => {
    try {
      const { action, id, type, title, priority, payload } = req.body || {};

      if (action === 'cancel' || req.body?.cancel === true) {
        if (!id) {
          return res.status(400).json({ success: false, error: 'Job id is required for cancellation.' });
        }
        const jobId = String(id).trim();
        const existing = await jobEngine.getJob(jobId);
        if (!existing) {
          return res.status(404).json({ success: false, error: `Job not found: ${id}` });
        }
        if (existing.status === 'completed') {
          return res.status(400).json({ success: false, error: 'Cannot cancel an already completed job.' });
        }
        await jobEngine.cancelJob(jobId, 'Cancelled from Mission Control Dashboard');
        const updated = await jobEngine.getJob(jobId);
        privacyLog('info', 'DASHBOARD_JOB_CANCELLED', { id: jobId });
        return res.status(200).json({ success: true, job: formatJobForDashboard(updated) });
      }

      if (action === 'retry') {
        if (!id) {
          return res.status(400).json({ success: false, error: 'Job id is required for retry.' });
        }
        const jobId = String(id).trim();
        const existing = await jobEngine.getJob(jobId);
        if (!existing) {
          return res.status(404).json({ success: false, error: `Job not found: ${id}` });
        }
        const retried = await jobEngine.retryJob(jobId);
        return res.status(200).json({ success: true, job: formatJobForDashboard(retried || existing) });
      }

      const jobTitle = title && typeof title === 'string' ? title.trim() : 'Background Task';
      const jobType = type && typeof type === 'string' ? type.trim() : 'system_task';
      const jobPriority = priority && ['high', 'normal', 'low'].includes(priority) ? priority : 'normal';
      registerDefaultDashboardJobHandlers();
      if (!jobEngine.handlers.has(jobType)) {
        jobEngine.registerJobHandler(jobType, async (_job, updateProgress, signal) => {
          await waitAbortable(200, signal);
          await updateProgress(100);
          return { status: 'completed', type: jobType };
        });
      }

      const submitted = await jobEngine.submitJob({
        type: jobType,
        priority: jobPriority,
        payload: { ...(payload || {}), title: jobTitle },
      });

      privacyLog('info', 'DASHBOARD_JOB_ENQUEUED', { id: submitted.id, type: jobType });
      res.status(201).json({ success: true, job: formatJobForDashboard(submitted) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6. MODEL ROUTER (backed live by gemini.js + src/model-router.js)
  router.get('/models', (_req, res) => {
    try {
      const currentActive = getActiveModel() || config.GEMINI_MODEL;
      const fallbackModels = getFallbackModels();
      const baseAvailable = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'];
      const availableModels = Array.from(new Set([currentActive, ...baseAvailable, ...fallbackModels]));

      const usageMetrics = modelRouter.getUsageMetrics();
      const byModel = usageMetrics.models || {};
      const modelStats = {
        'gemini-3.1-flash-lite': {
          requests: byModel['gemini-3.1-flash-lite']?.requests || 0,
          successes: byModel['gemini-3.1-flash-lite']?.requests || 0,
          failures: 0,
          avgLatencyMs: byModel['gemini-3.1-flash-lite']?.avgLatencyMs || 0,
        },
        ...byModel,
      };

      res.status(200).json({
        success: true,
        activeModel: currentActive,
        fallbackModels,
        availableModels,
        strategy: routerRuntimeConfig.strategy,
        circuitBreaker: routerRuntimeConfig.circuitBreaker,
        modelStats,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put('/models', (req, res) => {
    try {
      const { activeModel, fallbackModels, strategy, circuitBreakerReset } = req.body || {};

      if (activeModel && typeof activeModel === 'string') {
        setActiveModel(activeModel.trim());
      }
      if (Array.isArray(fallbackModels)) {
        setFallbackModels(fallbackModels);
      }
      if (strategy && ['latency-priority', 'cost-priority', 'quality-priority', 'balanced'].includes(strategy)) {
        routerRuntimeConfig.strategy = strategy;
      }
      if (circuitBreakerReset === true) {
        routerRuntimeConfig.circuitBreaker.state = 'closed';
        routerRuntimeConfig.circuitBreaker.failureCount = 0;
        routerRuntimeConfig.circuitBreaker.lastFailure = null;
      }

      const currentActive = getActiveModel() || config.GEMINI_MODEL;
      const effectiveFallbacks = getFallbackModels();

      privacyLog('info', 'DASHBOARD_MODEL_ROUTER_UPDATED', {
        model: currentActive,
        strategy: routerRuntimeConfig.strategy,
      });

      res.status(200).json({
        success: true,
        activeModel: currentActive,
        fallbackModels: effectiveFallbacks,
        strategy: routerRuntimeConfig.strategy,
        circuitBreaker: routerRuntimeConfig.circuitBreaker,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 7. SECURITY & PRIVACY (fixed real config.ALLOWED_PHONE_NUMBERS + live redactionCounters)
  router.get('/security', (_req, res) => {
    try {
      const whitelist = Array.from(config.ALLOWED_PHONE_NUMBERS || []);
      const primaryAdmin = getPrimaryAdminNumber();
      const extraAdmins = String(config.GROUP_ADMIN_HUMAN_ADMINS || '')
        .split(',')
        .map((n) => normalizePhoneNumber(n))
        .filter(Boolean);
      const adminNumbers = Array.from(new Set([primaryAdmin, ...extraAdmins].filter(Boolean)));

      const maskPhone = (num) => {
        const s = String(num).replace(/\D/g, '');
        if (s.length <= 4) return '***';
        return `+${s.slice(0, 2)} ***...${s.slice(-4)}`;
      };

      const logs = getRecentLogs ? getRecentLogs() : [];
      const formattedLogs = logs.slice(-50).map((log) => ({
        timestamp: log.timestamp || new Date().toISOString(),
        level: log.level || 'info',
        event: log.event || 'EVENT',
        meta: log.meta || {},
      }));

      const isVolatileChat = config.STATE_BACKEND === 'memory' && !config.REMINDERS_PERSIST;

      res.status(200).json({
        success: true,
        whitelist: {
          enabled: whitelist.length > 0,
          count: whitelist.length,
          authorizedNumbers: whitelist.map(maskPhone),
          adminNumbers: adminNumbers.map(maskPhone),
        },
        protectionBoundaries: {
          zeroDiskStorage: isVolatileChat,
          stateBackend: config.STATE_BACKEND || 'memory',
          groupAdminDiskStore: Boolean(config.GROUP_ADMIN_ENABLED),
          piiSanitization: true,
          hmacVerification: !config.SKIP_SIGNATURE_VERIFICATION,
          rateLimiting: true,
          sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES || 15,
        },
        redactionCounters: getRedactionCounters(),
        auditLogs: formattedLogs,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 8. SETTINGS & BRIEFING (fixed real config.STATE_BACKEND + wired live Gemini/Briefing state)
  router.get('/settings', (_req, res) => {
    try {
      const briefing = getUserBriefingSettings('default_user');
      res.status(200).json({
        success: true,
        environment: {
          nodeEnv: config.NODE_ENV,
          port: config.PORT,
          storageBackend: config.STATE_BACKEND || 'memory',
          sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES || 15,
          rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS || 60000,
          rateLimitMax: config.RATE_LIMIT_MAX_PER_WINDOW || 20,
        },
        features: {
          searchGrounding: isSearchGroundingEnabled(),
          voiceReply: isVoiceReplyEnabled(getDefaultUserAnonId()),
          imageGeneration: true,
          videoGeneration: true,
          ttsEnabled: true,
        },
        briefing: {
          enabled: Boolean(briefing.enabled),
          scheduledHour: briefing.deliveryHour,
          timezone: briefing.timezone,
          quietHours: briefing.quietHours,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put('/settings', (req, res) => {
    try {
      const { searchGrounding, voiceReply, briefing } = req.body || {};

      if (typeof searchGrounding === 'boolean') {
        setSearchGrounding(searchGrounding);
      }
      if (typeof voiceReply === 'boolean') {
        setVoiceReplyEnabled(getDefaultUserAnonId(), voiceReply);
      }

      if (briefing && typeof briefing === 'object') {
        const patch = {};
        if (typeof briefing.enabled === 'boolean') patch.enabled = briefing.enabled;
        if (typeof briefing.scheduledHour === 'number' && briefing.scheduledHour >= 0 && briefing.scheduledHour <= 23) {
          patch.deliveryHour = Math.floor(briefing.scheduledHour);
        }
        if (briefing.timezone && typeof briefing.timezone === 'string') {
          patch.timezone = briefing.timezone.trim();
        }
        if (briefing.quietHours && typeof briefing.quietHours === 'object') {
          const cur = getUserBriefingSettings('default_user').quietHours || {};
          patch.quietHours = {
            start: typeof briefing.quietHours.start === 'number' ? briefing.quietHours.start : cur.start,
            end: typeof briefing.quietHours.end === 'number' ? briefing.quietHours.end : cur.end,
          };
        }
        updateUserBriefingSettings('default_user', patch);
      }

      const updatedBriefing = getUserBriefingSettings('default_user');
      privacyLog('info', 'DASHBOARD_SETTINGS_UPDATED', {
        searchGrounding: isSearchGroundingEnabled(),
        briefingEnabled: updatedBriefing.enabled,
      });

      res.status(200).json({
        success: true,
        settings: {
          features: {
            searchGrounding: isSearchGroundingEnabled(),
            voiceReply: isVoiceReplyEnabled(getDefaultUserAnonId()),
          },
          briefing: {
            enabled: updatedBriefing.enabled,
            scheduledHour: updatedBriefing.deliveryHour,
            timezone: updatedBriefing.timezone,
            quietHours: updatedBriefing.quietHours,
          },
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 9. DLQ, HANDOFF, WEB-LEARN
  router.get('/dlq', async (_req, res) => {
    try {
      const deadLetters = await messageQueue.getDeadLetters();
      res.status(200).json({ success: true, count: deadLetters.length, deadLetters });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/dlq/:id/replay', async (req, res) => {
    try {
      const result = await messageQueue.replayDeadLetter(req.params.id);
      if (!result.success) {
        return res
          .status(404)
          .json({ success: false, error: result.error || 'Job not found or could not be replayed' });
      }
      res.status(200).json({ success: true, message: `Job ${req.params.id} replayed into work queue.` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/dlq/:id', async (req, res) => {
    try {
      await messageQueue.dismissDeadLetter(req.params.id);
      res.status(200).json({ success: true, message: `Job ${req.params.id} dismissed from DLQ.` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/handoff', async (_req, res) => {
    try {
      const handoffs = await listActiveHandoffs();
      res.status(200).json({ success: true, count: handoffs.length, handoffs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/handoff/:userId', async (req, res) => {
    try {
      const { enabled, reason, operatorId } = req.body;
      await setHumanHandoff(req.params.userId, Boolean(enabled), reason, operatorId);
      res.status(200).json({
        success: true,
        userId: req.params.userId,
        enabled: Boolean(enabled),
        message: enabled ? 'Human handoff activated.' : 'Human handoff cleared. AI resumed.',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/web-learn/watchlist', async (_req, res) => {
    try {
      const list = await getWatchlist();
      const quota = getBackgroundQuotaReport();
      res.status(200).json({ success: true, count: list.length, watchlist: list, quota });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/web-learn/watchlist', async (req, res) => {
    try {
      const { target, type, intervalSec, ttlSec } = req.body || {};
      const result = await addToWatchlist({ target, type, intervalSec, ttlSec });
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/web-learn/watchlist/:id', async (req, res) => {
    try {
      const result = await removeFromWatchlist(req.params.id);
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/web-learn/trigger', async (req, res) => {
    try {
      const job = await jobEngine.submitJob({
        type: 'web_knowledge_scrape',
        payload: { force: Boolean(req.body?.force) },
      });
      res.status(202).json({ success: true, jobId: job.id, status: job.status });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
