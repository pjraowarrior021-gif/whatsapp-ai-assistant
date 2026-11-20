/**
 * Analytics Agent.
 *
 * Records per-group counters and produces deterministic daily/weekly reports.
 * A model is optional for reports: if the gateway is unavailable the numbers
 * are still delivered accurately.
 */
export class AnalyticsAgent {
  /**
   * @param {{ analyticsStore: object, moderationStore: object, memoryAgent?: object, gateway?: object, config: object }} options
   */
  constructor({ analyticsStore, moderationStore, memoryAgent = null, gateway = null, config }) {
    this.analyticsStore = analyticsStore;
    this.moderationStore = moderationStore;
    this.memoryAgent = memoryAgent;
    this.gateway = gateway;
    this.config = config;
  }

  async record(groupJid, key, amount = 1) {
    try {
      return await this.analyticsStore.record(groupJid, key, amount);
    } catch {
      return null;
    }
  }

  getGroupSummary(groupJid, { days = 7 } = {}) {
    return this.analyticsStore.getGroupSummary(groupJid, { days });
  }

  getOverview({ days = 7 } = {}) {
    return this.analyticsStore.getOverview({ days });
  }

  /**
   * @param {{ groupJid: string, groupName?: string, period?: 'daily'|'weekly', settings?: object }} input
   */
  async buildReport({ groupJid, groupName = '', period = 'daily', settings: _settings = {} }) {
    const days = period === 'weekly' ? 7 : 1;
    const summary = this.getGroupSummary(groupJid, { days });
    const moderation = this.moderationStore.list({ groupJid, limit: 200 });
    const open = moderation.filter((e) => e.status === 'open' || e.status === 'escalated').length;
    const t = summary.totals || {};

    const lines = [
      `📊 ${period === 'weekly' ? 'Weekly' : 'Daily'} report — ${groupName || groupJid}`,
      `Messages seen: ${t.messagesSeen || 0}`,
      `AI replies: ${t.aiReplies || 0}`,
      `Moderation events: ${t.moderationEvents || 0} (${open} open)`,
      `Warnings: ${t.warnings || 0}`,
      `Escalations: ${t.escalations || 0}`,
      `New members: ${t.memberJoins || 0}`,
    ];

    const categories = new Map();
    for (const event of moderation.slice(0, 100)) {
      for (const category of event.categories || []) {
        categories.set(category, (categories.get(category) || 0) + 1);
      }
    }
    if (categories.size > 0) {
      const top = [...categories.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} (${count})`)
        .join(', ');
      lines.push(`Top moderation signals: ${top}`);
    }

    const memory = this.memoryAgent?.getMemory(groupJid);
    if (memory?.facts?.length) lines.push(`Remembered facts: ${memory.facts.length}`);
    if (open > 0) lines.push('⚠️ Open moderation cases need a human admin review.');

    return { text: lines.join('\n'), period, totals: t, openCases: open };
  }

  /**
   * True when a report for this period is due and has not been sent today.
   * @param {{ settings: object, lastSentAt?: string, now?: number }} input
   */
  static isReportDue({ settings = {}, lastSentAt = '', now = Date.now() } = {}) {
    const reports = settings.reports || {};
    const hour = Number(reports.hour ?? 21);
    const timezone = reports.timezone || 'UTC';
    let local;
    try {
      local = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
      }).formatToParts(new Date(now));
    } catch {
      local = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
      }).formatToParts(new Date(now));
    }
    const get = (type) => local.find((p) => p.type === type)?.value || '';
    const localHour = Number(get('hour'));
    const localDate = `${get('year')}-${get('month')}-${get('day')}`;
    if (localHour < hour) return { due: false, localDate };
    if (lastSentAt) {
      const lastDate = String(lastSentAt).slice(0, 10);
      if (lastDate >= localDate) return { due: false, localDate };
    }
    return { due: true, localDate };
  }
}
