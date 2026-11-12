/* global document, localStorage, confirm */
/**
 * Mission Control - Personal AI Dashboard Application Logic
 * Pure ES6+, Zero External Dependencies
 */

(function () {
  'use strict';

  // Application State
  const state = {
    activeView: 'overview',
    token: localStorage.getItem('ops_token') || '',
    refreshTimer: null,
    cachedMemoryFacts: [],
    cachedKnowledgeDocs: [],
  };

  const API_BASE = '/dashboard/api';

  // =========================================================================
  // TOAST NOTIFICATIONS
  // =========================================================================
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // =========================================================================
  // API CLIENT
  // =========================================================================
  async function apiFetch(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers,
      });

      if (res.status === 401) {
        showToast('Unauthorized: OPS_TOKEN required or invalid.', 'error');
        openModal('modal-auth');
        throw new Error('Unauthorized');
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP error ${res.status}`);
      }
      return data;
    } catch (err) {
      if (err.message !== 'Unauthorized') {
        showToast(err.message, 'error');
      }
      throw err;
    }
  }

  // =========================================================================
  // MODAL MANAGEMENT
  // =========================================================================
  function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('active');
  }

  function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('active');
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const modalId = e.currentTarget.getAttribute('data-close');
      closeModal(modalId);
    });
  });

  // Close modal when clicking on overlay background
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
      }
    });
  });

  // =========================================================================
  // NAVIGATION
  // =========================================================================
  function switchView(viewName) {
    state.activeView = viewName;

    document.querySelectorAll('.nav-item').forEach((item) => {
      if (item.getAttribute('data-view') === viewName) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    document.querySelectorAll('.view-section').forEach((sec) => {
      if (sec.id === `view-${viewName}`) {
        sec.classList.add('active');
      } else {
        sec.classList.remove('active');
      }
    });

    loadActiveView();
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const view = item.getAttribute('data-view');
      switchView(view);
    });
  });

  // Quick Action Buttons on Overview View
  document.getElementById('btn-quick-new-fact')?.addEventListener('click', () => {
    document.getElementById('modal-fact-title').textContent = '🧠 Add Knowledge Fact';
    document.getElementById('fact-edit-id').value = '';
    document.getElementById('fact-input-category').value = '';
    document.getElementById('fact-input-text').value = '';
    openModal('modal-fact');
  });

  document.getElementById('btn-quick-new-doc')?.addEventListener('click', () => {
    openModal('modal-doc');
  });

  document.getElementById('btn-quick-new-job')?.addEventListener('click', () => {
    openModal('modal-job');
  });

  document.getElementById('btn-quick-switch-model')?.addEventListener('click', () => {
    switchView('models');
  });

  // =========================================================================
  // VIEW LOADERS
  // =========================================================================

  function loadActiveView() {
    switch (state.activeView) {
      case 'overview':
        loadOverview();
        break;
      case 'memory':
        loadMemory();
        break;
      case 'knowledge':
        loadKnowledge();
        break;
      case 'agents':
        loadAgents();
        break;
      case 'jobs':
        loadJobs();
        break;
      case 'models':
        loadModels();
        break;
      case 'security':
        loadSecurity();
        break;
      case 'settings':
        loadSettings();
        break;
    }
  }

  // 1. OVERVIEW
  async function loadOverview() {
    try {
      const data = await apiFetch('/overview');
      document.getElementById('stat-uptime').textContent = data.uptimeFormatted || '--';
      document.getElementById('stat-model').textContent = data.model?.active || '--';
      document.getElementById('stat-model-strategy').textContent = `Strategy: ${data.model?.strategy || 'Balanced'}`;
      document.getElementById('stat-queue-pending').textContent = data.messageCounts?.queuePending || '0';
      document.getElementById('stat-queue-active').textContent =
        `Active in flight: ${data.messageCounts?.queueActive || '0'}`;
      document.getElementById('stat-jobs-running').textContent = data.activeJobs?.running || '0';
      document.getElementById('stat-jobs-total').textContent = `${data.activeJobs?.queued || '0'} queued tasks`;
      document.getElementById('stat-ram').textContent = `${data.memory?.rssMb || 0} MB`;
      document.getElementById('stat-heap').textContent = `Heap: ${data.memory?.heapUsedMb || 0} MB`;

      const sessionBadge = document.getElementById('vital-sessions');
      if (sessionBadge) {
        sessionBadge.textContent = `${data.messageCounts?.activeSessions || 0} Active Sessions`;
      }
    } catch {
      // Handled in apiFetch
    }
  }

  // 2. SEMANTIC MEMORY
  async function loadMemory() {
    try {
      const data = await apiFetch('/memory');
      state.cachedMemoryFacts = data.facts || [];

      // Populate Category filter
      const catSelect = document.getElementById('memory-category-filter');
      if (catSelect) {
        const currentVal = catSelect.value;
        catSelect.innerHTML = '<option value="">All Categories</option>';
        (data.categories || []).forEach((c) => {
          const opt = document.createElement('option');
          opt.value = c;
          opt.textContent = c;
          if (c === currentVal) opt.selected = true;
          catSelect.appendChild(opt);
        });
      }

      renderMemoryTable();
    } catch {
      // Handled in apiFetch
    }
  }

  function renderMemoryTable() {
    const tbody = document.getElementById('memory-table-body');
    if (!tbody) return;

    const q = (document.getElementById('memory-search-input')?.value || '').toLowerCase().trim();
    const cat = document.getElementById('memory-category-filter')?.value || '';

    let facts = state.cachedMemoryFacts;
    if (cat) facts = facts.filter((f) => f.category === cat);
    if (q) facts = facts.filter((f) => f.fact.toLowerCase().includes(q) || f.category.toLowerCase().includes(q));

    if (facts.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 30px;">No facts found.</td></tr>';
      return;
    }

    tbody.innerHTML = facts
      .map(
        (f) => `
      <tr>
        <td><span class="badge-tag badge-info">${escapeHtml(f.category)}</span></td>
        <td style="max-width: 420px; font-weight: 500;">${escapeHtml(f.fact)}</td>
        <td><span class="badge-tag ${f.confidence >= 0.9 ? 'badge-success' : 'badge-warning'}">${Math.round((f.confidence || 0.95) * 100)}%</span></td>
        <td><span style="font-size: 0.75rem; color: var(--text-dim); font-family: var(--font-mono);">${escapeHtml(f.source || 'user')}</span></td>
        <td style="font-size: 0.75rem; color: var(--text-muted);">${new Date(f.updatedAt || f.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td style="text-align: right;">
          <button class="btn btn-sm btn-edit-fact" data-id="${f.id}" style="margin-right: 6px;">✏️</button>
          <button class="btn btn-sm btn-danger btn-del-fact" data-id="${f.id}">🗑️</button>
        </td>
      </tr>
    `
      )
      .join('');

    // Attach row action listeners
    tbody.querySelectorAll('.btn-del-fact').forEach((b) => {
      b.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (confirm('Delete this knowledge fact?')) {
          try {
            await apiFetch(`/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            showToast('Fact deleted successfully.', 'success');
            loadMemory();
          } catch {}
        }
      });
    });

    tbody.querySelectorAll('.btn-edit-fact').forEach((b) => {
      b.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const f = state.cachedMemoryFacts.find((x) => x.id === id);
        if (f) {
          document.getElementById('modal-fact-title').textContent = '✏️ Edit Knowledge Fact';
          document.getElementById('fact-edit-id').value = f.id;
          document.getElementById('fact-input-category').value = f.category;
          document.getElementById('fact-input-text').value = f.fact;
          document.getElementById('fact-input-confidence').value = f.confidence || 0.95;
          openModal('modal-fact');
        }
      });
    });
  }

  document.getElementById('memory-search-input')?.addEventListener('input', renderMemoryTable);
  document.getElementById('memory-category-filter')?.addEventListener('change', renderMemoryTable);

  document.getElementById('btn-open-fact-modal')?.addEventListener('click', () => {
    document.getElementById('modal-fact-title').textContent = '🧠 Add Knowledge Fact';
    document.getElementById('fact-edit-id').value = '';
    document.getElementById('fact-input-category').value = '';
    document.getElementById('fact-input-text').value = '';
    openModal('modal-fact');
  });

  document.getElementById('btn-save-fact')?.addEventListener('click', async () => {
    const id = document.getElementById('fact-edit-id').value;
    const category = document.getElementById('fact-input-category').value;
    const fact = document.getElementById('fact-input-text').value;
    const confidence = parseFloat(document.getElementById('fact-input-confidence').value) || 0.95;

    if (!fact.trim()) {
      showToast('Fact text cannot be empty.', 'error');
      return;
    }

    try {
      await apiFetch('/memory', {
        method: 'POST',
        body: JSON.stringify({ id: id || undefined, category, fact, confidence }),
      });
      showToast('Memory fact saved successfully!', 'success');
      closeModal('modal-fact');
      loadMemory();
    } catch {}
  });

  document.getElementById('btn-clear-memory')?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear ALL knowledge facts?')) {
      try {
        await apiFetch('/memory?clear=true', { method: 'DELETE' });
        showToast('All knowledge facts cleared.', 'info');
        loadMemory();
      } catch {}
    }
  });

  // 3. KNOWLEDGE BASE
  async function loadKnowledge() {
    try {
      const data = await apiFetch('/knowledge');
      state.cachedKnowledgeDocs = data.documents || [];
      renderKnowledgeGrid();
    } catch {}
  }

  function renderKnowledgeGrid() {
    const container = document.getElementById('knowledge-docs-grid');
    if (!container) return;

    const q = (document.getElementById('knowledge-search-input')?.value || '').toLowerCase().trim();
    let docs = state.cachedKnowledgeDocs;
    if (q) {
      docs = docs.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.snippet.toLowerCase().includes(q) ||
          (d.tags && d.tags.some((t) => t.toLowerCase().includes(q)))
      );
    }

    if (docs.length === 0) {
      container.innerHTML =
        '<div style="grid-column: 1/-1; text-align: center; color: var(--text-dim); padding: 40px;">No indexed documents found. Click "+ Index New Document" to add reference material.</div>';
      return;
    }

    container.innerHTML = docs
      .map(
        (d) => `
      <div class="glass-panel card-box">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
          <h4 style="font-size: 1.05rem; font-weight: 600;">${escapeHtml(d.title)}</h4>
          <span class="badge-tag badge-info">${escapeHtml(d.category)}</span>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; margin-bottom: 14px;">
          ${escapeHtml(d.snippet)}
        </p>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;">
          <span class="badge-tag">${d.chunkCount} chunks</span>
          <span class="badge-tag">${d.charCount} chars</span>
          ${(d.tags || []).map((t) => `<span class="badge-tag" style="color: var(--accent-cyan);">#${escapeHtml(t)}</span>`).join('')}
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button class="btn btn-sm btn-danger btn-del-doc" data-id="${d.id}">Delete Document</button>
        </div>
      </div>
    `
      )
      .join('');

    container.querySelectorAll('.btn-del-doc').forEach((b) => {
      b.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        if (confirm('Delete this indexed document and its chunks?')) {
          try {
            await apiFetch(`/knowledge?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            showToast('Document deleted.', 'success');
            loadKnowledge();
          } catch {}
        }
      });
    });
  }

  document.getElementById('knowledge-search-input')?.addEventListener('input', renderKnowledgeGrid);

  document.getElementById('btn-open-doc-modal')?.addEventListener('click', () => {
    openModal('modal-doc');
  });

  document.getElementById('btn-save-doc')?.addEventListener('click', async () => {
    const title = document.getElementById('doc-input-title').value;
    const category = document.getElementById('doc-input-category').value;
    const tags = document
      .getElementById('doc-input-tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const content = document.getElementById('doc-input-content').value;

    if (!title.trim() || !content.trim()) {
      showToast('Document title and content are required.', 'error');
      return;
    }

    try {
      await apiFetch('/knowledge', {
        method: 'POST',
        body: JSON.stringify({ title, category, tags, content }),
      });
      showToast('Document indexed and chunked successfully!', 'success');
      closeModal('modal-doc');
      loadKnowledge();
    } catch {}
  });

  // 4. MULTI-AGENT SWARM
  async function loadAgents() {
    try {
      const data = await apiFetch('/agents');
      const container = document.getElementById('agents-cards-grid');
      if (!container) return;

      container.innerHTML = (data.agents || [])
        .map(
          (a) => `
        <div class="glass-panel card-box">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h4 style="font-size: 1.1rem; font-weight: 600;">${escapeHtml(a.name)}</h4>
            <span class="badge-tag ${a.status === 'active' ? 'badge-success' : 'badge-danger'}">${a.status.toUpperCase()}</span>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 16px; min-height: 38px;">
            ${escapeHtml(a.description)}
          </p>
          <div style="border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-bottom: 14px;">
            <div style="font-size: 0.78rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px;">Permissions</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.8rem;">
              <label><input type="checkbox" data-agent="${a.id}" data-perm="allowWebSearch" ${a.permissions?.allowWebSearch ? 'checked' : ''}> Web Search</label>
              <label><input type="checkbox" data-agent="${a.id}" data-perm="allowCodeExecution" ${a.permissions?.allowCodeExecution ? 'checked' : ''}> Code Exec</label>
              <label><input type="checkbox" data-agent="${a.id}" data-perm="allowFileAccess" ${a.permissions?.allowFileAccess ? 'checked' : ''}> File Access</label>
              <label><input type="checkbox" data-agent="${a.id}" data-perm="allowToolDispatch" ${a.permissions?.allowToolDispatch ? 'checked' : ''}> Tool Dispatch</label>
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; color: var(--text-muted);">
            <span>Model: <code style="color: var(--accent-cyan);">${escapeHtml(a.modelPreference)}</code></span>
            <span>Max Hops: <b>${a.maxHops}</b></span>
          </div>
          <div style="margin-top: 16px; display: flex; justify-content: flex-end;">
            <button class="btn btn-sm btn-primary btn-save-agent" data-id="${a.id}">Save Configuration</button>
          </div>
        </div>
      `
        )
        .join('');

      container.querySelectorAll('.btn-save-agent').forEach((b) => {
        b.addEventListener('click', async (e) => {
          const id = e.currentTarget.getAttribute('data-id');
          const webSearch = container.querySelector(`input[data-agent="${id}"][data-perm="allowWebSearch"]`)?.checked;
          const codeExec = container.querySelector(
            `input[data-agent="${id}"][data-perm="allowCodeExecution"]`
          )?.checked;
          const fileAccess = container.querySelector(`input[data-agent="${id}"][data-perm="allowFileAccess"]`)?.checked;
          const toolDispatch = container.querySelector(
            `input[data-agent="${id}"][data-perm="allowToolDispatch"]`
          )?.checked;

          try {
            await apiFetch('/agents', {
              method: 'PUT',
              body: JSON.stringify({
                id,
                permissions: {
                  allowWebSearch: Boolean(webSearch),
                  allowCodeExecution: Boolean(codeExec),
                  allowFileAccess: Boolean(fileAccess),
                  allowToolDispatch: Boolean(toolDispatch),
                },
              }),
            });
            showToast(`Agent "${id}" settings updated!`, 'success');
          } catch {}
        });
      });
    } catch {}
  }

  // 5. JOB ENGINE
  async function loadJobs() {
    try {
      const data = await apiFetch('/jobs');
      document.getElementById('stat-job-queued').textContent = data.stats?.queued || 0;
      document.getElementById('stat-job-running').textContent = data.stats?.running || 0;
      document.getElementById('stat-job-completed').textContent = data.stats?.completed || 0;
      document.getElementById('stat-job-failed').textContent = (data.stats?.failed || 0) + (data.stats?.cancelled || 0);

      const tbody = document.getElementById('jobs-table-body');
      if (!tbody) return;

      if (!data.jobs || data.jobs.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="7" style="text-align: center; color: var(--text-dim); padding: 30px;">No background jobs recorded.</td></tr>';
        return;
      }

      tbody.innerHTML = data.jobs
        .map(
          (j) => `
        <tr>
          <td style="font-weight: 500;">${escapeHtml(j.title)}</td>
          <td><span class="badge-tag">${escapeHtml(j.type)}</span></td>
          <td><span class="badge-tag ${j.priority === 'high' ? 'badge-danger' : 'badge-info'}">${escapeHtml(j.priority)}</span></td>
          <td>
            <span class="badge-tag ${j.status === 'completed' ? 'badge-success' : j.status === 'running' ? 'badge-info' : j.status === 'failed' || j.status === 'cancelled' ? 'badge-danger' : 'badge-warning'}">
              ${escapeHtml(j.status.toUpperCase())}
            </span>
          </td>
          <td style="min-width: 100px;">
            <div style="background: rgba(255,255,255,0.06); height: 6px; border-radius: 3px; overflow: hidden;">
              <div style="width: ${j.progress}%; background: var(--accent-primary); height: 100%;"></div>
            </div>
          </td>
          <td style="font-size: 0.75rem; color: var(--text-muted);">${new Date(j.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
          <td style="text-align: right;">
            ${
              j.status === 'queued' || j.status === 'running'
                ? `<button class="btn btn-sm btn-danger btn-cancel-job" data-id="${j.id}">Cancel</button>`
                : j.status === 'failed' || j.status === 'cancelled'
                  ? `<button class="btn btn-sm btn-retry-job" data-id="${j.id}">Retry</button>`
                  : `<span style="font-size: 0.75rem; color: var(--text-dim);">Done</span>`
            }
          </td>
        </tr>
      `
        )
        .join('');

      tbody.querySelectorAll('.btn-cancel-job').forEach((b) => {
        b.addEventListener('click', async (e) => {
          const id = e.currentTarget.getAttribute('data-id');
          try {
            await apiFetch('/jobs', {
              method: 'POST',
              body: JSON.stringify({ action: 'cancel', id }),
            });
            showToast('Job cancelled.', 'info');
            loadJobs();
          } catch {}
        });
      });

      tbody.querySelectorAll('.btn-retry-job').forEach((b) => {
        b.addEventListener('click', async (e) => {
          const id = e.currentTarget.getAttribute('data-id');
          try {
            await apiFetch('/jobs', {
              method: 'POST',
              body: JSON.stringify({ action: 'retry', id }),
            });
            showToast('Job queued for retry.', 'success');
            loadJobs();
          } catch {}
        });
      });
    } catch {}
  }

  document.getElementById('btn-open-job-modal')?.addEventListener('click', () => {
    openModal('modal-job');
  });

  document.getElementById('btn-save-job')?.addEventListener('click', async () => {
    const title = document.getElementById('job-input-title').value;
    const type = document.getElementById('job-input-type').value;
    const priority = document.getElementById('job-input-priority').value;

    if (!title.trim()) {
      showToast('Job title cannot be empty.', 'error');
      return;
    }

    try {
      await apiFetch('/jobs', {
        method: 'POST',
        body: JSON.stringify({ title, type, priority }),
      });
      showToast('Background job enqueued successfully!', 'success');
      closeModal('modal-job');
      loadJobs();
    } catch {}
  });

  // 6. MODEL ROUTER
  async function loadModels() {
    try {
      const data = await apiFetch('/models');
      const activeSelect = document.getElementById('model-active-select');
      if (activeSelect && data.activeModel) {
        activeSelect.value = data.activeModel;
      }

      const strategySelect = document.getElementById('model-strategy-select');
      if (strategySelect && data.strategy) {
        strategySelect.value = data.strategy;
      }

      const cbBadge = document.getElementById('cb-state');
      if (cbBadge) {
        const isClosed = data.circuitBreaker?.state === 'closed';
        cbBadge.className = `badge-tag ${isClosed ? 'badge-success' : 'badge-danger'}`;
        cbBadge.textContent = isClosed ? 'CLOSED (HEALTHY)' : data.circuitBreaker?.state.toUpperCase();
      }

      const fbSpan = document.getElementById('cb-fallback-chain');
      if (fbSpan && data.fallbackModels) {
        fbSpan.textContent = data.fallbackModels.join(' → ');
      }

      const tbody = document.getElementById('model-stats-tbody');
      if (tbody && data.modelStats) {
        tbody.innerHTML = Object.entries(data.modelStats)
          .map(
            ([m, s]) => `
          <tr>
            <td><code style="color: var(--accent-cyan); font-weight: 600;">${escapeHtml(m)}</code></td>
            <td>${s.requests}</td>
            <td><span class="badge-tag badge-success">${s.successes}</span></td>
            <td><span class="badge-tag ${s.failures > 0 ? 'badge-danger' : ''}">${s.failures}</span></td>
            <td style="font-family: var(--font-mono);">${s.avgLatencyMs} ms</td>
          </tr>
        `
          )
          .join('');
      }
    } catch {}
  }

  document.getElementById('btn-save-model-config')?.addEventListener('click', async () => {
    const activeModel = document.getElementById('model-active-select').value;
    const strategy = document.getElementById('model-strategy-select').value;

    try {
      await apiFetch('/models', {
        method: 'PUT',
        body: JSON.stringify({ activeModel, strategy }),
      });
      showToast('Model router configuration updated!', 'success');
      loadModels();
    } catch {}
  });

  document.getElementById('btn-reset-cb')?.addEventListener('click', async () => {
    try {
      await apiFetch('/models', {
        method: 'PUT',
        body: JSON.stringify({ circuitBreakerReset: true }),
      });
      showToast('Circuit breaker reset to CLOSED.', 'success');
      loadModels();
    } catch {}
  });

  // 7. SECURITY & AUDIT
  async function loadSecurity() {
    try {
      const data = await apiFetch('/security');

      const wlBadge = document.getElementById('sec-whitelist-status');
      if (wlBadge) {
        const enabled = data.whitelist?.enabled;
        wlBadge.className = `badge-tag ${enabled ? 'badge-success' : 'badge-warning'}`;
        wlBadge.textContent = enabled ? 'ENFORCED' : 'OPEN (OFF)';
      }

      document.getElementById('sec-whitelist-count').textContent = `${data.whitelist?.count || 0} phone numbers`;

      const wlList = document.getElementById('sec-whitelist-list');
      if (wlList) {
        const nums = data.whitelist?.authorizedNumbers || [];
        wlList.innerHTML =
          nums.length > 0
            ? nums.map((n) => `<div>${escapeHtml(n)}</div>`).join('')
            : 'None configured (Open in development)';
      }

      // Redaction Counters
      const red = data.redactionCounters || {};
      document.getElementById('redact-card').textContent = red['Payment Card'] || 0;
      document.getElementById('redact-pin').textContent = (red['PIN'] || 0) + (red['Password'] || 0);
      document.getElementById('redact-id').textContent = (red['National ID'] || 0) + (red['SSN'] || 0);
      document.getElementById('redact-otp').textContent = red['One-Time Password'] || 0;

      // Audit Logs Table
      const tbody = document.getElementById('sec-audit-tbody');
      if (tbody) {
        const logs = data.auditLogs || [];
        if (logs.length === 0) {
          tbody.innerHTML =
            '<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: 20px;">No recent audit logs.</td></tr>';
          return;
        }
        tbody.innerHTML = logs
          .slice()
          .reverse()
          .slice(0, 30)
          .map(
            (l) => `
          <tr>
            <td style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">${new Date(l.timestamp).toLocaleTimeString()}</td>
            <td><span class="badge-tag ${l.level === 'warn' ? 'badge-warning' : l.level === 'error' ? 'badge-danger' : 'badge-info'}">${l.level.toUpperCase()}</span></td>
            <td style="font-family: var(--font-mono); font-weight: 500;">${escapeHtml(l.event)}</td>
            <td style="font-size: 0.78rem; color: var(--text-dim); max-width: 320px; word-break: break-all;">${escapeHtml(JSON.stringify(l.meta))}</td>
          </tr>
        `
          )
          .join('');
      }
    } catch {}
  }

  // 8. SETTINGS
  async function loadSettings() {
    try {
      const data = await apiFetch('/settings');

      const briefToggle = document.getElementById('setting-briefing-toggle');
      if (briefToggle) briefToggle.checked = Boolean(data.briefing?.enabled);

      const briefHour = document.getElementById('setting-briefing-hour');
      if (briefHour && data.briefing?.scheduledHour !== undefined) {
        briefHour.value = String(data.briefing.scheduledHour);
      }

      const briefTz = document.getElementById('setting-briefing-tz');
      if (briefTz && data.briefing?.timezone) {
        briefTz.value = data.briefing.timezone;
      }

      const groundToggle = document.getElementById('setting-grounding-toggle');
      if (groundToggle) groundToggle.checked = Boolean(data.features?.searchGrounding);

      const voiceToggle = document.getElementById('setting-voice-toggle');
      if (voiceToggle) voiceToggle.checked = Boolean(data.features?.voiceReply);
    } catch {}
  }

  document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
    const briefingEnabled = document.getElementById('setting-briefing-toggle').checked;
    const scheduledHour = parseInt(document.getElementById('setting-briefing-hour').value, 10);
    const timezone = document.getElementById('setting-briefing-tz').value;
    const searchGrounding = document.getElementById('setting-grounding-toggle').checked;
    const voiceReply = document.getElementById('setting-voice-toggle').checked;

    try {
      await apiFetch('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          searchGrounding,
          voiceReply,
          briefing: {
            enabled: briefingEnabled,
            scheduledHour,
            timezone,
          },
        }),
      });
      showToast('Settings saved successfully!', 'success');
      loadSettings();
    } catch {}
  });

  // Auth Modal Handler
  document.getElementById('btn-auth-toggle')?.addEventListener('click', () => {
    document.getElementById('input-ops-token').value = state.token;
    openModal('modal-auth');
  });

  document.getElementById('btn-save-token')?.addEventListener('click', () => {
    const val = document.getElementById('input-ops-token').value.trim();
    state.token = val;
    if (val) {
      localStorage.setItem('ops_token', val);
      showToast('Ops token saved in session.', 'success');
    } else {
      localStorage.removeItem('ops_token');
      showToast('Ops token cleared.', 'info');
    }
    closeModal('modal-auth');
    loadActiveView();
  });

  // Global Refresh Button
  document.getElementById('btn-global-refresh')?.addEventListener('click', () => {
    loadActiveView();
    showToast('Refreshed data.', 'info');
  });

  // Bootstrapping
  loadActiveView();

  // Periodic polling every 8s
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      loadActiveView();
    }
  }, 8000);
})();
