import eventBus from '../modules/EventBus.js';
import { CAPTURE_GUIDE, EVENTS } from '../modules/constants.js';

export default class CaptureGuideUI {
  constructor() {
    this.status = document.getElementById('captureGuideStatus');
    this.sample = document.getElementById('captureSampleText');
    this.sampleDisclosure = this.sample.closest('details');
    this.sampleLabel = this.sampleDisclosure.querySelector('summary');
    this.sample.textContent = CAPTURE_GUIDE.SAMPLE_TEXT;
    this.unsubscribers = [
      eventBus.on(EVENTS.CAPTURE_GUIDE_CHANGED, state => this.render(state)),
      eventBus.on(EVENTS.PROFILE_CHANGED, () => {
        this.status.hidden = true;
        this.sampleDisclosure.open = false;
        this.sampleLabel.textContent = "Preview what you’ll read";
      })
    ];
  }
  render({ runId, stage, guided, micName, inputDetected }) {
    if (stage === 'prepare') {
      this.runId = runId;
      this.sampleDisclosure.open = false;
    }
    if (runId !== this.runId) return;
    const messages = {
      prepare: `Getting ${micName} ready. Say a few words.`,
      'input-detected': `Input detected from ${micName}. Get ready to record.`,
      quiet: 'Stay quiet for 3 seconds while we check your surroundings. We’ll tell you when to speak.',
      speak: guided ? 'Now read the sentence below in your normal voice. We’ll stop the recording for you.'
        : 'Recording · Read the sample or speak naturally. Keep the same distance when testing again.',
      captured: 'Recording complete.'
    };
    this.status.hidden = !messages[stage];
    const inputWarning = inputDetected === false && (stage === 'quiet' || stage === 'speak')
      ? 'No input was detected during preparation. Check the selected microphone. ' : '';
    this.status.textContent = inputWarning + (messages[stage] || '');
    this.sampleLabel.textContent = stage === 'speak' ? 'Read this aloud' : "Preview what you’ll read";
    if (stage === 'speak' && guided) this.sampleDisclosure.open = true;
  }
  destroy() {
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
  }
}
