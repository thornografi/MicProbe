const STORAGE_KEY = 'micprobe:report-history:v1';
const MAX_LOCAL_BYTES = 2500000;
const validEntries = entries => Array.isArray(entries) ? entries.filter(entry => entry && typeof entry.id === 'string'
  && entry.report && typeof entry.report.run?.id === 'string' && typeof entry.note === 'string') : [];

export function reportIdentity(report) {
  return report?.run?.id || `${report?.sessionId || 'report'}:${report?.generatedAt || ''}`;
}

/** Only account-owned reports are retained; pending writes stay with their owner. */
export class ReportHistory {
  constructor({ account, storage = globalThis.localStorage } = {}) {
    this.account = account;
    this.storage = storage;
    this.listeners = new Set();
    this.userId = null;
    this.revision = 0;
    this.loadRevision = 0;
    this.reports = [];
    this.error = '';
    this.loading = false;
    this.nextCursor = null;
    this.suppressCapture = false;
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}');
      this.pending = Object.fromEntries(Object.entries(saved.pending || {}).map(([owner, entries]) => [owner, validEntries(entries)]));
      // Retire guest history from older versions without dropping account-owned writes.
      if (Object.hasOwn(saved, 'guest')) this._persist();
    } catch { this.pending = {}; }
    this.unsubscribeAccount = account.subscribe(state => this._onAccount(state));
  }
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }
  getState() {
    return structuredClone({ reports: this.reports,
      pendingCount: this._pending().length,
      loading: this.loading, error: this.error || (this._pending().some(entry => entry.saveError)
        ? 'Some reports contain unsupported data and could not be saved. They remain on this browser.' : ''),
      userId: this.userId, nextCursor: this.nextCursor });
  }
  _notify() { this.listeners.forEach(listener => listener(this.getState())); }
  _pending() { return this.userId ? this.pending[this.userId] || [] : []; }
  _persist() {
    try {
      const text = JSON.stringify({ pending: this.pending });
      if (text.length > MAX_LOCAL_BYTES) throw new Error('storage_full');
      this.storage?.setItem(STORAGE_KEY, text);
    } catch { this.error = 'Browser storage is full or unavailable. Keep this page open and retry saving.'; }
  }
  _onAccount(state) {
    const nextId = state.user?.id || null;
    if (nextId === this.userId) return;
    this.userId = nextId;
    ++this.revision;
    this.error = '';
    this.nextCursor = null;
    this.loading = false;
    this.reports = structuredClone(this._pending());
    this._notify();
    if (nextId) this.reload();
  }
  capture(report) {
    if (this.suppressCapture || !report || !report.run?.id) return;
    const identity = reportIdentity(report);
    const ownerId = Object.hasOwn(report.run, 'accountOwnerId') ? report.run.accountOwnerId : this.userId;
    if (!ownerId) return;
    const records = ownerId === this.userId ? this.reports : this.pending[ownerId] || [];
    if (records.some(entry => reportIdentity(entry.report) === identity)) return;
    const entry = { id: identity, report: structuredClone(report), note: '', createdAt: report.generatedAt || new Date().toISOString(),
      pending: true, cloudSaveUnknown: false };
    this.pending[ownerId] = [entry, ...(this.pending[ownerId] || [])];
    if (ownerId === this.userId) this.reports.unshift(entry);
    this._persist();
    this._notify();
    if (ownerId === this.userId) this.retry({ includeRejected: false });
  }
  open(entry, restore) {
    this.suppressCapture = true;
    try { restore(structuredClone(entry.report)); }
    finally { this.suppressCapture = false; }
  }
  async reload({ more = false } = {}) {
    if (!this.userId) return;
    const revision = this.revision;
    const loadRevision = ++this.loadRevision;
    const entriesAtStart = new Set(this.reports);
    const idsAtStart = new Set(this.reports.map(entry => reportIdentity(entry.report)));
    this.loading = true;
    this._notify();
    try {
      const cursor = more && this.nextCursor ? `?cursor=${encodeURIComponent(this.nextCursor)}` : '';
      const result = await this.account.api(`/reports${cursor}`);
      if (revision !== this.revision || loadRevision !== this.loadRevision) return;
      const currentIds = new Set(this.reports.map(entry => reportIdentity(entry.report)));
      const received = (result.reports || []).filter(entry => !idsAtStart.has(reportIdentity(entry.report)) || currentIds.has(reportIdentity(entry.report)));
      // A save/delete completed after this GET began. Its local result owns
      // that row until a later refresh, even if this response predates it.
      const changed = this.reports.filter(entry => !entriesAtStart.has(entry));
      const existing = more ? this.reports : [];
      const byRun = new Map([...existing, ...received, ...changed, ...this._pending()]
        .map(entry => [reportIdentity(entry.report), entry]));
      this.reports = [...byRun.values()].sort((a, b) => String(b.report.generatedAt || b.createdAt).localeCompare(String(a.report.generatedAt || a.createdAt)));
      this.nextCursor = result.nextCursor || null;
      this.error = '';
    } catch { if (revision === this.revision && loadRevision === this.loadRevision) this.error = 'History could not be loaded. Your pending reports are kept on this browser; retry when connected.'; }
    finally {
      if (revision === this.revision && loadRevision === this.loadRevision) { this.loading = false; this._notify(); }
    }
  }
  async retry({ includeRejected = true } = {}) {
    if (!this.userId) return;
    const revision = this.revision;
    if (this.syncRevision === revision) return;
    this.syncRevision = revision;
    if (includeRejected) this._pending().forEach(entry => { delete entry.saveError; });
    try {
      while (revision === this.revision) {
        const entry = this._pending().find(item => !item.saveError);
        if (!entry) break;
        // Missing state from an older browser version is conservatively unknown.
        const wasUnknown = entry.cloudSaveUnknown !== false;
        entry.cloudSaveUnknown = true;
        this._persist();
        let result;
        try {
          result = await this.account.api('/reports', { method: 'POST', body: { report: entry.report, note: entry.note } });
        } catch (error) {
          if (revision !== this.revision) return;
          if ((error.status === 400 && error.message === 'invalid_report')
              || (error.status === 413 && error.message === 'request_too_large')) {
            for (const pending of this._pending().filter(item => reportIdentity(item.report) === reportIdentity(entry.report))) {
              pending.saveError = error.message;
              pending.cloudSaveUnknown = wasUnknown;
            }
            this.reports = this.reports.map(item => this._pending().find(pending => reportIdentity(pending.report) === reportIdentity(item.report)) || item);
            this._persist();
            this._notify();
            continue;
          }
          throw error;
        }
        if (revision !== this.revision) return;
        if (result.report && result.report.note !== entry.note) {
          result = await this.account.api(`/reports/${encodeURIComponent(result.report.id)}`, { method: 'PATCH', body: { note: entry.note } });
          if (revision !== this.revision) return;
        }
        // Editing the note while a save is in flight queues a replacement rather than dropping it.
        this.pending[this.userId] = this._pending().filter(item => item !== entry);
        const stored = { ...(result.report || result.entry || entry), pending: false, cloudSaveUnknown: false };
        if (!stored.report) stored.report = entry.report;
        const updated = this._pending().find(item => reportIdentity(item.report) === reportIdentity(entry.report));
        this.reports = this.reports.map(item => reportIdentity(item.report) === reportIdentity(entry.report) ? (updated || stored) : item);
        this.error = '';
        this._persist();
        this._notify();
      }
    } catch {
      if (revision === this.revision) { this.error = 'Some reports are waiting to sync. They remain on this browser; use Retry sync when connected.'; this._notify(); }
    } finally { if (this.syncRevision === revision) this.syncRevision = null; }
  }
  async updateNote(entryId, note) {
    if (!this.userId) return;
    const entries = this.reports;
    const entry = entries.find(item => item.id === entryId);
    if (!entry) return;
    const updated = { ...entry, note: String(note).slice(0, 500), pending: true };
    this.reports = entries.map(item => item === entry ? updated : item);
    this.pending[this.userId] = [...this._pending().filter(item => reportIdentity(item.report) !== reportIdentity(entry.report)), updated];
    this._persist();
    this._notify();
    await this.retry({ includeRejected: false });
  }
  async remove(entryId) {
    if (!this.userId) return;
    const revision = this.revision;
    const entry = this.reports.find(item => item.id === entryId);
    if (!entry) return;
    if (this.syncRevision === revision) throw new Error('history_sync_busy');
    // Serialize deletion with saving so an in-flight retry cannot recreate the row.
    this.syncRevision = revision;
    try {
      const neverSaved = entry.pending && entry.id === reportIdentity(entry.report) && entry.cloudSaveUnknown === false;
      if (!neverSaved) {
        let cloudId = entryId;
        if (entry.pending && entry.id === reportIdentity(entry.report)) {
          // A lost save response may already have created the immutable cloud row.
          const saved = await this.account.api('/reports', { method: 'POST', body: { report: entry.report, note: entry.note } });
          if (revision !== this.revision) return;
          cloudId = saved.report.id;
        }
        try { await this.account.api(`/reports/${encodeURIComponent(cloudId)}`, { method: 'DELETE' }); }
        catch (error) {
          // Another device may already have removed this row. Only a confirmed
          // missing report is equivalent to a successful delete.
          if (error.status !== 404 || error.message !== 'report_not_found') throw error;
        }
        if (revision !== this.revision) return;
      }
      const identity = reportIdentity(entry.report);
      this.pending[this.userId] = this._pending().filter(item => reportIdentity(item.report) !== identity);
      this.reports = this.reports.filter(item => reportIdentity(item.report) !== identity);
    } finally { if (this.syncRevision === revision) this.syncRevision = null; }
    this._persist();
    this._notify();
    await this.retry({ includeRejected: false });
  }
  destroy() { this.unsubscribeAccount?.(); this.listeners.clear(); }
}
