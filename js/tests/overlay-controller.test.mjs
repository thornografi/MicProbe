import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayController, getOpenOverlayCount } from '../ui/OverlayController.js';

// Minimal DOM taklidi: OverlayController'in dokundugu API yuzeyi kadar.
function fakeElement({ visible = true, focusable = true } = {}) {
  const el = {
    isConnected: true,
    inert: false,
    parentElement: null,
    attributes: {},
    classes: new Set(),
    listeners: {},
    focused: false,
    visible,
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
      toggle: (c, force) => { force ? el.classes.add(c) : el.classes.delete(c); }
    },
    setAttribute: (k, v) => { el.attributes[k] = v; },
    getAttribute: (k) => el.attributes[k],
    hasAttribute: (k) => k in el.attributes,
    removeAttribute: (k) => { delete el.attributes[k]; },
    addEventListener: (type, fn) => { (el.listeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { el.listeners[type] = (el.listeners[type] || []).filter(f => f !== fn); },
    dispatch: (type, event = {}) => { (el.listeners[type] || []).forEach(fn => fn({ target: el, ...event })); },
    getClientRects: () => (el.visible ? [{}] : []),
    querySelector: () => null,
    focus: focusable ? () => { globalThis.document.activeElement = el; el.focused = true; } : undefined
  };
  return el;
}

function fakeDialog() {
  const el = fakeElement();
  el.open = false;
  el.showModal = () => { el.open = true; };
  el.close = () => { el.open = false; el.dispatch('close'); };
  return el;
}

function harness(t) {
  const previous = globalThis.document;
  const previousCustomEvent = globalThis.CustomEvent;
  const docListeners = {};
  const events = [];
  const html = fakeElement();
  const body = fakeElement();
  globalThis.document = {
    activeElement: body,
    documentElement: html,
    addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => { docListeners[type] = (docListeners[type] || []).filter(f => f !== fn); },
    dispatchEvent: (event) => { events.push(event.detail); (docListeners[event.type] || []).forEach(fn => fn(event)); return true; }
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  const pressEscape = () => {
    let prevented = false;
    (docListeners.keydown || []).forEach(fn => fn({ key: 'Escape', preventDefault: () => { prevented = true; } }));
    return prevented;
  };
  t.after(() => { globalThis.document = previous; globalThis.CustomEvent = previousCustomEvent; });
  return { html, body, events, pressEscape, docListeners };
}

test('ESC closes only the most recently opened overlay, then the next one', t => {
  const { pressEscape } = harness(t);
  const a = createOverlayController(fakeElement(), { modal: false });
  const b = createOverlayController(fakeElement(), { modal: false });
  a.open(); b.open();
  assert.equal(getOpenOverlayCount(), 2);
  pressEscape();
  assert.equal(b.isOpen(), false);
  assert.equal(a.isOpen(), true);
  pressEscape();
  assert.equal(a.isOpen(), false);
  assert.equal(getOpenOverlayCount(), 0);
});

test('keydown listener exists only while an overlay is open', t => {
  const { docListeners } = harness(t);
  const a = createOverlayController(fakeElement(), { modal: false });
  assert.equal((docListeners.keydown || []).length, 0);
  a.open();
  assert.equal(docListeners.keydown.length, 1);
  a.close();
  assert.equal(docListeners.keydown.length, 0);
});

test('focus returns to the previously focused element, or the trigger when it is gone', t => {
  const { body } = harness(t);
  const trigger = fakeElement();
  const opener = fakeElement();
  const closeBtn = fakeElement();
  const overlay = fakeElement();
  const ctrl = createOverlayController(overlay, { modal: false, triggerEl: trigger, initialFocus: () => closeBtn });
  globalThis.document.activeElement = opener;
  ctrl.open();
  assert.equal(globalThis.document.activeElement, closeBtn);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  ctrl.close();
  assert.equal(globalThis.document.activeElement, opener);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');

  globalThis.document.activeElement = opener;
  ctrl.open();
  opener.isConnected = false; // acan eleman DOM'dan kalkti
  ctrl.close();
  assert.equal(globalThis.document.activeElement, trigger);
  globalThis.document.activeElement = body;
});

test('explicit opener restores focus when the browser did not focus the clicked button', t => {
  const { body } = harness(t);
  body.focus = () => {}; // WebKit can leave BODY active when a pointer opens the dialog.
  const opener = fakeElement();
  const closeBtn = fakeElement();
  const ctrl = createOverlayController(fakeDialog(), { initialFocus: () => closeBtn });
  ctrl.open({ opener });
  assert.equal(globalThis.document.activeElement, closeBtn);
  ctrl.close();
  assert.equal(globalThis.document.activeElement, opener);

  const previous = fakeElement();
  globalThis.document.activeElement = previous;
  opener.visible = false;
  ctrl.open({ opener });
  ctrl.close();
  assert.equal(globalThis.document.activeElement, previous, 'A hidden opener falls back to the previous control');
  ctrl.destroy();
});

test('modal overlays lock scroll with a counter and inert targets with refcounts', t => {
  const { html } = harness(t);
  const main = fakeElement();
  const a = createOverlayController(fakeElement(), { modal: true, inertTargets: () => [main] });
  const b = createOverlayController(fakeElement(), { modal: true, inertTargets: () => [main] });
  a.open(); b.open();
  assert.equal(main.inert, true);
  assert.equal(html.classes.has('is-scroll-locked'), true);
  b.close();
  assert.equal(main.inert, true, 'a still holds the inert reference');
  assert.equal(html.classes.has('is-scroll-locked'), true);
  a.close();
  assert.equal(main.inert, false);
  assert.equal(html.classes.has('is-scroll-locked'), false);
});

test('backdrop click closes only its own overlay', t => {
  harness(t);
  const backdropA = fakeElement();
  const a = createOverlayController(fakeElement(), { modal: false, backdropEl: backdropA });
  const b = createOverlayController(fakeElement(), { modal: false });
  a.open(); b.open();
  backdropA.dispatch('click');
  assert.equal(a.isOpen(), false);
  assert.equal(b.isOpen(), true);
  assert.equal(backdropA.classes.has('open'), false);
  b.close();
  assert.equal(getOpenOverlayCount(), 0);
});

test('dialog adapter: native close event drops the stack entry and ESC is left to the browser', t => {
  const { pressEscape, events } = harness(t);
  const dialog = fakeDialog();
  const ctrl = createOverlayController(dialog, { adapter: 'dialog' });
  ctrl.open();
  assert.equal(dialog.open, true);
  assert.equal(getOpenOverlayCount(), 1);
  assert.equal(pressEscape(), false, 'ESC on a native dialog is not intercepted');
  dialog.close(); // tarayici cancel -> close
  assert.equal(getOpenOverlayCount(), 0);
  assert.deepEqual(events.map(e => e.open), [true, false]);
  ctrl.open();
  ctrl.close();
  assert.equal(dialog.open, false);
  assert.equal(getOpenOverlayCount(), 0);
});

test('an old queued native close cannot detach a reopened dialog from its controller', t => {
  const { html } = harness(t), dialog = fakeDialog();
  dialog.close = () => { dialog.open = false; };
  const ctrl = createOverlayController(dialog, { adapter: 'dialog' });
  ctrl.open(); ctrl.close(); ctrl.open();
  dialog.dispatch('close');
  assert.equal(getOpenOverlayCount(), 1);
  assert.equal(html.classes.has('is-scroll-locked'), true);
  ctrl.close();
  assert.equal(dialog.open, false); assert.equal(getOpenOverlayCount(), 0);
  dialog.dispatch('close'); ctrl.destroy();
});

test('closing an overlay that is no longer on top does not steal focus from the overlay above it', t => {
  harness(t);
  const opener = fakeElement();
  const upperFocus = fakeElement();
  const lower = createOverlayController(fakeElement(), { modal: false });
  const upper = createOverlayController(fakeElement(), { modal: false, initialFocus: () => upperFocus });
  globalThis.document.activeElement = opener;
  lower.open();
  upper.open();
  lower.close();
  assert.equal(globalThis.document.activeElement, upperFocus);
  upper.close();
});

test('destroy closes an open overlay and unbinds its listeners', t => {
  harness(t);
  const closeBtn = fakeElement();
  const ctrl = createOverlayController(fakeElement(), { modal: false, closeEls: [closeBtn] });
  ctrl.open();
  ctrl.destroy();
  assert.equal(ctrl.isOpen(), false);
  assert.equal(closeBtn.listeners.click.length, 0);
  assert.equal(getOpenOverlayCount(), 0);
});
