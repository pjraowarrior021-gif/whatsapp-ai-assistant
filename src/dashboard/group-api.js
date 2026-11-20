/**
 * Group administration API, mounted under /dashboard/api/groups.
 * All routes inherit the dashboard's OPS_TOKEN authentication middleware.
 */
import express from 'express';
import QRCode from 'qrcode';
import { getGroupAdminService } from '../group-admin/registry.js';

export function createGroupAdminRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    const service = getGroupAdminService();
    if (!service || !service.initialized) {
      return res.status(503).json({ success: false, error: 'Group administrator is not initialized' });
    }
    req.groupAdmin = service;
    next();
  });

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const message = String(err.message || 'Unexpected error');
      const status = /not found|not discovered|invalid/i.test(message) ? 404 : 400;
      res.status(status).json({ success: false, error: message });
    }
  };

  /* ------------------------------- overview ------------------------------ */

  router.get(
    '/',
    handle(async (req, res) => {
      const service = req.groupAdmin;
      const days = clampDays(req.query.days);
      const groups = await service.listGroups({ days });
      res.json({ success: true, groups, status: service.status() });
    })
  );

  router.get(
    '/status',
    handle(async (req, res) => {
      const service = req.groupAdmin;
      res.json({
        success: true,
        status: service.status(),
        personal: service.personal?.getStatus ? service.personal.getStatus() : null,
        cloud: service.cloud?.getStatus ? service.cloud.getStatus() : null,
        global: service.activation.getGlobalState(),
      });
    })
  );

  router.get(
    '/analytics',
    handle(async (req, res) => {
      const service = req.groupAdmin;
      const days = clampDays(req.query.days);
      res.json({
        success: true,
        overview: service.analyticsAgent.getOverview({ days }),
        usage: service.getUsage({ days }),
      });
    })
  );

  router.get(
    '/providers',
    handle(async (req, res) => {
      const service = req.groupAdmin;
      const refresh = req.query.refresh === 'true';
      const freeOnly = req.query.freeOnly === 'true';
      const result = await service.listModels({ refresh, freeOnly });
      res.json({ success: true, ...result, gateway: service.gateway.describe() });
    })
  );

  router.get(
    '/usage',
    handle(async (req, res) => {
      res.json({ success: true, usage: req.groupAdmin.getUsage({ days: clampDays(req.query.days) }) });
    })
  );

  router.get(
    '/audit',
    handle(async (req, res) => {
      res.json({
        success: true,
        entries: req.groupAdmin.getAudit({
          groupJid: req.query.groupJid || null,
          limit: clampLimit(req.query.limit),
        }),
      });
    })
  );

  router.get(
    '/approvals',
    handle(async (req, res) => {
      res.json({
        success: true,
        approvals: req.groupAdmin.getApprovals(req.query.groupJid || null, { status: req.query.status || null }),
      });
    })
  );

  router.post(
    '/approvals/:id/resolve',
    handle(async (req, res) => {
      const approved = req.body?.approved === true;
      const result = await req.groupAdmin.resolveApproval(req.params.id, {
        approved,
        actor: actorFrom(req),
        note: String(req.body?.note || '').slice(0, 500),
      });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/moderation/:id/resolve',
    handle(async (req, res) => {
      const event = await req.groupAdmin.resolveModerationCase(req.params.id, {
        status: String(req.body?.status || 'resolved'),
        actor: actorFrom(req),
        note: String(req.body?.note || '').slice(0, 500),
      });
      res.json({ success: true, event });
    })
  );

  /* ------------------------------ emergency ------------------------------ */

  router.post(
    '/emergency-stop',
    handle(async (req, res) => {
      const paused = req.body?.paused === true;
      const global = await req.groupAdmin.emergencyStop(paused, {
        actor: actorFrom(req),
        reason: String(req.body?.reason || (paused ? 'Emergency stop' : 'Resumed')).slice(0, 300),
      });
      res.json({ success: true, global });
    })
  );

  /* --------------------------- personal session -------------------------- */

  router.get(
    '/personal/status',
    handle(async (req, res) => {
      res.json({ success: true, personal: req.groupAdmin.personal?.getStatus?.() || null });
    })
  );

  router.get(
    '/personal/qr',
    handle(async (req, res) => {
      const personal = req.groupAdmin.personal;
      if (!personal || typeof personal.getQr !== 'function') {
        return res.status(400).json({ success: false, error: 'Personal transport is unavailable' });
      }
      const qr = personal.getQr();
      if (!qr) return res.status(404).json({ success: false, error: 'No QR code is pending' });
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      res.json({ success: true, qrDataUrl: dataUrl, updatedAt: new Date().toISOString() });
    })
  );

  router.post(
    '/personal/connect',
    handle(async (req, res) => {
      const personal = req.groupAdmin.personal;
      if (!personal) return res.status(400).json({ success: false, error: 'Personal transport is unavailable' });
      await req.groupAdmin.audit.record({
        actor: actorFrom(req),
        action: 'personal_connect_requested',
      });
      const status = await personal.start();
      res.json({ success: true, personal: status || personal.getStatus() });
    })
  );

  router.post(
    '/personal/logout',
    handle(async (req, res) => {
      const personal = req.groupAdmin.personal;
      if (!personal) return res.status(400).json({ success: false, error: 'Personal transport is unavailable' });
      await req.groupAdmin.audit.record({ actor: actorFrom(req), action: 'personal_logout_requested' });
      const status = await personal.stop({ logout: true });
      res.json({ success: true, personal: status || personal.getStatus() });
    })
  );

  router.post(
    '/discover',
    handle(async (req, res) => {
      const personal = req.groupAdmin.personal;
      if (!personal || typeof personal.refreshGroups !== 'function') {
        return res.status(400).json({ success: false, error: 'Personal transport is unavailable' });
      }
      const groups = await personal.refreshGroups();
      const registered = await req.groupAdmin.registerDiscoveredGroups(groups, 'personal');
      res.json({ success: true, discovered: registered, groups: await req.groupAdmin.listGroups() });
    })
  );

  /* ------------------------------ cloud groups --------------------------- */

  router.get(
    '/cloud/status',
    handle(async (req, res) => {
      res.json({ success: true, cloud: req.groupAdmin.cloud?.getStatus?.() || null });
    })
  );

  router.post(
    '/cloud/create',
    handle(async (req, res) => {
      const result = await req.groupAdmin.createCloudGroup(
        {
          subject: String(req.body?.subject || '').slice(0, 128),
          description: String(req.body?.description || '').slice(0, 2048),
          joinApprovalMode: String(req.body?.joinApprovalMode || ''),
        },
        { actor: actorFrom(req) }
      );
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/cloud/discover',
    handle(async (req, res) => {
      const result = await req.groupAdmin.refreshCloudGroups();
      res.json({ success: true, ...result });
    })
  );

  /* ------------------------------- one group ----------------------------- */

  router.get(
    '/:jid',
    handle(async (req, res) => {
      const detail = await req.groupAdmin.getGroupDetail(req.params.jid);
      res.json({ success: true, ...detail });
    })
  );

  router.get(
    '/:jid/invite-link',
    handle(async (req, res) => {
      const result = await req.groupAdmin.getCloudInviteLink(req.params.jid);
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/invite-link/reset',
    handle(async (req, res) => {
      const result = await req.groupAdmin.resetCloudInviteLink(req.params.jid, { actor: actorFrom(req) });
      res.json({ success: true, ...result });
    })
  );

  router.get(
    '/:jid/join-requests',
    handle(async (req, res) => {
      const requests = await req.groupAdmin.listCloudJoinRequests(req.params.jid);
      res.json({ success: true, requests });
    })
  );

  router.post(
    '/:jid/join-requests',
    handle(async (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter(Boolean) : [];
      if (!ids.length)
        return res.status(400).json({ success: false, error: 'At least one join request id is required' });
      const result = await req.groupAdmin.resolveCloudJoinRequests(req.params.jid, {
        approve: req.body?.approve === true,
        ids,
        actor: actorFrom(req),
      });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/enable',
    handle(async (req, res) => {
      const group = await req.groupAdmin.enableGroup(req.params.jid, {
        actor: actorFrom(req),
        reason: String(req.body?.reason || '').slice(0, 300),
      });
      res.json({ success: true, group, message: 'Group enabled. Only messages received from now on are processed.' });
    })
  );

  router.post(
    '/:jid/disable',
    handle(async (req, res) => {
      const group = await req.groupAdmin.disableGroup(req.params.jid, {
        actor: actorFrom(req),
        reason: String(req.body?.reason || '').slice(0, 300),
      });
      res.json({ success: true, group, message: 'Group disabled. All AI processing for this group has stopped.' });
    })
  );

  router.patch(
    '/:jid/settings',
    handle(async (req, res) => {
      const patch = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : req.body;
      const group = await req.groupAdmin.updateGroupSettings(req.params.jid, patch, { actor: actorFrom(req) });
      res.json({ success: true, group });
    })
  );

  router.get(
    '/:jid/activity',
    handle(async (req, res) => {
      res.json({ success: true, activity: req.groupAdmin.getConversation(req.params.jid) });
    })
  );

  router.get(
    '/:jid/conversation',
    handle(async (req, res) => {
      res.json({ success: true, conversation: req.groupAdmin.getConversation(req.params.jid) });
    })
  );

  router.get(
    '/:jid/moderation',
    handle(async (req, res) => {
      res.json({
        success: true,
        events: req.groupAdmin.getModeration(req.params.jid, { limit: clampLimit(req.query.limit) }),
      });
    })
  );

  router.get(
    '/:jid/approvals',
    handle(async (req, res) => {
      res.json({ success: true, approvals: req.groupAdmin.getApprovals(req.params.jid) });
    })
  );

  router.get(
    '/:jid/audit',
    handle(async (req, res) => {
      res.json({
        success: true,
        entries: req.groupAdmin.getAudit({ groupJid: req.params.jid, limit: clampLimit(req.query.limit) }),
      });
    })
  );

  router.post(
    '/:jid/operations',
    handle(async (req, res) => {
      const action = String(req.body?.action || '');
      const result = await req.groupAdmin.administrationAgent.requestOperation({
        groupJid: req.params.jid,
        action,
        targetJid: String(req.body?.targetJid || ''),
        value: String(req.body?.value || ''),
        reason: String(req.body?.reason || 'Requested from dashboard').slice(0, 300),
        requestedBy: actorFrom(req),
      });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/announcement',
    handle(async (req, res) => {
      const result = await req.groupAdmin.requestAnnouncement({
        groupJid: req.params.jid,
        topic: String(req.body?.topic || '').slice(0, 500),
      });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/announcement/send',
    handle(async (req, res) => {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ success: false, error: 'Announcement text is required' });
      const result = await req.groupAdmin.sendOperatorMessage({
        groupJid: req.params.jid,
        text,
        actor: actorFrom(req),
      });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/send',
    handle(async (req, res) => {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ success: false, error: 'Message text is required' });
      const result = await req.groupAdmin.sendOperatorMessage({
        groupJid: req.params.jid,
        text,
        actor: actorFrom(req),
      });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/summarize',
    handle(async (req, res) => {
      const result = await req.groupAdmin.summarizeGroup({ groupJid: req.params.jid });
      res.json({ success: true, summary: result });
    })
  );

  router.get(
    '/:jid/report',
    handle(async (req, res) => {
      const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
      const report = await req.groupAdmin.generateReport({ groupJid: req.params.jid, period, send: false });
      res.json({ success: true, report });
    })
  );

  router.post(
    '/:jid/report',
    handle(async (req, res) => {
      const period = req.body?.period === 'weekly' ? 'weekly' : 'daily';
      const report = await req.groupAdmin.generateReport({
        groupJid: req.params.jid,
        period,
        send: req.body?.send === true,
      });
      res.json({ success: true, report });
    })
  );

  /* -------------------------------- memory ------------------------------- */

  router.get(
    '/:jid/memory',
    handle(async (req, res) => {
      res.json({ success: true, memory: req.groupAdmin.memoryAgent.getMemory(req.params.jid) });
    })
  );

  router.put(
    '/:jid/memory/rules',
    handle(async (req, res) => {
      const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
      const result = await req.groupAdmin.memoryAgent.setRules(req.params.jid, rules, { actor: actorFrom(req) });
      res.json({ success: true, ...result });
    })
  );

  router.post(
    '/:jid/memory/facts',
    handle(async (req, res) => {
      const file = req.groupAdmin.activation.getGroup(req.params.jid);
      const result = await req.groupAdmin.memoryAgent.addFact(
        req.params.jid,
        {
          text: String(req.body?.text || ''),
          category: String(req.body?.category || 'general'),
          source: 'dashboard',
          addedBy: actorFrom(req),
        },
        { maxFacts: file?.settings?.memory?.maxFacts || 200 }
      );
      res.json({ success: true, fact: result });
    })
  );

  router.post(
    '/:jid/memory/faqs',
    handle(async (req, res) => {
      const result = await req.groupAdmin.memoryAgent.addFaq(req.params.jid, {
        question: String(req.body?.question || ''),
        answer: String(req.body?.answer || ''),
        addedBy: actorFrom(req),
      });
      res.json({ success: true, faq: result });
    })
  );

  router.delete(
    '/:jid/memory/:type/:id',
    handle(async (req, res) => {
      const type = String(req.params.type || '');
      if (!['facts', 'faqs', 'summaries', 'rules'].includes(type)) {
        return res.status(400).json({ success: false, error: 'Unknown memory type' });
      }
      const result = await req.groupAdmin.memoryAgent.deleteItem(req.params.jid, type, req.params.id, {
        actor: actorFrom(req),
      });
      res.json({ success: true, ...result });
    })
  );

  router.delete(
    '/:jid/memory',
    handle(async (req, res) => {
      const result = await req.groupAdmin.memoryAgent.clear(req.params.jid, { actor: actorFrom(req) });
      res.json({ success: true, ...result });
    })
  );

  router.delete(
    '/:jid/data',
    handle(async (req, res) => {
      const result = await req.groupAdmin.deleteGroupData(req.params.jid, { actor: actorFrom(req) });
      res.json({ success: true, ...result });
    })
  );

  return router;
}

function clampDays(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.min(90, Math.max(1, Math.round(num)));
}

function clampLimit(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 100;
  return Math.min(500, Math.max(1, Math.round(num)));
}

function actorFrom(req) {
  return String(req.body?.actor || 'dashboard').slice(0, 120);
}
