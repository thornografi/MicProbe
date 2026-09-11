import reviewAccess from '../modules/ReviewAccess.js';
import accountAccess from '../modules/AccountAccess.js';

/** One report, one public assessment. No questions, attempts or other recordings
 * are inputs. Archiving the selected current result is a separate user action. */
export class ReportAssessmentUI {
  constructor({ root, createElement, onSummary, onSaved, isSaved, waitForAccess }) {
    Object.assign(this, { root, createElement, onSummary, onSaved, isSaved, waitForAccess });
    this.generation = 0;
  }
  setReport(report, premium) {
    const account = accountAccess.getState();
    const key = `${account.user?.id || ''}:${report?.run?.id || ''}:${premium}:${account.configured}`;
    if (key === this.key) { this.render(); return; }
    this.key = key; this.report = report; this.premium = premium;
    ++this.generation; this.error = ''; this.busy = false; this.saved = !!report?.savedEvaluation;
    this.render();
    if (report?.savedEvaluation?.public) this.onSummary(report.savedEvaluation.public);
    else if (report && account.configured) this.load();
  }
  async load() {
    const generation = this.generation, report = this.report;
    try {
      await this.waitForAccess?.(report);
      if (generation !== this.generation) return;
      const result = await reviewAccess.assess(report);
      if (generation === this.generation && result.summary) this.onSummary(result.summary);
    } catch { /* The local factual summary remains usable if assessment is offline. */ }
  }
  async save() {
    if (this.busy || !this.premium) return;
    const generation = this.generation, report = this.report;
    this.busy = true; this.error = ''; this.render();
    try {
      await this.waitForAccess?.(report);
      if (generation !== this.generation) return;
      const result = await reviewAccess.archive(report);
      if (generation !== this.generation) return;
      this.saved = true;
      report.savedEvaluation = result.report.evaluation;
      if (result.report.evaluation?.public) this.onSummary(result.report.evaluation.public);
      this.onSaved?.();
    } catch (error) {
      if (generation === this.generation) this.error = error.code === 'report_storage_full'
        ? 'Your archive is full. This result is still available here. Remove a saved report to make room.'
        : error.code === 'premium_access_required' ? 'Premium is required to save this report.'
          : error.code === 'report_deleted' ? 'This report was deleted and cannot be saved again.'
            : 'This report could not be saved. Keep this page open and retry when connected.';
    } finally { if (generation === this.generation) { this.busy = false; this.render(); } }
  }
  render() {
    if (!this.root) return;
    this.root.replaceChildren();
    this.root.hidden = !this.report || !this.premium || !accountAccess.getState().configured;
    if (this.root.hidden) return;
    const saved = this.saved || this.isSaved?.(this.report.run.id);
    this.root.append(this.createElement('p', 'report-review-status', this.error || (saved
      ? 'Saved to your account. Each report is assessed independently.'
      : 'Keep this result in your Premium archive. Your audio stays on this device.')));
    if (!saved) {
      const button = this.createElement('button', 'btn btn--secondary btn--m', this.busy ? 'Saving…' : 'Save this report');
      button.type = 'button'; button.disabled = this.busy;
      button.addEventListener('click', () => this.save()); this.root.append(button);
    }
  }
  destroy() { ++this.generation; this.root?.replaceChildren(); }
}
