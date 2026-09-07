/**
 * OverlayController - tum overlay'ler icin tek davranis sozlesmesi
 *
 * Kapsam: rapor popup'i ve account dialog'u (native <dialog>), mobil profil
 * cekmecesi ve dev console (class tabanli drawer), landing mobil menusu.
 *
 * Sozlesme:
 * - Tek overlay stack'i: ESC yalnizca en son acilan overlay'i kapatir. Tepede
 *   native <dialog> varsa tarayicinin cancel -> close akisi calisir, biz
 *   dinleyiciden hicbir sey yapmayiz (close event'i stack'ten dusurur).
 * - Backdrop tiklamasi yalnizca o overlay'i kapatir.
 * - Modal overlay'ler arka plani `inert` yapar (refcount'lu; ayni hedef iki
 *   overlay tarafindan inert edildiyse biri kapaninca inert kalir) ve body
 *   scroll'unu tek sayacla kilitler (`html.is-scroll-locked`).
 * - Acilista odak: `initialFocus()` -> ilk odaklanabilir -> overlay'in kendisi.
 *   Kapanista odak: acilmadan onceki eleman (hala bagli, gorunur ve inert degilse)
 *   -> tetikleyici buton.
 * - Tetikleyicide `aria-expanded` senkron tutulur.
 * - Her acilis/kapanista document uzerinde `micprobe:overlay` CustomEvent'i
 *   yayinlanir ({ el, open, modal }); StatusManager toast'i bununla yeniden
 *   yukseltir. EventBus bagimliligi yoktur - modul dusuk seviyede kalir.
 *
 * Modul seviyesinde DOM'a dokunulmaz (Node testleri import edebilsin diye);
 * tum DOM erisimi controller olusturulunca/acilinca yapilir.
 */

const stack = [];
const inertRefs = new WeakMap();
let scrollLocks = 0;
let keydownBound = false;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function isVisible(el) {
  return !!el && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
}

function isInertOrDetached(el) {
  if (!el || !el.isConnected) return true;
  let node = el;
  while (node) {
    if (node.inert) return true;
    node = node.parentElement;
  }
  return false;
}

function handleKeydown(event) {
  if (event.key !== 'Escape' || stack.length === 0) return;
  const top = stack[stack.length - 1];
  if (!top.closeOnEscape) return;
  // Native dialog: tarayici cancel -> close uretir, close event'i stack'i gunceller
  if (top.adapter === 'dialog') return;
  event.preventDefault();
  top.close('escape');
}

function syncKeydownListener() {
  if (typeof document === 'undefined') return;
  if (stack.length > 0 && !keydownBound) {
    document.addEventListener('keydown', handleKeydown);
    keydownBound = true;
  } else if (stack.length === 0 && keydownBound) {
    document.removeEventListener('keydown', handleKeydown);
    keydownBound = false;
  }
}

function changeScrollLock(delta) {
  scrollLocks = Math.max(0, scrollLocks + delta);
  document.documentElement?.classList?.toggle('is-scroll-locked', scrollLocks > 0);
}

function setInert(target, on) {
  if (!target) return;
  const next = Math.max(0, (inertRefs.get(target) || 0) + (on ? 1 : -1));
  inertRefs.set(target, next);
  target.inert = next > 0;
}

function emitOverlayEvent(el, open, modal) {
  if (typeof document === 'undefined' || typeof CustomEvent !== 'function' || !document.dispatchEvent) return;
  document.dispatchEvent(new CustomEvent('micprobe:overlay', { detail: { el, open, modal } }));
}

/**
 * @param {HTMLElement|null} el - Overlay elemani (<dialog> veya .open class'i alan kutu)
 * @param {Object} options
 * @param {'class'|'dialog'} [options.adapter='class'] - 'dialog': showModal()/close(); 'class': .open toggle
 * @param {boolean} [options.modal=true] - inert + scroll-lock; false: yan panel / disclosure
 * @param {HTMLElement|null} [options.backdropEl] - class adapter'da .open alan backdrop; tiklamasi kapatir
 * @param {HTMLElement[]} [options.closeEls] - kapatma butonlari
 * @param {HTMLElement|null} [options.triggerEl] - aria-expanded senkronu ve odak geri donus yedegi
 * @param {Function} [options.inertTargets] - modal class adapter'da inert edilecek elemanlar (() => Element[])
 * @param {Function} [options.initialFocus] - acilista odaklanacak eleman (() => Element|null)
 * @param {boolean} [options.restoreFocus=true]
 * @param {boolean} [options.lockScroll=modal]
 * @param {boolean} [options.closeOnEscape=true]
 * @param {boolean} [options.closeOnBackdrop=true]
 * @param {Function} [options.onOpen]
 * @param {Function} [options.onClose] - (reason) => void
 */
export function createOverlayController(el, options = {}) {
  const {
    adapter = 'class',
    modal = true,
    backdropEl = null,
    closeEls = [],
    triggerEl = null,
    inertTargets = () => [],
    initialFocus = () => null,
    restoreFocus = true,
    lockScroll = modal,
    closeOnEscape = true,
    closeOnBackdrop = true,
    onOpen = null,
    onClose = null
  } = options;

  const isDialog = adapter === 'dialog';
  let previouslyFocused = null;
  let openerEl = null;
  let inertApplied = [];
  let scrollLocked = false;
  let opened = false;
  let destroyed = false;
  const listeners = [];

  const on = (target, type, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };

  const setExpanded = (expanded) => {
    triggerEl?.setAttribute?.('aria-expanded', expanded ? 'true' : 'false');
  };

  const focusInitial = () => {
    const target = initialFocus?.() || el?.querySelector?.(FOCUSABLE) || null;
    if (target?.focus) {
      target.focus({ preventScroll: true });
      return;
    }
    if (el?.focus) {
      if (!el.hasAttribute?.('tabindex')) el.setAttribute?.('tabindex', '-1');
      el.focus({ preventScroll: true });
    }
  };

  const returnFocus = () => {
    if (!restoreFocus) return;
    const candidates = [previouslyFocused, openerEl, triggerEl];
    previouslyFocused = null;
    openerEl = null;
    const target = candidates.find(node => node?.focus && !isInertOrDetached(node) && isVisible(node));
    target?.focus({ preventScroll: true });
  };

  const controller = {
    el,
    adapter,
    modal,
    closeOnEscape,

    isOpen() {
      if (!el) return false;
      return isDialog ? !!el.open : opened;
    },

    /**
     * @param {Object} [opts]
     * @param {HTMLElement|null} [opts.opener] - kapanista odak icin yedek hedef (birden fazla tetikleyici varsa)
     */
    open(opts = {}) {
      if (!el || destroyed || this.isOpen()) return;
      previouslyFocused = (typeof document !== 'undefined' && document.activeElement) || null;
      openerEl = opts?.opener || null;
      opened = true;
      if (isDialog) {
        if (typeof el.showModal === 'function') el.showModal();
        else el.setAttribute('open', '');
      } else {
        el.classList?.add('open');
        backdropEl?.classList?.add('open');
        if (modal) {
          inertApplied = (inertTargets?.() || []).filter(Boolean);
          inertApplied.forEach(target => setInert(target, true));
        }
      }
      if (lockScroll) {
        changeScrollLock(1);
        scrollLocked = true;
      }
      setExpanded(true);
      stack.push(controller);
      syncKeydownListener();
      focusInitial();
      onOpen?.();
      emitOverlayEvent(el, true, modal);
    },

    close(reason = 'programmatic') {
      if (!el || !opened) return;
      if (isDialog && el.open) {
        // Native close event'i asenkron (task) gelir; stack/odak/scroll durumu hemen
        // tutarli olsun diye burada senkron bitirilir, event `opened` guard'iyla no-op olur.
        if (typeof el.close === 'function') { try { el.close(); } catch { el.removeAttribute?.('open'); } }
        else el.removeAttribute?.('open');
      }
      finishClose(reason);
    },

    toggle() {
      this.isOpen() ? this.close('toggle') : this.open();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (opened) finishClose('destroy');
      listeners.forEach(off => off());
      listeners.length = 0;
    }
  };

  function finishClose(reason) {
    if (!opened) return;
    opened = false;
    if (!isDialog) {
      el.classList?.remove('open');
      backdropEl?.classList?.remove('open');
      inertApplied.forEach(target => setInert(target, false));
      inertApplied = [];
    }
    if (scrollLocked) {
      changeScrollLock(-1);
      scrollLocked = false;
    }
    setExpanded(false);
    const index = stack.indexOf(controller);
    const wasTop = index === stack.length - 1;
    if (index >= 0) stack.splice(index, 1);
    syncKeydownListener();
    // Ustunde baska overlay acildiysa (ornek: rapor -> account gecisi) odak ona aittir
    if (wasTop) returnFocus();
    else { previouslyFocused = null; openerEl = null; }
    onClose?.(reason);
    emitOverlayEvent(el, false, modal);
  }

  if (el) {
    closeEls.filter(Boolean).forEach(btn => on(btn, 'click', () => controller.close('button')));
    if (isDialog) {
      // ESC (cancel -> close) veya disaridan el.close(): stack/odak burada toparlanir
      on(el, 'close', () => finishClose('native'));
      if (closeOnBackdrop) on(el, 'click', (event) => { if (event.target === el) controller.close('backdrop'); });
    } else if (backdropEl && closeOnBackdrop) {
      on(backdropEl, 'click', () => controller.close('backdrop'));
    }
  }

  return controller;
}

/** Test/debug: acik overlay sayisi */
export function getOpenOverlayCount() {
  return stack.length;
}
