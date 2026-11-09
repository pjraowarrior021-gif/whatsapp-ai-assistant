# 🤖 Personal WhatsApp AI Assistant (Google Gemini)

A high-performance, privacy-focused WhatsApp chatbot that connects your personal WhatsApp directly to **Google Gemini** using the official **WhatsApp Cloud API** and **Node.js (Express)** on Windows 10.

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

- **Google Gemini Integration:** Powered by Google Gemini (default `gemini-3.5-flash-lite`, configurable via `GEMINI_MODEL`) with automatic fallback failover (`GEMINI_FALLBACK_MODELS`) via the modern `@google/genai` SDK. Supports runtime model switching.
- **🔗 Smart Webpage & Article Summarizer:** Share any article or webpage URL to receive an instant, high-yield 3-5 bullet point executive summary with original titles and clickable links. Features strict SSRF protection and Open Graph metadata fallback for single-page applications.
- **▶️ YouTube Video Intelligence & Summarizer:** Share any YouTube link (Standard, Shorts, Live Streams, or `youtu.be`) to receive an instant, structured summary with core thesis, key insights, and milestone topic timestamps parsed directly from video transcripts. Features resilient fallback to oEmbed metadata and Google Search Grounding when captions are unavailable or rate-limited.
- **📸 Instagram Reel & Post Summarizer:** Share any Instagram Reel or Post link (`/reel/`, `/p/`, `/reels/`, `/share/`) to extract venue names, locations, recommended menu items, creator handles, and critical insights via Open Graph metadata paired with Google Search Grounding. Zero API tokens or logins required.
- **📍 Location Intelligence:** Send your WhatsApp location pin to receive an instant local snapshot with current weather, area overview, and top points of interest, grounded in real-time Google Search data.
- **🎙️ Voice Note Audio Replies (Text-to-Speech):** Toggle `/voice on` or append `--voice` to receive responses synthesized directly into speech audio voice notes (`audio/mpeg`) in addition to text.
- **📝 Quick Notes & To-Do List Tracker:** Track tasks effortlessly with `/todo <task>`, `/todos`, `/done <id>`, and `/clear_todos`. Stored in RAM with optional persistence (`REMINDERS_PERSIST=true`).
- **🎭 Dynamic Persona Switching:** Custom AI system instruction personas via `/persona [name]` (`coder`, `tutor`, `executive`, `default`).
- **Multimodal Intelligence (Voice & Documents):**
  - **Voice Notes:** Inbound audio and voice notes are automatically normalized, streamed in memory, transcribed, and answered with Gemini multimodal audio capabilities.
  - **Document Analysis:** Upload PDFs, Office presentations and documents (PowerPoint PPTX, Word DOCX, Excel XLSX), TXT, or CSV files (up to 100MB) with captions to summarize, extract data, or answer analytical questions. Large PDFs (>20MB) are seamlessly routed via Gemini Files API with zero-disk storage.
- **Clean Image Generation:** Send `/image <prompt>` or `/draw <prompt>` to generate AI images via Pollinations with smart multi-corner watermark removal using Sharp.
- **Google Search Grounding:** Toggle live web retrieval with `/search on` or `/search off`. Answers include verified clickable sources.
- **Quoted-Reply Context:** Replying directly to previous messages automatically injects the parent message context into Gemini's prompt.
- **Interactive WhatsApp UI:** Supports interactive button replies (e.g., Quick Actions in `/help` and `/status`) and list messages.
- **Scheduled Reminders:** Schedule alarms using natural syntax (`/remind 10m Call client`, `/remind 18:30 Workout`, `/remind 25-12-2026 09:00 Plan`). Managed in RAM with optional atomic file persistence (`REMINDERS_PERSIST=true`).
- **Daily Quotas & Cost Guards:** Enforces per-user daily message quotas (`USER_DAILY_QUOTA_MAX`) and global daily Gemini budgets (`DAILY_GEMINI_BUDGET_MAX`). Check usage anytime with `/usage`.
- **Production Observability:** Prometheus metrics endpoint (`GET /metrics`), structured JSON logging (`LOG_FORMAT=json`), and end-to-end request correlation IDs (`requestId`).
- **Enterprise-Grade Privacy & Security:**
  - **Zero Permanent Disk Storage (Default):** Volatile RAM memory only with idle TTL eviction (default: 15 min).
  - **Zero-Content Logging:** Message contents, prompts, and tokens are never logged.
  - **Precise PII & Luhn Redaction:** Redacts payment cards using the Luhn algorithm, Aadhaar IDs (4-4-4 format or context prefix), CVVs, PINs, passwords, and OTPs while preserving ordinary order IDs and dates.
  - **Timing-Safe Meta Webhook Authentication:** Cryptographically validates Meta signatures (`x-hub-signature-256`) and verify tokens using constant-time buffer comparisons (`crypto.timingSafeEqual`).
  - **Streaming Media Safety:** Hardened media download pipeline with strict size caps (`MEDIA_MAX_BYTES=100MB`) and fetch timeouts (`MEDIA_FETCH_TIMEOUT_MS=60000ms`).
  - **Dual Rate Limiting:** Global Express rate limiter plus per-user sliding-window limiter.
  - **Phone Whitelist Guard:** Strictly blocks all unauthorized phone numbers.

---

## 🏛️ Architecture & Data Flow

```
WhatsApp User (Text / Voice / Image / Document / Buttons)
    │
    ▼ (HTTPS/TLS)
Meta WhatsApp Cloud API (Graph API v21.0)
    │
    ▼ (HTTPS Webhook with HMAC-SHA256 signature & Request-ID)
Node.js + Express Server (Railway / Render / Windows)
    │
    ├── 1. Cryptographic HMAC Verification (timingSafeEqual)
    ├── 2. Whitelist Check (ALLOWED_PHONE_NUMBERS)
    ├── 3. Per-User Sliding Window Limiter & Daily Quota Guard
    ├── 4. PII Redaction with Luhn Card Check & Context Scanners
    ├── 5. Quoted-Reply Context Assembly (Bounded 10m Cache)
    ├── 6. In-Memory Session Memory (RAM Only, 15m TTL)
    │
    ├── [Voice / Audio] ──> Stream Buffer ──> Normalize audio/ogg ──┐
    ├── [PDF / Doc]     ──> Stream Buffer ──> Validate MIME       ──┤
    ├── [Image Gen]     ──> Pollinations  ──> Sharp Smart Crop   ──┤
    │                                                               │
    ▼ (HTTPS API Call)                                             │
Google Gemini API (gemini-3.5-flash-lite + Fallback Failover)      │
    │   ├── Optional: Google Search Grounding Tool                 │
    │   └── Multimodal Inline Data (Audio / Image / Document) <────┘
    ▼
Generate AI Response (Formatted for WhatsApp Markdown)
    │
    ▼ (Auto-chunked if > 4000 characters or interactive buttons)
Meta WhatsApp Cloud API
    │
    ▼
WhatsApp User Receives Reply / Media / Reminder Alert
```

---

## 🔒 Privacy & Encryption Disclosure

> [!IMPORTANT]
>
> ### Crucial Transparency Notice: Cloud Boundaries & Privacy Safeguards
>
> While standard WhatsApp peer-to-peer chats use the Signal protocol for end-to-end encryption (E2EE), **a chatbot interacting with external cloud AI services cannot be end-to-end encrypted across the entire lifecycle:**
>
> 1. **Meta WhatsApp Cloud API:** When you text the bot, your message is routed to and decrypted on Meta's servers so it can be forwarded to your webhook server.
> 2. **Node.js Server:** Your server receives the text, strips any detected sensitive credentials (Luhn card checks, PINs, OTPs), manages in-memory context, and communicates with Google Gemini over TLS.
> 3. **Google Gemini API:** Google processes prompt payloads (and attached multimodal audio/document buffers) to generate answers.
> 4. **Google Search Grounding:** When enabled (`/search on`), search queries extracted from your prompt are submitted to Google Search to retrieve live facts.
> 5. **Quoted-Reply Context:** To allow natural conversational replies, inbound messages are temporarily cached in volatile RAM for up to 10 minutes (bounded to 200 items max) and are never written to disk.
> 6. **Reminders Storage Exception:** By default, all reminders live strictly in volatile memory. If you explicitly enable `REMINDERS_PERSIST=true`, active reminders (target time, user hash, and task text) are stored atomically in a restricted local JSON file (`.data/reminders.json`) so they survive server restarts.
>
> **All communication in transit is encrypted using HTTPS / TLS 1.3.** See [`SECURITY.md`](SECURITY.md) for full architecture details.

---

## 💻 Prerequisites for Windows 10

Your machine already has the core prerequisites installed:

- **Node.js:** v22+ (Confirmed: Node v26 installed)
- **npm:** v10+ (Confirmed: npm v12 installed)
- **Git:** (Confirmed: Git installed)
- **PowerShell / Terminal**

---

## 🚀 Quick Start Guide

### 1. Install Dependencies

In your PowerShell terminal in the project directory:

```powershell
npm install
```

### 2. Configure Environment Variables

Copy the template to create your `.env` file:

```powershell
copy .env.example .env
```

Open `.env` in VS Code / Antigravity and enter your credentials.

### 3. Run Preflight Diagnostics

Verify that all your tokens and network connections are valid:

```powershell
npm run check
```

### 4. Run Automated Test Suite

Execute the 32 comprehensive unit and integration tests:

```powershell
npm test
```

### 5. Start the Development Server

```powershell
# Development mode (with live auto-reload on file changes)
npm run dev

# Or standard production mode
npm start
```

The server will start listening at `http://localhost:3000`.

---

## 🔑 Step-by-Step Account Configuration

### 1. Google Gemini API Key (FREE)

1. Navigate to **[Google AI Studio](https://aistudio.google.com/apikey)**.
2. Sign in with your Google account.
3. Click **"Get API key"** and then **"Create API key in new project"**.
4. Copy the API key and paste it into your `.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...your_key_here...
   GEMINI_MODEL=gemini-2.5-flash
   ```

---

### 2. Meta WhatsApp Cloud API Setup

1. Go to the **[Meta for Developers Portal](https://developers.facebook.com/)** and log in.
2. Click **My Apps** > **Create App**.
3. Select **Other** as the use case > Next > Select **Business** > Next.
4. Give your app a name (e.g., `My-Gemini-Assistant`) and click **Create app**.
5. On the App Dashboard, scroll to **WhatsApp** and click **Set up**.
6. On the **API Setup** page:
   - Notice the **Temporary access token** (valid 24 hours for testing) or set up a Permanent System User token.
   - Note down the **Phone number ID** (e.g., `109876543210987`).
   - In **"To"**, add your personal phone number to receive test messages. You will receive an OTP on WhatsApp to verify your number.
7. Go to **App settings** > **Basic**:
   - Click **Show** next to **App secret** and copy it.
8. In your project `.env`:
   ```env
   WHATSAPP_TOKEN=EAAG...your_token_here...
   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
   WHATSAPP_APP_SECRET=your_meta_app_secret
   WHATSAPP_VERIFY_TOKEN=create_any_random_string_like_secret123
   ALLOWED_PHONE_NUMBERS=your_phone_number_with_country_code
   ```
   _(Example: `ALLOWED_PHONE_NUMBERS=919876543210` for an Indian number without `+` or dashes)_.

---

### 3. Local Webhook Tunneling on Windows 10

Meta requires a public **HTTPS** URL to deliver webhooks. For local testing on Windows 10, use any free tunneling tool:

#### Option A: Cloudflare Tunnel (100% Free, Recommended)

Download `cloudflared` from Cloudflare or via winget:

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

Copy the generated `https://<unique-subdomain>.trycloudflare.com` URL.

#### Option B: ngrok

```powershell
winget install ngrok
ngrok http 3000
```

Copy the generated `https://<unique-id>.ngrok-free.app` URL.

---

### 4. Configure Webhook in Meta Dashboard

1. In Meta Developer Dashboard, click **WhatsApp** > **Configuration** on the left menu.
2. In the **Webhook** section, click **Edit**:
   - **Callback URL:** `https://<your-tunnel-url>/webhook`
   - **Verify token:** The exact value you set in `WHATSAPP_VERIFY_TOKEN` in `.env`.
3. Click **Verify and Save**. Meta will send a verification GET request to your server, which will authenticate instantly.
4. Under **Webhook fields**, click **Manage** and **Subscribe** to the `messages` field.

🎉 **Your WhatsApp bot is now live and ready to chat!**

---

## 💬 WhatsApp Chat Commands

You can send these commands in your WhatsApp chat at any time:

| Command                 | Action                                                                                                             |
| :---------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `/help`                 | Displays the complete command manual with interactive Quick Action buttons                                         |
| `/image <prompt>`       | Generates a clean AI image without watermarks via Pollinations (also `/draw <prompt>`)                             |
| `/todo <task>`          | Adds a task to your quick to-do list with a 6-character short ID                                                   |
| `/todos`                | Lists all your active to-do items with checkboxes (`[ ]` or `[x]`)                                                 |
| `/done <id>`            | Marks a task as completed                                                                                          |
| `/clear_todos`          | Clears all completed to-do items                                                                                   |
| `/persona [name]`       | Views or switches persona: `/persona coder`, `/persona tutor`, `/persona executive`, `/persona default`            |
| `/language [code]`      | Sets preferred reply language (`/language hi` for Hindi, `ta`, `te`, `bn`, `es`, `fr`, or `/language auto`)        |
| `/memory [add\|list]`   | Manages long-term personal facts and preferences (`/memory add ...`, `/memory list`, `/memory clear`)              |
| `/export`               | Exports a full sanitized copy of your active session, to-dos, and preferences as a JSON document                   |
| `/voice <on\|off>`      | Toggles audio voice note responses (or append `--voice` to any message)                                            |
| `/remind <when> <task>` | Sets a reminder. Relative: `/remind 10m Call mom`, 24h: `/remind 18:30 Workout`, Date: `/remind 25-12 09:00 Party` |
| `/reminders`            | Lists all your pending scheduled reminders with IDs and target times                                               |
| `/remind delete <id>`   | Cancels an active scheduled reminder by ID                                                                         |
| `/search <on\|off>`     | Toggles live Google Search grounding on Gemini answers with source citations                                       |
| `/usage`                | Displays your daily WhatsApp message quota and global Gemini API usage status                                      |
| `/reset`                | Clears active conversation turns from RAM; starts a fresh dialogue session                                         |
| `/delete` or `/forget`  | Purges all temporary in-memory session data for your user ID                                                       |
| `/privacy`              | Displays full privacy disclosure, cloud boundaries, and data flow details                                          |
| `/status`               | Shows server health, active Gemini model, fallback status, and search grounding state                              |
| `/model <name>`         | Switches active Gemini model at runtime (e.g. `/model gemini-3.5-flash-lite`)                                      |

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
| `REMINDERS_PERSIST`             | Boolean | `true`                     | When `true`, persists scheduled reminders and todos to disk across server restarts             |
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

This project is tailored specifically for personal use within free quotas:

| Provider   | Service               | Free Tier Limits                                  | How This Project Stays Free                                                                                                     |
| :--------- | :-------------------- | :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------ |
| **Google** | Gemini 2.5 Flash      | **15 RPM**, 1,000,000 TPM, **1,500 requests/day** | Uses light Flash model, trims conversation turns with sliding window (`MAX_CONTEXT_TURNS=10`), and blocks repeated empty pings. |
| **Meta**   | WhatsApp Cloud API    | **1,000 free service conversations/month**        | User-initiated messages fall under the free customer service window (24 hours).                                                 |
| **Host**   | Local PC / Free Cloud | **100% Free**                                     | Runs locally on your Windows 10 laptop using Cloudflare Tunnel, or deploys to free tiers on Render, Railway, or Koyeb.          |

---

## 🧪 Automated Testing & Diagnostics

### Run Unit & Integration Tests:

```powershell
npm test
```

**Test Coverage Includes:**

- Webhook HMAC-SHA256 signature validation (valid, forged, and tampered)
- Phone number whitelist authorization (allowed vs rejected strangers)
- Sensitive data & PII redaction (Credit cards, CVVs, UPI PINs, Passwords, OTPs)
- RAM context lifecycle and TTL expiration
- Multi-chunk message splitting for responses over 4,000 characters
- Health check and secret masking diagnostics

### Run Live Preflight Check:

```powershell
npm run check
```

Verifies your live Gemini API key and Meta token without exposing secrets.

---

## 📁 Project Structure

```
c:\Users\PJ\Documents\WHATSAPP bot\
│
├── src/
│   ├── server.js            # Express app, security middleware, rate limiter, admin dashboard, /metrics
│   ├── webhook.js           # Webhook routes, HMAC signature validation, commands, media dispatch
│   ├── queue.js             # Bounded in-process FIFO message queue with backpressure & exponential retries
│   ├── gemini.js            # Google Gen AI SDK integration, model fallback, search grounding, function calling
│   ├── language.js          # Multilingual translation directives & user language preference store
│   ├── memory.js            # Long-term personal fact memory & system prompt injection
│   ├── export.js            # User data export generator delivering sanitized JSON via WhatsApp
│   ├── whatsapp.js          # WhatsApp Cloud API client, message chunking, buttons, media I/O, templates
│   ├── privacy.js           # Whitelist guard, Luhn PII redactor, in-memory store, zero-logging
│   ├── image-gen.js         # Prompt detection, Pollinations client, Sharp corner crop
│   ├── reminders.js         # Scheduled alarms, time parser, durable storage sweeper, timers
│   ├── todos.js             # Personal task to-do manager with durable persistence
│   ├── document.js          # Multimodal document parser (PDF, PPTX, DOCX, XLSX, TXT, CSV)
│   ├── web-scraper.js       # SSRF-guarded web reader & article extractor
│   ├── tts.js               # Voice synthesizer client for WhatsApp voice note replies
│   ├── quota.js             # Daily per-user request limits & global Gemini budget guard
│   ├── metrics.js           # In-memory metrics counters & Prometheus exporter
│   ├── config.js            # Environment validation, secret masking, configuration
│   ├── test-connection.js   # Preflight diagnostic runner
│   ├── store/
│   │   ├── index.js         # Pluggable storage facade (memory vs redis)
│   │   ├── memory.js        # RAM store with automated 30s TTL eviction
│   │   └── redis.js         # Distributed Redis store client with retry failover
│   └── tools/
│       ├── index.js         # Tool registry and dispatcher for Gemini function calling
│       ├── time.js          # Real-time world clock and timezone tool
│       └── weather.js       # Zero-cost Open-Meteo real-time weather tool
│
├── tests/
│   ├── server.test.js       # Full HTTP E2E tests across health, ops, admin, and webhook
│   ├── queue.test.js        # Concurrency capping, backpressure, retries & dead-letter tests
│   ├── store.test.js        # Durable store interface & backend contract tests
│   ├── language.test.js     # Multilingual switching and directive tests
│   ├── memory.test.js       # Long-term memory facts, toggle & prompt injection tests
│   ├── tools.test.js        # Function calling tools (time, weather, reminder, todo) tests
│   ├── export.test.js       # User data JSON compilation and transmission tests
│   ├── config.test.js       # Configuration & model parsing tests
│   ├── privacy.test.js      # Privacy, Luhn redaction, rate limiting & cache tests
│   ├── whatsapp.test.js     # WhatsApp chunking, media timeout/cap, & interactive button tests
│   ├── gemini.test.js       # Gemini model switcher, fallbacks, & search grounding tests
│   ├── webhook.test.js      # HMAC validation, voice/document routing, & quoted context tests
│   ├── reminders.test.js    # Time parsing, relative/absolute timers & reminder lifecycle tests
│   ├── todos.test.js        # To-do list lifecycle & formatting tests
│   ├── document.test.js     # Multimodal document parsing tests
│   ├── quota.test.js        # Daily user and global quota limit tests
│   ├── metrics.test.js      # Prometheus exposition tests
│   ├── image-gen.test.js    # Image prompt extraction & watermark removal tests
│   └── benchmark.js         # Latency, throughput, and memory profiling suite
│
├── .github/workflows/
│   └── ci.yml               # GitHub Actions CI matrix (Node 20 & 22)
├── .env.example             # Complete configuration template
├── .env                     # Your local credentials (NEVER commit to git)
├── .gitignore               # Strict exclusion rules
├── eslint.config.js         # ESLint 9 flat configuration
├── .prettierrc              # Prettier formatting configuration
├── package.json             # Dependencies and npm scripts
├── README.md                # Full documentation & setup guide
└── SECURITY.md              # Cybersecurity & privacy architecture specification
```

---

## ☁️ Production Free-Tier Deployment

If you want the bot running 24/7 without keeping your Windows laptop on:

### Deploy to Render (Free Tier):

1. Push your repository to a private GitHub repository.
2. Sign up at **[Render.com](https://render.com/)**.
3. Click **New +** > **Web Service**.
4. Connect your GitHub repository.
5. Configuration:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
6. Under **Environment Variables**, add the keys from your `.env`:
   - `GEMINI_API_KEY`
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_VERIFY_TOKEN`
   - `WHATSAPP_APP_SECRET`
   - `ALLOWED_PHONE_NUMBERS`
   - `NODE_ENV=production`
7. Click **Deploy Web Service**.
8. Copy the Render URL (`https://your-service.onrender.com/webhook`) and update it in your Meta Developer Portal.

---

## 📜 License

MIT License. Built for private, personal use.
