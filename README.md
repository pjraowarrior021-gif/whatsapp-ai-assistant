# 🤖 Personal WhatsApp AI Assistant (Google Gemini)

A high-performance, privacy-focused WhatsApp chatbot that connects your personal WhatsApp directly to **Google Gemini** using the official **WhatsApp Cloud API** and **Node.js (Express)** on Windows 10 / local development environments.

Designed for zero cloud costs (**₹0 budget**), zero database maintenance, and strict privacy safeguards.

---

## 📑 Table of Contents

- [Key Features](#-key-features)
- [Architecture & Data Flow](#-architecture--data-flow)
- [Privacy & Encryption Disclosure](#-privacy--encryption-disclosure)
- [Prerequisites for Windows 10](#-prerequisites-for-windows-10)
- [Quick Start Guide](#-quick-start-guide)
- [Step-by-Step Account Configuration](#-step-by-step-account-configuration)
  - [1. Google Gemini API Key](#1-google-gemini-api-key-free)
  - [2. Meta WhatsApp Cloud API Setup](#2-meta-whatsapp-cloud-api-setup)
  - [3. Local Webhook Tunneling on Windows 10](#3-local-webhook-tunneling-on-windows-10)
- [WhatsApp Chat Commands](#-whatsapp-chat-commands)
- [Zero-Cost Free-Tier Optimization (₹0 Budget)](#-zero-cost-free-tier-optimization-0-budget)
- [Automated Testing & Diagnostics](#-automated-testing--diagnostics)
- [Project Structure](#-project-structure)
- [Production Free-Tier Deployment](#-production-free-tier-deployment)

---

## ✨ Key Features

- **Google Gemini Integration:** Powered by Google Gemini (default `gemini-3.5-flash-lite`, configurable via `GEMINI_MODEL`) with automatic fallback failover (`GEMINI_FALLBACK_MODELS`) via the model fallback system.
- **🧠 Autonomous Fact & Preference Learner:** Automatically extracts personal facts, dietary preferences, constraints, preferred code languages, and corrections from natural conversation turns.
- **🔄 Workflow & Habit Sequence Learner:** Learns how the user works by detecting multi-step workflow patterns across sessions.
- **💬 Human-Like WhatsApp Conversational Cadence:** Communicates naturally with warm, direct, non-corporate language.
- **🔗 Smart Webpage & Article Summarizer:** Share any article or webpage URL to receive a structured summary with original titles and clickable links.
- **▶️ YouTube Video Intelligence & Summarizer:** Share any YouTube link for instant summary and key insights.
- **📸 Instagram Reel & Post Summarizer:** Share Instagram links to extract venue names, locations, recommended menu items, and creator handles.
- **📍 Location Intelligence:** Send a WhatsApp location pin to receive a local snapshot with weather, area overview, and points of interest.
- **🎙️ Voice Note Audio Replies (Text-to-Speech):** Toggle `/voice on` or append `--voice` to receive voice-note responses.
- **📝 Quick Notes & To-Do List Tracker:** Track tasks with `/todo`, `/todos`, `/done`, and `/clear_todos`. They are stored in RAM with optional persistence (`REMINDERS_PERSIST=true`).
- **🎭 Dynamic Persona Switching:** Switch between `coder`, `tutor`, `executive`, and `default` personas.
- **Multimodal Intelligence (Voice & Documents):**
  - **Voice Notes:** Inbound audio and voice notes are normalized and answered with Gemini multimodal capabilities.
  - **Document Analysis:** Upload PDFs, Office documents, TXT, and CSV files for summarization and extraction.
- **Clean Image Generation:** Send `/image <prompt>` or `/draw <prompt>` to generate AI images via Pollinations.
- **Google Search Grounding:** Toggle live web retrieval with `/search on` or `/search off`. Answers include verified clickable sources.
- **Quoted-Reply Context:** Replying directly to previous messages automatically injects parent message context into Gemini's prompt.
- **Interactive WhatsApp UI:** Supports interactive button replies and list messages.
- **Scheduled Reminders:** Schedule alarms using natural syntax (`/remind 10m Call client`, `/remind 18:30 Workout`, `/remind 25-12-2026 09:00 Plan`). Managed in RAM with optional atomic file persistence when enabled.
- **Daily Quotas & Cost Guards:** Enforces per-user daily message quotas and global Gemini budgets. Check usage anytime with `/usage`.
- **Production Observability:** Prometheus metrics endpoint (`GET /metrics`), structured JSON logging (`LOG_FORMAT=json`), and end-to-end request correlation IDs (`requestId`).
- **Enterprise-Grade Privacy & Security:**
  - **Zero Permanent Disk Storage (Default):** Volatile RAM memory only with idle TTL eviction.
  - **Zero-Content Logging:** Message contents, prompts, and tokens are never logged.
  - **Precise PII & Luhn Redaction:** Redacts payment cards, Aadhaar IDs, CVVs, PINs, passwords, and OTPs.
  - **Timing-Safe Meta Webhook Authentication:** Validates Meta signatures and verify tokens with constant-time comparisons.
  - **Streaming Media Safety:** Enforces strict size caps and fetch timeouts.
  - **Dual Rate Limiting:** Global Express rate limiter plus per-user sliding-window limiter.
  - **Phone Whitelist Guard:** Strictly blocks unauthorized phone numbers.

---

## ⚙️ Environment Variables Reference

| Variable                        | Type    | Default                    | Description                                                                                    |
| :------------------------------ | :------ | :------------------------- | :--------------------------------------------------------------------------------------------- |
| `PORT`                          | Number  | `3000`                     | HTTP server listening port                                                                     |
| `NODE_ENV`                      | String  | `development`              | Application environment (`development`, `production`, `test`)                                  |
| `OPS_TOKEN`                     | String  | _Optional_                 | Secret bearer token required to authenticate `/metrics`, `/diagnostic`, and `/admin` in prod   |
| `GEMINI_API_KEY`                | String  | _Required_                 | Google AI Studio Gemini API key                                                                |
| `GEMINI_MODEL`                  | String  | `gemini-3.5-flash-lite`    | Single primary Gemini model used for generation                                                |
| `GEMINI_FALLBACK_MODELS`        | String  | `gemini-3.1-flash-lite...` | Comma-separated list of fallback Gemini model IDs                                              |
| `WHATSAPP_TOKEN`                | String  | _Required_                 | Meta WhatsApp Cloud API access token                                                           |
| `WHATSAPP_PHONE_NUMBER_ID`      | String  | _Required_                 | Meta WhatsApp business phone number ID                                                         |
| `WHATSAPP_APP_SECRET`           | String  | _Required_                 | Meta App Secret for HMAC-SHA256 signature verification (fail-closed in production)             |
| `WHATSAPP_VERIFY_TOKEN`         | String  | _Required_                 | Secret token for Meta Webhook subscription challenge verification                              |
| `ALLOWED_PHONE_NUMBERS`         | String  | _Required_                 | Comma-separated list of authorized sender phone numbers (e.g. `919876543210`)                  |
| `MAX_CONTEXT_TURNS`             | Number  | `10`                       | Maximum user/model conversation turns kept in sliding memory window                            |
| `SESSION_TIMEOUT_MINUTES`       | Number  | `15`                       | Inactivity TTL in minutes before RAM session context is pruned                                 |
| `MEDIA_MAX_BYTES`               | Number  | `104857600` (100MB)        | Maximum allowed media file size for audio, documents, and images                               |
| `MEDIA_FETCH_TIMEOUT_MS`        | Number  | `60000` (60s)              | Timeout in ms when fetching media attachments or Pollinations images                           |
| `USER_RATE_LIMIT_MAX`           | Number  | `10`                       | Maximum messages per user sliding window before throttling                                     |
| `USER_RATE_LIMIT_WINDOW_MS`     | Number  | `60000` (1 min)            | Duration of per-user sliding rate limit window in milliseconds                                 |
| `MAX_REQUESTS_PER_USER_PER_DAY` | Number  | `200`                      | Maximum inbound messages per user per UTC day (resets at 00:00 UTC)                            |
| `MAX_GEMINI_REQUESTS_PER_DAY`   | Number  | `1400`                     | Maximum Gemini API calls across all users per UTC day                                          |
| `STATE_BACKEND`                 | String  | `memory`                   | State persistence backend: `memory` (default in-RAM) or `redis` (shared cache)                 |
| `REDIS_URL`                     | String  | _Optional_                 | Redis connection URL (e.g. `redis://localhost:6379`)                                           |
| `DATA_DIR`                      | String  | `.data`                    | Directory for persistent disk files (reminders, todos)                                         |
| `REMINDERS_PERSIST`             | Boolean | `false`                    | When `true`, persists scheduled reminders and todos to disk across server restarts             |
| `MESSAGE_CONCURRENCY`           | Number  | `4`                        | Max concurrent message pipelines processed simultaneously in-process                           |
| `QUEUE_MAX_RETRIES`             | Number  | `3`                        | Retry count for transient 429/5xx errors before dead-letter routing                            |
| `QUEUE_MAX_SIZE`                | Number  | `1000`                     | Maximum buffer size before queue backpressure drops requests                                   |
| `SHUTDOWN_TIMEOUT_MS`           | Number  | `10000` (10s)              | Grace period for in-flight tasks to complete during SIGINT/SIGTERM                             |
| `ENABLE_AI_TOOLS`               | Boolean | `false`                    | Enables Gemini function calling (real-time weather, clock, auto-reminders)                     |
| `ALLOWED_GROUP_IDS`             | String  | _Optional_                 | Comma-separated list of authorized WhatsApp Group IDs                                          |
| `GROUP_TRIGGER_PREFIX`          | String  | `/`                        | Prefix required in group messages to trigger assistant replies                                 |
| `LOG_FORMAT`                    | String  | `text`                     | Output logging format: `text` (human-readable timestamps) or `json` (machine-readable newline) |

---

## 💰 Zero-Cost Free-Tier Optimization (₹0 Budget)

This project is tailored specifically for personal use within free quotas.

---

## 🧪 Automated Testing & Diagnostics

### Run Unit & Integration Tests:

```powershell
npm test
```

### Run Live Preflight Check:

```powershell
npm run check
```

Verifies your live Gemini API key and Meta token without exposing secrets.

---

## 📁 Project Structure

```text
c:\Users\PJ\Documents\WHATSAPP bot\
│
├── src/
│   ├── server.js
│   ├── webhook.js
│   ├── queue.js
│   ├── gemini.js
│   ├── language.js
│   ├── memory.js
│   ├── export.js
│   ├── auto-learner.js
│   ├── workflow-learner.js
│   ├── youtube.js
│   ├── instagram.js
│   ├── whatsapp.js
│   ├── privacy.js
│   ├── image-gen.js
│   ├── reminders.js
│   ├── todos.js
│   ├── document.js
│   ├── web-scraper.js
│   ├── tts.js
│   ├── quota.js
│   ├── metrics.js
│   ├── config.js
│   ├── test-connection.js
│   ├── store/
│   │   ├── index.js
│   │   ├── memory.js
│   │   └── redis.js
│   └── tools/
│       ├── index.js
│       ├── time.js
│       └── weather.js
│
├── tests/
├── .github/workflows/
├── .env.example
├── .env
├── .gitignore
├── eslint.config.js
├── .prettierrc
├── package.json
├── README.md
├── SECURITY.md
├── LICENSE
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── OPEN_SOURCE_CHECKLIST.md
└── .github/ISSUE_TEMPLATE/
```

---

## ☁️ Production Free-Tier Deployment

If you want the bot running 24/7 without keeping your Windows laptop on:

### Deploy to Render (Free Tier):

1. Push your repository to GitHub.
2. Sign up at **[Render.com](https://render.com/)**.
3. Click **New +** > **Web Service**.
4. Connect your GitHub repository.
5. Add environment variables from your `.env`.
6. Click **Deploy Web Service**.

---

## 📜 License

MIT License. Built for private, personal use.
