import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { config } from '../src/config.js';

test('Server E2E: Full HTTP wiring across public, operational, admin, and webhook endpoints', async (t) => {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  t.after(() => {
    server.close();
  });

  // 1. GET /health
  await t.test('GET /health returns 200 and healthy status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'healthy');
    assert.ok(data.uptimeSeconds >= 0);
  });

  // 2. GET /metrics (Authentication & Timing-safe checks)
  await t.test('GET /metrics enforces OPS_TOKEN in production', async () => {
    const origEnv = config.NODE_ENV;
    const origToken = config.OPS_TOKEN;

    config.NODE_ENV = 'production';
    config.OPS_TOKEN = 'test_secret_ops_token_12345';

    // No auth
    const resNoAuth = await fetch(`${baseUrl}/metrics`);
    assert.strictEqual(resNoAuth.status, 401);

    // Wrong auth
    const resWrong = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: 'Bearer wrong_token' },
    });
    assert.strictEqual(resWrong.status, 401);

    // Correct Bearer token
    const resBearer = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${config.OPS_TOKEN}` },
    });
    assert.strictEqual(resBearer.status, 200);
    const text = await resBearer.text();
    assert.ok(text.includes('whatsapp_bot_uptime_seconds'));

    // Correct query parameter token
    const resQuery = await fetch(`${baseUrl}/metrics?token=${config.OPS_TOKEN}`);
    assert.strictEqual(resQuery.status, 200);

    config.NODE_ENV = origEnv;
    config.OPS_TOKEN = origToken;
  });

  // 3. GET /diagnostic
  await t.test('GET /diagnostic delivers masked config summary', async () => {
    const origEnv = config.NODE_ENV;
    const origToken = config.OPS_TOKEN;

    config.NODE_ENV = 'production';
    config.OPS_TOKEN = 'test_secret_ops_token_12345';

    const res = await fetch(`${baseUrl}/diagnostic`, {
      headers: { Authorization: `Bearer ${config.OPS_TOKEN}` },
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'online');
    assert.ok(data.config);
    assert.ok(data.recentLogs);

    config.NODE_ENV = origEnv;
    config.OPS_TOKEN = origToken;
  });

  // 4. GET /admin Dashboard
  await t.test('GET /admin renders operational HTML dashboard', async () => {
    const origEnv = config.NODE_ENV;
    const origToken = config.OPS_TOKEN;

    config.NODE_ENV = 'production';
    config.OPS_TOKEN = 'test_secret_ops_token_12345';

    // Unauthenticated in production -> 401
    const unauthRes = await fetch(`${baseUrl}/admin`);
    assert.strictEqual(unauthRes.status, 401);

    // Authenticated via query param
    const authRes = await fetch(`${baseUrl}/admin?token=${config.OPS_TOKEN}`);
    assert.strictEqual(authRes.status, 200);
    const html = await authRes.text();
    assert.ok(html.includes('Operational Admin Dashboard'));
    assert.ok(html.includes('Active AI Model'));
    assert.ok(html.includes('Queue Inflight'));

    config.NODE_ENV = origEnv;
    config.OPS_TOKEN = origToken;
  });

  // 5. GET /webhook handshake
  await t.test('GET /webhook validates hub challenge', async () => {
    const challenge = 'challenge_test_string_54321';
    const validUrl = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${config.WHATSAPP_VERIFY_TOKEN}&hub.challenge=${challenge}`;
    const res = await fetch(validUrl);
    assert.strictEqual(res.status, 200);
    const reply = await res.text();
    assert.strictEqual(reply, challenge);

    const invalidUrl = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=${challenge}`;
    const failRes = await fetch(invalidUrl);
    assert.strictEqual(failRes.status, 403);
  });

  // 6. POST /webhook HMAC verification
  await t.test('POST /webhook validates authentic HMAC signatures', async () => {
    const secret = 'valid_test_secret_999';
    const origSecret = config.WHATSAPP_APP_SECRET;
    const origSkip = config.SKIP_SIGNATURE_VERIFICATION;
    const origEnv = config.NODE_ENV;

    config.NODE_ENV = 'development';
    config.WHATSAPP_APP_SECRET = secret;
    config.SKIP_SIGNATURE_VERIFICATION = false;

    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const signatureHash = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // Authentic signature
    const validRes = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${signatureHash}`,
      },
      body: payload,
    });
    assert.strictEqual(validRes.status, 200);
    const text = await validRes.text();
    assert.strictEqual(text, 'EVENT_RECEIVED');

    // Tampered signature
    const invalidRes = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=tampered_hex_hash_00000000',
      },
      body: payload,
    });
    assert.strictEqual(invalidRes.status, 401);

    config.WHATSAPP_APP_SECRET = origSecret;
    config.SKIP_SIGNATURE_VERIFICATION = origSkip;
    config.NODE_ENV = origEnv;
  });
});
