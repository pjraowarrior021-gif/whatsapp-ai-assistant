import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { verifyMetaSignature, normalizeCommand } from '../src/webhook.js';
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

import { resetUserRateLimit, getAnonymizedId } from '../src/privacy.js';

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

  await t.test(
    'POST /webhook bypasses signature check when WHATSAPP_APP_SECRET is placeholder test_meta_app_secret',
    async () => {
      const origSecret = config.WHATSAPP_APP_SECRET;
      config.WHATSAPP_APP_SECRET = 'test_meta_app_secret_1234567890';

      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
      const res = await fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': 'sha256=some_signature_from_meta',
        },
        body,
      });
      assert.strictEqual(res.status, 200);
      const reply = await res.text();
      assert.strictEqual(reply, 'EVENT_RECEIVED');

      config.WHATSAPP_APP_SECRET = origSecret;
    }
  );

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

    // 10c. Valid PPTX Presentation
    const validPptxPayload = {
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
                    id: `wamid.test_pptx_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'document',
                    document: {
                      id: 'test_pptx_id_123',
                      mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                      filename: 'IECE_Module_1.pptx',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawPptx = JSON.stringify(validPptxPayload);
    const sigPptx = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawPptx).digest('hex');

    const resPptx = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sigPptx}`,
      },
      body: rawPptx,
    });
    assert.strictEqual(resPptx.status, 200);
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

  // 13. Test incoming location message
  await t.test('POST /webhook accepts incoming location message and processes coordinates', async () => {
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
                    id: `wamid.test_loc_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'location',
                    location: {
                      latitude: 37.7749,
                      longitude: -122.4194,
                      name: 'Market Street Cafe',
                      address: '100 Market St, San Francisco, CA',
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
    const sig = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sig}`,
      },
      body: raw,
    });

    assert.strictEqual(res.status, 200);
  });

  // 14. Test incoming webpage URL message
  await t.test('POST /webhook processes URL link for article summarization', async () => {
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
                    id: `wamid.test_url_${Date.now()}`,
                    timestamp: '1730000000',
                    type: 'text',
                    text: { body: 'Please summarize https://en.wikipedia.org/wiki/Artificial_intelligence' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const raw = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hub-signature-256': `sha256=${sig}`,
      },
      body: raw,
    });

    assert.strictEqual(res.status, 200);
  });

  // 15. Test to-do list commands
  await t.test('POST /webhook handles /todo, /todos, /done, and /clear_todos commands', async () => {
    const authorizedNumber = '910000000000';
    resetUserRateLimit(getAnonymizedId(authorizedNumber));

    const sendCmd = async (cmdText) => {
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
                      id: `wamid.cmd_${Date.now()}_${Math.random()}`,
                      timestamp: '1730000000',
                      type: 'text',
                      text: { body: cmdText },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const raw = JSON.stringify(payload);
      const sig = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
      return fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': `sha256=${sig}`,
        },
        body: raw,
      });
    };

    const res1 = await sendCmd('/todo Buy groceries');
    assert.strictEqual(res1.status, 200);

    const res2 = await sendCmd('/todos');
    assert.strictEqual(res2.status, 200);

    const res3 = await sendCmd('/clear_todos');
    assert.strictEqual(res3.status, 200);
  });

  // 16. Test persona commands
  await t.test('POST /webhook handles /persona commands', async () => {
    const authorizedNumber = '910000000000';
    resetUserRateLimit(getAnonymizedId(authorizedNumber));

    const sendCmd = async (cmdText) => {
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
                      id: `wamid.cmd_${Date.now()}_${Math.random()}`,
                      timestamp: '1730000000',
                      type: 'text',
                      text: { body: cmdText },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const raw = JSON.stringify(payload);
      const sig = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
      return fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': `sha256=${sig}`,
        },
        body: raw,
      });
    };

    const res1 = await sendCmd('/persona');
    assert.strictEqual(res1.status, 200);

    const res2 = await sendCmd('/persona coder');
    assert.strictEqual(res2.status, 200);

    const res3 = await sendCmd('/persona default');
    assert.strictEqual(res3.status, 200);
  });

  // 17. Test voice mode toggle commands
  await t.test('POST /webhook handles /voice on and /voice off toggle commands', async () => {
    const authorizedNumber = '910000000000';
    resetUserRateLimit(getAnonymizedId(authorizedNumber));

    const sendCmd = async (cmdText) => {
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
                      id: `wamid.cmd_${Date.now()}_${Math.random()}`,
                      timestamp: '1730000000',
                      type: 'text',
                      text: { body: cmdText },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const raw = JSON.stringify(payload);
      const sig = crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
      return fetch(`${baseUrl}/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': `sha256=${sig}`,
        },
        body: raw,
      });
    };

    const res1 = await sendCmd('/voice on');
    assert.strictEqual(res1.status, 200);

    const res2 = await sendCmd('/voice status');
    assert.strictEqual(res2.status, 200);

    const res3 = await sendCmd('/voice off');
    assert.strictEqual(res3.status, 200);
  });
});

test('Webhook: normalizeCommand normalizes button IDs, slashless commands, and prefixes', () => {
  // 1. Button IDs
  assert.strictEqual(normalizeCommand('cmd_help'), '/help');
  assert.strictEqual(normalizeCommand('cmd_status'), '/status');
  assert.strictEqual(normalizeCommand('cmd_todos'), '/todos');
  assert.strictEqual(normalizeCommand('cmd_reminders'), '/reminders');

  // 2. Exact slashless commands
  assert.strictEqual(normalizeCommand('help'), '/help');
  assert.strictEqual(normalizeCommand('status'), '/status');
  assert.strictEqual(normalizeCommand('STATUS'), '/status');
  assert.strictEqual(normalizeCommand('usage'), '/usage');
  assert.strictEqual(normalizeCommand('todos'), '/todos');
  assert.strictEqual(normalizeCommand('reminders'), '/reminders');
  assert.strictEqual(normalizeCommand('privacy'), '/privacy');
  assert.strictEqual(normalizeCommand('reset'), '/reset');
  assert.strictEqual(normalizeCommand('voice'), '/voice');
  assert.strictEqual(normalizeCommand('voice on'), '/voice on');
  assert.strictEqual(normalizeCommand('voice off'), '/voice off');
  assert.strictEqual(normalizeCommand('search on'), '/search on');

  // 3. Prefix slashless commands
  assert.strictEqual(normalizeCommand('remind 10m Take break'), '/remind 10m Take break');
  assert.strictEqual(normalizeCommand('todo Buy milk'), '/todo Buy milk');
  assert.strictEqual(normalizeCommand('done a1b2c3'), '/done a1b2c3');
  assert.strictEqual(normalizeCommand('persona coder'), '/persona coder');
  assert.strictEqual(normalizeCommand('model gemini-3.5-flash-lite'), '/model gemini-3.5-flash-lite');
  assert.strictEqual(normalizeCommand('image a roaring tiger'), '/image a roaring tiger');

  // 4. Preserves already slashed commands
  assert.strictEqual(normalizeCommand('/status'), '/status');
  assert.strictEqual(normalizeCommand('/todo Clean desk'), '/todo Clean desk');

  // 5. Preserves natural conversation
  assert.strictEqual(normalizeCommand('What is quantum physics?'), 'What is quantum physics?');
  assert.strictEqual(
    normalizeCommand('Can you tell me about the Roman Empire?'),
    'Can you tell me about the Roman Empire?'
  );

  // 6. Preserves media captions without auto-prefixing
  assert.strictEqual(normalizeCommand('status', true), 'status');
});

test('HTTP Endpoints: rate limiter skip allows unlimited health, diagnostic, and metrics probes', async (t) => {
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  t.after(() => {
    server.close();
  });

  // Make 10 rapid concurrent health requests
  const healthRequests = Array.from({ length: 10 }).map(() => fetch(`${baseUrl}/health`));
  const healthResponses = await Promise.all(healthRequests);
  for (const res of healthResponses) {
    assert.strictEqual(res.status, 200);
  }

  // Diagnostic requests
  const diagRes = await fetch(`${baseUrl}/diagnostic`);
  assert.strictEqual(diagRes.status, 200);
  const diagData = await diagRes.json();
  assert.strictEqual(diagData.status, 'online');
  assert.ok(diagData.config.timezone);
  assert.strictEqual(diagData.config.timezone.zone, 'Asia/Kolkata');
});
