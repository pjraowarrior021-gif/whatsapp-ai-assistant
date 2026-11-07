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

- **Google Gemini Integration:** Powered by the default `gemini-2.5-flash` model via the modern `@google/genai` SDK. Supports runtime model switching.
- **Official WhatsApp Cloud API:** Built with Meta's Graph API (v21.0), complete with read receipts (blue ticks) and automatic 4,000-character message chunking.
- **Enhanced Privacy Layer:**
  - **Zero Disk Storage:** No conversation text or history is ever saved to disk or databases.
  - **Volatile RAM Only:** Context is preserved strictly in temporary memory with automatic idle eviction (default: 15 minutes).
  - **Zero Content Logging:** Logs contain only timestamps, event types, latency, and anonymized user hashes. Message bodies are **never** logged.
  - **Sensitive Data Redaction:** Automatically detects and redacts credit cards, CVVs, UPI PINs, passwords, and OTPs before sending data to Gemini.
  - **Strict Access Control:** Rejects any incoming messages from phone numbers not listed in your authorized whitelist.
  - **Meta Webhook Signature Verification:** Cryptographically validates every incoming webhook request using HMAC-SHA256 and your Meta App Secret.

---

## 🏛️ Architecture & Data Flow

```
WhatsApp User
    │
    ▼ (HTTPS/TLS)
Meta WhatsApp Cloud API (Graph API v21.0)
    │
    ▼ (HTTPS Webhook with HMAC-SHA256 signature)
Node.js + Express Server (Windows 10 / Cloud)
    │
    ▼
Privacy & Security Layer
 ├── 1. Verify Meta HMAC-SHA256 Signature
 ├── 2. Whitelist Check (ALLOWED_PHONE_NUMBERS)
 ├── 3. PII & Financial Credential Redactor
 ├── 4. Anonymize User Identifier (Salted Hash)
 └── 5. Sliding-Window In-Memory Context (RAM Only)
    │
    ▼ (HTTPS API Call)
Google Gemini API (gemini-2.5-flash)
    │
    ▼
Generate AI Response (Formatted for WhatsApp Markdown)
    │
    ▼ (Split into chunks if > 4000 characters)
Meta WhatsApp Cloud API
    │
    ▼
WhatsApp User Receives Answer
```

---

## 🔒 Privacy & Encryption Disclosure

> [!IMPORTANT]
> ### Crucial Transparency Notice: Not End-to-End Encrypted Across the AI Pipeline
>
> While standard WhatsApp peer-to-peer chats use the Signal protocol for end-to-end encryption (E2EE), **a chatbot interacting with external cloud AI services cannot be end-to-end encrypted across the entire lifecycle:**
>
> 1. **Meta WhatsApp Cloud API:** When you text the bot, your message is routed to and decrypted on Meta's servers so it can be forwarded to your webhook server.
> 2. **Node.js Server:** Your server receives the text, strips any detected sensitive credentials, and sends the prompt to Google.
> 3. **Google Gemini API:** Google processes your text on its servers to generate the neural model's answer.
>
> **All communication in transit is encrypted using HTTPS / TLS 1.3.** However, Meta and Google process message content within their respective clouds. See [`SECURITY.md`](SECURITY.md) for full architecture details.

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
   *(Example: `ALLOWED_PHONE_NUMBERS=919876543210` for an Indian number without `+` or dashes)*.

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

| Command | Action |
| :--- | :--- |
| `/help` | Displays the help manual and usage guide |
| `/reset` | Clears the active conversation context from RAM; starts fresh session |
| `/delete` or `/forget` | Purges all temporary in-memory session data for your user ID |
| `/privacy` | Displays full privacy disclosure, cloud boundaries, and data flow details |
| `/status` | Shows server health, active Gemini model, and security mode |
| `/model <name>` | Switches active Gemini model at runtime (e.g. `/model gemini-1.5-flash`) |

---

## 💰 Zero-Cost Free-Tier Optimization (₹0 Budget)

This project is tailored specifically for personal use within free quotas:

| Provider | Service | Free Tier Limits | How This Project Stays Free |
| :--- | :--- | :--- | :--- |
| **Google** | Gemini 2.5 Flash | **15 RPM**, 1,000,000 TPM, **1,500 requests/day** | Uses light Flash model, trims conversation turns with sliding window (`MAX_CONTEXT_TURNS=10`), and blocks repeated empty pings. |
| **Meta** | WhatsApp Cloud API | **1,000 free service conversations/month** | User-initiated messages fall under the free customer service window (24 hours). |
| **Host** | Local PC / Free Cloud | **100% Free** | Runs locally on your Windows 10 laptop using Cloudflare Tunnel, or deploys to free tiers on Render, Railway, or Koyeb. |

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
│   ├── server.js            # Express app, security middleware, rate limiter, graceful shutdown
│   ├── webhook.js           # Webhook routes, HMAC signature validation, commands, dedup
│   ├── gemini.js            # Google Gen AI SDK integration, system prompts, error handling
│   ├── whatsapp.js          # WhatsApp Cloud API client, message chunking, read receipts
│   ├── privacy.js           # Whitelist guard, PII redaction, in-memory store, zero-logging
│   ├── config.js            # Environment validation, secret masking, configuration
│   └── test-connection.js   # Preflight diagnostic runner
│
├── tests/
│   ├── config.test.js       # Configuration tests
│   ├── privacy.test.js      # Privacy and credential redactor tests
│   ├── whatsapp.test.js     # WhatsApp chunking and client tests
│   ├── gemini.test.js       # Gemini model switcher tests
│   └── webhook.test.js      # HMAC validation and HTTP integration tests
│
├── .env.example             # Complete configuration template
├── .env                     # Your local credentials (NEVER commit to git)
├── .gitignore               # Strict exclusion rules
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
