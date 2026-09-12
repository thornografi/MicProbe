/**
 * MicProbe - Landing Page JavaScript
 *
 * Sorumluluklar:
 * - View switching (landing <-> app)
 * - Lazy loading of app.js
 * - Route handling (path + hash based)
 * - Navbar scroll effect
 * - Smooth scroll for anchor links
 * - Decorative hero waveform
 * - Navigation event binding
 */

import { createOverlayController, closeAllOverlays } from './ui/OverlayController.js';
import { appPageTitle } from './modules/utils/ui.js';
import APP_STYLESHEET_HREFS from './app-styles.js';
import { initWaveAnimator } from './modules/WaveAnimator.js';
import { createLandingPricing } from './landing-pricing.js';
import { initAccountHeader } from './ui/AccountHeader.js';
import { accountHash, accountIntentFromHash } from './modules/AccountNavigation.js';
import { getCurrentMode, getIsPreparing } from './app/AppState.js';
import { markStartupDiag, markStartupFrameSequence, startStartupDiagnostics } from './modules/StartupDiagnostics.js';

// ============================================
// STATE
// ============================================
let appModule = null;
let loadLandingPrice;
let pendingAccountIntent = null;
const LANDING_HASHES = ['#features', '#how-it-works', '#pricing', '#faq', '#faq-privacy', '#faq-test-limits', '#faq-saved-reports'];
let appModulePromise = null;
let viewRevision = 0;
let initialRouteHandled = false;
let appStylesPromise = null;
let fontStylesPromise = null;
const stylesheetLoads = new Map();
let activeEntry = { url: window.location.href, index: history.state?.micprobeIndex ?? 0 };
// /app has its own initial metadata in a build; returning home restores this title.
const LANDING_TITLE = document.querySelector('meta[property="og:site_name"]')
  ? 'MicProbe — Check your microphone before a call' : document.title;

startStartupDiagnostics();

const FONT_STYLESHEET_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap';

function findStylesheet(href) {
  const absoluteHref = new URL(href, window.location.href).href;
  return [...document.querySelectorAll('link[rel="stylesheet"]')]
    .find(link => link.getAttribute('href') === href || link.href === absoluteHref);
}

function loadStylesheet(href, marker = 'appStyle') {
  if (stylesheetLoads.has(href)) return stylesheetLoads.get(href);
  const existing = findStylesheet(href);
  if (existing?.sheet) {
    markStartupDiag('stylesheet.reused', { href, marker });
    return Promise.resolve();
  }

  const pending = new Promise((resolve, reject) => {
    const startedAt = performance.now();
    markStartupDiag('stylesheet.requested', { href, marker });

    const link = existing || document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset[marker] = 'true';
    link.onload = () => {
      markStartupDiag('stylesheet.loaded', {
        href,
        marker,
        ms: Math.round((performance.now() - startedAt) * 10) / 10
      });
      resolve();
    };
    link.onerror = () => {
      markStartupDiag('stylesheet.failed', {
        href,
        marker,
        ms: Math.round((performance.now() - startedAt) * 10) / 10
      });
      console.error(`[Landing] Failed to load stylesheet: ${href}`);
      link.remove();
      reject(new Error(`Failed to load stylesheet: ${href}`));
    };
    if (!existing) document.head.appendChild(link);
  }).catch(error => {
    stylesheetLoads.delete(href);
    throw error;
  });
  stylesheetLoads.set(href, pending);
  return pending;
}

function ensureFontStylesLoaded() {
  if (!fontStylesPromise) {
    markStartupDiag('fontStyles.ensure.start');
    fontStylesPromise = loadStylesheet(FONT_STYLESHEET_HREF, 'fontStyle')
      .then(() => markStartupDiag('fontStyles.ensure.end'))
      .catch(() => { fontStylesPromise = null; }); // System fonts remain usable.
  } else {
    markStartupDiag('fontStyles.ensure.reuse');
  }
  return fontStylesPromise;
}

function ensureAppStylesLoaded() {
  if (!appStylesPromise) {
    markStartupDiag('appStyles.ensure.start', { count: APP_STYLESHEET_HREFS.length });
    appStylesPromise = Promise.all(APP_STYLESHEET_HREFS.map(href => loadStylesheet(href, 'appStyle')))
      .then(() => markStartupDiag('appStyles.ensure.end', { count: APP_STYLESHEET_HREFS.length }))
      .catch(error => { appStylesPromise = null; throw error; });
  } else {
    markStartupDiag('appStyles.ensure.reuse');
  }
  return appStylesPromise;
}

function loadAppModule(reason = 'demand') {
  if (appModule) {
    markStartupDiag('appModule.load.reused', { reason });
    return Promise.resolve(appModule);
  }

  if (!appModulePromise) {
    markStartupDiag('appModule.load.requested', { reason });
    appModulePromise = import('./app.js')
      .then((module) => {
        appModule = module;
        markStartupDiag('appModule.load.resolved', { reason });
        return module;
      })
      .catch((err) => {
        appModulePromise = null;
        markStartupDiag('appModule.load.failed', { reason, error: err.message });
        throw err;
      });
  } else {
    markStartupDiag('appModule.load.pending', { reason });
  }

  return appModulePromise;
}

function loadAppModuleForView() {
  if (appModule) {
    markStartupDiag('showAppView.appImport.reused');
    return Promise.resolve(appModule);
  }

  markStartupDiag('showAppView.appImport.requested', { preloadInFlight: !!appModulePromise });
  return loadAppModule('showAppView').then((module) => {
    markStartupDiag('showAppView.appImport.resolved');
    return module;
  });
}

function schedulePostLoadWarmups() {
  const warmup = () => {
    markStartupDiag('warmup.schedule', { readyState: document.readyState });
    const requestIdle = window.requestIdleCallback || ((cb) => window.setTimeout(cb, 1200));
    requestIdle(() => {
      markStartupDiag('warmup.font.idle');
      ensureFontStylesLoaded();
    }, { timeout: 1000 });
  };

  if (document.readyState === 'complete') {
    warmup();
  } else {
    window.addEventListener('load', warmup, { once: true });
  }
}

// ============================================
// VIEW SWITCHING
// ============================================

/**
 * Show App View with lazy loading
 */
export async function showAppView(trigger = 'programmatic', historyMode = 'push', accountIntent = null) {
  pendingAccountIntent = accountIntent || (trigger === 'retry' ? pendingAccountIntent
    : trigger.startsWith('route:') ? accountIntentFromHash(window.location.hash) : null);

  // Imports/styles already share their promises; only the latest navigation may commit.
  const revision = ++viewRevision;
  setLoadStatus('loading');
  markStartupDiag('showAppView.start', {
    trigger,
    appModuleLoaded: !!appModule,
    path: window.location.pathname,
    hash: window.location.hash
  });

  const appView = document.getElementById('app-view');
  const appLoad = loadAppModuleForView();
  const stylesLoad = ensureAppStylesLoaded()
    .then(() => markStartupDiag('showAppView.styles.ready'));

  try {
    await Promise.all([stylesLoad, appLoad]);
    if (revision !== viewRevision) return;
    setLoadStatus();
    markStartupDiag('showAppView.readyToSwap');

    // Update UI — body.app-mode controls visibility, .hidden only for initial load
    document.body.classList.add('app-mode');
    appView.classList.remove('hidden');
    markStartupDiag('showAppView.appMode.applied');
    const appModePaintReady = markStartupFrameSequence('showAppView.appMode');
    if (initialRouteHandled) {
      appView.classList.add('view-enter');
      appView.addEventListener('animationend', () => appView.classList.remove('view-enter'), { once: true });
    }
    window.scrollTo(0, 0);

    // Footer'ı app-shell'e taşı
    const footer = document.getElementById('sharedFooter');
    if (footer) {
      document.querySelector('.app-shell').appendChild(footer);
    }

    // Update URL (hibrit: path-based tercih, hash fallback)
    // Freemius geri dönüş parametreleri (imzalı satın alma kanıtı) varsa URL'yi
    // normalize ETME — aksi halde PremiumAccess okumadan önce silinir. Temizligi
    // dogrulama sonrasi PremiumAccess._cleanFreemiusParamsFromUrl() ustleniyor.
    const hasPurchaseRedirect = new URLSearchParams(window.location.search).has('signature');
    const hasGoogleReturn = /^#google_(return|error)=/.test(window.location.hash);
    // Account bootstrap owns the Google return marker, just as billing owns
    // its signed checkout parameters. Keep it until the session is checked.
    const newUrl = hasPurchaseRedirect || hasGoogleReturn ? window.location.href
      : '/app' + window.location.search + (pendingAccountIntent ? accountHash(pendingAccountIntent) : '');
    updateRoute(newUrl, historyMode);
    const heading = appView.querySelector('#scenarioWorkspace:not([hidden]) h1')
      || appView.querySelector('#scenarioPicker h1');
    document.title = appPageTitle(heading);
    // An owned checkout can open a dialog during startup; keep its focus.
    if (!document.querySelector('dialog[open]')) heading?.focus({ preventScroll: true });
    if (pendingAccountIntent) {
      appModule?.openAccount?.(pendingAccountIntent);
      pendingAccountIntent = null;
    } else {
      appModule?.syncAccountSignIn?.();
    }

    await appModePaintReady;
    markStartupDiag('showAppView.complete');
    window.__micprobeFlushStartupDiagnosticsToLog?.('showAppView.complete');
  } catch (err) {
    if (revision !== viewRevision) return;
    setLoadStatus('error');
    markStartupDiag('showAppView.failed', { error: err.message });
    console.error('[Landing] Failed to load app view:', err);
  }
}

/**
 * Show Landing View — aktif operation varsa engelle
 */
export function showLandingView({ hash = '', historyMode = 'push', smooth = false } = {}) {
  // State guard: aktif islem varsa navigasyonu engelle
  if (isBusy()) return false;
  pendingAccountIntent = null;
  void loadLandingPrice?.();
  ++viewRevision;
  setLoadStatus();

  closeAllOverlays();
  document.body.classList.remove('app-mode');
  appModule?.syncAccountSignIn?.();
  if (initialRouteHandled) {
    const landingView = document.getElementById('landing-view');
    landingView.classList.add('view-enter');
    landingView.addEventListener('animationend', () => landingView.classList.remove('view-enter'), { once: true });
  }
  const target = hash ? document.getElementById(hash.slice(1)) : document.getElementById('hero-title');
  if (target?.matches('details')) target.open = true;
  const heading = target?.matches('h1, h2') ? target : target?.querySelector('h1, h2, summary');
  // Leave the initial home page at the document start so Tab reaches the skip link.
  if (initialRouteHandled || hash) heading?.focus({ preventScroll: true });
  if (hash) target?.scrollIntoView({ behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' });
  else window.scrollTo(0, 0);

  // Footer'ı landing-view'a geri taşı
  const footer = document.getElementById('sharedFooter');
  if (footer) {
    document.getElementById('landing-view').appendChild(footer);
  }

  document.title = LANDING_TITLE;
  updateRoute('/' + window.location.search + hash, historyMode);
  return true;
}

function isBusy() {
  return getCurrentMode() || getIsPreparing() || appModule?.isWorkflowBusy?.();
}

// Normalization replaces the current entry; only an explicit new destination pushes.
function updateRoute(destination, mode) {
  const url = new URL(destination, window.location.href).href;
  const push = mode === 'push' && url !== window.location.href;
  const index = push ? activeEntry.index + 1 : history.state?.micprobeIndex ?? activeEntry.index;
  history[push ? 'pushState' : 'replaceState']({ ...history.state, micprobeIndex: index }, '', url);
  activeEntry = { url, index };
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    const path = document.body.classList.contains('app-mode') ? '/app' : '/';
    canonical.href = new URL(path, canonical.href).href;
    document.querySelector('meta[property="og:url"]')?.setAttribute('content', canonical.href);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
  }
}

function setLoadStatus(state) {
  const status = document.getElementById('appLoadStatus');
  status.hidden = !state;
  document.getElementById('appLoadMessage').textContent = state === 'error'
    ? 'MicProbe could not open. Check your connection and try again.' : 'Opening MicProbe…';
  document.getElementById('appLoadRetry').hidden = state !== 'error';
  document.getElementById('app-view').setAttribute('aria-busy', String(state === 'loading'));
  if (state === 'error') document.getElementById('appLoadMessage').focus({ preventScroll: true });
}

// ============================================
// ROUTE HANDLING
// ============================================

/**
 * Handle route based on URL path or hash
 * Supports both /app and #app
 */
function handleRoute() {
  const path = window.location.pathname;
  const hash = window.location.hash;
  markStartupDiag('route.handle', { path, hash });

  // Path-based routing (preferred)
  if (path === '/app' || path === '/app/') {
    if (appModule && !accountIntentFromHash(hash) && !/^#google_(return|error)=/.test(hash)
      && !new URLSearchParams(window.location.search).has('signature')) appModule.closeAccount?.();
    showAppView('route:/app', 'replace');
    return;
  }

  // Hash-based routing (fallback for static hosting)
  if (hash === '#app') {
    showAppView('route:#app', 'replace');
    return;
  }

  if (isBusy()) {
    // popstate happens after the address changes. Restore the accepted entry
    // without adding entries or interrupting capture / pending report analysis.
    const index = history.state?.micprobeIndex;
    if (Number.isInteger(index) && index !== activeEntry.index) history.go(activeEntry.index - index);
    else history.replaceState({ ...history.state, micprobeIndex: activeEntry.index }, '', activeEntry.url);
    return;
  }
  showLandingView({ hash: LANDING_HASHES.includes(hash) ? hash : '', historyMode: 'replace' });
}

// ============================================
// NAVBAR
// ============================================

/**
 * Add/remove scrolled class on navbar based on scroll position
 */
function initNavbarScroll() {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;

  const updateNavbar = () => {
    navbar.classList.toggle('scrolled', window.scrollY > 50);
  };

  window.addEventListener('scroll', updateNavbar, { passive: true });
  updateNavbar(); // Initial state
}

// ============================================
// SMOOTH SCROLL
// ============================================

/**
 * Section links also work after the shared footer moves into the app.
 * Keep the existing capture guard and respect reduced-motion preferences.
 */
function initSmoothScroll() {
  document.querySelectorAll('#landing-view a[href^="#"]:not([download]), #landing-view a[href^="/#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      if (!isPlainClick(e)) return;
      const href = new URL(this.getAttribute('href'), window.location.href).hash;

      // Skip empty hash and #app (handled by showAppView)
      if (!href || href === '#app') return;

      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        showLandingView({ hash: href, smooth: true });
      }
    });
  });
}

function isPlainClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

// ============================================
// NAVIGATION EVENT BINDING
// ============================================

/**
 * Bind click handlers to navigation elements (replaces inline onclick)
 */
function bindNavigationEvents() {
  document.getElementById('skipToContent')?.addEventListener('click', event => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    const target = document.body.classList.contains('app-mode')
      ? document.querySelector('#scenarioWorkspace:not([hidden]) h1') || document.getElementById('scenarioPickerTitle')
      : document.getElementById('landing-main');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  });
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileNav = document.getElementById('mobileNav');
  // Mobil menu: modal olmayan disclosure; ESC + aria-expanded OverlayController'dan
  const mobileMenu = createOverlayController(mobileNav, {
    modal: false,
    triggerEl: mobileMenuBtn,
    restoreFocus: false,
    onOpen: () => mobileMenuBtn?.setAttribute('aria-label', 'Close menu'),
    onClose: () => mobileMenuBtn?.setAttribute('aria-label', 'Open menu')
  });
  const closeMobileMenu = () => mobileMenu.close();
  mobileMenuBtn?.addEventListener('click', () => mobileMenu.toggle());

  // showAppView triggers
  const appViewTriggers = [
    document.getElementById('navbarCta'),
    document.getElementById('heroLaunchBtn'),
    document.getElementById('heroMicIcon'),
    ...document.querySelectorAll('[data-open-app]')
  ];
  appViewTriggers.forEach(el => {
    if (!el) return;

    const triggerName = el.id || el.className || 'app-trigger';
    el.addEventListener('click', (e) => {
      if (!isPlainClick(e)) return;
      e.preventDefault();
      markStartupDiag('appTrigger.click', { trigger: triggerName });
      closeMobileMenu();
      showAppView(`click:${triggerName}`, 'push', el.dataset.accountIntent || null);
    });
  });

  // showLandingView triggers (prevent default for <a> tags)
  const landingViewTriggers = [
    document.getElementById('navbarBrand'),
    document.getElementById('footerBrand'),
    document.getElementById('appHeaderBrand')
  ];
  landingViewTriggers.forEach(el => el?.addEventListener('click', (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    closeMobileMenu();
    showLandingView();
  }));

  mobileNav?.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', closeMobileMenu);
  });

  document.getElementById('appLoadRetry').addEventListener('click', () => {
    // A failed module evaluation stays cached for this document. Start a new
    // document on explicit retry; CSS-only failures can recover in place.
    if (!appModule) window.location.assign('/app' + window.location.search + (pendingAccountIntent ? accountHash(pendingAccountIntent) : ''));
    else showAppView('retry', window.location.pathname.startsWith('/app') ? 'replace' : 'push');
  });
  document.getElementById('appLoadCancel').addEventListener('click', () => showLandingView());

}

// ============================================
// INITIALIZATION
// ============================================

function init() {
  markStartupDiag('landing.init.start', { readyState: document.readyState });
  initAccountHeader();
  document.addEventListener('micprobe:account-route', event => {
    if (!document.body.classList.contains('app-mode') || /^#google_(return|error)=/.test(window.location.hash)
        || new URLSearchParams(window.location.search).has('signature')) return;
    updateRoute('/app' + window.location.search + (event.detail.intent ? accountHash(event.detail.intent) : ''), 'replace');
  });
  // Initialize landing page features
  initNavbarScroll();
  initSmoothScroll();
  initWaveAnimator('.hero-soundwave', {
    barCount: 132,
    width: 800,
    height: 180,
    barWidth: 3,
    barGap: 3,
    minBarHeight: 6,
    maxBarHeight: 146,
    centerGap: 0.14,
    centerFadeZone: 0.08,
    edgeFadeStart: 0.16,
    edgeFadeEnd: 0.015
  });
  bindNavigationEvents();
  loadLandingPrice = createLandingPricing();
  schedulePostLoadWarmups();

  // Handle initial route (skip animation on first load)
  handleRoute();
  initialRouteHandled = true;
  markStartupDiag('landing.init.end', { initialRouteHandled });
}

// ============================================
// EVENT LISTENERS
// ============================================

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Handle browser back/forward
window.addEventListener('popstate', handleRoute);
window.addEventListener('hashchange', () => {
  if (window.location.href !== activeEntry.url) handleRoute();
});
