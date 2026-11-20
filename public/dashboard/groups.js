/* global window, document, localStorage, confirm, fetch */
/**
 * Group Administrator dashboard view.
 *
 * Kept separate from app.js so the existing Mission Control views remain
 * untouched. All values rendered here are escaped; no API key is ever present
 * in this file or in API responses.
 */
(function () {
  'use strict';

  const API = '/dashboard/api/groups';
  const state = {
    groups: [],
    selectedJid: '',
    detail: null,
    tab: 'settings',
    status: null,
    loading: false,
    providers: null,
    cloud: null,
    cloudInvite: null,
    joinRequests: [],
    lastQrAt: 0,
    reportText: '',
    announcementDraft: '',
  };

  function token() {
    return localStorage.getItem('ops_token') || '';
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;

    const res = await fetch(`${API}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      if (res.status === 401) throw new Error('Unauthorized. Set your OPS token first.');
      if (res.status === 503) throw new Error('Group administrator is starting up. Try again in a moment.');
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'}</span><span>${esc(
      message
    )}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(100%)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, 3800);
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '—';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function groupByJid(jid) {
    return state.groups.find((g) => g.jid === jid);
  }

  function groupName(jid) {
    return groupByJid(jid)?.name || jid;
  }

  /* ------------------------------- loading ------------------------------- */

  async function load() {
    if (state.loading) return;
    if (state.status && state.status.global?.aiPaused) {
      // Keep the emergency banner accurate even while paused.
    }
    state.loading = true;
    try {
      await loadStatus();
      await Promise.all([loadGroups(), loadApprovals(), loadAudit()]);
      if (state.selectedJid) {
        const active = document.activeElement;
        const typing =
          active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && active.closest('#group-detail');
        if (!typing) await loadDetail(state.selectedJid, { quiet: true });
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.loading = false;
    }
  }

  async function loadStatus() {
    const data = await api('/status');
    state.status = data.status;
    state.cloud = data.cloud || data.status?.cloud || null;
    renderSession(data.status, data.personal);
    renderCloud();
    renderStats();
  }

  async function loadGroups() {
    const data = await api('/');
    state.groups = data.groups || [];
    state.status = data.status || state.status;
    renderGroups();
    renderStats();
    renderApprovals();
  }

  async function loadDetail(jid, { quiet = false } = {}) {
    const data = await api(`/${encodeURIComponent(jid)}`);
    const changed = state.selectedJid !== jid;
    state.detail = data;
    state.selectedJid = jid;
    if (changed) {
      state.cloudInvite = null;
      state.joinRequests = [];
      if (state.tab === 'cloud' && data.group?.transport !== 'cloud') state.tab = 'settings';
    }
    renderGroups();
    renderDetail();
    if (!quiet) renderApprovals();
  }

  async function loadApprovals() {
    const data = await api('/approvals?status=pending');
    state.approvals = data.approvals || [];
    renderApprovals();
  }

  async function loadAudit() {
    const data = await api('/audit?limit=60');
    state.audit = data.entries || [];
    renderAudit();
  }

  /* ------------------------------- render -------------------------------- */

  function renderSession(status, personal) {
    const dot = document.getElementById('ga-session-dot');
    const label = document.getElementById('ga-session-state');
    const meta = document.getElementById('ga-session-meta');
    const qrBox = document.getElementById('group-qr-box');
    if (!dot || !label) return;

    const p = personal || status?.personal || {};
    const map = {
      connected: ['Connected', 'var(--accent-primary)'],
      qr: ['Scan QR to link', 'var(--accent-amber)'],
      connecting: ['Connecting…', 'var(--accent-cyan)'],
      reconnecting: ['Reconnecting…', 'var(--accent-amber)'],
      disabled: ['Transport disabled', 'var(--text-dim)'],
      logged_out: ['Logged out', 'var(--accent-rose)'],
      replaced: ['Replaced by another session', 'var(--accent-rose)'],
      error: ['Connection error', 'var(--accent-rose)'],
      idle: ['Idle', 'var(--text-dim)'],
      stopped: ['Stopped', 'var(--text-dim)'],
    };
    const [text, color] = map[p.state] || [p.state || 'Unknown', 'var(--text-dim)'];
    label.textContent = text;
    dot.style.background = color;
    dot.style.boxShadow = `0 0 10px ${color}`;

    const bits = [];
    if (p.botJids?.length) bits.push(`Bot: ${p.botJids[0]}`);
    bits.push(`${p.groupCount || 0} groups cached`);
    if (p.reconnectAttempts) bits.push(`${p.reconnectAttempts} reconnect attempts`);
    if (p.lastError) bits.push(p.lastError);
    meta.textContent = bits.join(' • ');

    if (p.state === 'qr' && p.qrAvailable) {
      qrBox.hidden = false;
      const now = Date.now();
      if (now - state.lastQrAt > 45000) {
        state.lastQrAt = now;
        api('/personal/qr')
          .then((data) => {
            const img = document.getElementById('group-qr-img');
            if (img && data.qrDataUrl) img.src = data.qrDataUrl;
          })
          .catch(() => {});
      }
    } else {
      qrBox.hidden = true;
    }

    const stopBtn = document.getElementById('btn-emergency-stop');
    if (stopBtn) {
      const paused = status?.global?.aiPaused === true;
      stopBtn.textContent = paused ? '▶️ Resume AI' : '🛑 Emergency Stop';
      stopBtn.classList.toggle('btn-primary', paused);
      stopBtn.classList.toggle('btn-danger', !paused);
    }
  }

  function renderCloud() {
    const dot = document.getElementById('ga-cloud-dot');
    const label = document.getElementById('ga-cloud-state');
    if (!dot || !label) return;
    const c = state.cloud || {};
    const connected = c.connected === true;
    label.textContent = connected ? 'Configured' : c.state === 'unconfigured' ? 'Not configured' : 'Unavailable';
    const color = connected ? 'var(--accent-primary)' : 'var(--text-dim)';
    dot.style.background = color;
    dot.style.boxShadow = `0 0 10px ${color}`;

    const meta = document.getElementById('ga-cloud-meta');
    if (meta) {
      const bits = [];
      if (c.phoneNumberId) bits.push(`Phone number ID ${c.phoneNumberId}`);
      if (c.apiVersion) bits.push(c.apiVersion);
      bits.push('Invite-only · max 8 participants · business-owned');
      meta.textContent = bits.join(' • ');
    }

    for (const id of ['btn-cloud-create', 'btn-cloud-refresh']) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !connected;
    }
  }

  function renderStats() {
    const enabled = state.groups.filter((g) => g.enabled).length;
    const msgs = state.groups.reduce((sum, g) => sum + (g.stats?.messagesSeen || 0), 0);
    const replies = state.groups.reduce((sum, g) => sum + (g.stats?.aiReplies || 0), 0);
    const cases = state.groups.reduce((sum, g) => sum + (g.openModerationCases || 0), 0);
    setText('stat-ga-enabled', enabled);
    setText('stat-ga-total', `${state.groups.length} discovered`);
    setText('stat-ga-msgs', msgs);
    setText('stat-ga-replies', replies);
    setText('stat-ga-cases', cases);
    setText('ga-group-count', state.groups.length);
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  }

  function renderGroups() {
    const container = document.getElementById('group-list');
    if (!container) return;
    const query = (document.getElementById('group-search')?.value || '').trim().toLowerCase();
    const list = state.groups.filter(
      (g) =>
        !query ||
        String(g.name || '')
          .toLowerCase()
          .includes(query) ||
        g.jid.toLowerCase().includes(query)
    );

    if (list.length === 0) {
      container.innerHTML = `<div class="empty-state">${
        state.groups.length === 0
          ? 'No groups discovered. Connect WhatsApp and press “Refresh Groups”.'
          : 'No groups match your search.'
      }</div>`;
      return;
    }

    container.innerHTML = list
      .map((g) => {
        const name = g.name || g.jid;
        const initials = esc(
          name
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((s) => s[0])
            .join('')
            .toUpperCase() || 'G'
        );
        return `
          <div class="group-row ${g.jid === state.selectedJid ? 'active' : ''}" data-jid="${esc(g.jid)}">
            <div class="group-avatar">${initials}</div>
            <div class="group-meta">
              <strong>${esc(name)}</strong>
              <span>${esc(g.jid)}</span>
              <span>${g.enabled ? '🟢 Enabled' : '⚪ Disabled'} · ${g.stats?.messagesSeen || 0} msgs · ${
                g.openModerationCases || 0
              } open cases</span>
            </div>
            <label class="switch" title="${g.enabled ? 'Disable AI in this group' : 'Enable AI in this group'}">
              <input type="checkbox" data-toggle-group="${esc(g.jid)}" ${g.enabled ? 'checked' : ''}
                aria-label="${g.enabled ? 'Disable' : 'Enable'} AI in ${esc(name)}" />
              <span></span>
            </label>
          </div>`;
      })
      .join('');
  }

  function renderDetail() {
    const el = document.getElementById('group-detail');
    if (!el) return;
    const d = state.detail;
    if (!d) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">👈</div><p>Select a group to configure it.</p></div>`;
      return;
    }
    const g = d.group;
    const tabs = [
      ['settings', '⚙️ Settings'],
      ['memory', `🧠 Memory (${d.memory?.facts?.length || 0})`],
      ['activity', '💬 Activity'],
      ['moderation', `🛡️ Moderation (${d.moderation?.length || 0})`],
      ['reports', '📊 Reports'],
    ];
    if (g.transport === 'cloud') tabs.push(['cloud', '☁️ Cloud']);

    el.innerHTML = `
      <div class="detail-head">
        <div style="min-width:0">
          <div class="detail-title">${esc(g.name || g.jid)}</div>
          <div class="detail-jid">${esc(g.jid)}</div>
          <div class="detail-badges">
            <span class="badge-tag ${g.enabled ? 'badge-success' : 'badge-danger'}">${g.enabled ? 'AI ENABLED' : 'AI DISABLED'}</span>
            <span class="badge-tag badge-info">${esc(g.transport || 'personal')}</span>
            <span class="badge-tag">${esc(g.settings?.persona || 'professional')}</span>
            <span class="badge-tag">${esc(g.settings?.responseMode || 'mention')}</span>
          </div>
        </div>
        <label class="switch" title="Toggle group AI">
          <input type="checkbox" data-toggle-group="${esc(g.jid)}" ${g.enabled ? 'checked' : ''}
            aria-label="Enable AI in this group" />
          <span></span>
        </label>
      </div>
      <div class="detail-tabs">
        ${tabs
          .map(
            ([id, label]) =>
              `<button class="detail-tab ${state.tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`
          )
          .join('')}
      </div>
      <div id="group-tab-body">${renderTab(g, d)}</div>
    `;
  }

  function renderTab(g, d) {
    if (state.tab === 'memory') return renderMemoryTab(g, d);
    if (state.tab === 'activity') return renderActivityTab(g, d);
    if (state.tab === 'moderation') return renderModerationTab(g, d);
    if (state.tab === 'reports') return renderReportsTab(g, d);
    if (state.tab === 'cloud') return renderCloudTab(g);
    return renderSettingsTab(g, d);
  }

  function renderCloudTab(g) {
    const invite = state.cloudInvite;
    const requests = state.joinRequests || [];
    return `
      <h4 class="card-title" style="margin:0 0 10px">Invite link</h4>
      <div class="stat-sub">
        Participants join only through this link. Only the Cloud business number can be a group admin.
      </div>
      <div class="cloud-invite-box">
        ${
          invite?.inviteLink
            ? `<code>${esc(invite.inviteLink)}</code>`
            : '<span class="stat-sub">No invite link loaded.</span>'
        }
        <button class="btn btn-sm" data-action="cloud-invite">Load</button>
        <button class="btn btn-sm btn-danger" data-action="cloud-reset-invite">Reset link</button>
      </div>

      <h4 class="card-title" style="margin:22px 0 10px">Join requests</h4>
      <div class="stat-sub">Approval mode: ${esc(g.metadata?.joinApprovalMode || 'unknown')}</div>
      <div class="detail-actions" style="margin-top:10px">
        <button class="btn btn-sm" data-action="cloud-join-requests">Load requests</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>User</th><th>Request ID</th><th>Created</th><th>Controls</th></tr>
          </thead>
          <tbody>
            ${
              requests.length === 0
                ? '<tr><td colspan="4" class="empty-cell">No join requests loaded.</td></tr>'
                : requests
                    .map(
                      (r) => `<tr>
                        <td>${esc(r.username || r.waId || r.userId || 'Unknown')}</td>
                        <td><code>${esc(r.joinRequestId)}</code></td>
                        <td>${esc(r.createdAt || '—')}</td>
                        <td>
                          <button class="btn btn-sm btn-primary" data-action="cloud-approve" data-id="${esc(
                            r.joinRequestId
                          )}">Approve</button>
                          <button class="btn btn-sm btn-danger" data-action="cloud-reject" data-id="${esc(
                            r.joinRequestId
                          )}">Reject</button>
                        </td>
                      </tr>`
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    `;
  }

  function options(values, current) {
    return values
      .map((v) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`)
      .join('');
  }

  function renderSettingsTab(g, _d) {
    const s = g.settings || {};
    const m = s.moderation || {};
    const r = s.reports || {};
    const mem = s.memory || {};
    const models = s.models || {};
    return `
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label" for="gs-persona">Persona</label>
          <select class="form-select" id="gs-persona">
            ${options(['professional', 'friendly', 'concise', 'moderator', 'assistant', 'custom'], s.persona || 'professional')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-mode">Response mode</label>
          <select class="form-select" id="gs-mode">
            ${options(['mention', 'prefix', 'all', 'never'], s.responseMode || 'mention')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-prefix">Trigger prefix</label>
          <input class="form-input" id="gs-prefix" value="${esc(s.triggerPrefix || '/')}" maxlength="5" />
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-cooldown">Reply cooldown (seconds)</label>
          <input class="form-input" type="number" id="gs-cooldown" min="0" max="3600"
            value="${esc(Math.round((s.replyCooldownMs ?? 15000) / 1000))}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-maxhour">Max replies per hour</label>
          <input class="form-input" type="number" id="gs-maxhour" min="1" max="500" value="${esc(s.maxRepliesPerHour ?? 30)}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-maxchars">Max reply characters</label>
          <input class="form-input" type="number" id="gs-maxchars" min="200" max="3000" value="${esc(s.maxReplyChars ?? 1400)}" />
        </div>
      </div>

      <div class="form-group" style="margin-top:14px">
        <label class="form-label" for="gs-custom-persona">Custom persona (used when persona = custom)</label>
        <textarea class="form-textarea" id="gs-custom-persona" rows="2" maxlength="2000">${esc(s.customPersona || '')}</textarea>
      </div>

      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label"><input type="checkbox" id="gs-welcome" ${s.welcomeNewMembers ? 'checked' : ''} /> Welcome new members</label>
          <textarea class="form-textarea" id="gs-welcome-msg" rows="2" maxlength="1000"
            placeholder="Welcome to {{group}}, {{name}}!">${esc(s.welcomeMessage || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label"><input type="checkbox" id="gs-auto-memory" ${mem.autoCapture !== false ? 'checked' : ''} /> Auto-capture admin “remember:” notes</label>
          <label class="form-label" style="margin-top:10px"><input type="checkbox" id="gs-daily-summary" ${mem.summarizeDaily !== false ? 'checked' : ''} /> Daily conversation summary</label>
          <input class="form-input" type="number" id="gs-maxfacts" min="10" max="2000" value="${esc(mem.maxFacts ?? 200)}" />
          <div class="stat-sub">Max stored facts</div>
        </div>
      </div>

      <h4 class="card-title" style="margin:16px 0 10px">Moderation</h4>
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label"><input type="checkbox" id="gs-mod-enabled" ${m.enabled !== false ? 'checked' : ''} /> Enabled</label>
          <label class="form-label"><input type="checkbox" id="gs-mod-warn" ${m.warnEnabled !== false ? 'checked' : ''} /> Warnings allowed</label>
          <label class="form-label"><input type="checkbox" id="gs-mod-notify" ${m.notifyInGroup ? 'checked' : ''} /> Post warnings in group</label>
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-mod-action">Action for medium findings</label>
          <select class="form-select" id="gs-mod-action">${options(['escalate', 'warn'], m.action || 'escalate')}</select>
          <label class="form-label" style="margin-top:8px" for="gs-mod-repeat">Repeated-message threshold</label>
          <input class="form-input" type="number" id="gs-mod-repeat" min="2" max="20" value="${esc(m.repeatedMessageThreshold ?? 3)}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-mod-words">Banned words (comma separated)</label>
          <input class="form-input" id="gs-mod-words" value="${esc((m.bannedWords || []).join(', '))}" />
          <label class="form-label" style="margin-top:8px" for="gs-mod-domains">Blocked domains</label>
          <input class="form-input" id="gs-mod-domains" value="${esc((m.blockedDomains || []).join(', '))}" />
        </div>
      </div>

      <h4 class="card-title" style="margin:16px 0 10px">Reports</h4>
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label"><input type="checkbox" id="gs-report-daily" ${r.daily !== false ? 'checked' : ''} /> Daily report</label>
          <label class="form-label"><input type="checkbox" id="gs-report-weekly" ${r.weekly !== false ? 'checked' : ''} /> Weekly report (Monday)</label>
          <label class="form-label"><input type="checkbox" id="gs-report-send" ${r.sendToGroup ? 'checked' : ''} /> Send reports to group</label>
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-report-hour">Report hour (0–23)</label>
          <input class="form-input" type="number" id="gs-report-hour" min="0" max="23" value="${esc(r.hour ?? 21)}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="gs-report-tz">Timezone</label>
          <input class="form-input" id="gs-report-tz" value="${esc(r.timezone || 'Asia/Kolkata')}" />
        </div>
      </div>

      <h4 class="card-title" style="margin:16px 0 10px">Models per task</h4>
      <div class="stat-sub" style="margin-bottom:8px">
        Leave blank to use the provider default. Use <code>provider:model</code> for an explicit provider.
      </div>
      <div class="settings-grid">
        ${['chat', 'moderation', 'summary', 'report', 'memory']
          .map(
            (task) => `
          <div class="form-group">
            <label class="form-label" for="gs-model-${task}">${task}</label>
            <input class="form-input" id="gs-model-${task}" list="ga-model-options" value="${esc(models[task] || '')}"
              placeholder="e.g. gemini:gemini-2.5-flash" />
          </div>`
          )
          .join('')}
      </div>
      <datalist id="ga-model-options"></datalist>
      <div class="detail-actions">
        <button class="btn btn-sm" data-action="load-models">Load available models</button>
        <label class="form-label" style="display:flex;align-items:center;gap:6px;margin:0">
          <input type="checkbox" id="ga-free-only" /> Free models only (where supported)
        </label>
        <span class="stat-sub" id="ga-model-status"></span>
      </div>

      <div class="detail-actions">
        <button class="btn btn-primary" data-action="save-settings">Save settings</button>
        <button class="btn ${g.enabled ? 'btn-danger' : 'btn-primary'}" data-action="toggle-detail">
          ${g.enabled ? 'Disable AI in this group' : 'Enable AI in this group'}
        </button>
      </div>

      <h4 class="card-title" style="margin:22px 0 10px">High-impact administration</h4>
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label" for="ga-op-action">Action</label>
          <select class="form-select" id="ga-op-action">
            ${options(
              g.transport === 'cloud'
                ? ['remove_participant', 'set_subject', 'set_description']
                : ['remove_participant', 'promote_participant', 'demote_participant', 'set_subject', 'set_description'],
              'remove_participant'
            )}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="ga-op-target">Participant (phone or JID)</label>
          <input class="form-input" id="ga-op-target" placeholder="e.g. 9198…" />
        </div>
        <div class="form-group">
          <label class="form-label" for="ga-op-value">Subject / description value</label>
          <input class="form-input" id="ga-op-value" />
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn" data-action="request-op">Request human approval</button>
        <span class="stat-sub">Nothing is executed without approval and a verified bot-admin permission.</span>
      </div>
    `;
  }

  function renderMemoryTab(g, d) {
    const mem = d.memory || {};
    const rules = mem.rules || [];
    const facts = mem.facts || [];
    const faqs = mem.faqs || [];
    const summaries = mem.summaries || [];
    return `
      <div class="memory-block">
        <h4>Group rules (one per line)</h4>
        <textarea class="form-textarea" id="ga-rules" rows="4">${esc(rules.join('\n'))}</textarea>
        <div class="detail-actions"><button class="btn btn-sm btn-primary" data-action="save-rules">Save rules</button></div>
      </div>

      <div class="memory-block">
        <h4>Remembered facts (${facts.length})</h4>
        <div id="ga-facts">
          ${facts.length ? facts.map((f) => memoryItem(f.text, f.id, 'facts')).join('') : '<div class="stat-sub">No facts stored.</div>'}
        </div>
        <div class="settings-grid" style="margin-top:8px">
          <input class="form-input" id="ga-fact-text" placeholder="New fact…" />
          <input class="form-input" id="ga-fact-category" placeholder="Category (default: general)" />
        </div>
        <div class="detail-actions"><button class="btn btn-sm" data-action="add-fact">Add fact</button></div>
      </div>

      <div class="memory-block">
        <h4>FAQs (${faqs.length})</h4>
        <div>
          ${faqs.length ? faqs.map((f) => memoryItem(`Q: ${f.question}\nA: ${f.answer}`, f.id, 'faqs')).join('') : '<div class="stat-sub">No FAQs stored.</div>'}
        </div>
        <div class="settings-grid" style="margin-top:8px">
          <input class="form-input" id="ga-faq-q" placeholder="Question…" />
          <input class="form-input" id="ga-faq-a" placeholder="Answer…" />
        </div>
        <div class="detail-actions"><button class="btn btn-sm" data-action="add-faq">Add FAQ</button></div>
      </div>

      <div class="memory-block">
        <h4>Summaries (${summaries.length})</h4>
        ${summaries.length ? summaries.map((s) => memoryItem(s.text, s.id, 'summaries')).join('') : '<div class="stat-sub">No summaries stored.</div>'}
      </div>

      <div class="detail-actions">
        <button class="btn btn-danger" data-action="clear-memory">Delete this group’s memory</button>
        <button class="btn btn-danger" data-action="delete-data">Delete all stored group data</button>
        <span class="stat-sub">Isolated to <code>${esc(g.jid)}</code>. Other groups are untouched.</span>
      </div>
    `;
  }

  function memoryItem(text, id, type) {
    return `<div class="memory-item"><span>${esc(text).replace(/\n/g, '<br/>')}</span>
      <button class="btn btn-sm btn-danger" data-action="delete-memory" data-type="${type}" data-id="${esc(id)}">✕</button></div>`;
  }

  function renderActivityTab(_g, d) {
    const turns = d.conversation || [];
    return `
      <div class="detail-actions" style="margin-top:0">
        <button class="btn btn-sm" data-action="summarize">Summarize now</button>
        <button class="btn btn-sm" data-action="report" data-period="daily">Daily report</button>
        <button class="btn btn-sm" data-action="report" data-period="weekly">Weekly report</button>
      </div>
      <div id="ga-report-output">${state.reportText ? `<pre class="activity-item">${esc(state.reportText)}</pre>` : ''}</div>

      <div class="memory-block" style="margin-top:14px">
        <h4>Announcement</h4>
        <div class="settings-grid">
          <input class="form-input" id="ga-announce-topic" placeholder="Announcement topic…" />
        </div>
        <div class="detail-actions">
          <button class="btn btn-sm" data-action="draft-announcement">Draft</button>
        </div>
        <textarea class="form-textarea" id="ga-announce-draft" rows="3" placeholder="Draft appears here…">${esc(state.announcementDraft)}</textarea>
        <div class="detail-actions">
          <button class="btn btn-sm btn-primary" data-action="send-announcement">Send as human operator</button>
          <span class="stat-sub">AI-requested announcements require approval; this button is your explicit human action.</span>
        </div>
      </div>

      <h4 class="card-title" style="margin:16px 0 10px">Recent conversation (RAM only)</h4>
      ${
        turns.length
          ? turns
              .slice()
              .reverse()
              .map(
                (t) => `<div class="activity-item ${t.role === 'assistant' ? 'assistant' : ''}">
                  <div class="activity-meta">${t.role === 'assistant' ? 'AI' : esc(t.senderJid || 'member')} · ${esc(timeAgo(t.at))}</div>
                  ${esc(t.text).replace(/\n/g, '<br/>')}
                </div>`
              )
              .join('')
          : '<div class="stat-sub">No conversation context yet. History is bounded and expires.</div>'
      }
    `;
  }

  function renderModerationTab(_g, d) {
    const events = d.moderation || [];
    if (!events.length) return `<div class="empty-state">No moderation events recorded.</div>`;
    return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>When</th><th>Severity</th><th>Categories</th><th>Action</th><th>Status</th><th>Controls</th></tr></thead>
          <tbody>
            ${events
              .map(
                (e) => `<tr>
                  <td>${esc(timeAgo(e.createdAt))}</td>
                  <td><span class="badge-tag ${e.severity === 'high' ? 'badge-danger' : 'badge-warning'}">${esc(e.severity)}</span></td>
                  <td>${esc((e.categories || []).join(', '))}<div class="stat-sub">${esc((e.reasons || []).join('; '))}</div></td>
                  <td>${esc(e.action)}</td>
                  <td>${esc(e.status)}</td>
                  <td>
                    <button class="btn btn-sm" data-action="resolve-case" data-id="${esc(e.id)}" data-status="resolved">Resolve</button>
                    <button class="btn btn-sm" data-action="resolve-case" data-id="${esc(e.id)}" data-status="dismissed">Dismiss</button>
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderReportsTab(g, d) {
    const a = d.analytics || {};
    const totals = a.totals || {};
    const daily = a.daily || [];
    const max = Math.max(1, ...daily.map((x) => x.messagesSeen || 0));
    return `
      <div class="settings-grid">
        ${[
          ['Messages seen', totals.messagesSeen || 0],
          ['AI replies', totals.aiReplies || 0],
          ['Moderation events', totals.moderationEvents || 0],
          ['Warnings', totals.warnings || 0],
          ['Escalations', totals.escalations || 0],
          ['New members', totals.memberJoins || 0],
          ['Summaries', totals.summaries || 0],
          ['Prompt tokens', totals.promptTokens || 0],
        ]
          .map(
            ([label, value]) =>
              `<div class="glass-panel stat-card"><div class="stat-label">${label}</div><div class="stat-val">${esc(
                value
              )}</div><div class="stat-sub">Last 7 days</div></div>`
          )
          .join('')}
      </div>
      <div class="memory-block" style="margin-top:16px">
        <h4>Daily message volume</h4>
        ${
          daily.length
            ? daily
                .map(
                  (day) => `<div class="activity-item">
                    <div class="activity-meta">${esc(day.date)}</div>
                    <div style="height:8px;border-radius:4px;background:rgba(16,185,129,0.25);width:${Math.max(
                      4,
                      Math.round(((day.messagesSeen || 0) / max) * 100)
                    )}%"></div>
                    <div class="stat-sub">${day.messagesSeen || 0} messages · ${day.aiReplies || 0} AI replies</div>
                  </div>`
                )
                .join('')
            : '<div class="stat-sub">No analytics for this period.</div>'
        }
      </div>
      <div class="detail-actions">
        <button class="btn btn-sm" data-action="report" data-period="daily">Generate daily report</button>
        <button class="btn btn-sm" data-action="report" data-period="weekly">Generate weekly report</button>
      </div>
      <div class="stat-sub">Group: ${esc(g.name || g.jid)}</div>
    `;
  }

  function renderApprovals() {
    const body = document.getElementById('group-approvals-body');
    if (!body) return;
    const approvals = state.approvals || [];
    setText('ga-approval-count', approvals.length);
    if (approvals.length === 0) {
      body.innerHTML = `<tr><td colspan="6" class="empty-cell">No pending approvals.</td></tr>`;
      return;
    }
    body.innerHTML = approvals
      .map(
        (a) => `<tr>
          <td>${esc(timeAgo(a.createdAt))}</td>
          <td>${esc(groupName(a.groupJid))}</td>
          <td>${esc(a.type)}</td>
          <td>${esc(a.reason || '—')}</td>
          <td><span class="badge-tag ${a.expired ? 'badge-danger' : 'badge-warning'}">${a.expired ? 'expired' : esc(a.status)}</span></td>
          <td>
            <button class="btn btn-sm btn-primary" data-approval="${esc(a.id)}" data-approve="true" ${a.expired ? 'disabled' : ''}>Approve</button>
            <button class="btn btn-sm btn-danger" data-approval="${esc(a.id)}" data-approve="false">Reject</button>
          </td>
        </tr>`
      )
      .join('');
  }

  function renderAudit() {
    const body = document.getElementById('group-audit-body');
    if (!body) return;
    const entries = state.audit || [];
    if (entries.length === 0) {
      body.innerHTML = `<tr><td colspan="5" class="empty-cell">No audit entries.</td></tr>`;
      return;
    }
    body.innerHTML = entries
      .map(
        (e) => `<tr>
          <td>${esc(timeAgo(e.at))}</td>
          <td>${esc(e.actor)}</td>
          <td>${esc(e.action)}</td>
          <td>${esc(e.groupJid ? groupName(e.groupJid) : '—')}</td>
          <td><span class="badge-tag ${e.outcome === 'success' ? 'badge-success' : e.outcome === 'denied' ? 'badge-danger' : 'badge-warning'}">${esc(e.outcome)}</span></td>
        </tr>`
      )
      .join('');
  }

  /* ------------------------------- actions ------------------------------- */

  async function toggleGroup(jid, enabled) {
    try {
      await api(`/${encodeURIComponent(jid)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: {} });
      toast(enabled ? 'Group enabled.' : 'Group disabled. AI processing stopped.', 'success');
      await loadGroups();
      if (state.selectedJid === jid) await loadDetail(jid);
    } catch (err) {
      toast(err.message, 'error');
      await loadGroups();
    }
  }

  function readSettingsFromForm() {
    const val = (id) => document.getElementById(id);
    const num = (id, fallback) => {
      const n = Number(val(id)?.value);
      return Number.isFinite(n) ? n : fallback;
    };
    const csv = (id) =>
      String(val(id)?.value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      persona: val('gs-persona')?.value,
      customPersona: val('gs-custom-persona')?.value,
      responseMode: val('gs-mode')?.value,
      triggerPrefix: val('gs-prefix')?.value,
      replyCooldownMs: num('gs-cooldown', 15) * 1000,
      maxRepliesPerHour: num('gs-maxhour', 30),
      maxReplyChars: num('gs-maxchars', 1400),
      welcomeNewMembers: Boolean(val('gs-welcome')?.checked),
      welcomeMessage: val('gs-welcome-msg')?.value,
      memory: {
        autoCapture: Boolean(val('gs-auto-memory')?.checked),
        summarizeDaily: Boolean(val('gs-daily-summary')?.checked),
        maxFacts: num('gs-maxfacts', 200),
      },
      moderation: {
        enabled: Boolean(val('gs-mod-enabled')?.checked),
        warnEnabled: Boolean(val('gs-mod-warn')?.checked),
        notifyInGroup: Boolean(val('gs-mod-notify')?.checked),
        action: val('gs-mod-action')?.value,
        repeatedMessageThreshold: num('gs-mod-repeat', 3),
        bannedWords: csv('gs-mod-words'),
        blockedDomains: csv('gs-mod-domains'),
      },
      reports: {
        daily: Boolean(val('gs-report-daily')?.checked),
        weekly: Boolean(val('gs-report-weekly')?.checked),
        sendToGroup: Boolean(val('gs-report-send')?.checked),
        hour: num('gs-report-hour', 21),
        timezone: val('gs-report-tz')?.value,
      },
      models: {
        chat: val('gs-model-chat')?.value || '',
        moderation: val('gs-model-moderation')?.value || '',
        summary: val('gs-model-summary')?.value || '',
        report: val('gs-model-report')?.value || '',
        memory: val('gs-model-memory')?.value || '',
      },
    };
  }

  async function saveSettings() {
    if (!state.selectedJid) return;
    try {
      await api(`/${encodeURIComponent(state.selectedJid)}/settings`, {
        method: 'PATCH',
        body: readSettingsFromForm(),
      });
      toast('Group settings saved.', 'success');
      await loadDetail(state.selectedJid);
      await loadGroups();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function actionHandler(action, target) {
    const jid = state.selectedJid;
    try {
      if (action === 'save-settings') return await saveSettings();
      if (action === 'cloud-invite') {
        const data = await api(`/${encodeURIComponent(jid)}/invite-link`);
        state.cloudInvite = data;
        state.tab = 'cloud';
        renderDetail();
        toast(
          data.inviteLink ? 'Invite link loaded.' : 'No invite link returned.',
          data.inviteLink ? 'success' : 'info'
        );
        return;
      }
      if (action === 'cloud-reset-invite') {
        if (!confirm('Reset the invite link? Every previous link stops working immediately.')) return;
        const data = await api(`/${encodeURIComponent(jid)}/invite-link/reset`, { method: 'POST', body: {} });
        state.cloudInvite = data;
        state.tab = 'cloud';
        renderDetail();
        toast('Invite link reset.', 'success');
        return;
      }
      if (action === 'cloud-join-requests') {
        const data = await api(`/${encodeURIComponent(jid)}/join-requests`);
        state.joinRequests = data.requests || [];
        state.tab = 'cloud';
        renderDetail();
        toast(`${state.joinRequests.length} join request(s) loaded.`, 'info');
        return;
      }
      if (action === 'cloud-approve' || action === 'cloud-reject') {
        const approve = action === 'cloud-approve';
        const ids = [target?.dataset?.id].filter(Boolean);
        if (!ids.length) return;
        if (!approve && !confirm('Reject this join request?')) return;
        await api(`/${encodeURIComponent(jid)}/join-requests`, { method: 'POST', body: { approve, ids } });
        toast(approve ? 'Join request approved.' : 'Join request rejected.', 'success');
        const data = await api(`/${encodeURIComponent(jid)}/join-requests`);
        state.joinRequests = data.requests || [];
        state.tab = 'cloud';
        return renderDetail();
      }
      if (action === 'toggle-detail') {
        const group = state.detail?.group;
        return await toggleGroup(jid, !group?.enabled);
      }
      if (action === 'load-models') {
        const freeOnly = Boolean(document.getElementById('ga-free-only')?.checked);
        const statusEl = document.getElementById('ga-model-status');
        if (statusEl) statusEl.textContent = 'Loading…';
        const data = await api(`/providers?refresh=true&freeOnly=${freeOnly ? 'true' : 'false'}`);
        state.providers = data;
        const list = document.getElementById('ga-model-options');
        if (list) {
          const seen = new Set();
          list.innerHTML = (data.providers || [])
            .flatMap((p) =>
              (p.models || []).map((m) => {
                const value = `${p.provider}:${m.id}`;
                if (seen.has(value)) return '';
                seen.add(value);
                return `<option value="${esc(value)}">${esc(m.label || m.id)}</option>`;
              })
            )
            .join('');
        }
        if (statusEl) {
          const count = (data.providers || []).reduce((n, p) => n + (p.models || []).length, 0);
          const errors = (data.providers || []).filter((p) => p.error).length;
          statusEl.textContent = `${count} models loaded${errors ? `, ${errors} provider(s) unavailable` : ''}`;
        }
        return;
      }
      if (action === 'request-op') {
        const body = {
          action: document.getElementById('ga-op-action')?.value,
          targetJid: document.getElementById('ga-op-target')?.value,
          value: document.getElementById('ga-op-value')?.value,
        };
        const data = await api(`/${encodeURIComponent(jid)}/operations`, { method: 'POST', body });
        toast(`Queued for approval (${data.approvalId}). Nothing changed yet.`, 'success');
        await loadApprovals();
        return;
      }
      if (action === 'save-rules') {
        const rules = String(document.getElementById('ga-rules')?.value || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        await api(`/${encodeURIComponent(jid)}/memory/rules`, { method: 'PUT', body: { rules } });
        toast('Group rules saved.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'add-fact') {
        const text = document.getElementById('ga-fact-text')?.value;
        const category = document.getElementById('ga-fact-category')?.value;
        await api(`/${encodeURIComponent(jid)}/memory/facts`, { method: 'POST', body: { text, category } });
        toast('Fact stored for this group.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'add-faq') {
        await api(`/${encodeURIComponent(jid)}/memory/faqs`, {
          method: 'POST',
          body: {
            question: document.getElementById('ga-faq-q')?.value,
            answer: document.getElementById('ga-faq-a')?.value,
          },
        });
        toast('FAQ stored for this group.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'delete-memory') {
        const type = target.dataset.type;
        const id = target.dataset.id;
        if (!confirm('Delete this memory item?')) return;
        await api(`/${encodeURIComponent(jid)}/memory/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        toast('Memory item deleted.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'clear-memory') {
        if (!confirm('Delete ALL memory for this group? Other groups are unaffected.')) return;
        await api(`/${encodeURIComponent(jid)}/memory`, { method: 'DELETE' });
        toast('Group memory deleted.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'delete-data') {
        if (!confirm('Delete memory, moderation history, analytics and conversation context for this group?')) return;
        await api(`/${encodeURIComponent(jid)}/data`, { method: 'DELETE' });
        toast('Stored group data deleted.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'resolve-case') {
        await api(`/moderation/${encodeURIComponent(target.dataset.id)}/resolve`, {
          method: 'POST',
          body: { status: target.dataset.status },
        });
        toast('Case updated.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'summarize') {
        const data = await api(`/${encodeURIComponent(jid)}/summarize`, { method: 'POST', body: {} });
        toast(data.summary?.text ? 'Summary stored.' : 'Not enough conversation to summarize.', 'success');
        return await loadDetail(jid);
      }
      if (action === 'report') {
        const period = target.dataset.period || 'daily';
        const data = await api(`/${encodeURIComponent(jid)}/report`, { method: 'POST', body: { period, send: false } });
        state.reportText = data.report?.text || '';
        toast('Report generated.', 'success');
        return renderDetail();
      }
      if (action === 'draft-announcement') {
        const topic = document.getElementById('ga-announce-topic')?.value;
        const data = await api(`/${encodeURIComponent(jid)}/announcement`, { method: 'POST', body: { topic } });
        state.announcementDraft = data.draft || '';
        if (data.status === 'pending_approval') {
          toast(`Announcement queued for approval (${data.approvalId}).`, 'info');
          await loadApprovals();
        }
        return renderDetail();
      }
      if (action === 'send-announcement') {
        const text = document.getElementById('ga-announce-draft')?.value;
        if (!text?.trim()) return toast('Draft is empty.', 'error');
        if (!confirm('Send this message to the group now?')) return;
        await api(`/${encodeURIComponent(jid)}/announcement/send`, { method: 'POST', body: { text } });
        toast('Announcement sent.', 'success');
        state.announcementDraft = '';
        return await loadDetail(jid);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ------------------------------- events -------------------------------- */

  function bind() {
    document.getElementById('group-search')?.addEventListener('input', renderGroups);

    document.getElementById('group-list')?.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-toggle-group]');
      if (toggle) {
        event.stopPropagation();
        toggleGroup(toggle.getAttribute('data-toggle-group'), toggle.checked);
        return;
      }
      const row = event.target.closest('.group-row');
      if (row) loadDetail(row.getAttribute('data-jid')).catch((err) => toast(err.message, 'error'));
    });

    const detail = document.getElementById('group-detail');
    detail?.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (tab) {
        state.tab = tab.getAttribute('data-tab');
        return renderDetail();
      }
      const actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        event.preventDefault();
        actionHandler(actionEl.getAttribute('data-action'), actionEl);
      }
    });
    detail?.addEventListener('change', (event) => {
      const toggle = event.target.closest('[data-toggle-group]');
      if (toggle) toggleGroup(toggle.getAttribute('data-toggle-group'), toggle.checked);
    });

    document.getElementById('btn-emergency-stop')?.addEventListener('click', async () => {
      const paused = state.status?.global?.aiPaused === true;
      if (!paused && !confirm('Pause ALL group AI processing immediately?')) return;
      try {
        await api('/emergency-stop', { method: 'POST', body: { paused: !paused } });
        toast(!paused ? 'All group AI paused.' : 'Group AI resumed.', 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('btn-wa-connect')?.addEventListener('click', async () => {
      try {
        await api('/personal/connect', { method: 'POST', body: {} });
        toast('Connection started. Scan the QR if it appears.', 'info');
        await loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('btn-wa-refresh')?.addEventListener('click', async () => {
      try {
        await api('/discover', { method: 'POST', body: {} });
        await loadGroups();
        toast('Group list refreshed. New groups remain disabled.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('btn-wa-logout')?.addEventListener('click', async () => {
      if (!confirm('Log out of the personal WhatsApp session?')) return;
      try {
        await api('/personal/logout', { method: 'POST', body: {} });
        toast('Session logged out.', 'success');
        await loadStatus();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('btn-cloud-refresh')?.addEventListener('click', async () => {
      try {
        const data = await api('/cloud/discover', { method: 'POST', body: {} });
        await loadGroups();
        toast(`Cloud sync complete. ${data.discovered?.discovered || 0} new group(s) registered disabled.`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('btn-cloud-create')?.addEventListener('click', async () => {
      const subject = document.getElementById('cloud-subject')?.value.trim();
      const description = document.getElementById('cloud-description')?.value.trim();
      const joinApprovalMode = document.getElementById('cloud-approval')?.value;
      if (!subject) return toast('Group subject is required.', 'error');
      if (!confirm(`Create Cloud API group “${subject}”? It will be registered disabled.`)) return;
      try {
        const data = await api('/cloud/create', {
          method: 'POST',
          body: { subject, description, joinApprovalMode },
        });
        document.getElementById('cloud-subject').value = '';
        document.getElementById('cloud-description').value = '';
        await loadGroups();
        if (data.groupJid) await loadDetail(data.groupJid);
        toast(
          data.pendingConfirmation
            ? 'Group creation requested. It appears once the lifecycle webhook arrives.'
            : 'Group created and registered disabled.',
          'success'
        );
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('group-approvals-body')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-approval]');
      if (!btn) return;
      const approved = btn.getAttribute('data-approve') === 'true';
      if (!approved && !confirm('Reject this request?')) return;
      try {
        const data = await api(`/approvals/${encodeURIComponent(btn.getAttribute('data-approval'))}/resolve`, {
          method: 'POST',
          body: { approved },
        });
        if (approved && data.executed === false) {
          toast(`Approved but not executed: ${data.result?.reason || data.reason || 'verification failed'}`, 'error');
        } else {
          toast(approved ? 'Approved and executed with verification.' : 'Request rejected.', 'success');
        }
        await Promise.all([loadApprovals(), loadAudit()]);
        if (state.selectedJid) await loadDetail(state.selectedJid);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    document.getElementById('btn-refresh-audit')?.addEventListener('click', () => loadAudit());
  }

  function shouldAutoLoad() {
    if (document.visibilityState !== 'visible') return false;
    const view = document.getElementById('view-groups');
    if (!view || !view.classList.contains('active')) return false;
    return true;
  }

  bind();

  window.GroupAdminDashboard = {
    load: () => {
      if (shouldAutoLoad()) load();
    },
  };
})();
