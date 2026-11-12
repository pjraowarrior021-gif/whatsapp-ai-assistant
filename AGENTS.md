# Project Context & Symbol Map: WhatsApp Bot

This repository is a production WhatsApp bot integrated with Google Gemini AI, media handling, and security rate limiting.

## Architectural Map & Symbol Indices

Do NOT re-read large files blindly. Use this reference for line locations and responsibilities:

### `src/webhook.js` (~1677 lines)

- **Lines 1 - 120**: Imports, rate limiter initialization (`RateLimiterMemory`), deduplication cache, and Express router setup.
- **Lines 121 - 144**: `verifyMetaSignature(rawBody, signatureHeader, appSecret)` - HMAC-SHA256 crypto validation.
- **Lines 145 - 260**: `GET /webhook` verification handshake, `POST /webhook` endpoint, work queue enqueueing.
- **Lines 261 - 272**: `normalizeAudioMime(mimeType)` - Audio format conversion mapping.
- **Lines 273 - 378**: `normalizeCommand(rawText)` - Command parsing (`/start`, `/help`, `/reset`, `/privacy`, `/video`, button IDs).
- **Lines 379 - 1675**: `handleIncomingMessage(message, requestId)` - Core message dispatcher, multimodal OCR/audio/video/document processing, Gemini AI invocation, and response formatting.
- **Lines 1676 - 1677**: Work queue handler binding (`messageQueue.setHandler`).

### Core Modules

- **`src/server.js`**: Express server bootstrapping, port binding, and route mounting (`/webhook`, `/health`, `/diagnostic`, `/metrics`, `/admin`).
- **`src/gemini.js`**: Gemini API client, system prompt definitions, conversation history handling, personas, and image generation.
- **`src/whatsapp.js`**: WhatsApp Graph API wrapper for sending text messages, media, buttons, templates, and interactive lists.
- **`src/privacy.js`**: User consent tracking, data retention policies, and GDPR/privacy commands.
- **`src/reminders.js`**: In-memory scheduled task and reminder queues.
- **`src/todos.js`**: In-memory quick note and to-do item management.
- **`src/contacts.js`**: Outbound contact alias book and admin messaging relay.
- **`src/image-learner.js`**: Reinforcement learning engine for AI image prompt optimization.
- **`src/video-gen.js`**: Generative AI video pipeline (Wan 2.1, storyboard, motion).
- **`src/config.js`**: Environment variable validation and defaults.

## Testing & Verification Guidelines

- Unit tests: `npm test`
- Specific test: `node --test tests/webhook.test.js`
- Performance benchmark: `node tests/benchmark.js`
- PDF report generation: `node scripts/generate-pdf-report.js`

## File Reading Directives

- Before editing any function in `src/webhook.js`, consult the line index above and read ONLY the specific line range needed. Never read the entire file in 800-line blocks.
- Do not re-read files after editing; verify test results with `npm test`.
