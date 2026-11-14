---
name: agent-browser
description: Fast browser automation CLI for AI agents (Chrome/Chromium via CDP with accessibility-tree snapshots and compact @eN element refs). Use when navigating pages, clicking elements, filling forms, taking screenshots, extracting data, running web QA/dogfooding, testing web applications, or inspecting local web servers. Triggers on requests to "open a website", "test the web app", "click a button", "inspect web page", "fill form", or "browser automation".
---

# Agent Browser Automation Skill (`agent-browser`)

`agent-browser` is a browser automation CLI built for AI agents by Vercel Labs. It controls Chrome/Chromium directly via the Chrome DevTools Protocol (CDP) with accessibility-tree snapshots, compact `@eN` element references, and zero heavy browser wrapper dependencies.

Repository: [https://github.com/vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)

---

## 1. Quick Installation & Launcher

`agent-browser` runs natively via Node.js / npx or global npm install:

```bash
# Direct on-demand execution (recommended for agent runs):
npx agent-browser <command> [args]

# Global installation:
npm install -g agent-browser && agent-browser install
```

---

## 2. Core Snapshot-and-Ref Workflow

The agent-browser workflow operates in a tight 4-step loop:

```bash
# 1. Open the target web page
npx agent-browser open http://localhost:3000/dashboard

# 2. Capture interactive accessibility snapshot
npx agent-browser snapshot -i

# 3. Perform actions on @eN refs identified in the snapshot
npx agent-browser click @e1
npx agent-browser fill @e2 "Search query"
npx agent-browser press Enter

# 4. Re-snapshot to observe DOM updates
npx agent-browser snapshot -i
```

---

## 3. Standard CLI Commands

### Navigation & Page Control

- `agent-browser open <url>`: Opens a URL in the active tab.
- `agent-browser reload`: Reloads the current page.
- `agent-browser back` / `agent-browser forward`: History navigation.
- `agent-browser close`: Closes the browser instance.

### Inspection & Snapshots

- `agent-browser snapshot -i`: Accessibility tree of interactive elements with `@eN` references.
- `agent-browser snapshot`: Full accessibility tree including headings, text, and containers.
- `agent-browser snapshot --json`: Outputs snapshot as structured JSON.
- `agent-browser text`: Extracts rendered page text content.
- `agent-browser title`: Prints current page title.

### User Interaction

- `agent-browser click @eN`: Clicks element identified by `@eN`.
- `agent-browser fill @eN "text"`: Clears and types text into input/textarea.
- `agent-browser type @eN "text"`: Types text without clearing existing content.
- `agent-browser hover @eN`: Hovers over the target element.
- `agent-browser select @eN "option_value"`: Selects a dropdown option.
- `agent-browser press <Key>`: Presses keyboard key (`Enter`, `Tab`, `Escape`, `ArrowDown`).
- `agent-browser scroll <up|down|top|bottom>`: Scrolls the viewport.

### Waiting & Timing

- `agent-browser wait @eN`: Waits until target element exists and becomes visible.
- `agent-browser wait --text "Expected Text"`: Waits until text appears in DOM.
- `agent-browser wait <ms>`: Pauses execution for specified milliseconds (e.g. `1000`).

### Visual Capture & Evaluation

- `agent-browser screenshot [path.png]`: Captures viewport screenshot.
- `agent-browser screenshot --full [path.png]`: Captures full scrollable page screenshot.
- `agent-browser screenshot --annotate [path.png]`: Labels interactive elements with `[N]` corresponding to `@eN` refs.
- `agent-browser eval "<code>"`: Executes arbitrary JavaScript expression in the page context.

---

## 4. Session Isolation & Daemon Management

Each agent or task should use an isolated session to prevent cross-talk:

```bash
# Generate a dedicated worktree session ID:
SESSION=$(npx agent-browser session id --scope worktree --prefix test)

# Run commands within that session:
npx agent-browser --session "$SESSION" open http://localhost:3000
npx agent-browser --session "$SESSION" snapshot -i
npx agent-browser --session "$SESSION" close
```

---

## 5. Testing & Dogfooding Web Applications

When testing local web applications (such as Node.js / Express dashboards, Vite apps, Next.js apps):

1. **Verify Server Health First**: Confirm the backend daemon is running (`curl -I http://localhost:PORT/health`).
2. **Open Page & Snapshot**: Open target route (`/`, `/dashboard`, `/admin`) and capture accessibility snapshot.
3. **Verify Critical UI Elements**:
   - Check headers, status indicators (e.g., `ONLINE`), navigation tabs, and metrics.
   - Verify that data tables and lists render without placeholder errors or blank areas.
4. **Test Interactive Elements**:
   - Click action buttons, toggles, filter dropdowns, and form submits.
   - Verify modal dialogs or responsive menus open and close cleanly.
5. **Capture Verification Artifact**:
   - Take a screenshot of the tested interface: `agent-browser screenshot path/to/output.png`.
6. **Graceful Teardown**:
   - Always close the session when testing completes: `agent-browser close`.

---

## 6. Detailed References

Additional deep-dive reference manuals located in `references/`:

- [`commands.md`](./references/commands.md): Complete flag dictionary and command specifications.
- [`snapshot-refs.md`](./references/snapshot-refs.md): Accessibility snapshot syntax and ref resolution.
- [`session-management.md`](./references/session-management.md): Browser daemons, cookies, and authentication vaults.
- [`trust-boundaries.md`](./references/trust-boundaries.md): Security practices for executing untrusted page code.
