# WhatsApp Bot Failover Router (Cloudflare Worker)

Zero-cost, automatic active-passive failover router for your WhatsApp AI Assistant.

## How it works

1. All Meta WhatsApp Webhooks arrive at `https://whatsapp-failover-router.<subdomain>.workers.dev/webhook`.
2. The Worker forwards the request to your **Primary** server (`Render`).
3. If Primary succeeds within 4 seconds, the response returns immediately with `x-handled-by: primary`.
4. If Primary times out, sleeps, or returns a 5xx error, the Worker automatically retries on the **Secondary Backup** server (`Koyeb`) with `x-handled-by: secondary-backup`.

## Deployment Options

### Option A: 1-Click via Cloudflare Dashboard (No Terminal Required)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com/) → **Workers & Pages** → **Create Application** → **Create Worker**.
2. Name it `whatsapp-failover-router` and click **Deploy**.
3. Click **Edit code**, replace everything with the contents of `worker.js`, and click **Deploy**.
4. Go to **Settings** → **Variables** and add:
   - `PRIMARY_URL`: Your Render app URL (e.g. `https://whatsapp-ai-primary.onrender.com`)
   - `BACKUP_URL`: Your Koyeb app URL (e.g. `https://whatsapp-ai-backup.koyeb.app`)
   - `TIMEOUT_MS`: `4000`

### Option B: Using Wrangler CLI

```bash
cd infra/failover-worker
npx wrangler deploy
```
