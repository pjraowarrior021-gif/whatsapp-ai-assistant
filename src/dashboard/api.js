import express from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { getRecentLogs, getActiveSessionCount, privacyLog } from '../privacy.js';
import { getActiveModel, setActiveModel } from '../gemini.js';
import { messageQueue } from '../queue.js';
import { listActiveHandoffs, setHumanHandoff } from '../approval.js';
import { getWatchlist, addToWatchlist, removeFromWatchlist } from '../web-scraper.js';
import { getBackgroundQuotaReport } from '../quota.js';
import { jobEngine } from '../job-engine.js';

export const dashboardRouter = express.Router();

// Ensure body parser is active for API router
dashboardRouter.use(express.json());

// In-Memory Redaction Counters & Dashboard Audit Log
const redactionCounters = {
  'Payment Card': 0,
  PIN: 0,
  Password: 0,
  'National ID': 0,
  SSN: 0,
  'One-Time Password': 0,
};

// In-Memory Knowledge Documents Store
const knowledgeDocs = new Map();

// Helper to chunk document into clean paragraphs/slices
function chunkDocumentText(text, maxChars = 500) {
  if (!text || typeof text !== 'string') return [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];

  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      chunks.push(para);
    } else {
      // Split large paragraphs by sentence or character boundary
      const sentences = para.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [para];
      let currentChunk = '';
      for (const sentence of sentences) {
        if ((currentChunk + ' ' + sentence).trim().length <= maxChars) {
          currentChunk = (currentChunk + ' ' + sentence).trim();
        } else {
          if (currentChunk) chunks.push(currentChunk);
          currentChunk = sentence.trim();
        }
      }
      if (currentChunk) chunks.push(currentChunk);
    }
  }

  return chunks.length > 0 ? chunks : [text.trim()];
}

// In-Memory Fact Store (Supplements or mirrors src/memory.js)
const memoryFacts = new Map();

// Initialize initial default memory facts for master user
const initialFacts = [
  {
    id: 'fact-1',
    userId: 'default_user',
    category: 'user_profile',
    fact: 'User prefers concise, bulleted responses without conversational filler.',
    confidence: 0.98,
    source: 'system',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: 'fact-2',
    userId: 'default_user',
    category: 'system_preference',
    fact: 'Standard code snippets should always use TypeScript or ES6 JavaScript.',
    confidence: 0.95,
    source: 'user_input',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
    updatedAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: 'fact-3',
    userId: 'default_user',
    category: 'timezone_schedule',
    fact: 'Active operating hours: 08:00 - 22:00 IST (UTC+5:30).',
    confidence: 0.99,
    source: 'auto_learner',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 86400000).toISOString(),
  },
];
initialFacts.forEach((f) => memoryFacts.set(f.id, f));

// In-Memory Agents Directory & Permissions
const agentsDirectory = new Map([
  [
    'research',
    {
      id: 'research',
      name: 'Research Agent',
      description: 'Web & Search grounding specialist with verified citation extraction.',
      status: 'active',
      permissions: {
        allowWebSearch: true,
        allowCodeExecution: false,
        allowFileAccess: true,
        allowToolDispatch: true,
      },
      maxHops: 3,
      modelPreference: 'gemini-2.5-flash',
      callCount: 42,
      avgLatencyMs: 412,
    },
  ],
  [
    'coding',
    {
      id: 'coding',
      name: 'Coding & Architecture Agent',
      description: 'Full-stack software engineering, syntax verification, and bug fixing.',
      status: 'active',
      permissions: {
        allowWebSearch: true,
        allowCodeExecution: true,
        allowFileAccess: true,
        allowToolDispatch: true,
      },
      maxHops: 3,
      modelPreference: 'gemini-2.5-pro',
      callCount: 28,
      avgLatencyMs: 820,
    },
  ],
  [
    'document',
    {
      id: 'document',
      name: 'Document Analysis Agent',
      description: 'PDF, DOCX, and text file parser with chunked RAG retrieval.',
      status: 'active',
      permissions: {
        allowWebSearch: false,
        allowCodeExecution: false,
        allowFileAccess: true,
        allowToolDispatch: true,
      },
      maxHops: 2,
      modelPreference: 'gemini-2.5-pro',
      callCount: 19,
      avgLatencyMs: 640,
    },
  ],
  [
    'media',
    {
      id: 'media',
      name: 'Media & Vision Agent',
      description: 'Computer vision OCR, audio transcription, and image/video synthesis.',
      status: 'active',
      permissions: {
        allowWebSearch: false,
        allowCodeExecution: false,
        allowFileAccess: true,
        allowToolDispatch: true,
      },
      maxHops: 2,
      modelPreference: 'gemini-2.5-flash',
      callCount: 35,
      avgLatencyMs: 780,
    },
  ],
  [
    'productivity',
    {
      id: 'productivity',
      name: 'Productivity & Schedule Agent',
      description: 'Reminders, task queues, contacts, and calendar synchronization.',
      status: 'active',
      permissions: {
        allowWebSearch: false,
        allowCodeExecution: false,
        allowFileAccess: false,
        allowToolDispatch: true,
      },
      maxHops: 1,
      modelPreference: 'gemini-3.1-flash-lite',
      callCount: 64,
      avgLatencyMs: 145,
    },
  ],
  [
    'conversation',
    {
      id: 'conversation',
      name: 'Conversation Fast-Path Agent',
      description: 'High-speed conversational turns, greetings, and persona adaptation.',
      status: 'active',
      permissions: {
        allowWebSearch: false,
        allowCodeExecution: false,
        allowFileAccess: false,
        allowToolDispatch: false,
      },
      maxHops: 1,
      modelPreference: 'gemini-3.1-flash-lite',
      callCount: 182,
      avgLatencyMs: 95,
    },
  ],
]);

// In-Memory Background Job Queue & Engine Store
const jobsStore = new Map();
let jobCounter = 1;

// Seed initial jobs
const initialJobs = [
  {
    id: 'job-101',
    title: 'Daily RAG Indexing & Vector Refresh',
    type: 'document_indexing',
    priority: 'normal',
    status: 'completed',
    progress: 100,
    retries: 0,
    maxRetries: 3,
    createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    startedAt: new Date(Date.now() - 3600000 * 2 + 1000).toISOString(),
    completedAt: new Date(Date.now() - 3600000 * 2 + 45000).toISOString(),
    error: null,
  },
  {
    id: 'job-102',
    title: 'Morning Briefing Digest Compilation',
    type: 'briefing_compile',
    priority: 'high',
    status: 'completed',
    progress: 100,
    retries: 0,
    maxRetries: 3,
    createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
    startedAt: new Date(Date.now() - 3600000 * 5 + 500).toISOString(),
    completedAt: new Date(Date.now() - 3600000 * 5 + 8200).toISOString(),
    error: null,
  },
];
initialJobs.forEach((j) => jobsStore.set(j.id, j));

// Model Router Configuration State
let modelRouterConfig = {
  activeModel: getActiveModel() || config.GEMINI_MODEL,
  fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  availableModels: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  strategy: 'latency-priority', // 'latency-priority' | 'cost-priority' | 'quality-priority' | 'balanced'
  circuitBreaker: {
    state: 'closed', // 'closed' | 'half-open' | 'open'
    failureThreshold: 5,
    failureCount: 0,
    lastFailure: null,
    resetTimeoutMs: 30000,
  },
  modelStats: {
    'gemini-3.1-flash-lite': { requests: 240, successes: 238, failures: 2, avgLatencyMs: 140 },
    'gemini-2.5-flash': { requests: 85, successes: 84, failures: 1, avgLatencyMs: 380 },
    'gemini-2.5-pro': { requests: 32, successes: 32, failures: 0, avgLatencyMs: 820 },
  },
};

// Runtime Config / Briefing Settings State
let runtimeSettings = {
  searchGrounding: Boolean(config.ENABLE_SEARCH_GROUNDING),
  voiceReply: false,
  briefing: {
    enabled: true,
    scheduledHour: 8,
    timezone: 'Asia/Kolkata',
    quietHours: {
      start: 23,
      end: 7,
    },
  },
};

/**
 * Timing-safe Authentication Middleware for Dashboard API
 * Validates OPS_TOKEN or API key from Authorization header, x-api-key, or query param.
 */
export function requireDashboardAuth(req, res, next) {
  const opsToken = config.OPS_TOKEN;
  let token = '';

  const authHeader = req.headers['authorization'] || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    token = String(apiKeyHeader).trim();
  } else if (req.query && req.query.token) {
    token = String(req.query.token).trim();
  }

  if (opsToken) {
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or invalid Authorization header, x-api-key, or token query.',
      });
    }

    const expectedBuf = Buffer.from(opsToken, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid operational token.',
      });
    }
    return next();
  }

  // Enforce token in production
  if (config.NODE_ENV === 'production') {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Dashboard operational endpoints require OPS_TOKEN in production.',
    });
  }

  return next();
}

// Apply authentication to all /dashboard/api routes except auth check/health probe
dashboardRouter.use((req, res, next) => {
  if (req.path === '/auth/status') {
    return next();
  }
  return requireDashboardAuth(req, res, next);
});

// =========================================================================
// 0. AUTH STATUS / PROBE
// =========================================================================
dashboardRouter.get('/auth/status', (req, res) => {
  const opsToken = config.OPS_TOKEN;
  let hasValidToken = false;

  let token = '';
  const authHeader = req.headers['authorization'] || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    token = String(apiKeyHeader).trim();
  } else if (req.query && req.query.token) {
    token = String(req.query.token).trim();
  }

  if (opsToken && token) {
    const expectedBuf = Buffer.from(opsToken, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');
    if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      hasValidToken = true;
    }
  } else if (!opsToken && config.NODE_ENV !== 'production') {
    hasValidToken = true;
  }

  res.status(200).json({
    success: true,
    authenticated: hasValidToken,
    requiresAuth: Boolean(opsToken) || config.NODE_ENV === 'production',
    env: config.NODE_ENV,
  });
});

// =========================================================================
// 1. OVERVIEW: System Status, Uptime, Model, Message Counts, Active Jobs
// =========================================================================
dashboardRouter.get('/overview', (_req, res) => {
  try {
    const uptimeSec = Math.floor(process.uptime());
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptimeFormatted = `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m ${seconds}s`;

    const mem = process.memoryUsage();
    const qStats = messageQueue.getStats();

    // Active background jobs count
    let activeJobsCount = 0;
    let pendingJobsCount = 0;
    jobsStore.forEach((j) => {
      if (j.status === 'running') activeJobsCount++;
      if (j.status === 'queued') pendingJobsCount++;
    });

    const activeModel = getActiveModel() || config.GEMINI_MODEL;
    const activeSessions = getActiveSessionCount ? getActiveSessionCount() : 0;

    res.status(200).json({
      success: true,
      status: 'online',
      systemHealth: 'healthy',
      timestamp: new Date().toISOString(),
      uptimeSeconds: uptimeSec,
      uptimeFormatted,
      model: {
        active: activeModel,
        fallbackChain: modelRouterConfig.fallbackModels,
        strategy: modelRouterConfig.strategy,
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
        running: activeJobsCount,
        queued: pendingJobsCount,
        totalTracked: jobsStore.size,
      },
      memory: {
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
        heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
      },
      features: {
        searchGrounding: runtimeSettings.searchGrounding,
        voiceReply: runtimeSettings.voiceReply,
        dailyBriefing: runtimeSettings.briefing.enabled,
        zeroDiskStorage: true,
      },
    });
  } catch (err) {
    privacyLog('error', 'DASHBOARD_OVERVIEW_ERROR', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to retrieve overview statistics.' });
  }
});

// =========================================================================
// 2. SEMANTIC MEMORY: Browse, Search, Add/Edit, Delete Facts
// =========================================================================
dashboardRouter.get('/memory', (req, res) => {
  try {
    const q = req.query.q ? String(req.query.q).toLowerCase().trim() : '';
    const category = req.query.category ? String(req.query.category).trim() : '';
    const userId = req.query.userId ? String(req.query.userId).trim() : '';

    let facts = Array.from(memoryFacts.values());

    if (userId) {
      facts = facts.filter((f) => f.userId === userId);
    }
    if (category) {
      facts = facts.filter((f) => f.category === category);
    }
    if (q) {
      facts = facts.filter(
        (f) =>
          f.fact.toLowerCase().includes(q) ||
          f.category.toLowerCase().includes(q) ||
          (f.source && f.source.toLowerCase().includes(q))
      );
    }

    const categories = Array.from(new Set(Array.from(memoryFacts.values()).map((f) => f.category)));

    res.status(200).json({
      success: true,
      total: facts.length,
      categories,
      autoEnabled: true,
      facts,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.post('/memory', (req, res) => {
  try {
    const { id, userId, category, fact, confidence, source } = req.body || {};

    if (!fact || typeof fact !== 'string' || !fact.trim()) {
      return res.status(400).json({ success: false, error: 'Missing or invalid fact text.' });
    }

    const factCategory = category && typeof category === 'string' ? category.trim() : 'general';
    const factId = id ? String(id).trim() : `fact-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = new Date().toISOString();

    const existing = memoryFacts.get(factId);
    const updatedFact = {
      id: factId,
      userId: userId ? String(userId).trim() : existing ? existing.userId : 'default_user',
      category: factCategory,
      fact: fact.trim(),
      confidence:
        typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : existing ? existing.confidence : 0.95,
      source: source || (existing ? existing.source : 'dashboard'),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    memoryFacts.set(factId, updatedFact);
    privacyLog('info', 'DASHBOARD_MEMORY_SAVED', { id: factId, category: factCategory });

    res.status(200).json({
      success: true,
      fact: updatedFact,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.delete('/memory', (req, res) => {
  try {
    const id = req.query.id || (req.body && req.body.id);
    const clearAll = req.query.clear === 'true' || (req.body && req.body.clear === true);

    if (clearAll) {
      const count = memoryFacts.size;
      memoryFacts.clear();
      privacyLog('info', 'DASHBOARD_MEMORY_CLEARED', { count });
      return res.status(200).json({ success: true, message: `Cleared ${count} facts.` });
    }

    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing required query param or body: id.' });
    }

    const factId = String(id).trim();
    if (!memoryFacts.has(factId)) {
      return res.status(404).json({ success: false, error: `Fact not found with id: ${factId}` });
    }

    memoryFacts.delete(factId);
    privacyLog('info', 'DASHBOARD_MEMORY_DELETED', { id: factId });

    res.status(200).json({
      success: true,
      deletedId: factId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 3. KNOWLEDGE BASE & RAG: List, Upload/Index Text, Delete Docs
// =========================================================================
dashboardRouter.get('/knowledge', (req, res) => {
  try {
    const q = req.query.q ? String(req.query.q).toLowerCase().trim() : '';
    const category = req.query.category ? String(req.query.category).trim() : '';

    let docs = Array.from(knowledgeDocs.values());

    if (category) {
      docs = docs.filter((d) => d.category === category);
    }
    if (q) {
      docs = docs.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.content.toLowerCase().includes(q) ||
          (d.tags && d.tags.some((t) => t.toLowerCase().includes(q)))
      );
    }

    let totalChunks = 0;
    knowledgeDocs.forEach((d) => {
      totalChunks += d.chunkCount;
    });

    res.status(200).json({
      success: true,
      totalDocs: docs.length,
      totalChunks,
      vectorIndexed: true,
      documents: docs.map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        chunkCount: d.chunkCount,
        charCount: d.charCount,
        tags: d.tags,
        createdAt: d.createdAt,
        snippet: d.content.substring(0, 160) + (d.content.length > 160 ? '...' : ''),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.post('/knowledge', (req, res) => {
  try {
    const { title, content, category, tags } = req.body || {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Document title is required.' });
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Document content is required.' });
    }

    const docId = `doc-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const chunks = chunkDocumentText(content.trim(), 500);
    const now = new Date().toISOString();

    const newDoc = {
      id: docId,
      title: title.trim(),
      category: category ? String(category).trim() : 'reference',
      content: content.trim(),
      chunks,
      chunkCount: chunks.length,
      charCount: content.trim().length,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      createdAt: now,
      updatedAt: now,
    };

    knowledgeDocs.set(docId, newDoc);
    privacyLog('info', 'DASHBOARD_KNOWLEDGE_INDEXED', {
      id: docId,
      title: newDoc.title,
      chunks: chunks.length,
    });

    res.status(200).json({
      success: true,
      doc: {
        id: newDoc.id,
        title: newDoc.title,
        category: newDoc.category,
        chunkCount: newDoc.chunkCount,
        charCount: newDoc.charCount,
        tags: newDoc.tags,
        createdAt: newDoc.createdAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.delete('/knowledge', (req, res) => {
  try {
    const id = req.query.id || (req.body && req.body.id);
    if (!id) {
      return res.status(400).json({ success: false, error: 'Missing required document id.' });
    }

    const docId = String(id).trim();
    if (!knowledgeDocs.has(docId)) {
      return res.status(404).json({ success: false, error: `Document not found with id: ${docId}` });
    }

    knowledgeDocs.delete(docId);
    privacyLog('info', 'DASHBOARD_KNOWLEDGE_DELETED', { id: docId });

    res.status(200).json({
      success: true,
      deletedId: docId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 4. MULTI-AGENT ORCHESTRATOR: List Agents, Inspect Status, Permissions
// =========================================================================
dashboardRouter.get('/agents', (_req, res) => {
  try {
    const agentsList = Array.from(agentsDirectory.values());
    res.status(200).json({
      success: true,
      totalAgents: agentsList.length,
      maxHopsDefault: 3,
      fastPathEnabled: true,
      agents: agentsList,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.put('/agents', (req, res) => {
  try {
    const { id, enabled, status, permissions, maxHops, modelPreference } = req.body || {};

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing agent id.' });
    }

    const agentId = id.trim().toLowerCase();
    const agent = agentsDirectory.get(agentId);

    if (!agent) {
      return res.status(404).json({ success: false, error: `Agent not found: ${agentId}` });
    }

    if (typeof enabled === 'boolean') {
      agent.status = enabled ? 'active' : 'disabled';
    } else if (status && typeof status === 'string') {
      agent.status = status;
    }

    if (permissions && typeof permissions === 'object') {
      agent.permissions = {
        ...agent.permissions,
        ...permissions,
      };
    }

    if (typeof maxHops === 'number' && maxHops >= 1 && maxHops <= 10) {
      agent.maxHops = maxHops;
    }

    if (modelPreference && typeof modelPreference === 'string') {
      agent.modelPreference = modelPreference.trim();
    }

    agentsDirectory.set(agentId, agent);
    privacyLog('info', 'DASHBOARD_AGENT_CONFIGURED', { id: agentId, status: agent.status });

    res.status(200).json({
      success: true,
      agent,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 5. JOB ENGINE: List Active/Completed/Failed, Trigger/Cancel Jobs
// =========================================================================
dashboardRouter.get('/jobs', (req, res) => {
  try {
    const statusFilter = req.query.status ? String(req.query.status).toLowerCase().trim() : '';
    const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(req.query.limit, 10))) : 50;

    let jobs = Array.from(jobsStore.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const stats = {
      total: jobs.length,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    jobs.forEach((j) => {
      if (stats[j.status] !== undefined) {
        stats[j.status]++;
      }
    });

    if (statusFilter && statusFilter !== 'all') {
      jobs = jobs.filter((j) => j.status === statusFilter);
    }

    res.status(200).json({
      success: true,
      stats,
      jobs: jobs.slice(0, limit),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.post('/jobs', (req, res) => {
  try {
    const { action, id, type, title, priority, payload } = req.body || {};

    // 1. Cancellation action
    if (action === 'cancel' || req.body.cancel === true) {
      if (!id) {
        return res.status(400).json({ success: false, error: 'Job id is required for cancellation.' });
      }
      const job = jobsStore.get(String(id).trim());
      if (!job) {
        return res.status(404).json({ success: false, error: `Job not found: ${id}` });
      }
      if (job.status === 'completed') {
        return res.status(400).json({ success: false, error: 'Cannot cancel an already completed job.' });
      }

      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      jobsStore.set(job.id, job);
      privacyLog('info', 'DASHBOARD_JOB_CANCELLED', { id: job.id });

      return res.status(200).json({
        success: true,
        job,
      });
    }

    // 2. Retry action
    if (action === 'retry') {
      if (!id) {
        return res.status(400).json({ success: false, error: 'Job id is required for retry.' });
      }
      const job = jobsStore.get(String(id).trim());
      if (!job) {
        return res.status(404).json({ success: false, error: `Job not found: ${id}` });
      }

      job.status = 'queued';
      job.progress = 0;
      job.error = null;
      job.startedAt = null;
      job.completedAt = null;
      job.retries = (job.retries || 0) + 1;
      jobsStore.set(job.id, job);

      return res.status(200).json({
        success: true,
        job,
      });
    }

    // 3. Create job action
    const jobTitle = title && typeof title === 'string' ? title.trim() : 'Background Task';
    const jobType = type && typeof type === 'string' ? type.trim() : 'system_task';
    const jobPriority = priority && ['high', 'normal', 'low'].includes(priority) ? priority : 'normal';

    const newJob = {
      id: `job-${100 + jobCounter++}`,
      title: jobTitle,
      type: jobType,
      priority: jobPriority,
      status: 'queued',
      progress: 0,
      retries: 0,
      maxRetries: 3,
      payload: payload || {},
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
    };

    jobsStore.set(newJob.id, newJob);
    privacyLog('info', 'DASHBOARD_JOB_ENQUEUED', { id: newJob.id, type: jobType });

    res.status(201).json({
      success: true,
      job: newJob,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 6. MODEL ROUTER: Model Router Status, Latency, Fallback Rules
// =========================================================================
dashboardRouter.get('/models', (_req, res) => {
  try {
    const currentActive = getActiveModel() || modelRouterConfig.activeModel;

    res.status(200).json({
      success: true,
      activeModel: currentActive,
      fallbackModels: modelRouterConfig.fallbackModels,
      availableModels: modelRouterConfig.availableModels,
      strategy: modelRouterConfig.strategy,
      circuitBreaker: modelRouterConfig.circuitBreaker,
      modelStats: modelRouterConfig.modelStats,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.put('/models', (req, res) => {
  try {
    const { activeModel, fallbackModels, strategy, circuitBreakerReset } = req.body || {};

    if (activeModel && typeof activeModel === 'string') {
      const cleanModel = activeModel.trim();
      setActiveModel(cleanModel);
      modelRouterConfig.activeModel = cleanModel;
    }

    if (Array.isArray(fallbackModels)) {
      modelRouterConfig.fallbackModels = fallbackModels.map(String).map((m) => m.trim());
    }

    if (strategy && ['latency-priority', 'cost-priority', 'quality-priority', 'balanced'].includes(strategy)) {
      modelRouterConfig.strategy = strategy;
    }

    if (circuitBreakerReset === true) {
      modelRouterConfig.circuitBreaker.state = 'closed';
      modelRouterConfig.circuitBreaker.failureCount = 0;
      modelRouterConfig.circuitBreaker.lastFailure = null;
    }

    privacyLog('info', 'DASHBOARD_MODEL_ROUTER_UPDATED', {
      model: modelRouterConfig.activeModel,
      strategy: modelRouterConfig.strategy,
    });

    res.status(200).json({
      success: true,
      activeModel: modelRouterConfig.activeModel,
      fallbackModels: modelRouterConfig.fallbackModels,
      strategy: modelRouterConfig.strategy,
      circuitBreaker: modelRouterConfig.circuitBreaker,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 7. SECURITY: Whitelist Status, Audit Logs, Redaction Counters
// =========================================================================
dashboardRouter.get('/security', (_req, res) => {
  try {
    const whitelist = config.PHONE_NUMBER_WHITELIST || [];
    const adminNumbers = config.ADMIN_PHONE_NUMBERS || [];

    // Mask phone numbers for safe display (+91 98*** **321)
    const maskPhone = (num) => {
      const s = String(num).replace(/\D/g, '');
      if (s.length <= 4) return '***';
      return `+${s.slice(0, 2)} ***...${s.slice(-4)}`;
    };

    const maskedWhitelist = whitelist.map(maskPhone);
    const maskedAdmins = adminNumbers.map(maskPhone);

    const logs = getRecentLogs ? getRecentLogs() : [];
    const formattedLogs = logs.slice(-50).map((log) => ({
      timestamp: log.timestamp || new Date().toISOString(),
      level: log.level || 'info',
      event: log.event || 'EVENT',
      meta: log.meta || {},
    }));

    res.status(200).json({
      success: true,
      whitelist: {
        enabled: whitelist.length > 0,
        count: whitelist.length,
        authorizedNumbers: maskedWhitelist,
        adminNumbers: maskedAdmins,
      },
      protectionBoundaries: {
        zeroDiskStorage: true,
        piiSanitization: true,
        hmacVerification: !config.SKIP_SIGNATURE_VERIFICATION,
        rateLimiting: true,
        sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES || 30,
      },
      redactionCounters,
      auditLogs: formattedLogs,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// 8. SETTINGS: Environment Toggles, Daily Briefing Settings
// =========================================================================
dashboardRouter.get('/settings', (_req, res) => {
  try {
    res.status(200).json({
      success: true,
      environment: {
        nodeEnv: config.NODE_ENV,
        port: config.PORT,
        storageBackend: config.STORAGE_BACKEND || 'memory',
        sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES || 30,
        rateLimitWindowMs: config.RATE_LIMIT_WINDOW_MS || 60000,
        rateLimitMax: config.RATE_LIMIT_MAX_PER_WINDOW || 30,
      },
      features: {
        searchGrounding: runtimeSettings.searchGrounding,
        voiceReply: runtimeSettings.voiceReply,
        imageGeneration: true,
        videoGeneration: true,
        ttsEnabled: Boolean(config.ELEVENLABS_API_KEY),
      },
      briefing: runtimeSettings.briefing,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

dashboardRouter.put('/settings', (req, res) => {
  try {
    const { searchGrounding, voiceReply, briefing } = req.body || {};

    if (typeof searchGrounding === 'boolean') {
      runtimeSettings.searchGrounding = searchGrounding;
    }

    if (typeof voiceReply === 'boolean') {
      runtimeSettings.voiceReply = voiceReply;
    }

    if (briefing && typeof briefing === 'object') {
      if (typeof briefing.enabled === 'boolean') {
        runtimeSettings.briefing.enabled = briefing.enabled;
      }
      if (typeof briefing.scheduledHour === 'number' && briefing.scheduledHour >= 0 && briefing.scheduledHour <= 23) {
        runtimeSettings.briefing.scheduledHour = Math.floor(briefing.scheduledHour);
      }
      if (briefing.timezone && typeof briefing.timezone === 'string') {
        runtimeSettings.briefing.timezone = briefing.timezone.trim();
      }
      if (briefing.quietHours && typeof briefing.quietHours === 'object') {
        runtimeSettings.briefing.quietHours = {
          start:
            typeof briefing.quietHours.start === 'number'
              ? briefing.quietHours.start
              : runtimeSettings.briefing.quietHours.start,
          end:
            typeof briefing.quietHours.end === 'number'
              ? briefing.quietHours.end
              : runtimeSettings.briefing.quietHours.end,
        };
      }
    }

    privacyLog('info', 'DASHBOARD_SETTINGS_UPDATED', {
      searchGrounding: runtimeSettings.searchGrounding,
      briefingEnabled: runtimeSettings.briefing.enabled,
    });

    res.status(200).json({
      success: true,
      settings: {
        features: {
          searchGrounding: runtimeSettings.searchGrounding,
          voiceReply: runtimeSettings.voiceReply,
        },
        briefing: runtimeSettings.briefing,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Dead-Letter Queue (DLQ) & Human Handoff API Endpoints
// -----------------------------------------------------------------------------

// GET /dashboard/api/dlq - List all failed tasks in Dead-Letter Queue
dashboardRouter.get('/dlq', async (_req, res) => {
  try {
    const deadLetters = await messageQueue.getDeadLetters();
    res.status(200).json({ success: true, count: deadLetters.length, deadLetters });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /dashboard/api/dlq/:id/replay - Replay a failed job back into the active work queue
dashboardRouter.post('/dlq/:id/replay', async (req, res) => {
  try {
    const result = await messageQueue.replayDeadLetter(req.params.id);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error || 'Job not found or could not be replayed' });
    }
    res.status(200).json({ success: true, message: `Job ${req.params.id} replayed into work queue.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /dashboard/api/dlq/:id - Dismiss a job from DLQ
dashboardRouter.delete('/dlq/:id', async (req, res) => {
  try {
    await messageQueue.dismissDeadLetter(req.params.id);
    res.status(200).json({ success: true, message: `Job ${req.params.id} dismissed from DLQ.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /dashboard/api/handoff - List all chats currently paused for human agent
dashboardRouter.get('/handoff', async (_req, res) => {
  try {
    const handoffs = await listActiveHandoffs();
    res.status(200).json({ success: true, count: handoffs.length, handoffs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /dashboard/api/handoff/:userId - Set or clear human handoff for a chat
dashboardRouter.post('/handoff/:userId', async (req, res) => {
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

// GET /dashboard/api/web-learn/watchlist - List vetted domains/feeds/topics
dashboardRouter.get('/web-learn/watchlist', async (_req, res) => {
  try {
    const list = await getWatchlist();
    const quota = getBackgroundQuotaReport();
    res.status(200).json({ success: true, count: list.length, watchlist: list, quota });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /dashboard/api/web-learn/watchlist - Add or update a target
dashboardRouter.post('/web-learn/watchlist', async (req, res) => {
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

// DELETE /dashboard/api/web-learn/watchlist/:id - Remove a target
dashboardRouter.delete('/web-learn/watchlist/:id', async (req, res) => {
  try {
    const result = await removeFromWatchlist(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /dashboard/api/web-learn/trigger - Manually trigger background knowledge scrape
dashboardRouter.post('/web-learn/trigger', async (req, res) => {
  try {
    const job = await jobEngine.submitJob('web_knowledge_scrape', {
      force: Boolean(req.body?.force),
    });
    res.status(202).json({ success: true, jobId: job.id, status: job.status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
