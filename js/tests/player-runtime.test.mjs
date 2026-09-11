import test from 'node:test';
import assert from 'node:assert/strict';
import Player from '../modules/Player.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function player(t) {
  const globals = ['document', 'Audio', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  globalThis.document = { getElementById: () => null };
  const pending = [];
  globalThis.Audio = class {
    duration = 1; currentTime = 0;
    play() { const result = deferred(); pending.push(result); return result.promise; }
    pause() {}
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const instance = new Player({}); instance.currentUrl = 'audit-audio';
  const messages = [];
  const off = eventBus.on(EVENTS.UI_MESSAGE, message => messages.push(message));
  t.after(() => {
    instance.currentUrl = null; instance.destroy(); off();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { instance, pending, messages };
}

test('an interrupted Play rejection cannot stop or report an error against a newer Play', async t => {
  const { instance, pending, messages } = player(t);
  const first = instance.togglePlay(); instance.pause();
  const second = instance.togglePlay();
  pending[0].reject(new DOMException('Interrupted', 'AbortError')); await first;
  assert.equal(instance.isPlaying, true); assert.equal(messages.length, 0);
  pending[1].resolve(); await second;
});

test('a real playback failure restores controls, stops animation and allows retry', async t => {
  const { instance, pending, messages } = player(t);
  const first = instance.togglePlay();
  pending[0].reject(new DOMException('Unsupported audio', 'NotSupportedError')); await first;
  assert.equal(instance.isPlaying, false); assert.equal(instance.progressAnimId, null);
  assert.equal(messages.length, 1); assert.match(messages[0].message, /could not play/);
  const retry = instance.togglePlay(); pending[1].resolve(); await retry;
  assert.equal(instance.isPlaying, true);
});

test('reset invalidates a pending playback failure', async t => {
  const { instance, pending, messages } = player(t);
  const first = instance.togglePlay(); instance.currentUrl = null; instance.reset();
  pending[0].reject(new DOMException('Old source', 'NotSupportedError')); await first;
  assert.equal(instance.isPlaying, false); assert.equal(messages.length, 0);
});
