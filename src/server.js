import express from 'express';
import rateLimit from 'express-rate-limit';
import url from 'url';
import { config, validateConfig, getSafeConfigSummary } from './config.js';
import { privacyLog, startSessionSweeper, getRecentLogs } from './privacy.js';
import { getActiveModel } from './gemini.js';
import { webhookRouter } from './webhook.js';
import { getPrometheusMetrics } from './metrics.js';
import { initReminders, stopReminders } from './reminders.js';
import { initTodos } from './todos.js';

export const app = express();

// Enable trust proxy for reverse proxies and tunnels (Cloudflare Tunnel, ngrok, Render)
app.set('trust proxy', 1);

// Global debug request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] [HTTP_${req.method}] ${req.url}`);
  next();
});

// 1. Preserve raw body buffer for HMAC-SHA256 webhook signature validation
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
    limit: '1mb',
  })
);

// 2. Parse URL-encoded bodies if needed
app.use(express.urlencoded({ extended: true }));

// 3. Security headers middleware (lightweight defense-in-depth)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 4. Rate Limiting to protect against DoS attacks & abuse
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

// 5. Mount WhatsApp Cloud API Webhook routes
app.use('/webhook', webhookRouter);

// 6. Health Check Endpoint
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

// 7. Safe Diagnostics Endpoint (Redacts all sensitive tokens)
app.get('/diagnostic', (_req, res) => {
  res.status(200).json({
    app: 'whatsapp-gemini-assistant',
    status: 'online',
    timestamp: new Date().toISOString(),
    config: getSafeConfigSummary(),
    recentLogs: getRecentLogs(),
  });
});

// 8. Prometheus Metrics Endpoint
app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.status(200).send(getPrometheusMetrics());
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
        <p><strong>Monitoring:</strong> <a href="/health">/health</a> | <a href="/diagnostic">/diagnostic</a> | <a href="/metrics">/metrics</a></p>
      </div>

      <div class="warning">
        <strong>⚠️ Privacy Notice:</strong> Zero conversation text or media is stored on disk (volatile RAM with automatic TTL purge). Scheduled reminders and to-do lists persist across restarts only when <code>REMINDERS_PERSIST=true</code> is explicitly configured.
      </div>

      <div class="card">
        <h3>WhatsApp Commands</h3>
        <ul>
          <li><code>/help</code> - Manual & interactive quick action buttons</li>
          <li><code>/image &lt;prompt&gt;</code> - Generate watermark-free AI artwork</li>
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
    console.warn('\n⚠️  CONFIGURATION WARNINGS / MISSING KEYS:');
    validation.errors.forEach((err) => console.warn(`   ❌ ${err}`));
    validation.warnings.forEach((warn) => console.warn(`   ⚠️  ${warn}`));
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
    console.log('====================================================\n');
  });

  // Graceful shutdown
  const handleShutdown = (signal) => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    if (sweeperInterval) clearInterval(sweeperInterval);
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
}
