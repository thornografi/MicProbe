import { createOverlayController } from './OverlayController.js';

export class TestAccessUI {
  constructor({ onContinue }) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'testAccessDialog';
    this.dialog.className = 'account-dialog';
    this.dialog.setAttribute('aria-labelledby', 'testAccessTitle');
    this.dialog.setAttribute('aria-describedby', 'testAccessMessage');
    this.dialog.innerHTML = `<div class="account-dialog-header"><h2 id="testAccessTitle">Continue testing</h2>
      <button type="button" class="account-button" aria-label="Close">Close</button></div>
      <div class="account-dialog-body"><p id="testAccessMessage"></p><p class="account-muted" data-detail></p>
      <button type="button" class="account-button account-button--primary" data-continue></button></div>`;
    document.body.append(this.dialog);
    this.message = this.dialog.querySelector('#testAccessMessage');
    this.detail = this.dialog.querySelector('[data-detail]');
    this.action = this.dialog.querySelector('[data-continue]');
    this.overlay = createOverlayController(this.dialog, { adapter: 'dialog', closeEls: [this.dialog.querySelector('[aria-label="Close"]')] });
    this.action.onclick = () => { this.overlay.close(); onContinue(this.code); };
  }
  show(code) {
    this.code = code;
    const guest = code === 'guest_test_limit', free = code === 'free_test_limit';
    this.message.textContent = guest ? 'Sign in for free to run more tests.' : free ? 'Continue testing with Premium.'
      : code === 'account_changed' ? 'Your account changed. Start the test again.'
      : code === 'test_access_busy' ? 'Testing is temporarily busy. Please try again later.'
      : 'We could not check test access. Please reconnect and try again.';
    this.detail.textContent = guest || free ? 'You can also return tomorrow. Your current recording and result remain available.'
      : 'Your current recording and result remain available.';
    this.action.textContent = guest ? 'Sign in for free' : 'Get Lifetime Premium';
    this.action.hidden = !guest && !free;
    this.overlay.open();
  }
  destroy() { this.overlay.destroy(); this.dialog.remove(); }
}
