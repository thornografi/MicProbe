import accountAccess from '../modules/AccountAccess.js';
import reportEvaluator from '../modules/ReportEvaluator.js';
import { createOverlayController } from './OverlayController.js';

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(text, action, className = 'account-button') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable';
}
const testDate = entry => dateLabel(entry.report.generatedAt || entry.createdAt);
function valueLabel(value, unit = '') {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return 'Unknown';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return `${typeof value === 'number' ? Number(value.toFixed(2)) : value}${unit ? ` ${unit}` : ''}`;
}

export function comparisonRows(report, { detailed = false } = {}) {
  if (!detailed) {
    const free = reportEvaluator.evaluateFree(report);
    const assessment = { measured: 'Measured', limited: 'Limited assessment', insufficient: 'Insufficient audio',
      'not-measured': 'Not measured' }[free.assessment?.status] || 'Unknown';
    return [
      ['Profile', report.profile?.label || report.profile?.id || 'Unknown'],
      ['Result', free.overall.label], ['Summary', free.summary], ['Assessment', assessment]
    ];
  }
  const metrics = report.audioMetrics || {};
  const measured = metrics.status === 'measured';
  const metric = (value, unit, status = measured) => valueLabel(status ? value : null, unit);
  const applied = report.profile?.appliedConstraints || report.profile?.constraints || {};
  const requested = report.profile?.requestedConstraints || {};
  const rows = [
    ['Profile', report.profile?.label || report.profile?.id || 'Unknown'],
    ['Microphone', report.device?.micName || 'Unknown'],
    ['Measurement status', metrics.status || 'Unavailable'],
    ['Analyzed duration', metric(metrics.durationMs == null ? null : metrics.durationMs / 1000, 's')],
    ['Analyzed coverage', metrics.coverage?.truncated === true ? 'Partial recording' : metrics.coverage?.truncated === false ? 'Complete recording' : 'Unknown'],
    ['Capture method', report.recording && Object.hasOwn(report.recording, 'guidedSegments')
      ? report.recording.guidedSegments ? 'Guided quiet / speaking' : 'Free speaking' : 'Unknown'],
    ['RMS level', metric(metrics.signal?.rmsDb, 'dBFS')],
    ['Peak level', metric(metrics.signal?.peakDb, 'dBFS')],
    ['Clipped samples', metric(metrics.clipping?.rate == null ? null : metrics.clipping.rate * 100, '%', measured && metrics.clipping?.status === 'measured')],
    ['Estimated noise floor', metric(metrics.noiseFloor?.estimatedDb, 'dBFS', measured && metrics.noiseFloor?.status === 'measured')],
    ['Estimated SNR', metric(metrics.snr?.estimatedDb, 'dB', measured && metrics.snr?.status === 'measured')],
    ['Speaking / quiet contrast', metric(metrics.guidedNoise?.contrastDb, 'dB', measured && metrics.guidedNoise?.status === 'measured')],
    ['Requested bitrate', valueLabel(report.profile?.bitrate, 'bps')],
    ['Pipeline', valueLabel(report.profile?.pipeline)],
    ['Encoder', valueLabel(report.profile?.encoder)]
  ];
  for (const [key, label, unit] of [
    ['sampleRate', 'Sample rate', 'Hz'], ['channelCount', 'Channels', ''],
    ['echoCancellation', 'Echo cancellation', ''], ['noiseSuppression', 'Noise suppression', ''],
    ['autoGainControl', 'Automatic gain', '']
  ]) {
    rows.push([`${label} (requested)`, valueLabel(requested[key], unit)]);
    rows.push([`${label} (applied)`, valueLabel(applied[key], unit)]);
  }
  return rows;
}

/** Summarize the same values shown in the table; a numerical change is never a quality verdict. */
export function comparisonSummary(before, after, { detailed = false } = {}) {
  const context = [], settings = [], measurements = [];
  if (!before.profile?.id || !after.profile?.id) context.push('Scenario information is incomplete.');
  else if (before.profile.id !== after.profile.id) context.push('Different scenarios: differences may come from the selected processing.');
  if (before.run?.type !== after.run?.type) context.push('Different capture types.');
  if (!detailed) return { context, settings, measurements };
  const left = comparisonRows(before, { detailed }), right = comparisonRows(after, { detailed });
  const contextRows = new Set(['Microphone', 'Capture method', 'Analyzed coverage', 'Measurement status']);
  const settingRows = new Set(['Pipeline', 'Encoder', 'Requested bitrate']);
  const metricRows = new Set(['Analyzed duration', 'RMS level', 'Peak level', 'Clipped samples', 'Estimated noise floor', 'Estimated SNR', 'Speaking / quiet contrast']);
  for (let index = 0; index < left.length; index++) {
    const [label, previous] = left[index], current = right[index][1];
    if (contextRows.has(label)) {
      if (previous === 'Unknown' || current === 'Unknown') context.push(`${label}: unavailable for one or both tests.`);
      else if (previous !== current) context.push(`${label}: ${previous} → ${current}.`);
    } else if (previous !== current && (settingRows.has(label) || /\((requested|applied)\)$/.test(label))) {
      settings.push(`${label}: ${previous} → ${current}.`);
    } else if (metricRows.has(label)) {
      const previousNumber = /^(-?\d+(?:\.\d+)?) (.+)$/.exec(previous);
      const currentNumber = /^(-?\d+(?:\.\d+)?) (.+)$/.exec(current);
      if (!previousNumber || !currentNumber || previousNumber[2] !== currentNumber[2]) continue;
      const delta = +(Number(currentNumber[1]) - Number(previousNumber[1])).toFixed(2);
      if (!delta) continue;
      const unit = currentNumber[2] === '%' ? `percentage point${Math.abs(delta) === 1 ? '' : 's'}`
        : currentNumber[2] === 'dBFS' ? 'dB' : currentNumber[2];
      measurements.push(`${label}: ${delta > 0 ? 'increased' : 'decreased'} by ${Math.abs(delta)} ${unit}.`);
    }
  }
  return { context, settings, measurements };
}

let googleScriptPromise;
function loadGoogle() {
  if (globalThis.google?.accounts?.id) return Promise.resolve();
  if (!googleScriptPromise) googleScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = resolve;
    script.onerror = () => { script.remove(); googleScriptPromise = null; reject(new Error('google_unavailable')); };
    document.head.append(script);
  });
  return googleScriptPromise;
}

export default class AccountPanelUI {
  constructor({ history, premiumAccess, onOpenReport, onAccountChanged, onCheckout, onBeforeOpen, getIsBusy, onRestoreLegacyPurchase, elements = {} } = {}) {
    this.history = history;
    this.premiumAccess = premiumAccess;
    this.onOpenReport = onOpenReport;
    this.onCheckout = onCheckout;
    this.onRestoreLegacyPurchase = onRestoreLegacyPurchase;
    this.onBeforeOpen = onBeforeOpen;
    this.getIsBusy = getIsBusy;
    this.selected = new Set();
    this.noteDrafts = new Map();
    this.accountState = accountAccess.getState();
    this.historyState = history.getState();
    // DOM: elements DI (UIElements) - modul Node'da import edilebilir kalir
    this.dialog = elements.dialog || document.getElementById('accountDialog');
    this.title = elements.title || document.getElementById('accountDialogTitle');
    this.menuButton = elements.menuButton || document.getElementById('accountMenuBtn');
    this.historyButton = elements.historyButton || document.getElementById('reportHistoryBtn');
    this.accountBody = elements.identity || document.getElementById('accountIdentity');
    this.list = elements.historyList || document.getElementById('accountHistoryList');
    this.historySection = this.list?.closest('.account-history');
    this.status = elements.status || document.getElementById('accountStatus');
    this.compare = elements.comparison || document.getElementById('accountComparison');
    this.actions = elements.historyActions || document.getElementById('accountHistoryActions');
    // Native <dialog>; ESC (cancel->close), backdrop tiklamasi ve odak geri donusu OverlayController'da.
    // onClose: her kapanis yolunda (ESC, backdrop, buton, programatik) intent temizlenir.
    this.overlay = createOverlayController(this.dialog, {
      adapter: 'dialog',
      closeEls: this.dialog ? [...this.dialog.querySelectorAll('[data-close-account]')] : [],
      triggerEl: this.menuButton,
      onClose: () => { this.intent = null; accountAccess.clearIntent(); }
    });
    this.menuButton?.addEventListener('click', () => this.open(null, this.menuButton));
    this.historyButton?.addEventListener('click', () => this.open(null, this.historyButton));
    this.unsubscribeAccount = accountAccess.subscribe(state => {
      const previousId = this.accountState.user?.id;
      this.accountState = state;
      if (previousId && previousId !== state.user?.id) {
        this.selected.clear();
        this.compare?.replaceChildren();
        onAccountChanged?.();
      }
      if (this.menuButton) this.menuButton.textContent = state.user ? 'Account & History' : 'Sign in';
      if (this.title) this.title.textContent = state.user ? 'Your account & test history' : 'Sign in';
      if (this.historyButton) this.historyButton.hidden = !state.user;
      this.renderIdentity();
      this.renderHistory();
    });
    this.unsubscribeHistory = history.subscribe(state => { this.historyState = state; this.renderHistory(); });
    this.unsubscribeIntent = accountAccess.subscribeIntent(intent => this.open(intent));
    this.unsubscribePremium = premiumAccess?.subscribe(state => this._syncComparisonAccess(state));
    accountAccess.bootstrap();
  }
  _syncComparisonAccess(state) {
    if ((state.userId ?? null) !== (this.accountState.user?.id ?? null)) {
      this.compare?.replaceChildren();
      return;
    }
    if (this.compare?.hasChildNodes()) this.renderComparison({ scroll: false });
  }
  message(text = '') { if (this.status) this.status.textContent = text; }
  open(intent = null, opener = null) {
    if (!this.dialog) return;
    this.intent = intent;
    if (!this.dialog.open) { this.onBeforeOpen?.(); this.overlay?.open({ opener }); }
    this.renderIdentity();
    this.renderHistory();
    if (!this.accountState.user && this.accountState.configured) this.renderGoogle();
    if (this.accountState.user) this.history.reload();
  }
  close() { this.overlay?.close(); this.intent = null; accountAccess.clearIntent(); }
  comparisonPair(report) {
    if (!this.accountState.user || this.historyState.userId !== this.accountState.user.id) return [];
    const entries = this.historyState.reports;
    const index = entries.findIndex(entry => entry.report.run?.id === report?.run?.id);
    if (index < 0 || !report.profile?.id) return [];
    const previous = entries.slice(index + 1).find(entry => entry.report.profile?.id === report.profile.id
      && entry.report.run?.type === report.run.type);
    return previous ? [previous, entries[index]] : [];
  }
  compareWithPrevious(report) {
    if (this.getIsBusy?.()) return;
    const pair = this.comparisonPair(report);
    if (pair.length !== 2) return;
    this.selected = new Set(pair.map(entry => entry.id));
    this.open();
    this.renderComparison();
  }
  openReport(entry) {
    if (this.getIsBusy?.()) {
      this.message('Wait for the current recording or test and its analysis to finish before opening a saved report.');
      return;
    }
    this.close();
    this.history.open(entry, this.onOpenReport);
  }
  syncBusyState() {
    const busy = !!this.getIsBusy?.();
    for (const open of this.list?.querySelectorAll('[data-open-report]') || []) {
      open.disabled = busy;
      open.title = busy ? 'Available when the current recording or test and its analysis finish.' : '';
    }
  }
  async run(action, success = '') {
    this.message('Working…');
    try { await action(); this.message(typeof success === 'function' ? success() : success); }
    catch (error) {
      const messages = {
        account_sign_in_required: 'Sign in to attach your lifetime purchase to your account.',
        purchase_verification_pending: 'Your purchase is waiting for verification. Use Retry purchase verification; you do not need to buy again.',
        billing_temporarily_unavailable: this.accountState.premium?.pending
          ? 'Purchase verification is pending. Use Retry purchase verification; you do not need to buy again.'
          : 'Purchase verification is temporarily unavailable. Please retry when connected.',
        sign_in_required: 'Your session ended. Sign in again to continue; pending reports stay with your account.',
        sign_in_expired: 'This sign-in request expired. Select Load Google sign-in and try again.',
        invalid_identity: 'Google sign-in could not be verified. Select Load Google sign-in and try again.',
        account_changed: 'The account changed in another tab. This view has been refreshed; please check the account before continuing.',
        public_checkout_required: 'Checkout is available on the public MicProbe site. Your test results remain here.',
        history_sync_busy: 'A report is saving. Please try again in a moment.',
        license_already_linked: 'This purchase is already linked to another account. Sign in with that account.',
        invalid_license: 'This purchase could not be verified. Check the key from your purchase email.',
        google_unavailable: 'Google sign-in could not load. Check your connection or browser settings, then retry.'
      };
      this.message(messages[error.message] || 'The request could not be completed. Your current test is preserved; please retry.');
    }
  }
  renderIdentity() {
    if (!this.accountBody) return;
    this.accountBody.replaceChildren();
    const state = this.accountState;
    if (state.user) {
      this.accountBody.append(element('h3', '', state.user.name || 'Your account'), element('p', 'account-muted', state.user.email));
      this.accountBody.append(element('p', 'account-entitlement', state.premium?.pending
        ? 'Purchase verification pending. Your purchase is linked, but we could not confirm access yet. You do not need to buy again.'
        : state.error
        ? 'Your account connection could not be checked. Reconnect to confirm your purchase and sync reports.'
        : state.premium?.unlocked ? 'Lifetime Premium · One payment, repeat tests anytime' : 'Free account · Test again whenever you change a setting'));
      const actions = element('div', 'account-actions');
      if (state.premium?.pending) actions.append(button('Retry purchase verification', () => this.run(() => accountAccess.refresh({ sessionOnly: true }))));
      else if (state.error) actions.append(button('Retry account connection', () => this.run(() => accountAccess.refresh())));
      else if (!state.premium?.unlocked) actions.append(button('Get Lifetime Premium', () => this.run(() => this.onCheckout())));
      else actions.append(button('Manage purchase', () => this.run(async () => {
        const { url } = await accountAccess.api('/portal', { method: 'POST', body: {} });
        const target = new URL(url);
        if (target.protocol !== 'https:' || !(target.hostname === 'freemius.com' || target.hostname.endsWith('.freemius.com'))) throw new Error('invalid_portal_url');
        window.location.assign(target.href);
      })));
      actions.append(button('Sign out', () => this.run(() => accountAccess.logout(), 'Signed out. Account history is hidden on this browser.')));
      this.accountBody.append(actions);
      if (!state.error && !state.premium?.pending && !state.premium?.unlocked) this.renderPurchaseRestore();
    } else {
      this.accountBody.append(element('h3', '', this.intent === 'checkout' ? 'Keep your lifetime purchase with you' : 'Keep your results and see what changed'));
      this.accountBody.append(element('p', 'account-muted', 'Sign in to save reports across devices and restore your premium access automatically. You can keep testing without an account.'));
      if (state.error) this.accountBody.append(button('Retry account connection', () => this.run(() => accountAccess.refresh())));
      else if (!state.ready) this.accountBody.append(element('p', 'account-muted', 'Checking sign-in availability…'));
      else if (!state.configured) {
        this.accountBody.append(element('p', 'account-muted', 'Account sign-in is not available on this site yet. You can continue testing, but reports will not be saved to history.'));
        this.renderPurchaseRestore({ legacy: true });
      }
      else {
        this.googleContainer = element('div', 'account-google');
        this.accountBody.append(this.googleContainer, button('Load Google sign-in', () => this.renderGoogle()));
        if (this.dialog?.open) this.renderGoogle();
      }
    }
  }
  renderPurchaseRestore({ legacy = false } = {}) {
    const details = element('details', 'account-restore');
    details.append(element('summary', '', legacy ? 'Restore an earlier purchase' : 'Link an earlier purchase'));
    details.append(element('p', 'account-muted', legacy
      ? 'Use the full license key from your purchase email to restore Premium on this browser.'
      : 'Only needed for a purchase made before you used this account. Future visits use your Google sign-in.'));
    const form = element('form', 'account-actions');
    const label = element('label', 'account-field', 'License key from your purchase email');
    const input = element('input'); input.type = 'password'; input.required = true; input.autocomplete = 'off'; input.maxLength = 256;
    label.append(input);
    const submit = button(legacy ? 'Restore purchase' : 'Link purchase', () => {}); submit.type = 'submit';
    form.append(label, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.run(async () => {
        if (legacy) await this.onRestoreLegacyPurchase(input.value.trim());
        else await accountAccess.restorePurchase(input.value.trim());
        input.value = '';
      }, legacy ? 'Premium access restored on this browser.' : 'Your purchase is linked to this account.');
    });
    details.append(form); this.accountBody.append(details);
  }
  async renderGoogle() {
    const container = this.googleContainer;
    if (!container || !this.dialog?.open || this.googleLoading) return;
    this.googleLoading = true;
    try {
      const config = await accountAccess.getSignInConfig();
      if (!config.configured || !config.googleClientId) throw new Error('account_unavailable');
      await loadGoogle();
      if (container !== this.googleContainer || !container.isConnected) return;
      globalThis.google.accounts.id.initialize({
        client_id: config.googleClientId, nonce: config.nonce, auto_select: false,
        callback: response => this.run(async () => {
          const intent = this.intent;
          await accountAccess.signInWithGoogle(response.credential);
          accountAccess.clearIntent();
          if (intent === 'checkout') await this.onCheckout();
          this.intent = null;
        }, 'Signed in. New reports will be saved to your account.')
      });
      container.replaceChildren();
      globalThis.google.accounts.id.renderButton(container, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', width: 260 });
    } catch { this.message('Google sign-in could not load. You can continue testing or retry sign-in.'); }
    finally {
      this.googleLoading = false;
      // Replacing the signed-out view while Google loads must not leave its
      // new button empty. Same-container calls share this request and nonce.
      if (this.dialog?.open && !this.accountState.user && this.googleContainer !== container) this.renderGoogle();
    }
  }
  renderHistory() {
    if (!this.list || !this.actions) return;
    const state = this.historyState;
    const visible = !!this.accountState.user && state.userId === this.accountState.user.id;
    if (this.historySection) this.historySection.hidden = !visible;
    if (!visible) {
      this.selected.clear();
      this.actions.replaceChildren();
      this.list.replaceChildren();
      this.compare?.replaceChildren();
      return;
    }
    const ids = new Set(state.reports.map(entry => entry.id));
    const selectedCount = this.selected.size;
    this.selected = new Set([...this.selected].filter(id => ids.has(id)));
    if (this.selected.size !== selectedCount) this.compare?.replaceChildren();
    this.actions.replaceChildren();
    this.actions.append(element('p', 'account-muted', 'Reports and notes sync to your account. Items marked Waiting to sync are kept on this browser. Audio recordings are not uploaded or included in history.'));
    const buttons = element('div', 'account-actions');
    buttons.append(button(state.pendingCount ? `Retry sync (${state.pendingCount})` : 'Refresh history', () => this.run(async () => { await this.history.retry(); await this.history.reload(); })));
    if (state.nextCursor) buttons.append(button('Load older reports', () => this.history.reload({ more: true })));
    this.compareButton = button(`Compare selected (${this.selected.size}/2)`, () => this.renderComparison());
    this.compareButton.disabled = this.selected.size !== 2;
    buttons.append(this.compareButton); this.actions.append(buttons);
    if (state.error) this.actions.append(element('p', 'account-error', state.error));
    this.list.replaceChildren();
    if (!state.reports.length) this.list.append(element('p', 'account-empty', state.loading ? 'Loading your reports…' : 'No reports yet. Run a test, adjust one setting, then test again to compare.'));
    for (const entry of state.reports) {
      const card = element('li', 'account-report');
      const row = element('div', 'account-report-heading');
      const choose = element('label', 'account-select');
      const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(entry.id);
      checkbox.setAttribute('aria-label', `Compare ${entry.report.profile?.label || 'report'} from ${testDate(entry)}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked && this.selected.size >= 2) { checkbox.checked = false; this.message('Select two reports. Deselect one to compare another.'); return; }
        if (checkbox.checked) this.selected.add(entry.id); else this.selected.delete(entry.id);
        this.compareButton.disabled = this.selected.size !== 2;
        this.compareButton.textContent = `Compare selected (${this.selected.size}/2)`;
        this.compare.replaceChildren();
      });
      choose.append(checkbox, element('span', '', 'Compare'));
      const title = element('div');
      title.append(element('h4', '', entry.report.profile?.label || entry.report.profile?.id || 'Microphone report'), element('p', 'account-muted', `${testDate(entry)} · ${entry.report.device?.micName || 'Microphone unknown'}`));
      row.append(title, choose); card.append(row);
      const field = element('label', 'account-field', 'What did you change?');
      // A refresh may replace cloud IDs; run identity and owner keep an unsaved
      // note stable without carrying it into a different account's editor.
      const draftKey = JSON.stringify([state.userId, entry.report.run.id]);
      const note = element('input'); note.type = 'text'; note.maxLength = 500;
      note.value = this.noteDrafts.get(draftKey) ?? entry.note ?? ''; note.placeholder = 'e.g. Lowered gain, moved microphone closer';
      note.addEventListener('input', () => this.noteDrafts.set(draftKey, note.value));
      field.append(note); card.append(field);
      const actions = element('div', 'account-actions');
      const open = button('Open report', () => this.openReport(entry));
      open.dataset.openReport = '';
      actions.append(open,
        button('Save note', () => this.run(async () => {
          const draft = note.value;
          await this.history.updateNote(entry.id, draft);
          if (this.noteDrafts.get(draftKey) === draft) this.noteDrafts.delete(draftKey);
        }, () => {
          const current = this.history.getState();
          if (current.userId !== state.userId) return 'The account changed. Check your account before continuing.';
          const saved = current.reports.find(item => item.report.run.id === entry.report.run.id);
          return saved?.pending ? 'Note kept on this browser and waiting to sync. Use Retry sync when connected.' : 'Note saved.';
        })),
        button('Delete', () => {
          const warning = element('span', 'account-delete-confirm', 'Delete this saved report? ');
          warning.append(button('Delete report', () => this.run(() => this.history.remove(entry.id))), button('Keep', () => warning.remove()));
          actions.querySelector('.account-delete-confirm')?.remove(); actions.append(warning);
        }));
      if (entry.pending) actions.append(element('span', 'account-muted', entry.saveError
        ? 'Could not save: unsupported report data' : 'Waiting to sync'));
      card.append(actions); this.list.append(card);
    }
    this.syncBusyState();
  }
  renderComparison({ scroll = true } = {}) {
    const entries = [...this.selected].map(id => this.historyState.reports.find(entry => entry.id === id)).filter(Boolean)
      .sort((a, b) => new Date(a.report.generatedAt || a.createdAt) - new Date(b.report.generatedAt || b.createdAt));
    if (entries.length !== 2) return;
    const detailed = this.premiumAccess?.isUnlocked() === true;
    this.compare.replaceChildren(element('h3', '', 'Compare your two tests'), element('p', 'account-muted', detailed
      ? 'Use the same phrase, distance and room when comparing. Louder does not automatically mean better. Hardware gain and microphone position are not measured; record them in your notes. Local call profiles do not measure the real app or internet connection.'
      : 'Short results and your notes are shown here. Open a report for Premium details and instructions on screen.'));
    const summary = comparisonSummary(entries[0].report, entries[1].report, { detailed });
    for (const [title, lines] of [['Comparison context', summary.context], ['Changed settings', summary.settings], ['Measured changes', summary.measurements]]) {
      if (!lines.length) continue;
      const section = element('section', 'account-comparison-summary');
      section.append(element('h4', '', title));
      const list = element('ul');
      lines.forEach(line => list.append(element('li', '', line)));
      section.append(list); this.compare.append(section);
    }
    if (detailed) this.compare.append(element('p', 'account-muted',
      'Changes run from the left test to the right test, ordered by their saved dates when available. Higher or lower does not by itself mean better. Differences do not establish a cause.'));
    const table = element('table', 'account-comparison-table');
    const caption = element('caption', '', detailed ? 'Saved report measurements and captured settings' : 'Saved report summaries'); table.append(caption);
    const head = element('tr');
    for (const label of ['Observation', ...entries.map(testDate)]) head.append(element('th', '', label));
    const thead = element('thead'); thead.append(head); table.append(thead);
    const tbody = element('tbody');
    const [left, right] = entries.map(entry => comparisonRows(entry.report, { detailed }));
    const rows = [['Your note', entries[0].note || 'No note', entries[1].note || 'No note'], ...left.map((row, index) => [row[0], row[1], right[index]?.[1] || 'Unknown'])];
    for (const row of rows) {
      const tr = element('tr'); const label = element('th', '', row[0]); label.scope = 'row';
      tr.append(label, element('td', '', row[1]), element('td', '', row[2])); tbody.append(tr);
    }
    table.append(tbody); this.compare.append(table);
    if (scroll) this.compare.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  destroy() { this.unsubscribeAccount?.(); this.unsubscribeHistory?.(); this.unsubscribeIntent?.(); this.unsubscribePremium?.(); }
}
