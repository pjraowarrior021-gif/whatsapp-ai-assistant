# Security & Privacy Architecture

This document details the security model, privacy safeguards, and architectural boundaries of the **Personal WhatsApp AI Assistant powered by Google Gemini**.

---

## 1. Fundamental Privacy Notice: Encryption & Cloud Processing Boundaries

> [!WARNING]
> ### Crucial Security Disclosure: The Complete System is NOT End-to-End Encrypted
>
> While traditional WhatsApp person-to-person chats use the Signal protocol for end-to-end encryption (E2EE), **using the official WhatsApp Cloud API and Google Gemini API changes the security boundary:**
>
> 1. **Meta Infrastructure:** Messages sent to this chatbot pass through Meta's WhatsApp Cloud API servers, where they are decrypted to be routed via Webhooks.
> 2. **Application Server:** Our Node.js backend receives the message via HTTPS, verifies the HMAC signature, applies redaction, and passes the prompt to Google Gemini.
> 3. **Google Infrastructure:** Google's Gemini API servers receive the prompt to run neural inference and generate the response.
>
> **Transport Encryption (TLS 1.3 / HTTPS)** protects your data in transit between your WhatsApp client, Meta servers, your backend, and Google's servers. However, **application-level processing occurs within Meta's and Google's cloud infrastructure**. Do not assume that your messages remain hidden from these platform providers.

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

### A. Zero Permanent Storage Policy
- **No Database:** The application runs completely without SQL, MongoDB, Redis, or disk-backed databases.
- **Volatile RAM Only:** Active conversation context is stored strictly in memory (`Map`).
- **Automatic TTL Eviction:** Inactive conversations are completely purged from RAM after `SESSION_TIMEOUT_MINUTES` (default: 15 minutes).
- **Manual Data Deletion:** Sending `/reset` or `/delete` immediately evicts all stored context for the user.
- **Process Restart Wipe:** When the server restarts, all in-memory sessions and the internal anonymization salt are irreversibly destroyed.

### B. Data Minimization & Sanitization
- **Credential & Financial Data Redactor:** Incoming prompts are inspected by regex filters before transmission to Gemini. The following patterns are automatically redacted:
  - Credit & debit card numbers (`[REDACTED_CARD_NUMBER]`)
  - Card CVV/CVC codes (`[REDACTED_CVV]`)
  - UPI PINs, ATM PINs, MPINs (`[REDACTED_PIN]`)
  - Passwords and auth tokens (`[REDACTED_PASSWORD]`)
  - National IDs (Aadhaar / US SSN) (`[REDACTED_NATIONAL_ID]`)
  - One-time verification codes (`[REDACTED_OTP]`)
- **Strict Prohibition:** The assistant is instructed never to request or store sensitive financial or banking credentials.

### C. Zero-Content Logging
- The application logger (`privacyLog`) strictly logs metadata:
  - Timestamp
  - Event type (e.g., `MESSAGE_RECEIVED`, `GEMINI_RESPONSE_GENERATED`)
  - Anonymized user ID (salted SHA-256 hash `u_xxxxxxxxxx`)
  - Message length in characters
  - API latency in milliseconds
- **Never Logged:** Message bodies, prompt text, AI responses, phone numbers, API keys, and access tokens are strictly stripped and never output to stdout, stderr, or files.

---

## 3. Threat Model & Mitigations

| Threat | Risk Level | Mitigation in Code |
| :--- | :--- | :--- |
| **Spoofed Webhook Requests** | High | `x-hub-signature-256` HMAC-SHA256 verification using Meta App Secret with `crypto.timingSafeEqual` prevents forged or tampered webhook deliveries. |
| **Unauthorized Bot Usage** | High | Whitelist enforcement via `ALLOWED_PHONE_NUMBERS`. Senders not in the whitelist are rejected immediately. |
| **Replay / Duplicate Messages** | Medium | Deduplication cache tracks processed WhatsApp message IDs (`wamid.*`) with a 5-minute auto-expiry window. |
| **Credential / Key Leakage** | High | Secrets stored strictly in `.env` (gitignored). Safe masking in diagnostics (`AIz***xyz`). Sanitized error messages strip keys from stack traces. |
| **Denial of Service (DoS)** | Medium | `express-rate-limit` throttles request floods. Gemini context sliding window limits prompt payload to `MAX_CONTEXT_TURNS`. |
| **Accidental PII Ingestion by AI** | Medium | Client-side sanitization layer strips detected credit card, PIN, and password strings before sending payload to Google. |

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
2. Review the code locally and fix the defect following the zero-bypass protocol.
