import accountAccess from './AccountAccess.js';
import { projectReviewReport } from './ReviewEvidence.js';
import { projectArchiveReport } from './ArchiveReport.js';

export class ReviewAccess {
  constructor({ account = accountAccess, request = (...args) => fetch(...args) } = {}) {
    this.account = account;
    this.request = request;
    this.pending = new Map();
  }
  async send(action, body) {
    const owner = this.account.getState().user?.id || 'anonymous';
    const key = JSON.stringify([owner, action, body]);
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = (async () => {
      const response = await this.request(`/api/reviews/${action}`, {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json',
          'X-MicProbe-Request': '1', 'X-MicProbe-Account': owner }, body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        await this.account.refreshRejectedAccess(payload.error, owner);
        throw Object.assign(new Error(payload.error || 'review_unavailable'), { code: payload.error, status: response.status });
      }
      if (owner !== (this.account.getState().user?.id || 'anonymous')) throw new Error('account_changed');
      return payload;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }
  assess(report) { return this.send('assess', { report: projectReviewReport(report) }); }
  archive(report) {
    return this.send('archive', { report: projectArchiveReport(report), adoptGuest: true });
  }
}
export default new ReviewAccess();
