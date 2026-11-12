# Open-source readiness checklist

This checklist is specific to `pjraowarrior021-gif/whatsapp-ai-assistant`. Check items off as they are verified; this file does not claim that checks have already been run or settings enabled.

## Repository and community

- [x] MIT `LICENSE` is present.
- [x] `CONTRIBUTING.md` explains setup, tests, and contribution expectations.
- [x] `CODE_OF_CONDUCT.md` defines community standards and a reporting path.
- [x] Bug and feature issue forms are available; blank issues are disabled and security reports are directed away from public issues.
- [x] Pull request template includes test, privacy, and security checks.
- [ ] Verify the repository's GitHub visibility is the intended public/private setting.
- [ ] In repository **Settings → Security**, enable Private vulnerability reporting if available; confirm the advisory link works while signed in.
- [ ] Consider enabling Dependabot alerts and security updates, and review their proposed changes before merging.

## Before announcing or making a release

- [ ] Run `npm ci`, `npm test`, `npm run lint`, `npm run format:check`, and `npm audit --audit-level=high`; resolve failures and review audit findings.
- [ ] Review the latest CI runs and ensure the checks match the currently supported Node.js versions and package scripts.
- [ ] Check the full Git history and current tracked files for secrets. If any real token was ever committed, revoke/rotate it; deleting it from the latest commit alone is not sufficient.
- [ ] Confirm `.env`, `.data/`, logs, and generated artifacts are ignored, and that `.env.example` contains placeholders only.
- [x] Reconcile README claims with implementation and configuration: `REMINDERS_PERSIST` default is confirmed `false` across `src/config.js`, `.env.example`, `SECURITY.md`, and `README.md` (reminders and to-dos remain strictly in volatile RAM by default).
- [ ] Verify documented provider limits, model names, API versions, platform instructions, and free-tier claims against current provider documentation; avoid promising that hosting or API use is always free.
- [ ] Review privacy disclosures for every external service receiving user data, including Gemini, Meta, search, media, transcription, and image-generation providers.
- [ ] Ensure users are told that redaction is best-effort and does not guarantee all sensitive data is removed before cloud processing.
- [ ] Confirm security reporting instructions match the repository's actual GitHub security settings and that maintainers monitor the chosen channel.
- [ ] If distributing publicly, add a version/release note and a concise support/maintenance status statement.

## Suggested repeatable local checks

```bash
npm ci
npm test
npm run lint
npm run format:check
npm audit --audit-level=high
```

`npm run check` requires real provider credentials; run it only in a controlled environment and never publish secret-bearing output.
