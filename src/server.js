import express from 'express';
import rateLimit from 'express-rate-limit';
import url from 'url';
import crypto from 'crypto';
import { config, validateConfig, getSafeConfigSummary } from './config.js';
import { privacyLog, startSessionSweeper, getRecentLogs } from './privacy.js';
import { getActiveModel, setActiveModel, listPersonas } from './gemini.js';
import { webhookRouter } from './webhook.js';
import { getPrometheusMetrics } from './metrics.js';
import { initReminders, stopReminders } from './reminders.js';
import { initTodos } from './todos.js';
import { initContacts } from './contacts.js';
import { initQuotas } from './quota.js';
import { initPrivacyStore } from './privacy.js';
import { initGeminiStore } from './gemini.js';
import { messageQueue } from './queue.js';
import { dashboardRouter } from './dashboard/api.js';

export const app = express();

// Security: Disable X-Powered-By fingerprinting header
app.disable('x-powered-by');

// Enable trust proxy for reverse proxies and tunnels (Cloudflare Tunnel, ngrok, Render)
app.set('trust proxy', 1);

// Global debug request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [HTTP_${req.method}] ${req.url}`);
  next();
});

// Security headers middleware (lightweight defense-in-depth)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Timing-safe authentication middleware for operational endpoints (/metrics, /diagnostic, /admin)
export function requireOpsAuth(req, res, next) {
  const opsToken = config.OPS_TOKEN;

  if (opsToken) {
    let token = '';
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.query && req.query.token) {
      token = String(req.query.token).trim();
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header or token param.' });
    }
    const expectedBuf = Buffer.from(opsToken, 'utf-8');
    const actualBuf = Buffer.from(token, 'utf-8');

    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid operational token.' });
    }
    return next();
  }

  // If OPS_TOKEN is not set
  if (config.NODE_ENV === 'production') {
    return res.status(401).json({
      error: 'Unauthorized: Operational endpoints require OPS_TOKEN in production environment.',
    });
  }

  next();
}

// Rate Limiting to protect against DoS attacks & abuse
// Skips rate limiting for internal platform health checks and Prometheus metrics scrapers
const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_PER_WINDOW * 5, // Allows headroom for webhooks
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  skip: (req) => {
    const p = req.path || '';
    return p === '/health' || p === '/diagnostic' || p === '/metrics' || p === '/';
  },
  message: {
    status: 429,
    error: 'Too many requests. Rate limit exceeded, please try again shortly.',
  },
});
app.use(limiter);

// Mount WhatsApp Cloud API Webhook routes
app.use('/webhook', webhookRouter);

// Mount Personal AI Dashboard API & Static Web UI
app.use('/dashboard/api', dashboardRouter);
app.use('/dashboard', express.static('public/dashboard'));

// Health Check Endpoint (Public unauthenticated probe)
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    activeModel: getActiveModel(),
    storageMode: 'Volatile RAM Only (Zero Disk Writes)',
    privacyGuard: 'Active (PII & Financial Data Redaction Enabled)',
  });
});

// Safe Diagnostics Endpoint (Protected by OPS_TOKEN in production)
app.get('/diagnostic', requireOpsAuth, (_req, res) => {
  const isProduction = config.NODE_ENV === 'production';
  res.status(200).json({
    app: 'whatsapp-gemini-assistant',
    status: 'online',
    timestamp: new Date().toISOString(),
    config: isProduction && !config.OPS_TOKEN ? undefined : getSafeConfigSummary(),
    recentLogs: getRecentLogs(),
  });
});

// Prometheus Metrics Endpoint (Protected by OPS_TOKEN in production)
app.get('/metrics', requireOpsAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(getPrometheusMetrics());
});

// Admin Ops Dashboard (Protected by OPS_TOKEN in production)
app.get('/admin', requireOpsAuth, (req, res) => {
  const qStats = messageQueue.getStats();
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  const heapMb = Math.round(mem.heapUsed / (1024 * 1024));
  const model = getActiveModel();
  const logs = getRecentLogs();
  const personas = listPersonas();
  const tokenQuery = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';

  // Handle optional quick model switch via ?switch_model=...
  if (req.query.switch_model) {
    setActiveModel(String(req.query.switch_model));
    return res.redirect(`/admin${tokenQuery}`);
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Ops Admin Dashboard - WhatsApp Assistant</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; max-width: 950px; margin: 30px auto; padding: 20px; line-height: 1.5; color: #222; background: #fdfdfd; }
        h1 { color: #075E54; margin-bottom: 4px; display: flex; align-items: center; gap: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin: 20px 0; }
        .card { background: #fff; border: 1px solid #e1e8e1; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .card h4 { margin: 0 0 10px 0; color: #555; text-transform: uppercase; font-size: 0.8em; letter-spacing: 0.5px; }
        .card .val { font-size: 1.8em; font-weight: bold; color: #075E54; }
        .badge { display: inline-block; background: #25D366; color: white; padding: 3px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.9em; }
        th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; }
        th { background: #f5f8f5; color: #333; }
        pre { background: #282c34; color: #abb2bf; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; max-height: 250px; }
        select, button { padding: 6px 12px; border-radius: 4px; border: 1px solid #ccc; font-size: 0.95em; }
        button { background: #075E54; color: white; cursor: pointer; border: none; font-weight: bold; }
        button:hover { background: #128C7E; }
      </style>
    </head>
    <body>
      <h1>🛠️ Operational Admin Dashboard <span class="badge">ONLINE</span></h1>
      <p style="color:#666;">Instance Uptime: <b>${Math.floor(process.uptime())}s</b> | Environment: <b>${config.NODE_ENV}</b> | RAM Usage: <b>${rssMb}MB (Heap: ${heapMb}MB)</b></p>

      <div class="grid">
        <div class="card">
          <h4>Active AI Model</h4>
          <div class="val" style="font-size:1.3em;">${model}</div>
          <form method="GET" action="/admin" style="margin-top:10px;">
            <input type="hidden" name="token" value="${req.query.token || ''}" />
            <select name="switch_model">
              <option value="gemini-3.5-flash-lite" ${model === 'gemini-3.5-flash-lite' ? 'selected' : ''}>gemini-3.5-flash-lite</option>
              <option value="gemini-3.1-flash-lite" ${model === 'gemini-3.1-flash-lite' ? 'selected' : ''}>gemini-3.1-flash-lite</option>
              <option value="gemini-3.5-flash" ${model === 'gemini-3.5-flash' ? 'selected' : ''}>gemini-3.5-flash</option>
            </select>
            <button type="submit">Switch</button>
          </form>
        </div>

        <div class="card">
          <h4>Queue Inflight</h4>
          <div class="val">${qStats.active} <span style="font-size:0.5em;color:#888;">active / ${qStats.concurrency} max</span></div>
          <p style="margin:5px 0 0 0;font-size:0.85em;color:#666;">Pending: <b>${qStats.pending}</b> (Buffer: ${qStats.maxSize})</p>
        </div>

        <div class="card">
          <h4>Processed Messages</h4>
          <div class="val">${qStats.processed}</div>
          <p style="margin:5px 0 0 0;font-size:0.85em;color:#666;">Retries: <b>${qStats.retried}</b> | Dead-letter: <b>${qStats.deadLettered}</b></p>
        </div>

        <div class="card">
          <h4>Storage Backend</h4>
          <div class="val" style="font-size:1.4em;">${config.STATE_BACKEND.toUpperCase()}</div>
          <p style="margin:5px 0 0 0;font-size:0.85em;color:#666;">Persist Reminders: <b>${config.REMINDERS_PERSIST ? 'ON' : 'OFF'}</b></p>
        </div>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h4>Configured Personas</h4>
        <ul>
          ${Object.values(personas)
            .map((p) => `<li><b>${p.name}</b> (${p.title}): <i>${p.description}</i></li>`)
            .join('')}
        </ul>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <h4>Recent Operational Logs (Privacy Redacted)</h4>
        <pre>${logs.length > 0 ? logs.map((l) => JSON.stringify(l)).join('\n') : 'No recent operational events.'}</pre>
      </div>

      <p><a href="/health" style="color:#075E54;">&larr; View Public Health Check</a> | <a href="/metrics${tokenQuery}" style="color:#075E54;">Prometheus Metrics</a></p>
    </body>
    </html>
  `;
  res.status(200).send(html);
});

// 9. Root Welcome / Dashboard
app.get('/', (_req, res) => {
  res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Personal WhatsApp AI Assistant</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #222; }
        h1 { color: #075E54; margin-bottom: 4px; }
        .tagline { color: #666; font-size: 1.1em; margin-bottom: 24px; }
        .card { background: #f9fbf9; border: 1px solid #e1e8e1; border-radius: 8px; padding: 18px; margin-bottom: 20px; }
        .badge { display: inline-block; background: #25D366; color: white; padding: 3px 8px; border-radius: 4px; font-size: 0.8em; font-weight: bold; }
        .warning { background: #fff3cd; border: 1px solid #ffeeba; border-radius: 8px; padding: 14px; margin-bottom: 20px; color: #856404; }
        code { background: #eef1f5; padding: 2px 6px; border-radius: 4px; font-family: Consolas, monospace; }
        ul { padding-left: 20px; }
        a { color: #128C7E; text-decoration: none; font-weight: 500; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <h1>Personal WhatsApp AI Assistant</h1>
      <p class="tagline">Powered by Google Gemini (${getActiveModel()}) with Hardened Privacy & Multimodal Architecture</p>
      
      <div class="card">
        <h3><span class="badge">ONLINE</span> System Status</h3>
        <p>Active endpoints for Meta WhatsApp Cloud API webhooks & Prometheus observability.</p>
        <p><strong>Webhook URL:</strong> <code>https://&lt;your-domain&gt;/webhook</code></p>
        <p><strong>Monitoring:</strong> <a href="/health">/health</a> | <a href="/diagnostic">/diagnostic</a> | <a href="/metrics">/metrics</a> | <a href="/dashboard">/dashboard</a></p>
      </div>

      <div class="warning">
        <strong>⚠️ Privacy Notice:</strong> Zero conversation text or media is stored on disk (volatile RAM with automatic TTL purge). Scheduled reminders and to-do lists persist across restarts only when <code>REMINDERS_PERSIST=true</code> is explicitly configured.
      </div>

      <div class="card">
        <h3>WhatsApp Commands</h3>
        <ul>
          <li><code>/help</code> - Manual & interactive quick action buttons</li>
          <li><code>/image &lt;prompt&gt;</code> - Generate watermark-free AI artwork</li>
          <li><code>/video &lt;prompt&gt;</code> - Generate cinematic AI video animation</li>
          <li><code>/todo &lt;task&gt;</code> - Add a task to your quick to-do list</li>
          <li><code>/todos</code> - Display active to-dos</li>
          <li><code>/done &lt;id&gt;</code> - Mark a to-do item completed</li>
          <li><code>/clear_todos</code> - Clear completed tasks</li>
          <li><code>/persona [name]</code> - Switch AI persona (coder, tutor, executive, default)</li>
          <li><code>/voice on|off</code> - Toggle voice note audio replies</li>
          <li><code>/remind &lt;time&gt; &lt;text&gt;</code> - Schedule relative or absolute reminders</li>
          <li><code>/reminders</code> - List active reminders</li>
          <li><code>/search on|off</code> - Toggle Google Search grounding with verified web sources</li>
          <li><code>/usage</code> - Check your remaining daily message quota</li>
          <li><code>/status</code> - View system health, active model & features</li>
          <li><code>/reset</code> - Clear conversational memory</li>
          <li><code>/delete</code> - Purge all temporary RAM session data</li>
          <li><code>/privacy</code> - View privacy disclosure & encryption boundary</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// 9. Startup Sequence & Server Listen (only when executed directly)
let serverInstance = null;
let sweeperInterval = null;

const isMainModule =
  (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) ||
  Boolean(process.env.pm_id) ||
  (process.argv[1] && process.argv[1].endsWith('server.js'));

if (isMainModule) {
  const validation = validateConfig();

  console.log('====================================================');
  console.log('🚀 Personal WhatsApp AI Assistant (Google Gemini)');
  console.log('====================================================');

  if (!validation.valid) {
    console.error('\n❌ CONFIGURATION ERROR(S):');
    validation.errors.forEach((err) => console.error(`   ❌ ${err}`));
    validation.warnings.forEach((warn) => console.warn(`   ⚠️  ${warn}`));
    if (config.NODE_ENV === 'production') {
      console.error('\n🛑 Fatal: Server refusing to start in production with invalid configuration.\n');
      process.exit(1);
    }
    console.log('\n👉 Update your .env file with your credentials.\n');
  } else {
    console.log('✅ Configuration validated successfully.');
    if (validation.warnings.length > 0) {
      validation.warnings.forEach((warn) => console.warn(`   ⚠️  ${warn}`));
    }
  }

  sweeperInterval = startSessionSweeper();
  initReminders();
  initTodos();
  initContacts();
  initQuotas().catch(() => {});
  initPrivacyStore().catch(() => {});
  initGeminiStore().catch(() => {});

  serverInstance = app.listen(config.PORT, '0.0.0.0', () => {
    privacyLog('info', 'SERVER_STARTED', {
      port: config.PORT,
      env: config.NODE_ENV,
      model: getActiveModel(),
      sessionTimeoutMinutes: config.SESSION_TIMEOUT_MINUTES,
    });
    console.log(`📡 Server listening on port ${config.PORT}`);
    console.log(`🔗 Local Webhook URL: http://localhost:${config.PORT}/webhook`);
    console.log(`🩺 Health check: http://localhost:${config.PORT}/health`);
    console.log(`💻 Mission Control Dashboard: http://localhost:${config.PORT}/dashboard`);
    console.log('====================================================\n');
  });

  // Graceful shutdown
  const handleShutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    if (sweeperInterval) clearInterval(sweeperInterval);
    try {
      console.log('⏳ Draining in-process message queue...');
      await messageQueue.drain(config.SHUTDOWN_TIMEOUT_MS);
      console.log('✅ Message queue drained.');
    } catch (drainErr) {
      console.warn('⚠️ Queue drain encountered an error:', drainErr.message);
    }
    stopReminders();
    if (serverInstance) {
      serverInstance.close(() => {
        privacyLog('info', 'SERVER_TERMINATED');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));

  // Process-level unhandled exception and rejection guards
  process.on('unhandledRejection', (reason) => {
    const errorMsg = reason instanceof Error ? reason.message : String(reason);
    privacyLog('error', 'UNHANDLED_PROMISE_REJECTION', { error: errorMsg });
    console.error('⚠️ Unhandled Promise Rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    privacyLog('error', 'UNCAUGHT_EXCEPTION', { error: err.message });
    console.error('❌ Uncaught Exception:', err);
  });
}
