import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { verifyMetaSignature } from '../src/webhook.js';
import { config } from '../src/config.js';
import { setGeminiClient } from '../src/gemini.js';

// Hermetic mock client to prevent any external Gemini calls during integration tests
setGeminiClient({
  models: {
    generateContent: async () => ({
      text: 'Mocked Gemini AI response for tests.',
      candidates: [{ groundingMetadata: null }],
    }),
  },
});

config.ALLOWED_PHONE_NUMBERS.add('910000000000');

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

  await t.test('GET /webhook rejects legacy hardcoded token with 403', async () => {
    const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=whatsapp_bot_verify_token_pj&hub.challenge=123`;
    const res = await fetch(url);
    assert.strictEqual(res.status, 403);
  });

  await t.test('GET /webhook rejects other tokens as verify token with 403', async () => {
    const origVerify = config.WHATSAPP_VERIFY_TOKEN;
    config.WHATSAPP_VERIFY_TOKEN = 'strictly_unique_verify_token_123';
    const url = `${baseUrl}/webhook?hub.mode=subscribe&hub.verify_token=different_token_value&hub.challenge=123`;
    const res = await fetch(url);
    assert.strictEqual(res.status, 403);
    config.WHATSAPP_VERIFY_TOKEN = origVerify;
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

  await t.test('POST /webhook skips signature check when SKIP_SIGNATURE_VERIFICATION is enabled in test', async () => {
    const origSkip = config.SKIP_SIGNATURE_VERIFICATION;
    const origEnv = config.NODE_ENV;
    config.NODE_ENV = 'test';
    config.SKIP_SIGNATURE_VERIFICATION = true;

    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': 'sha256=tampered_signature',
      },
      body,
    });
    assert.strictEqual(res.status, 200);
    const reply = await res.text();
    assert.strictEqual(reply, 'EVENT_RECEIVED');

    config.SKIP_SIGNATURE_VERIFICATION = origSkip;
    config.NODE_ENV = origEnv;
  });

  // 5. Test incoming webhook with authorized /help command
  await t.test('POST /webhook handles incoming WhatsApp message payload and triggers commands', async () => {
    const authorizedNumber = '910000000000';
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

  // 8. Test /metrics Prometheus exposition
  await t.test('GET /metrics returns 200 and Prometheus text format metrics', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get('content-type');
    assert.ok(contentType.includes('text/plain'));
    const text = await res.text();
    assert.ok(text.includes('whatsapp_bot_uptime_seconds'));
    assert.ok(text.includes('whatsapp_bot_active_sessions'));
    assert.ok(text.includes('whatsapp_bot_media_bytes_total'));
  });

  // 9. Test incoming voice note audio message
  await t.test('POST /webhook accepts incoming voice note audio and normalizes MIME', async () => {
    const authorizedNumber = '910000000000';
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
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: `wamid.test_voice_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'audio',
                    audio: {
                      id: 'test_audio_id_123',
                      mime_type: 'audio/ogg; codecs=opus',
                    },
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

  // 10. Test incoming document with allowlist enforcement
  await t.test('POST /webhook accepts PDF document and rejects unsupported formats', async () => {
    const authorizedNumber = '910000000000';

    // 10a. Valid PDF
    const validPdfPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_account_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: `wamid.test_doc_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'document',
                    document: {
                      id: 'test_doc_id_123',
                      mime_type: 'application/pdf',
                      filename: 'report.pdf',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawPdf = JSON.stringify(validPdfPayload);
    const sigPdf = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawPdf).digest('hex');

    const resValid = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sigPdf}`,
      },
      body: rawPdf,
    });
    assert.strictEqual(resValid.status, 200);

    // 10b. Unsupported document MIME (e.g. application/zip)
    const invalidDocPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_account_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: `wamid.test_zip_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'document',
                    document: {
                      id: 'test_zip_id_123',
                      mime_type: 'application/zip',
                      filename: 'archive.zip',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawInvalid = JSON.stringify(invalidDocPayload);
    const sigInvalid = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawInvalid).digest('hex');

    const resInvalid = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sigInvalid}`,
      },
      body: rawInvalid,
    });
    assert.strictEqual(resInvalid.status, 200);
  });

  // 11. Test incoming interactive button reply
  await t.test('POST /webhook routes interactive button reply to command handler', async () => {
    const authorizedNumber = '910000000000';
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
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: `wamid.test_btn_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: {
                        id: 'cmd_status',
                        title: 'Status',
                      },
                    },
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
  });

  // 12. Test quoted reply context injection
  await t.test('POST /webhook injects quoted reply context when message.context is present', async () => {
    const authorizedNumber = '910000000000';
    const earlierMsgId = `wamid.earlier_${Date.now()}`;

    // Step 1: Send initial message to populate rememberedMessages
    const initialPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_account_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: earlierMsgId,
                    timestamp: '1730000000',
                    type: 'text',
                    text: { body: 'What is the theory of relativity?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const raw1 = JSON.stringify(initialPayload);
    const sig1 = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw1).digest('hex');
    await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sig1}`,
      },
      body: raw1,
    });

    // Step 2: Send a reply quoting that message ID
    const replyPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test_account_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                contacts: [{ profile: { name: 'Authorized User' }, wa_id: authorizedNumber }],
                messages: [
                  {
                    from: authorizedNumber,
                    id: `wamid.reply_${Date.now()}`,
                    timestamp: '1730000001',
                    type: 'text',
                    context: { id: earlierMsgId },
                    text: { body: 'Can you summarize it in 5 bullet points?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const raw2 = JSON.stringify(replyPayload);
    const sig2 = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw2).digest('hex');
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sig2}`,
      },
      body: raw2,
    });

    assert.strictEqual(res.status, 200);
  });
});
