# Autonomous Group Administrator

An opt-in AI administrator for WhatsApp **groups**. It is built into this
project alongside the existing personal-assistant pipeline, but it is a
separate subsystem with its own stores, agents, transports and safety rules.

> **Default posture: everything is off.** No group is processed until a human
> explicitly enables that exact group ID. Discovering a group, receiving a
> message from it, or setting a display name never enables anything.

---

## 1. Why a separate pipeline?

The existing Cloud API pipeline handles private conversations with the bot's
own WhatsApp Business number. Group administration has different requirements:

- Activation must be per-group and enforced on the backend.
- Context and memory must never leak between groups.
- Administrative actions must be proposed, approved and verified.
- The bot must not reply to itself, to spam, or to a backlog from before the
  group was enabled.

The group subsystem therefore routes every group message through
`GroupOrchestrator.handleInbound()`, which is the single authorization point.
Private chats are untouched: they still use the original Gemini pipeline.

---

## 2. Architecture

```
WhatsApp
   │
   ├── Cloud API webhook ──► src/webhook.js ──► GroupOrchestrator (groups only)
   │                                      └─► legacy personal assistant (private)
   │
   └── Personal WhatsApp (Baileys, opt-in)
             └─► PersonalWhatsAppTransport ──► GroupOrchestrator
                                                    │
                    ┌───────────────────────────────┼───────────────────────────────┐
                    │                               │                               │
              SecurityAgent                  ConversationAgent              ModerationAgent
           (activation, pause,           (trigger, prompt, loop guard)     (spam, scam, links)
            admin identity)
                    │                               │                               │
              MemoryAgent                   AdministrationAgent              AnalyticsAgent
          (group-scoped memory)         (approvals + verified actions)     (counters, reports)
                    │
               AIGateway ──► Gemini / OpenRouter / Qwen / OpenAI-compatible
```

### Agents

| Agent                 | Responsibility                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `SecurityAgent`       | Backend gate: subsystem flag, activation, global pause, pre-activation cutoff, admin identity, approval checks. |
| `ConversationAgent`   | Trigger detection, reply cooldown, hourly cap, loop guard, isolated prompt, bounded reply.                      |
| `ModerationAgent`     | Deterministic findings, warnings, escalation. Never deletes or removes on its own.                              |
| `MemoryAgent`         | Durable, group-scoped rules/facts/FAQs/summaries and “remember:” capture.                                       |
| `AdministrationAgent` | Drafts announcements, creates approvals, executes approved actions, verifies results.                           |
| `AnalyticsAgent`      | Per-group counters, daily/weekly reports, report scheduling.                                                    |

### Stores

All state lives in JSON files under `GROUP_ADMIN_DATA_DIR`
(default: `<DATA_DIR>/group-admin`):

| File              | Contents                                                         |
| ----------------- | ---------------------------------------------------------------- |
| `groups.json`     | Activation, per-group settings, global pause, last report times. |
| `memory.json`     | Group-scoped rules, facts, FAQs, summaries.                      |
| `moderation.json` | Moderation cases and their status.                               |
| `analytics.json`  | Per-group daily counters.                                        |
| `approvals.json`  | Pending/resolved approvals (24h expiry).                         |
| `dedupe.json`     | Processed message IDs (bounded ring).                            |
| `ai-usage.json`   | Token/cost accounting and recent provider errors.                |
| `audit.log`       | Append-only audit log (JSON lines, secrets redacted).            |

Writes are serialized and atomic (temp file + rename). Reads never cross group
boundaries: the memory store has no API that accepts two group IDs.

---

## 3. Transports

Two transports are available and can run at the same time:

|                             | Personal (Baileys) | Cloud API Groups                    |
| --------------------------- | ------------------ | ----------------------------------- |
| Existing consumer groups    | ✅ yes             | ❌ no API to join                   |
| Business-created groups     | ❌ not applicable  | ✅ create + invite link             |
| Group admin actions         | ✅ if bot is admin | ✅ business number is sole admin    |
| Promote/demote participants | ✅                 | ❌ unsupported by Meta              |
| Max participants            | WhatsApp limit     | **8**                               |
| Account requirement         | any spare number   | **Official Business Account (OBA)** |

### Personal WhatsApp (for existing groups)

Meta's Cloud API cannot add a number to an existing consumer group, so the
personal transport remains the way to automate groups you already have. It is
opt-in:

```dotenv
PERSONAL_WHATSAPP_ENABLED=true
PERSONAL_WHATSAPP_AUTH_DIR=            # defaults to <DATA_DIR>/personal-whatsapp-auth
# PERSONAL_WHATSAPP_PAIRING_NUMBER=9198xxxxxxxx   # optional, digits only
PERSONAL_WHATSAPP_PRIVATE_CHATS=false
PERSONAL_WHATSAPP_RECONNECT_MAX_MS=60000
```

Start the server, open **Dashboard → Group Administrator**, press **Connect**,
then scan the QR with WhatsApp → Linked devices → Link a device. The session
credentials are stored in the auth directory; keep it private.

**Risks and limitations**

- Baileys is an **unofficial** WhatsApp Web multi-device client. It is not
  endorsed by WhatsApp and carries an **account-restriction risk**. Use a
  number you are willing to expose, review WhatsApp's terms, and keep volume
  human-like.
- The transport ignores private chats unless `PERSONAL_WHATSAPP_PRIVATE_CHATS`
  is explicitly set (the group subsystem still ignores them; the flag is for a
  separately configured assistant).
- Only text and media captions are processed. Images, audio and video posted in
  groups are not analyzed by the group pipeline.
- Group administration requires the bot account to be a **group admin**. The
  backend checks this against fresh metadata before executing anything.

### Cloud API Groups (for a small business-owned group)

Meta's Groups API lets a Cloud API **business number create its own** group and
invite people. It is not a way to join an existing consumer group.

```dotenv
CLOUD_GROUPS_ENABLED=true
CLOUD_GROUPS_API_VERSION=              # defaults to WHATSAPP_API_VERSION
CLOUD_GROUPS_AUTO_DISCOVER=true        # registers groups disabled at startup
```

Prerequisites:

1. The number must be an **Official Business Account (OBA)**.
2. Subscribe the app to `group_lifecycle_update`, `group_participants_update`,
   `group_settings_update`, and `group_status_update` in addition to `messages`.
3. Grant `whatsapp_business_messaging`.
4. Use an API version that supports Groups (the docs currently show v27.0;
   set `CLOUD_GROUPS_API_VERSION` if `WHATSAPP_API_VERSION` is older).

What the adapter does:

- **Create** a group (`POST /{phone-number-id}/groups`) from the dashboard.
  The group is registered **disabled**; enabling is always a separate action.
- **List** active groups and register new ones disabled.
- **Send** text messages (`recipient_type: "group"`).
- **Get/reset** the invite link; participants join only through that link.
- **Approve/reject** join requests when `join_approval_mode=approval_required`.
- **Remove** participants and update **subject/description**, each verified
  against fresh group metadata before reporting success.
- **Webhooks** apply lifecycle, participant, settings, and suspension events.
  A suspension disables the group immediately; clearing a suspension never
  re-enables it.

Known Cloud API limitations:

- **Cannot join an arbitrary existing group**, and cannot be added to one.
- **Maximum 8 participants** per group, and the business number is always the
  creator and the only admin. Human participants cannot be promoted.
- No calling, disappearing messages, view-once, interactive, commerce, or
  authentication messages inside groups.
- A number registered on Cloud API cannot simultaneously be used as a personal
  WhatsApp companion device for Baileys.
- Inbound group webhooks do not expose group mentions, so mention-based
  triggering falls back to the bot alias/prefix triggers in Cloud groups.

---

## 4. Enabling the subsystem

```dotenv
GROUP_ADMIN_ENABLED=true
GROUP_ADMIN_DATA_DIR=                  # defaults to <DATA_DIR>/group-admin
GROUP_ADMIN_IMPORT_LEGACY=true         # import legacy ALLOWED_GROUP_IDS once
GROUP_ADMIN_BOT_ALIASES=ai,assistant,bot,admin
GROUP_ADMIN_HUMAN_ADMINS=9198xxxxxxxx,9197xxxxxxxx
GROUP_ADMIN_REQUIRE_APPROVAL=true
GROUP_ADMIN_CONTEXT_MESSAGES=24
GROUP_ADMIN_HISTORY_TTL_MINUTES=360
GROUP_ADMIN_MAX_REPLIES_PER_HOUR=30
GROUP_ADMIN_REPLY_COOLDOWN_MS=15000
GROUP_ADMIN_MAX_FACTS=200
GROUP_ADMIN_AUDIT_MAX_ENTRIES=2000
```

### Legacy groups

If you previously used `ALLOWED_GROUP_IDS`, those IDs were already an explicit
operator opt-in. On first boot with `GROUP_ADMIN_IMPORT_LEGACY=true` they are
imported as **enabled** groups exactly once. Set it to `false` to skip the
import. Newly discovered groups are always imported as **disabled**.

---

## 5. Daily use

### Dashboard

Open `/dashboard` and select **Group Administrator**:

- Session state, QR pairing, reconnect attempts, logout.
- Group list with per-group switches. New groups appear disabled.
- Per-group settings: persona, response mode, trigger prefix, cooldown, caps,
  moderation, memory, reports, per-task model overrides.
- Activity, memory, moderation cases, reports and audit for the selected group.
- Pending approvals with **Approve** / **Reject**.
- **Emergency Stop** to pause every group instantly.

All `/dashboard/api/groups/*` routes inherit the existing `OPS_TOKEN`
authentication. API keys are never returned by the API.

### Chat commands (human admins only)

Only senders recognized as group admins can use these:

| Command                     | Effect                                           |
| --------------------------- | ------------------------------------------------ |
| `!admin remove <phone>`     | Queue `remove_participant` for approval.         |
| `!admin promote <phone>`    | Queue `promote_participant` for approval.        |
| `!admin demote <phone>`     | Queue `demote_participant` for approval.         |
| `!admin subject <text>`     | Queue a subject change for approval.             |
| `!admin description <text>` | Queue a description change for approval.         |
| `!announce <topic>`         | Draft an announcement (approval by default).     |
| `!report [weekly]`          | Generate and post a report now.                  |
| `!summary`                  | Summarize recent context and store it in memory. |
| `remember: <fact>`          | Store a durable group fact (admin only).         |

**The AI never claims an administrative action succeeded.** Operations are
queued, approved by a human, executed through the transport, and only reported
as successful if fresh group metadata confirms the change.

### Response modes

- `mention` (default) — only @mentions, a leading bot alias, or a reply to the
  bot.
- `prefix` — only messages starting with the configured prefix (default `/`).
- `all` — every message in an enabled group (still rate-limited).
- `never` — never reply spontaneously; admin commands and reports still work.

### Memory

Memory is per-group and explicitly curated. The bot does **not** learn from
private chats or from other groups. Admins can add/delete facts, FAQs and
rules, or wipe a single group's data from the dashboard. Conversation context
is RAM-only, bounded, and expires.

---

## 6. Multi-provider AI gateway

Group agents use `src/ai-gateway/`, not the personal-assistant Gemini client.

```dotenv
AI_PROVIDER_ORDER=gemini,openrouter,qwen,openai_compatible
AI_FREE_ONLY=false
AI_RATE_LIMIT_PER_MINUTE=30
AI_REQUEST_TIMEOUT_MS=30000
AI_MAX_FALLBACKS=3
AI_USAGE_RETENTION_DAYS=90

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
QWEN_API_KEY=
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1

AI_MODEL_CHAT=
AI_MODEL_MODERATION=
AI_MODEL_SUMMARY=
AI_MODEL_REPORT=
AI_MODEL_MEMORY=
```

- Providers are tried in order. Explicit per-task models (dashboard or
  `AI_MODEL_*`) win, then provider defaults.
- Model references accept `provider:model` (e.g.
  `openrouter:meta-llama/llama-3.3-70b-instruct:free`) or a plain model name.
- Free filtering is applied only where provider metadata exposes pricing
  (OpenRouter today). Other providers keep their configured model.
- Each attempt is rate-limited locally; failures fall through to the next
  provider. Provider errors are redacted before logging or returning.
- Usage is stored as integer micro-USD. Keys are never persisted by the gateway
  or returned by the API.
- A provider that is not configured is skipped entirely.

---

## 7. Security model

| Requirement                  | Enforcement                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| AI off by default            | `registerDiscoveredGroup()` writes `enabled: false`; only `setEnabled(jid, true)` flips it.             |
| Backend activation           | `SecurityAgent.authorizeInbound()` runs before any analytics, memory, moderation or model call.         |
| No process before activation | `enabledAt` cutoff rejects older timestamps unless `processPreActivationHistory` is explicitly enabled. |
| Unique identity              | Canonical `<id>@g.us` JIDs; names are display-only.                                                     |
| Global stop                  | `activation.isGloballyPaused()` overrides every group; checked again immediately before sending.        |
| Human approval               | `GROUP_ADMIN_REQUIRE_APPROVAL` (default true); `remove_participant` always requires approval.           |
| Verified actions             | Execution is reported as success only when the transport confirms the new state.                        |
| Audit                        | Append-only log with actor, action, group, outcome and redacted detail. No message bodies.              |
| Cross-group isolation        | Memory/analytics/moderation APIs are single-group; conversation state is keyed by JID.                  |
| Private chats                | Ignored unless separately configured; the group pipeline checks `isGroup`.                              |
| Duplicate/replay             | Persisted dedupe ring plus in-memory loop guards.                                                       |
| Self-reply loops             | `fromMe` messages dropped; bot JIDs ignored; 3 consecutive bot turns trigger a loop guard.              |
| No API key exposure          | Gateway status returns booleans only; audit redacts secret-like keys.                                   |

### What approval does not cover

Approvals gate **structural/destructive** actions (remove, promote, demote,
subject, description, settings, announcements). Normal conversational replies
and moderation warnings are automated, but they are rate-limited and cannot
delete messages or remove members.

---

## 8. Reliability

- **Reconnects**: bounded exponential backoff with jitter, capped by
  `PERSONAL_WHATSAPP_RECONNECT_MAX_MS`. Logout (`401`) and session replacement
  (`440`) stop retrying instead of looping forever.
- **History sync**: `messages.upsert` events other than `notify` are ignored, so
  a reconnect does not replay old chats.
- **Dedupe**: message IDs are claimed before processing and persisted, so a
  restart cannot re-trigger a reply.
- **Scheduler**: one in-process tick per minute evaluates due daily/weekly
  reports. Reports use each group's timezone.
- **Graceful degradation**: if a model or transport fails, the pipeline logs the
  failure and sends nothing rather than inventing an answer.

---

## 9. Testing

```bash
npm test
node --test tests/group-admin-orchestrator.test.js
node --test tests/group-admin-activation.test.js
node --test tests/ai-gateway.test.js
node --test tests/personal-transport.test.js
node --test tests/group-api.test.js
npm run lint
```

The group tests use fake gateways, fake transports and injected sockets. They
never contact WhatsApp, a model provider, or the network.

Coverage includes: disabled-by-default activation, persistence across restart,
emergency stop, pre-activation cutoffs, duplicate suppression, bot/self-message
suppression, moderation warn/escalate, approval execution and verification,
cross-group memory isolation, provider fallback, free-model filtering, secret
redaction, reconnect/logout handling, private-chat filtering, and the HTTP API.

---

## 10. Troubleshooting

| Symptom                                    | Likely cause                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Group never replies                        | Group is not enabled, or the message does not address the bot in `mention` mode.                                          |
| “Group not found” on enable                | The group has not been discovered yet. Connect WhatsApp and press **Refresh Groups**.                                     |
| Admin command ignored                      | Sender is not in `GROUP_ADMIN_HUMAN_ADMINS`, not a live group admin, or the group is disabled.                            |
| Approval executes but reports “unverified” | The transport could not confirm the change (bot not admin, stale metadata, or WhatsApp rejected it). Check the audit log. |
| QR never appears                           | `PERSONAL_WHATSAPP_ENABLED` is false or the transport is already connected/logged out.                                    |
| Provider errors                            | Check `ai-usage.json` recent errors; confirm the key and base URL. Errors are redacted.                                   |
| Reports not sent                           | `reports.sendToGroup` is false by default; reports are still generated and stored.                                        |

---

## 11. Project layout

```
src/group-admin/
  orchestrator.js          central coordinator and inbound pipeline
  activation-store.js      per-group activation + global pause
  defaults.js              settings schema and clamping
  jid.js                   canonical group/user identifiers
  memory-store.js          group-scoped durable memory
  moderation-store.js      moderation cases
  moderation-detector.js   deterministic signals
  analytics-store.js       per-group counters
  approvals.js             human approval queue
  audit.js                 append-only audit log
  conversations.js         RAM-only context + loop guards
  dedupe.js                persisted duplicate protection
  persistent-store.js      atomic JSON helper
  registry.js              webhook ↔ service wiring
  agents/                  security, conversation, moderation,
                           administration, memory, analytics
src/ai-gateway/
  index.js                 routing, fallback, rate limits
  providers.js             Gemini / OpenRouter / Qwen / OpenAI-compatible
  usage-store.js           token and cost accounting
src/transports/
  personal-whatsapp.js     opt-in Baileys transport
  cloud-api.js             Cloud API Groups adapter + envelope mapping
src/dashboard/group-api.js group management HTTP API
public/dashboard/groups.js group management dashboard view
```
