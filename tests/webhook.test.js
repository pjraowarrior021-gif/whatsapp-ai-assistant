import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { verifyMetaSignature } from '../src/webhook.js';
import { config } from '../src/config.js';

test('Webhook HMAC: verifyMetaSignature validates authentic signatures', () => {
  const secret = 'test_secret_1234567890';
  const rawBody = Buffer.from(JSON.stringify({ test: 'payload' }), 'utf-8');

  const expectedHash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const validHeader = `sha256=${expectedHash}`;

  const isValid = verifyMetaSignature(rawBody, validHeader, secret);
  assert.strictEqual(isValid, true);
});

test('Webhook HMAC: verifyMetaSignature rejects tampered body or invalid signature', () => {
  const secret = 'test_secret_1234567890';
  const rawBody = Buffer.from(JSON.stringify({ test: 'payload' }), 'utf-8');
  const tamperedBody = Buffer.from(JSON.stringify({ test: 'tampered_payload' }), 'utf-8');

  const validHash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const validHeader = `sha256=${validHash}`;

  // Tampered payload
  assert.strictEqual(verifyMetaSignature(tamperedBody, validHeader, secret), false);

  // Wrong secret
  assert.strictEqual(verifyMetaSignature(rawBody, validHeader, 'wrong_secret'), false);

  // Malformed header
  assert.strictEqual(verifyMetaSignature(rawBody, 'invalid_header', secret), false);
  assert.strictEqual(verifyMetaSignature(rawBody, '', secret), false);
  assert.strictEqual(verifyMetaSignature(null, validHeader, secret), false);
});

test('HTTP Endpoints: Integration tests on live server instance', async (t) => {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  t.after(() => {
    server.close();
  });

  // 1. Test /health
  await t.test('GET /health returns 200 with healthy status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'healthy');
    assert.ok(data.uptimeSeconds >= 0);
    assert.ok(data.storageMode.includes('RAM Only'));
  });

  // 2. Test /diagnostic redacts secrets
  await t.test('GET /diagnostic returns 200 with masked secrets', async () => {
    const res = await fetch(`${baseUrl}/diagnostic`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'online');
    assert.ok(data.config.gemini.apiKeyMasked.includes('***'));
    assert.ok(!JSON.stringify(data).includes(config.WHATSAPP_TOKEN));
  });

  // 3. Test GET /webhook verification handshake
  await t.test('GET /webhook returns challenge on matching token', async () => {
    const challenge = 'random_challenge_string_9988';
    const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=${config.WHATSAPP_VERIFY_TOKEN}&hub.challenge=${challenge}`;
    const res = await fetch(url);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.strictEqual(text, challenge);
  });

  await t.test('GET /webhook returns 403 on token mismatch', async () => {
    const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=123`;
    const res = await fetch(url);
    assert.strictEqual(res.status, 403);
  });

  await t.test('GET /webhook returns 400 on missing parameters', async () => {
    const res = await fetch(`${baseUrl}/webhook`);
    assert.strictEqual(res.status, 400);
  });

  // 4. Test POST /webhook signature enforcement
  await t.test('POST /webhook rejects invalid signature with 401 when secret is configured', async () => {
    config.WHATSAPP_APP_SECRET = 'active_secret_for_test';
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body,
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test('POST /webhook accepts authentic signature and returns 200 EVENT_RECEIVED', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const signatureHash = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(body).digest('hex');

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${signatureHash}`,
      },
      body,
    });
    assert.strictEqual(res.status, 200);
    const reply = await res.text();
    assert.strictEqual(reply, 'EVENT_RECEIVED');
  });

  // 5. Test incoming webhook with authorized /help command
  await t.test('POST /webhook handles incoming WhatsApp message payload and triggers commands', async () => {
    const authorizedNumber = config.ALLOWED_PHONE_NUMBERS.values().next().value || '918217426307';
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_account_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551234567', phone_number_id: '123456789012345' },
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: `wamid.test_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'text',
                    text: { body: '/help' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const raw = JSON.stringify(payload);
    const signatureHash = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${signatureHash}`,
      },
      body: raw,
    });

    assert.strictEqual(res.status, 200);
    const reply = await res.text();
    assert.strictEqual(reply, 'EVENT_RECEIVED');
  });

  // 6. Test incoming message from unauthorized phone number
  await t.test('POST /webhook rejects unauthorized phone numbers safely', async () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_account_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ profile: { name: 'Stranger' }, wa_id: '9999999999' }],
                messages: [
                  {
                    from: '9999999999',
                    id: `wamid.unauth_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'text',
                    text: { body: 'Hello secret bot' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const raw = JSON.stringify(payload);
    const signatureHash = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');

    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${signatureHash}`,
      },
      body: raw,
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'EVENT_RECEIVED');
  });
});
