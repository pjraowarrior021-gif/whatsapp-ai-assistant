# Project Context & Symbol Map: WhatsApp Bot

This repository is a production WhatsApp bot integrated with Google Gemini AI, media handling, and security rate limiting.

## Architectural Map & Symbol Indices

Do NOT re-read large files blindly. Use this reference for line locations and responsibilities:

### `src/webhook.js` (~1260 lines)

- **Lines 1 - 98**: Imports, rate limiter initialization (`RateLimiterMemory`), and message deduplication cache.
- **Lines 99 - 238**: `verifyMetaSignature(rawBody, signatureHeader, appSecret)` - HMAC-SHA256 crypto validation.
- **Lines 239 - 250**: `normalizeAudioMime(mimeType)` - Audio format conversion mapping.
- **Lines 251 - 341**: `normalizeCommand(rawText)` - Command parsing (`/start`, `/help`, `/reset`, `/privacy`).
- **Lines 342 - 1263**: `handleIncomingMessage(body)` - Core message dispatcher, multimodal OCR/audio processing, Gemini AI invocation, and response formatting.

### Core Modules

- **`src/server.js`**: Express server bootstrapping, port binding, and route mounting (`/webhook`, `/health`).
- **`src/gemini.js`**: Gemini API client, system prompt definitions, conversation history handling, and image generation.
- **`src/whatsapp.js`**: WhatsApp Graph API wrapper for sending text messages, media, buttons, and template messages.
- **`src/privacy.js`**: User consent tracking, data retention policies, and GDPR/privacy commands.
- **`src/reminders.js`**: In-memory scheduled task and reminder queues.
- **`src/config.js`**: Environment variable validation and defaults.

## Testing & Verification Guidelines

- Unit tests: `npm test`
- Specific test: `npx jest tests/webhook.test.js`
- Performance benchmark: `node tests/benchmark.js`
- PDF report generation: `node scripts/generate-pdf-report.js`

## File Reading Directives

- Before editing any function in `src/webhook.js`, consult the line index above and read ONLY the specific line range needed. Never read the entire file in 800-line blocks.
- Do not re-read files after editing; verify test results with `npm test`.
