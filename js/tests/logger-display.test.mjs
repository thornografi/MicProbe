import test from 'node:test';
import assert from 'node:assert/strict';
import Logger from '../modules/Logger.js';
import eventBus from '../modules/EventBus.js';
import { EVENTS } from '../modules/constants.js';

// Only DOM/clipboard boundaries are faked; log filtering, history and events
// execute the production Logger. A browser probe measures the real layout cost.
class Element {
  constructor(fragment = false) { this.children = []; this.fragment = fragment; this.heightReads = 0; this.scrollWrites = 0; }
  appendChild(child) {
    if (child.fragment) {
      for (const node of [...child.children]) this.appendChild(node);
      child.children = [];
    } else { this.children.push(child); child.parent = this; }
  }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0]; }
  get scrollHeight() { this.heightReads++; return this.children.length * 20; }
  set scrollTop(value) { this.scrollWrites++; this.lastScroll = value; }
}

let copied;
globalThis.document = {
  createElement: () => new Element(), createDocumentFragment: () => new Element(true),
  querySelectorAll: () => [], querySelector: () => null
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  clipboard: { writeText: async text => { copied = text; } }
} });
const fixture = () => Object.assign(Object.create(Logger.prototype), {
  el: new Element(), history: [], activeFilter: null
});
const categories = ['ui', 'webaudio', 'stream', 'recorder', 'error'];
const history = length => Array.from({ length }, (_, index) => ({
  message: `Line ${index} <plain text>`, category: categories[index % categories.length]
}));
const visible = logger => logger.el.children.map(node => node.textContent);

for (const [filter, accepted] of [[null, categories], ['technical', ['webaudio', 'stream', 'recorder']], ['error', ['error']], ['unknown', []]]) {
  test(`filter ${filter ?? 'all'} keeps display/copy/order and scrolls once without publishing new logs`, async () => {
    const logger = fixture();
    logger.history = history(1000);
    const original = logger.history;
    const expected = original.filter(entry => accepted.includes(entry.category));
    const notifications = [];
    const unsubscribe = eventBus.on(EVENTS.LOG_ADDED, entry => notifications.push(entry));
    try {
      if (filter) logger.filterByCategory(filter); else logger.showAll();
      assert.deepEqual(visible(logger), expected.map(entry => entry.message));
      assert.deepEqual(logger.el.children.map(node => node.className), expected.map(entry => `log-line log-${entry.category}`));
      assert.equal(logger.history, original);
      if (!filter) assert.equal(logger.getFilteredHistory(), original);
      assert.equal(logger.el.heightReads, expected.length ? 1 : 0);
      assert.equal(logger.el.scrollWrites, expected.length ? 1 : 0);
      copied = null;
      assert.equal(await logger.copyAll(), expected.length > 0);
      assert.equal(copied, expected.length ? expected.map(entry => entry.message).join('\n') : null);
      assert.deepEqual(notifications, []);
    } finally { unsubscribe(); }
  });
}

test('live logs retain all categories but only display and publish matches; clearing resets the filter', () => {
  const logger = fixture();
  logger.filterByCategory('technical');
  const notifications = [];
  const unsubscribe = eventBus.on(EVENTS.LOG_ADDED, entry => notifications.push(entry));
  try {
    for (const category of categories) logger.log(`Incoming ${category}`, category);
    assert.deepEqual(logger.history.map(entry => entry.category), categories);
    assert.deepEqual(notifications.map(entry => entry.category), ['webaudio', 'stream', 'recorder']);
    assert.equal(logger.el.childElementCount, 3);
    logger.clear();
    assert.equal(logger.activeFilter, null);
    assert.equal(logger.history.length, 1);
    assert.equal(logger.history[0].raw, 'Log cleared');
    assert.equal(logger.el.childElementCount, 1);
    assert.equal(notifications.at(-1).category, 'system');
    logger.el = null;
    logger.log('No display element', 'error');
    assert.equal(notifications.at(-1).category, 'error');
    assert.doesNotThrow(() => logger.renderFilteredLogs());
  } finally { unsubscribe(); }
});

test('live append and filter rebuild retain the 1000-row cap without rebuilding unmatched live entries', () => {
  const logger = fixture();
  for (let index = 0; index < 1005; index++) logger.log(`Entry ${index}`);
  assert.equal(logger.history.length, 1000);
  assert.equal(logger.el.childElementCount, 1000);
  assert.equal(logger.history[0].raw, 'Entry 5');
  assert.equal(logger.el.firstElementChild.textContent, logger.history[0].message);

  logger.filterByCategory('error');
  logger.log('Visible error', 'error');
  const visibleError = logger.el.firstElementChild;
  for (let index = 0; index < 1000; index++) logger.log('Unmatched live entry', 'ui');
  assert.equal(logger.el.firstElementChild, visibleError, 'unmatched live logs do not rebuild the display');
  logger.renderFilteredLogs();
  assert.equal(logger.el.childElementCount, 0, 'filter rebuild uses the retained history');

  logger.history = history(1005);
  logger.showAll();
  assert.equal(logger.el.childElementCount, 1000);
  assert.equal(logger.el.firstElementChild.textContent, 'Line 5 <plain text>');
});
