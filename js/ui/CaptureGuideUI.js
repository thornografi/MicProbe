import eventBus from '../modules/EventBus.js';
import { CAPTURE_GUIDE, EVENTS } from '../modules/constants.js';

export default class CaptureGuideUI {
  constructor() {
    this.status = document.getElementById('captureGuideStatus');
    this.countdown = document.getElementById('recordingTimer');
    this.sample = document.getElementById('captureSampleText');
    this.sampleDisclosure = this.sample.closest('details');
    this.sampleLabel = this.sampleDisclosure.querySelector('summary');
    this.sample.textContent = CAPTURE_GUIDE.SAMPLE_TEXT;
    this.unsubscribers = [
      eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, state => this.render(state)),
      eventBus.on(EVENTS.TEST_COUNTDOWN, ({ runId, remainingSec, phase }) => {
        if (runId !== this.runId || !this.countdown) return;
        this.countdown.hidden = false;
        this.countdown.textContent = `${phase === 'prepare' ? 'Starting in' : 'Finishes in'} ${remainingSec}s`;
      }),
      eventBus.on(EVENTS.PROFILE_CHANGED, () => {
        this.clearCountdown();
        this.status.hidden = true;
        this.sampleDisclosure.open = false;
        this.sampleLabel.textContent = "Preview what you’ll read";
      })
    ];
  }
  clearCountdown() {
    this.runId = null;
    if (this.countdown) { this.countdown.hidden = true; this.countdown.textContent = ''; }
  }
  render({ runId, stage, guided, micName, interrupted, outcome }) {
    if (stage === 'prepare') {
      this.runId = runId;
      this.sampleDisclosure.open = false;
    }
    if (runId !== this.runId) return;
    const messages = {
      prepare: `Getting ${micName} ready. Recording starts shortly.`,
      'input-detected': `Input detected from ${micName}. Get ready to record.`,
      quiet: 'Stay quiet for 3 seconds while we check your surroundings. We’ll tell you when to speak.',
      speak: guided ? 'Now read the sentence below in your normal voice. We’ll stop the recording for you.'
        : 'Recording · Read the sample or speak naturally. Keep the same distance when testing again.',
      captured: outcome?.incomplete ? 'Recording stopped before the test was complete. Preparing the captured sample…'
        : outcome?.early ? 'Recording stopped early. Preparing your sample…' : 'Recording finished. Preparing your sample…'
    };
    if (stage === 'captured' || stage === 'cancelled') this.clearCountdown();
    this.status.hidden = !messages[stage];
    const notice = interrupted && (stage === 'quiet' || stage === 'speak')
      ? 'This test was interrupted while the page was hidden. Audio will be kept, but quiet/speaking comparison is unavailable. ' : '';
    this.status.textContent = notice + (messages[stage] || '');
    this.sampleLabel.textContent = stage === 'speak' ? 'Read this aloud' : "Preview what you’ll read";
    if (stage === 'speak' && guided) this.sampleDisclosure.open = true;
  }
  destroy() {
    this.clearCountdown();
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
  }
}
