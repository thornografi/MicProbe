import test from 'node:test';
import assert from 'node:assert/strict';
import StatusManager from '../modules/StatusManager.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

function harness(t) {
  const previousDocument = globalThis.document;
  const nodes = new Map();
  const node = () => ({ hidden: true, dataset: {}, style: { removeProperty() {} },
    setAttribute() {}, removeAttribute() {}, replaceChildren() {}, textContent: '' });
  globalThis.document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node, createTextNode: text => text
  };
  const context = { access: 'checking', category: 'call', mode: null, preparing: false, pending: false, hasResult: false };
  const manager = new StatusManager({
    messageEl: document.getElementById('message'),
    captureHintEl: document.getElementById('captureHint'),
    micHintEl: document.getElementById('microphoneHint')
  }, () => context);
  t.after(() => { manager.destroy(); globalThis.document = previousDocument; });
  const update = (next, event = EVENTS.UI_STATE_CHANGED) => { Object.assign(context, next); eventBus.emit(event); };
  return { manager, update, nodes };
}

test('inline guidance follows permission, preparation, capture and pending analysis', t => {
  const { manager, update, nodes } = harness(t);
  update({}); assert.equal(manager.getStatus(), 'checking');
  update({ access: 'prompt' }, EVENTS.MICROPHONE_ACCESS_CHANGED);
  assert.equal(manager.getStatus(), 'prompt');
  assert.match(nodes.get('microphoneHint').textContent, /allow microphone access/);
  assert.match(nodes.get('captureHint').textContent, /stops automatically/);
  update({ preparing: true, mode: 'test-recording' });
  assert.equal(manager.getStatus(), 'preparing');
  assert.match(nodes.get('captureHint').textContent, /Capture starts when ready/);
  update({ access: 'ready', preparing: false });
  assert.equal(manager.getStatus(), 'testing');
  update({ mode: null, pending: true });
  eventBus.emit(EVENTS.RECORDER_STOPPED);
  assert.equal(manager.getStatus(), 'analysing');
  assert.match(nodes.get('captureHint').textContent, /Analyzing your sample/);
  update({ pending: false, hasResult: true }, EVENTS.DIAGNOSTIC_REPORT_READY);
  assert.equal(manager.getStatus(), 'result');
  assert.match(nodes.get('captureHint').textContent, /Listen to your sample/);
  update({ category: 'record', hasResult: false }, EVENTS.PROFILE_CHANGED);
  assert.match(nodes.get('captureHint').textContent, /stops automatically/);
});

test('permission revocation and recovery do not mask errors or treat an informational message as failure', t => {
  const { manager, update, nodes } = harness(t);
  update({ access: 'denied' }, EVENTS.MICROPHONE_ACCESS_CHANGED);
  assert.equal(manager.getStatus(), 'denied');
  assert.match(nodes.get('microphoneHint').textContent, /access is blocked/);
  eventBus.emit(EVENTS.UI_MESSAGE, { message: 'Capture failed', tone: 'error' });
  update({ access: 'ready' }, EVENTS.MICROPHONE_ACCESS_CHANGED);
  assert.equal(manager.getStatus(), 'error');
  eventBus.emit(EVENTS.UI_CLEAR_MESSAGE);
  assert.equal(manager.getStatus(), 'ready');
  eventBus.emit(EVENTS.UI_MESSAGE, { message: 'Download ready', tone: 'info', status: 'idle' });
  update({}); assert.equal(manager.getStatus(), 'ready');
});
