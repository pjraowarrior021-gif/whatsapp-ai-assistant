# Contributing

Thanks for considering a contribution to **whatsapp-ai-assistant**! Contributions that improve usability, reliability, accessibility, testing, and privacy are welcome.

## Before you start

- For substantial changes, open an issue first to discuss the approach.
- For security vulnerabilities, do **not** open a public issue. Follow the private reporting instructions in [SECURITY.md](SECURITY.md).
- Please do not include real WhatsApp numbers, API keys, tokens, private messages, or other personal data in issues, tests, screenshots, or logs.

## Development setup

Requirements: Node.js 20 or newer (Node 22 is recommended), npm 10 or newer, and Git.

```bash
git clone https://github.com/pjraowarrior021-gif/whatsapp-ai-assistant.git
cd whatsapp-ai-assistant
npm ci
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Put only your own test credentials in `.env`; never commit it. The sample values are placeholders. Keep reminder/to-do persistence disabled unless you explicitly want local disk persistence.

## Checks before submitting

Run the relevant checks locally:

```bash
npm test
npm run lint
npm run format:check
npm audit --audit-level=high
```

The live preflight command (`npm run check`) requires valid provider credentials. Do not run it in CI or paste its output publicly without checking for sensitive data. The benchmark is optional:

```bash
npm run benchmark
```

Automated tests should mock external services; do not make real Meta, Gemini, or other provider API calls in tests.

## Contribution expectations

- Add or update tests for behavior changes and bug fixes.
- Keep secrets out of source, logs, fixtures, and test output. Route operational logging through the project's privacy-safe logger and avoid logging message content or personal identifiers.
- Preserve webhook authentication, authorization, input validation, rate limits, and privacy boundaries. Do not weaken production security checks to make tests pass.
- Document new or changed commands and environment variables in the README and `.env.example`; state defaults accurately.
- Keep dependencies and provider-specific claims current; explain new external services and their data flows.
- Use clear, focused changes and follow the existing JavaScript/ESM style and Prettier/ESLint configuration.

## Pull requests

1. Create a focused branch from `main`, for example `fix/reminder-default` or `feat/task-confirmation`.
2. Describe the user impact, implementation, and any privacy or security implications.
3. Link a related issue when applicable.
4. Include tests and document any configuration changes.
5. Complete the [pull request template](.github/pull_request_template.md) and wait for CI/review.

We use Conventional Commit-style prefixes where practical: `feat:`, `fix:`, `test:`, `refactor:`, `docs:`, and `chore:`.
