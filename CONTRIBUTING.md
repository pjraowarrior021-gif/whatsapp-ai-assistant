# Contributing to Personal WhatsApp AI Assistant

Thank you for your interest in contributing to Personal WhatsApp AI Assistant! We welcome contributions that maintain our core architectural principles: **Zero-Cost Default**, **Strict Privacy Guarantees**, **Hermetic Testing**, and **Backward Compatibility**.

---

## Code of Conduct

All contributors and participants are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). Please treat everyone with respect, patience, and courtesy.

---

## Core Development Principles

1. **Zero External Paid Dependencies by Default:**
   All default setups run on volatile in-RAM data structures or local disk files without requiring paid cloud infrastructure or commercial databases. External stores (e.g. Redis) are strictly opt-in.
2. **Strict Privacy Contract:**
   Never log raw message bodies, prompts, conversation transcripts, or API tokens. Always route logs through `privacyLog()` with anonymized user IDs (`anonId`) and redacted secrets (`maskSensitiveInfo()`).
3. **Fail-Closed Security:**
   Webhook signature verification, operational token checking (`requireOpsAuth`), and whitelist authorization must fail closed when unconfigured or invalid in production.
4. **100% Hermetic Test Coverage:**
   Never make external API calls (Meta Graph API, Gemini API, or Open-Meteo) during automated tests. Always mock network boundaries.

---

## Local Development Workflow

### 1. Prerequisites

- Node.js `>=20.0.0` (Node 22 LTS recommended, see `.nvmrc`)
- npm `>=10.0.0`
- Git

### 2. Setup

```bash
git clone https://github.com/PJ/whatsapp-ai-assistant.git
cd "WHATSAPP bot"
npm install
copy .env.example .env # On Windows PowerShell/CMD (or 'cp .env.example .env' on Unix)
```

### 3. Running Verification Suite

Before submitting any pull request, ensure all checks pass:

```bash
# Run unit and integration tests
npm test

# Check code formatting with Prettier
npm run format:check

# Format code automatically
npm run format

# Run ESLint static analysis
npm run lint

# Run non-blocking latency and memory benchmarks
npm run benchmark
```

---

## Commit Guidelines

We enforce **Conventional Commits**:

- `feat(scope): ...` for new capabilities
- `fix(scope): ...` for bug fixes
- `test(scope): ...` for test suite additions
- `refactor(scope): ...` for architectural improvements without behavioral changes
- `chore(scope): ...` for build scripts, CI, dependencies, or repo hygiene
- `docs(scope): ...` for documentation updates

---

## Pull Request Process

1. Fork the repository and create your branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Write unit tests for all new functions, endpoints, or tools in `tests/`.
3. Verify that `npm test`, `npm run lint`, and `npm run format:check` pass cleanly.
4. Open a pull request against `main` using the provided Pull Request Template.
