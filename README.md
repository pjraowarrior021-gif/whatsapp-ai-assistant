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

## 🏛️ Architecture & Data Flow

```
WhatsApp User (Text / Voice / Image / Document / Video / Buttons / Location)
    │
    ▼ (HTTPS / TLS)
Meta WhatsApp Cloud API (Graph API v21.0)
    │
    ▼ (HTTPS Webhook with HMAC-SHA256 signature & Request-ID)
Node.js + Express Server (Windows / Railway / Render / Linux)
    │
    ├── 1. Cryptographic HMAC Verification (timingSafeEqual)
    ├── 2. Whitelist Check (ALLOWED_PHONE_NUMBERS)
    ├── 3. Per-User Sliding Window Limiter & Daily Quota Guard
    ├── 4. PII Redaction with Luhn Card Check & Context Scanners
    ├── 5. Quoted-Reply Context Assembly (Bounded 10m Cache)
    ├── 6. In-Memory Session Context (RAM Only, 15m TTL)
    │
    ├── [Voice / Audio]  ──> Stream Buffer ──> Normalize audio/ogg ──┐
    ├── [PDF / Doc]      ──> Stream Buffer ──> Validate MIME       ──┤
    ├── [YouTube Link]   ──> Fetch Transcript / Metadata           ──┤
    ├── [Instagram Reel] ──> Open Graph Social Crawler + Grounding ──┤
    ├── [Image Gen]      ──> Pollinations  ──> Sharp Smart Crop   ──┤
    ├── [Video Gen]      ──> 4-Stage Diffusion / HF ZeroGPU / Wan  ──┤
    │                                                                │
    ▼ (HTTPS API Call)                                              │
Google Gemini API (gemini-3.5-flash-lite + Fallback Failover)       │
    │   ├── Optional: Google Search Grounding Tool                  │
    │   └── Multimodal Inline Data (Audio / Image / Document) <─────┘
    ▼
Generate AI Response (Formatted for WhatsApp Markdown)
    │
    ▼ (Auto-chunked if > 4000 characters or interactive buttons / media)
Meta WhatsApp Cloud API
    │
    ▼
WhatsApp User Receives Reply / Media / Video / Reminder Alert
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
> 2. **Node.js Server:** Your server receives the text, strips any detected sensitive credentials (Luhn card checks, PINs, passwords, OTPs), manages in-memory context, and communicates with Google Gemini over TLS.
> 3. **Google Gemini API:** Google processes prompt payloads (and attached multimodal audio/document buffers) to generate answers.
> 4. **Google Search Grounding:** When enabled (`/search on`), search queries extracted from your prompt are submitted to Google Search to retrieve live facts.
> 5. **Quoted-Reply Context:** To allow natural conversational replies, inbound messages are temporarily cached in volatile RAM for up to 10 minutes (bounded to 200 items max) and are never written to disk.
> 6. **Reminders Storage Exception:** By default (`REMINDERS_PERSIST=false`), all reminders and to-dos live strictly in volatile memory. If you explicitly enable `REMINDERS_PERSIST=true`, active reminders and to-dos are stored atomically in a restricted local JSON file (`.data/reminders.json` and `.data/todos.json`) so they survive server restarts.
>
> **All communication in transit is encrypted using HTTPS / TLS 1.3.** See [`SECURITY.md`](SECURITY.md) for full architecture details.

---

## 💻 Prerequisites for Windows 10

- **Node.js:** v20.0.0 or newer (Node 22 LTS recommended)
- **npm:** v10.0.0 or newer
- **Git**
- **FFmpeg:** Optional but recommended for audio normalization and AI video generation (`winget install Gyan.FFmpeg`)
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
Copy-Item .env.example .env
```

Open `.env` in your editor and enter your credentials. Keep reminder/to-do persistence disabled unless you explicitly want local disk persistence.

### 3. Run Preflight Diagnostics

Verify that all your tokens and network connections are valid:

```powershell
npm run check
```

_(Note: Run `npm run check` only with your private credentials in `.env`; never run it in CI or share output containing secrets)._

### 4. Run Automated Test Suite

Execute the hermetic unit and integration tests:

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

### 1. Google Gemini API Key (Free)

1. Navigate to **[Google AI Studio](https://aistudio.google.com/apikey)**.
2. Sign in with your Google account.
3. Click **"Get API key"** and then **"Create API key in new project"**.
4. Copy the API key and paste it into your `.env`:
   ```env
   GEMINI_API_KEY=AIzaSy...your_key_here...
   GEMINI_MODEL=gemini-3.5-flash-lite
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
   WHATSAPP_VERIFY_TOKEN=create_a_strong_random_secret_token
   ALLOWED_PHONE_NUMBERS=your_phone_number_with_country_code
   ```

---

### 3. Local Webhook Tunneling on Windows 10

Meta requires a public **HTTPS** URL to deliver webhooks. For local testing on Windows 10, use any free tunneling tool:

#### Option A: Cloudflare Tunnel (100% Free, Recommended)

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
3. Click **Verify and Save**. Meta will send a verification GET request to your server, which will authenticate instantly using timing-safe comparison.
4. Under **Webhook fields**, click **Manage** and **Subscribe** to the `messages` field.

🎉 **Your WhatsApp bot is now live and ready to chat!**

---

## 💬 WhatsApp Chat Commands

You can send these commands in your WhatsApp chat at any time:

| Command                    | Action                                                                                                             |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| `/send <contact> <msg>`    | Dispatches an outbound message to a contact alias or phone number (Admin-only)                                     |
| `/contacts`                | Lists all registered contacts in your WhatsApp contact book with masked numbers                                    |
| `/contact add <alias>`     | Saves a contact (e.g. `/contact add mom 919876543210 Mom`)                                                         |
| `/contact remove <alias>`  | Deletes a saved contact alias                                                                                      |
| `/contact permit <on/off>` | Toggles whether contact can directly chat with Gemini AI or relay-only                                             |
| `/help`                    | Displays the complete command manual with interactive Quick Action buttons                                         |
| `/image <prompt>`          | Generates a clean AI image without watermarks via Pollinations (also `/draw <prompt>`)                             |
| `/video <prompt>`          | Generates a 10–15s genuine AI video via multi-stage diffusion, ZeroGPU, or Wan (also `/reel`, `/animate`)          |
| `/todo <task>`             | Adds a task to your quick to-do list with a 6-character short ID                                                   |
| `/todos`                   | Lists all your active to-do items with checkboxes (`[ ]` or `[x]`)                                                 |
| `/done <id>`               | Marks a task as completed                                                                                          |
| `/clear_todos`             | Clears all completed to-do items                                                                                   |
| `/persona [name]`          | Views or switches persona: `/persona coder`, `/persona tutor`, `/persona executive`, `/persona default`            |
| `/language [code]`         | Sets preferred reply language (`/language hi` for Hindi, `ta`, `te`, `bn`, `es`, `fr`, or `/language auto`)        |
| `/memory [add\|list]`      | Manages long-term personal facts and preferences (`/memory add ...`, `/memory list`, `/memory clear`)              |
| `/memory auto <on\|off>`   | Toggles autonomous conversational fact learning (`/memory auto on` or `/memory auto off`)                          |
| `/export`                  | Exports a full sanitized copy of your active session, to-dos, and preferences as a JSON document                   |
| `/voice <on\|off>`         | Toggles audio voice note responses (or append `--voice` to any message)                                            |
| `/remind <when> <task>`    | Sets a reminder. Relative: `/remind 10m Call mom`, 24h: `/remind 18:30 Workout`, Date: `/remind 25-12 09:00 Party` |
| `/reminders`               | Lists all your pending scheduled reminders with IDs and target times                                               |
| `/remind delete <id>`      | Cancels an active scheduled reminder by ID                                                                         |
| `/search <on\|off>`        | Toggles live Google Search grounding on Gemini answers with source citations                                       |
| `/usage`                   | Displays your daily WhatsApp message quota and global Gemini API usage status                                      |
| `/reset`                   | Clears active conversation turns from RAM; starts a fresh dialogue session                                         |
| `/delete` or `/forget`     | Purges all temporary in-memory session data for your user ID                                                       |
| `/privacy`                 | Displays full privacy disclosure, cloud boundaries, and data flow details                                          |
| `/status`                  | Shows server health, active Gemini model, fallback status, and search grounding state                              |
| `/model <name>`            | Switches Gemini primary model dynamically (e.g. `/model gemini-3.5-flash-lite`)                                    |

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
| `GEMINI_MAX_OUTPUT_TOKENS`      | Number  | `1024`                     | Maximum token count for generated Gemini replies                                               |
| `GEMINI_TEMPERATURE`            | Number  | `0.7`                      | Sampling temperature for Gemini completions                                                    |
| `ENABLE_SEARCH_GROUNDING`       | Boolean | `false`                    | Default toggle for live Google Search grounding (can toggle in-chat via `/search`)             |
| `WHATSAPP_TOKEN`                | String  | _Required_                 | Meta WhatsApp Cloud API access token                                                           |
| `WHATSAPP_PHONE_NUMBER_ID`      | String  | _Required_                 | Meta WhatsApp business phone number ID                                                         |
| `WHATSAPP_BUSINESS_ACCOUNT_ID`  | String  | _Optional_                 | Meta WhatsApp Business Account ID                                                              |
| `WHATSAPP_APP_SECRET`           | String  | _Required_                 | Meta App Secret for HMAC-SHA256 signature verification (fail-closed in production)             |
| `WHATSAPP_VERIFY_TOKEN`         | String  | _Required_                 | Secret token for Meta Webhook subscription challenge verification                              |
| `WHATSAPP_API_VERSION`          | String  | `v21.0`                    | Meta Graph API version                                                                         |
| `SKIP_SIGNATURE_VERIFICATION`   | Boolean | `false`                    | Test-only bypass for signature checks (strictly honored when `NODE_ENV=test`)                  |
| `ALLOWED_PHONE_NUMBERS`         | String  | _Required_                 | Comma-separated list of authorized sender phone numbers (e.g. `919876543210`)                  |
| `MAX_CONTEXT_TURNS`             | Number  | `10`                       | Maximum user/model conversation turns kept in sliding memory window                            |
| `SESSION_TIMEOUT_MINUTES`       | Number  | `15`                       | Inactivity TTL in minutes before RAM session context is pruned                                 |
| `MEDIA_MAX_BYTES`               | Number  | `104857600` (100MB)        | Maximum allowed media file size for audio, documents, and images                               |
| `MEDIA_FETCH_TIMEOUT_MS`        | Number  | `60000` (60s)              | Timeout in ms when fetching media attachments or Pollinations images                           |
| `VIDEO_ENGINE`                  | String  | `free`                     | Video engine: `free` (Hugging Face ZeroGPU / Storyboard), `cloud` (Pollinations), or `motion`  |
| `VIDEO_MODEL`                   | String  | `storyboard`               | AI video model: `storyboard` (Gemini+FLUX 4-stage), `wan2.1` (Alibaba Wan 2.1), `animatediff`  |
| `VIDEO_DEFAULT_DURATION`        | Number  | `12`                       | Target duration for generated AI videos (10 to 15 seconds)                                     |
| `HF_TOKEN`                      | String  | _Optional_                 | Optional Hugging Face token for higher rate limits on HF Spaces / ZeroGPU                      |
| `POLLINATIONS_API_KEY`          | String  | _Optional_                 | Optional API key for cloud AI video generation via Pollinations                                |
| `POLLINATIONS_VIDEO_MODEL`      | String  | `alibaba/wan-2.2-fast`     | Cloud video model for Pollinations (`alibaba/wan-2.2-fast`, `google/veo-3.1-fast`)             |
| `USER_RATE_LIMIT_MAX`           | Number  | `10`                       | Maximum messages per user sliding window before throttling                                     |
| `USER_RATE_LIMIT_WINDOW_MS`     | Number  | `60000` (1 min)            | Duration of per-user sliding rate limit window in milliseconds                                 |
| `RATE_LIMIT_MAX_PER_WINDOW`     | Number  | `20`                       | Global HTTP requests allowed per IP window                                                     |
| `RATE_LIMIT_WINDOW_MS`          | Number  | `60000` (1 min)            | Global rate limit window duration in milliseconds                                              |
| `MAX_REQUESTS_PER_USER_PER_DAY` | Number  | `200`                      | Maximum inbound messages per user per UTC day (resets at 00:00 UTC)                            |
| `MAX_GEMINI_REQUESTS_PER_DAY`   | Number  | `1400`                     | Maximum Gemini API calls across all users per UTC day                                          |
| `STATE_BACKEND`                 | String  | `memory`                   | State persistence backend: `memory` (default in-RAM) or `redis` (shared cache)                 |
| `REDIS_URL`                     | String  | _Optional_                 | Redis connection URL (e.g. `redis://localhost:6379`)                                           |
| `DATA_DIR`                      | String  | `.data`                    | Directory for persistent disk files (reminders, todos)                                         |
| `REMINDERS_PERSIST`             | Boolean | `false`                    | When `true`, persists scheduled reminders and todos to disk across server restarts             |
| `TIMEZONE`                      | String  | `Asia/Kolkata`             | Timezone identifier used for date/time formatting and reminders                                |
| `TIMEZONE_OFFSET_HOURS`         | Number  | `5.5`                      | Timezone offset in hours relative to UTC (5.5 for IST)                                         |
| `MESSAGE_CONCURRENCY`           | Number  | `4`                        | Max concurrent message pipelines processed simultaneously in-process                           |
| `QUEUE_MAX_RETRIES`             | Number  | `3`                        | Retry count for transient 429/5xx errors before dead-letter routing                            |
| `QUEUE_MAX_SIZE`                | Number  | `1000`                     | Maximum buffer size before queue backpressure drops requests                                   |
| `SHUTDOWN_TIMEOUT_MS`           | Number  | `10000` (10s)              | Grace period for in-flight tasks to complete during SIGINT/SIGTERM                             |
| `ENABLE_AI_TOOLS`               | Boolean | `false`                    | Enables Gemini function calling (real-time weather, clock, auto-reminders)                     |
| `ALLOWED_GROUP_IDS`             | String  | _Optional_                 | Comma-separated list of authorized WhatsApp Group IDs                                          |
| `GROUP_TRIGGER_PREFIX`          | String  | `/`                        | Prefix required in group messages to trigger assistant replies                                 |
| `TEMPLATE_DIGEST_NAME`          | String  | _Optional_                 | Pre-approved WhatsApp message template name for proactive reminders                            |
| `TEMPLATE_DIGEST_LANG`          | String  | `en`                       | Language code for WhatsApp message template                                                    |
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
whatsapp-ai-assistant/
│
├── src/
│   ├── server.js
│   ├── webhook.js
│   ├── queue.js
│   ├── gemini.js
│   ├── contacts.js
│   ├── conversation-adapter.js
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
│   ├── image-learner.js
│   ├── video-gen.js
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
