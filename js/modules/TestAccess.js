const STORAGE_KEY = 'micprobe:test-settlements:v1';
const finite = value => Number.isFinite(value) ? value : null;
function sessionStorageOrNull() { try { return globalThis.sessionStorage; } catch { return null; } }

/** Reserves before microphone access, settles only a matching new report. Audio,
 * filenames, device IDs and report text never enter the quota request. */
export class TestAccess {
  constructor({ account, getAccessToken = () => '', onBlocked = () => {}, request = (...args) => fetch(...args),
    storage = sessionStorageOrNull(), locks = globalThis.navigator?.locks } = {}) {
    Object.assign(this, { account, getAccessToken, onBlocked, request, storage, locks });
    this.runs = new Map();
    try {
      for (const entry of JSON.parse(storage?.getItem(STORAGE_KEY) || '[]')) {
        if (typeof entry.runId === 'string') this.runs.set(entry.runId, { ...entry, active: false });
      }
    } catch { /* Session storage is optional; the server lease is the fallback. */ }
  }

  persist() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.runs.values()].map(({ runId, owner, operation, evidence }) =>
      ({ runId, owner, operation: operation || 'release', ...(evidence ? { evidence } : {}) })))); } catch { /* memory-only */ }
  }

  async api(action, entry) {
    const body = { runId: entry.runId };
    if (action === 'start') body.accessToken = this.getAccessToken();
    if (action === 'complete') body.evidence = entry.evidence;
    const response = await this.request(`/api/tests/${action}`, { method: 'POST', credentials: 'same-origin', keepalive: entry.keepalive === true,
      signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json',
        'X-MicProbe-Request': '1', 'X-MicProbe-Account': entry.owner || 'anonymous' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'test_access_unavailable'), { status: response.status });
  }

  async begin(snapshot) {
    const start = async () => {
      await this.account.bootstrap();
      if (this.account.getState().error) await this.account.refresh({ sessionOnly: true });
      const state = this.account.getState();
      if (state.error) throw new Error('test_access_unavailable');
      if ((state.user?.id || null) !== (snapshot.accountOwnerId || null)) throw new Error('account_changed');
      // Resume a lost completion, or release an interrupted preparation after reload.
      for (const entry of this.runs.values()) if (!entry.active) await this.flush(entry);
      const entry = { runId: snapshot.runId, owner: snapshot.accountOwnerId || null, operation: 'release', active: false };
      this.runs.set(entry.runId, entry);
      this.persist();
      entry.starting = this.api('start', entry);
      try { await entry.starting; }
      catch (error) {
        if (error.status && error.status < 500) { this.runs.delete(entry.runId); this.persist(); }
        throw error;
      }
      entry.operation = null;
      entry.active = true;
      this.persist();
      // Authentication may change while the reservation is in flight.
      if ((this.account.getState().user?.id || null) !== entry.owner) {
        await this.release(entry.runId);
        throw new Error('account_changed');
      }
      return true;
    };
    try {
      // Serializes the first cookie response across tabs, where Web Locks exist.
      return await (this.locks ? this.locks.request('micprobe-test-start', start) : start());
    } catch (error) {
      if (error.message === 'account_changed') await this.account.refresh({ sessionOnly: true });
      this.onBlocked(error.message);
      return false;
    }
  }

  async flush(entry) {
    if (entry.sending) return entry.sending;
    entry.sending = (async () => {
      try { await this.api(entry.operation, entry); }
      catch (error) { if (error.message !== 'test_session_expired') throw error; }
      this.runs.delete(entry.runId);
      this.persist();
    })().finally(() => { entry.sending = null; });
    return entry.sending;
  }

  async complete(report) {
    const entry = this.runs.get(report?.run?.id);
    if (!entry?.active || entry.operation) return;
    const m = report.audioMetrics;
    entry.evidence = { status: m?.status === 'measured' ? 'measured' : 'unavailable',
      sampleCount: finite(m?.sampleCount), durationMs: finite(m?.durationMs),
      signal: { rmsDb: finite(m?.signal?.rmsDb), peakDb: finite(m?.signal?.peakDb) },
      clipping: { status: m?.clipping?.status === 'measured' ? 'measured' : 'unavailable',
        method: m?.clipping?.method === 'sample-saturation' ? 'sample-saturation' : null, rate: finite(m?.clipping?.rate) } };
    entry.operation = 'complete';
    entry.active = false;
    this.persist();
    try { await this.flush(entry); } catch { /* Keep the result usable; retry before the next start. */ }
  }

  async waitForCompletion(runId) {
    // Report listeners run synchronously; settlement can start later in the
    // same event dispatch. Await that dispatch before checking the visit proof.
    await Promise.resolve();
    const entry = this.runs.get(runId);
    if (entry?.operation === 'complete') await this.flush(entry);
  }

  async release(runId) {
    const entry = this.runs.get(runId);
    if (!entry || entry.operation === 'complete') return;
    // Cancellation may arrive before the server's reservation reply.
    try { await entry.starting; } catch { /* A lost reply can still have reserved the run. */ }
    entry.operation = 'release';
    entry.active = false;
    this.persist();
    try { await this.flush(entry); } catch { /* Retry before the next start, or expire server-side. */ }
  }

  close() {
    return Promise.allSettled([...this.runs.values()].map(entry => {
      entry.keepalive = true;
      return entry.operation === 'complete' ? this.flush(entry) : this.release(entry.runId);
    }));
  }
}
