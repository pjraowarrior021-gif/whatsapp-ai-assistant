/**
 * WhatsApp AI Assistant - Zero-Downtime Failover Router
 * Cloudflare Worker for Active-Passive Cloud Hosting (₹0 Budget)
 *
 * Automatically routes incoming Meta WhatsApp webhooks to the Primary server (Render),
 * and transparently fails over to the Secondary Backup server (Koyeb) if the Primary
 * times out or returns a 5xx error.
 */

export default {
  async fetch(request, env, _ctx) {
    const PRIMARY = (env.PRIMARY_URL || 'https://whatsapp-ai-primary.onrender.com').replace(/\/+$/, '');
    const BACKUP = (env.BACKUP_URL || 'https://whatsapp-ai-backup.koyeb.app').replace(/\/+$/, '');
    const TIMEOUT_MS = parseInt(env.TIMEOUT_MS || '4000', 10);

    const url = new URL(request.url);

    // Status endpoint for the failover router itself
    if (url.pathname === '/router-status') {
      return new Response(
        JSON.stringify(
          {
            status: 'operational',
            primary: PRIMARY,
            backup: BACKUP,
            timeoutMs: TIMEOUT_MS,
            timestamp: new Date().toISOString(),
          },
          null,
          2
        ),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const primaryTarget = `${PRIMARY}${url.pathname}${url.search}`;
    const backupTarget = `${BACKUP}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    // Remove Cloudflare-specific or problematic hop-by-hop headers
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');

    // Read the body buffer once so we can replay it to backup if primary fails
    const requestBody =
      request.method !== 'GET' && request.method !== 'HEAD' ? await request.clone().arrayBuffer() : null;

    const executeFetch = async (targetUrl) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(targetUrl, {
          method: request.method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });
        clearTimeout(timer);
        return res;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    };

    // 1. Try Primary Server (Render)
    try {
      const response = await executeFetch(primaryTarget);
      // If primary responds with 2xx, 3xx, or 4xx, it is alive and functional
      // (Note: 4xx is a client error, not a server failure, so don't failover on 401/403/404)
      if (response.status < 500) {
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('x-handled-by', 'primary');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }
    } catch {
      // Primary timed out or encountered network error: continue to backup
    }

    // 2. Failover to Secondary Backup Server (Koyeb)
    try {
      const backupResponse = await fetch(backupTarget, {
        method: request.method,
        headers,
        body: requestBody,
      });

      const backupHeaders = new Headers(backupResponse.headers);
      backupHeaders.set('x-handled-by', 'secondary-backup');
      return new Response(backupResponse.body, {
        status: backupResponse.status,
        statusText: backupResponse.statusText,
        headers: backupHeaders,
      });
    } catch (backupErr) {
      return new Response(
        JSON.stringify({
          error: 'both_servers_unreachable',
          message: 'Both primary and secondary backup servers failed to respond.',
          details: backupErr.message,
        }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
