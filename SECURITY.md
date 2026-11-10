# Security & Privacy Architecture

This document details the security model, privacy safeguards, and architectural boundaries of the **Personal WhatsApp AI Assistant powered by Google Gemini**.

---

## 1. Fundamental Privacy Notice: Encryption & Cloud Processing Boundaries

> [!WARNING]
>
> ### Crucial Security Disclosure: The Complete System is NOT End-to-End Encrypted
>
> While traditional WhatsApp person-to-person chats use the Signal protocol for end-to-end encryption (E2EE), **using the official WhatsApp Cloud API and Google Gemini API changes the security boundary**.
>
> 1. **Meta Infrastructure:** Messages sent to this chatbot pass through Meta's WhatsApp Cloud API servers, where they are decrypted to be routed via Webhooks.
> 2. **Application Server:** Our Node.js backend receives the message via HTTPS, verifies the HMAC signature, applies redaction, and passes the prompt to Google Gemini.
> 3. **Google Infrastructure:** Google's Gemini API servers receive the prompt to run neural inference and generate the response.
>
> **Transport Encryption (TLS 1.3 / HTTPS)** protects your data in transit between your WhatsApp client, Meta servers, your backend, and Google's servers. However, **application-level processing and AI inference are not end-to-end encrypted across all systems**.

---

## 2. Privacy Architecture & Safeguards

```
+------------------+       HTTPS / TLS       +--------------------------+
|  User's WhatsApp  |  -------------------->  |  Meta WhatsApp Cloud API |
|      Client      |                         |      (Graph API v21)     |
+------------------+                         +--------------------------+
                                                          |
                                            HTTPS Webhook | (HMAC-SHA256 Verified)
                                                          v
                                             +--------------------------+
                                             |     Node.js Backend      |
                                             |  - Access Whitelist      |
                                             |  - In-Memory RAM Storage |
                                             |  - PII / Credential Guard|
                                             |  - Zero Message Logging  |
                                             +--------------------------+
                                                          |
                                             HTTPS / TLS  | (Prompt + Trimmed Context)
                                                          v
                                             +--------------------------+
                                             |    Google Gemini API     |
                                             |     (Gemini Flash)       |
                                             +--------------------------+
```

### A. Zero Permanent Storage Policy & Reminders Exception

- **No Database:** The application runs completely without SQL, MongoDB, Redis, or external persistence services.
- **Volatile RAM Only (Default):** Active conversation context, deduplication IDs, rate limiting windows, daily quotas, and quoted-reply history are stored strictly in memory (`Map`).
- **Automatic TTL Eviction:** Inactive conversations are completely purged from RAM after `SESSION_TIMEOUT_MINUTES` (default: 15 minutes). Quoted-reply messages expire after 10 minutes.
- **Manual Data Deletion:** Sending `/reset`, `/delete`, or `/forget` immediately evicts all stored context for the user.
- **Process Restart Wipe:** When the server restarts, all in-memory sessions and the internal anonymization salt are irreversibly destroyed.
- **Single Opt-In Disk Exception (Scheduled Reminders & To-Dos):**
  - By default (`REMINDERS_PERSIST=false`), scheduled reminders and to-do lists are stored strictly in volatile RAM.
  - When explicitly enabled (`REMINDERS_PERSIST=true`), pending reminders and active to-do items are persisted atomically to `.data/reminders.json` and `.data/todos.json` so users do not miss scheduled tasks.
  - No conversation history, tokens, or personal identifiers are written to these files.

### B. Data Minimization & Sanitization

- **Credential & Financial Data Redactor:** Incoming prompts are inspected by regex and algorithmic filters before transmission to Gemini. The following patterns are automatically redacted:
  - Credit & debit card numbers: Validated using the **Luhn algorithm** to avoid false positives on tracking or order numbers (`[REDACTED_CARD_NUMBER]`)
  - Card CVV/CVC codes (`[REDACTED_CVV]`)
  - UPI PINs, ATM PINs, MPINs (`[REDACTED_PIN]`)
  - Passwords and auth tokens (`[REDACTED_PASSWORD]`)
  - National IDs (Aadhaar 4-4-4 format or context prefix / US SSN) (`[REDACTED_NATIONAL_ID]`)
  - One-time verification codes (`[REDACTED_OTP]`)
- **Strict Prohibition:** The assistant is instructed never to request or store sensitive financial or banking credentials.

### C. Multimodal & Web Data Flows

- **Voice Notes (Audio):**
  - Downloaded in memory over HTTPS directly from Meta Graph API with strict size (16MB) and timeout (15s) caps.
  - Normalized to `audio/ogg` and passed as inline base64 data to Gemini. Never written to disk.
  - Outbound voice note synthesis uses lightweight in-memory audio streaming with zero disk writes.
- **Documents (PDF, TXT, CSV):**
  - Only MIME types in the strict allowlist (`application/pdf`, `text/plain`, `text/csv`) are accepted; all others are rejected immediately.
  - Downloaded into memory buffers and passed as inline data to Gemini for document Q&A.
- **Webpage & Article Summarizer (SSRF Protection):**
  - Validates URLs before fetching: strictly blocks loopback addresses (`127.0.0.1`, `localhost`, `[::1]`), internal subnets (`10.*`, `192.168.*`, `172.16-31.*`), and cloud metadata IP (`169.254.169.254`).
  - Fetches content strictly in memory with size caps (`16MB`) and timeouts (`15s`), stripping scripts, styles, boilerplates, and tracking tags.
- **Location Intelligence:**
  - Inbound coordinates, addresses, and place names are formatted in volatile RAM with automatic Google Search grounding to retrieve real-time local snapshots without disk writes.
- **Google Search Grounding:**
  - When enabled (`/search on` or dynamic location queries), search queries derived from user prompts are executed against Google Search to ground responses in fresh web knowledge.
  - Up to 3 sources are formatted into WhatsApp markdown links with citations.
- **Quoted-Reply Memory:**
  - Recent incoming messages are stored in an in-memory sliding cache (`Map<wamid, text>`) with a maximum capacity of 200 items and a 10-minute TTL to provide contextual grounding for WhatsApp replies.

### D. Zero-Content Logging

- The application logger (`privacyLog`) strictly logs metadata:
  - Timestamp and Correlation ID (`requestId`)
  - Event type (e.g., `MESSAGE_RECEIVED`, `GEMINI_RESPONSE_GENERATED`)
  - Anonymized user ID (salted SHA-256 hash `u_xxxxxxxxxx`)
  - Message length in characters and HTTP status / latency in milliseconds
- **Never Logged:** Message bodies, prompt text, AI responses, audio/document payloads, phone numbers, API keys, and access tokens are strictly stripped and never output to stdout, stderr, or files.

---

## 3. Threat Model & Mitigations

| Threat                                 | Risk Level | Mitigation in Code                                                                                                                                           |
| :------------------------------------- | :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-Side Request Forgery (SSRF)** | Critical   | Pre-fetch URL parsing in `src/web-scraper.js` strictly blocks private RFC1918 ranges, loopback addresses (`127.0.0.1`, `localhost`), and cloud metadata IPs. |
| **Spoofed Webhook Requests**           | High       | `x-hub-signature-256` HMAC-SHA256 verification using Meta App Secret with `crypto.timingSafeEqual` prevents forged or tampered webhook deliveries.           |
| **Verify Token Brute-Force**           | High       | Webhook challenge verification compares `hub.verify_token` against `WHATSAPP_VERIFY_TOKEN` strictly using `crypto.timingSafeEqual`.                          |
| **Slowloris & Resource Exhaustion**    | High       | Media downloads enforce strict size and timeout caps before buffering.                                                                                       |
| **Per-User Spam & DoS**                | High       | Dual-tier rate limiting: Global `express-rate-limit` plus per-user sliding window limiter.                                                                   |
| **Unauthorized Bot Usage**             | High       | Whitelist enforcement via `ALLOWED_PHONE_NUMBERS`. Senders not in the whitelist are rejected immediately.                                                    |
| **Replay / Duplicate Messages**        | Medium     | Deduplication cache tracks processed WhatsApp message IDs (`wamid.*`) with a 5-minute auto-expiry window.                                                    |
| **Credential / Key Leakage**           | High       | Secrets stored strictly in `.env` (gitignored). Safe masking in diagnostics.                                                                                 |
| **Accidental PII Ingestion by AI**     | Medium     | Client-side sanitization layer strips detected credit cards (Luhn-validated), PINs, and password strings before sending payload to Google.                   |

---

## 4. Environment Security Best Practices

1. **Protect your `.env` File:**
   - Never commit `.env` to git or public repositories.
   - Use environment variables directly in production hosting platforms.
2. **Rotate Tokens Periodically:**
   - Rotate your Meta Permanent Access Token and Google Gemini API key every 90 days.
3. **Use HTTPS / TLS Only:**
   - In production, ensure all external traffic is routed through TLS 1.3 / HTTPS.
   - For local development on Windows 10, use a secure HTTPS tunnel (e.g. Cloudflare Tunnel or ngrok).

---

## 5. Security Incident Reporting

If you identify a vulnerability in this project:

1. Please do not open a public issue on GitHub.
2. Report it privately through the repository's GitHub Security Advisories page: `Security` -> `Report a vulnerability`.
3. If you cannot access GitHub Security Advisories, reach out through a private maintainer channel and wait for triage before discussing it publicly.
4. Do not disclose the issue publicly until a fix is available and the maintainers have confirmed the disclosure plan.

---

## 6. Responsible Disclosure Expectations

- We appreciate responsible disclosure and will triage security reports promptly.
- Once verified, maintainers will work to fix the issue and coordinate a public disclosure if needed.
- For non-sensitive questions or general feedback, public issues are welcome.
