/**
 * Memory and Retrieval Agent.
 *
 * Every operation is scoped to exactly one group JID. The underlying store has
 * no cross-group read API, and this agent never accepts a second group id.
 */
export class MemoryAgent {
  /**
   * @param {{ memoryStore: object, gateway: object, config: object, audit?: object }} options
   */
  constructor({ memoryStore, gateway, config, audit = null }) {
    this.memoryStore = memoryStore;
    this.gateway = gateway;
    this.config = config;
    this.audit = audit;
  }

  getContext(groupJid) {
    return this.memoryStore.getContext(groupJid);
  }

  retrieve(groupJid, query, { limit = 6 } = {}) {
    return this.memoryStore.search(groupJid, query, { limit });
  }

  getMemory(groupJid) {
    return this.memoryStore.getGroupMemory(groupJid);
  }

  async setRules(groupJid, rules, { actor = 'dashboard' } = {}) {
    const result = await this.memoryStore.setRules(groupJid, rules, { actor });
    await this.#audit(groupJid, actor, 'memory_rules_updated', { count: result.rules.length });
    return result;
  }

  async addFact(groupJid, fact, { maxFacts = 200, actor = 'dashboard' } = {}) {
    const result = await this.memoryStore.addFact(groupJid, fact, { maxFacts });
    await this.#audit(groupJid, actor, 'memory_fact_added', { factId: result.id });
    return result;
  }

  async addFaq(groupJid, faq) {
    const result = await this.memoryStore.addFaq(groupJid, faq);
    await this.#audit(groupJid, faq?.addedBy || 'dashboard', 'memory_faq_added', { faqId: result.id });
    return result;
  }

  async addSummary(groupJid, summary) {
    const result = await this.memoryStore.addSummary(groupJid, summary);
    await this.#audit(groupJid, 'memory-agent', 'memory_summary_added', { summaryId: result.id });
    return result;
  }

  async deleteItem(groupJid, type, id, { actor = 'dashboard' } = {}) {
    const result = await this.memoryStore.deleteItem(groupJid, type, id);
    await this.#audit(groupJid, actor, 'memory_item_deleted', { type, id, removed: result.removed });
    return result;
  }

  async clear(groupJid, { actor = 'dashboard' } = {}) {
    const result = await this.memoryStore.clear(groupJid);
    await this.#audit(groupJid, actor, 'memory_cleared', {});
    return result;
  }

  /**
   * Captures a durable fact from an explicit command such as
   * "remember: fees are due on the 5th".
   * @param {string} groupJid
   * @param {string} text
   * @param {{ senderJid?: string }} [options]
   */
  async captureFromText(groupJid, text, { senderJid = '' } = {}) {
    const match = String(text || '').match(/^\s*(?:remember|note|save)\s*[:\-]\s*(.+)$/i);
    if (!match) return null;
    const fact = match[1].trim();
    if (fact.length < 4) return null;
    return this.addFact(
      groupJid,
      { text: fact, category: 'chat', source: 'group_message', addedBy: senderJid || 'member' },
      { maxFacts: this.config.GROUP_ADMIN_MAX_FACTS || 200 }
    );
  }

  /**
   * Summarizes recent turns and stores the summary in this group's memory.
   * @param {{ groupJid: string, turns: Array<object>, settings?: object, period?: string }} input
   * @returns {Promise<{ text: string, provider?: string, model?: string } | null>}
   */
  async summarize({ groupJid, turns = [], settings = {}, period = 'adhoc' }) {
    const cleaned = turns
      .filter((t) => t && t.text)
      .slice(-80)
      .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Member'}: ${String(t.text).slice(0, 800)}`)
      .join('\n');
    if (!cleaned.trim()) return null;

    const existing = this.getContext(groupJid);
    const system = [
      'You summarize a WhatsApp group conversation for its members.',
      'Return 4-8 short bullet points covering decisions, questions, deadlines and useful facts.',
      'Do not invent anything. Do not include usernames unless necessary. No preamble.',
      existing ? `Existing group memory:\n${existing}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const result = await this.gateway.complete({
        task: 'summary',
        groupJid,
        system,
        messages: [{ role: 'user', content: cleaned }],
        model: settings.models?.summary || '',
        taskModels: settings.models || {},
        maxTokens: 700,
        temperature: 0.3,
      });
      const summary = String(result.text || '').trim();
      if (!summary) return null;
      await this.addSummary(groupJid, { text: summary, period });
      return { text: summary, provider: result.provider, model: result.model };
    } catch {
      return null;
    }
  }

  async #audit(groupJid, actor, action, detail) {
    if (!this.audit) return;
    await this.audit.record({ groupJid, actor, action, detail }).catch(() => {});
  }
}
