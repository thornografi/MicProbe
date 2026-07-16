/**
 * MicProbe - Landing Page JavaScript
 *
 * Sorumluluklar:
 * - View switching (landing <-> app)
 * - Lazy loading of app.js
 * - Route handling (path + hash based)
 * - Navbar scroll effect
 * - Smooth scroll for anchor links
 * - Wave animator initialization
 * - Navigation event binding
 */

import { initWaveAnimator } from './modules/WaveAnimator.js';
import { getCurrentMode, getIsPreparing } from './app/AppState.js';
import { markStartupDiag, markStartupFrameSequence, startStartupDiagnostics } from './modules/StartupDiagnostics.js';

// ============================================
// STATE
// ============================================
let appModule = null;
let appModulePromise = null;
let appLoading = false;
let initialRouteHandled = false;
let appStylesPromise = null;
let fontStylesPromise = null;

startStartupDiagnostics();

const FONT_STYLESHEET_HREF = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&family=Poppins:wght@400;700&family=Rubik:wght@500;600;700;800&display=swap';

const APP_STYLESHEET_HREFS = [
  'css/layout.css',
  'css/header.css',
  'css/panels.css',
  'css/controls.css',
  'css/player.css',
  'css/vu-meter.css',
  'css/drawers.css',
  'css/components.css',
  'css/helpers.css',
  'css/report.css'
];

function findStylesheet(href) {
  const absoluteHref = new URL(href, window.location.href).href;
  return [...document.querySelectorAll('link[rel="stylesheet"]')]
    .find(link => link.getAttribute('href') === href || link.href === absoluteHref);
}

function loadStylesheet(href, marker = 'appStyle') {
  const existing = findStylesheet(href);
  if (existing) {
    markStartupDiag('stylesheet.reused', { href, marker });
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    markStartupDiag('stylesheet.requested', { href, marker });

    const link = document.createElement('link');
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
      resolve();
    };
    document.head.appendChild(link);
  });
}

function ensureFontStylesLoaded() {
  if (!fontStylesPromise) {
    markStartupDiag('fontStyles.ensure.start');
    fontStylesPromise = loadStylesheet(FONT_STYLESHEET_HREF, 'fontStyle')
      .then(() => markStartupDiag('fontStyles.ensure.end'));
  } else {
    markStartupDiag('fontStyles.ensure.reuse');
  }
  return fontStylesPromise;
}

function ensureAppStylesLoaded() {
  if (!appStylesPromise) {
    markStartupDiag('appStyles.ensure.start', { count: APP_STYLESHEET_HREFS.length });
    appStylesPromise = Promise.all(APP_STYLESHEET_HREFS.map(href => loadStylesheet(href, 'appStyle')))
      .then(() => markStartupDiag('appStyles.ensure.end', { count: APP_STYLESHEET_HREFS.length }));
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

function preloadAppModule(reason) {
  markStartupDiag('appModule.preload.start', { reason });
  return loadAppModule(reason)
    .then((module) => {
      markStartupDiag('appModule.preload.ready', { reason });
      return module;
    })
    .catch((err) => {
      markStartupDiag('appModule.preload.failed', { reason, error: err.message });
      return null;
    });
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
    requestIdle(() => {
      markStartupDiag('warmup.appStyles.idle');
      ensureAppStylesLoaded();
    }, { timeout: 3000 });
    requestIdle(() => {
      markStartupDiag('warmup.appModule.idle');
      preloadAppModule('idle');
    }, { timeout: 3500 });
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
export async function showAppView() {
  const trigger = typeof arguments[0] === 'string' ? arguments[0] : 'programmatic';

  // Prevent double loading
  if (appLoading) {
    markStartupDiag('showAppView.ignored.loading', { trigger });
    return;
  }
  appLoading = true;
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
    const newUrl = window.location.origin + '/app';
    if (!hasPurchaseRedirect && window.location.href !== newUrl) {
      history.pushState({ view: 'app' }, '', newUrl);
      markStartupDiag('showAppView.route.updated', { url: newUrl });
    }

    await appModePaintReady;
    markStartupDiag('showAppView.complete');
    window.__micprobeFlushStartupDiagnosticsToLog?.('showAppView.complete');
  } catch (err) {
    markStartupDiag('showAppView.failed', { error: err.message });
    console.error('[Landing] Failed to load app view:', err);
  } finally {
    appLoading = false;
  }
}

/**
 * Show Landing View — aktif operation varsa engelle
 */
export function showLandingView() {
  // State guard: aktif islem varsa navigasyonu engelle
  if (getCurrentMode() || getIsPreparing()) {
    return;
  }

  document.body.classList.remove('app-mode');
  if (initialRouteHandled) {
    const landingView = document.getElementById('landing-view');
    landingView.classList.add('view-enter');
    landingView.addEventListener('animationend', () => landingView.classList.remove('view-enter'), { once: true });
  }
  window.scrollTo(0, 0);

  // Footer'ı landing-view'a geri taşı
  const footer = document.getElementById('sharedFooter');
  if (footer) {
    document.getElementById('landing-view').appendChild(footer);
  }

  // Update URL to root
  if (window.location.pathname !== '/') {
    history.pushState({ view: 'landing' }, '', '/');
  }
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
    showAppView('route:/app');
    return;
  }

  // Hash-based routing (fallback for static hosting)
  if (hash === '#app') {
    showAppView('route:#app');
    return;
  }

  // Default: show landing
  showLandingView();
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
 * Enable smooth scrolling for anchor links in landing view only
 * Excludes #app (handled by view switching) and download links
 */
function initSmoothScroll() {
  document.querySelectorAll('#landing-view a[href^="#"]:not([download])').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const href = this.getAttribute('href');

      // Skip empty hash and #app (handled by showAppView)
      if (href === '#' || href === '#app') return;

      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}

// ============================================
// WAVE ANIMATOR
// ============================================

/**
 * Initialize hero section wave animation
 */
function initWaveAnimation() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  initWaveAnimator('.hero-soundwave', {
    barCount: 280,
    width: 1600,
    height: 260,
    barWidth: 2.5,
    barGap: 3,
    minBarHeight: 6,
    maxBarHeight: 180,
    waveFrequency: 1.8,
    secondaryFrequency: 4.3,
    tertiaryFrequency: 7.1,
    quaternaryFrequency: 11.7,
    centerGap: 0.10,
    centerFadeZone: 0.06,
    edgeFadeStart: 0.35,
    edgeFadeEnd: 0.05,
    centerHeightMin: 0.15,
    centerHeightEasing: 0.5
  });
}

// ============================================
// SCROLL REVEAL
// ============================================

/**
 * Initialize scroll-triggered reveal animations using IntersectionObserver
 */
function initScrollReveal() {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Reduced motion: hemen goster
  if (reducedMotion) {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
    return;
  }

  const revealElements = document.querySelectorAll('.reveal');

  // Viewport ustunde kalmis elementleri hemen goster
  revealElements.forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0) {
      el.classList.add('visible');
    }
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });

  revealElements.forEach(el => {
    if (!el.classList.contains('visible')) {
      observer.observe(el);
    }
  });
}

// ============================================
// NAVIGATION EVENT BINDING
// ============================================

/**
 * Bind click handlers to navigation elements (replaces inline onclick)
 */
function bindNavigationEvents() {
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileNav = document.getElementById('mobileNav');
  const closeMobileMenu = () => {
    if (!mobileMenuBtn || !mobileNav) return;
    mobileNav.classList.remove('open');
    mobileMenuBtn.setAttribute('aria-expanded', 'false');
    mobileMenuBtn.setAttribute('aria-label', 'Open menu');
  };

  if (mobileMenuBtn && mobileNav) {
    mobileMenuBtn.addEventListener('click', () => {
      const isOpen = mobileNav.classList.toggle('open');
      mobileMenuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      mobileMenuBtn.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    });
  }

  // showAppView triggers
  const appViewTriggers = [
    document.getElementById('navbarCta'),
    document.getElementById('heroLaunchBtn'),
    document.getElementById('heroMicIcon')
  ];
  appViewTriggers.forEach(el => {
    if (!el) return;

    const triggerName = el.id || el.className || 'app-trigger';
    el.addEventListener('pointerenter', () => {
      markStartupDiag('appTrigger.pointerenter', { trigger: triggerName });
      ensureAppStylesLoaded();
      preloadAppModule(`pointerenter:${triggerName}`);
    }, { once: true, passive: true });
    el.addEventListener('focus', () => {
      markStartupDiag('appTrigger.focus', { trigger: triggerName });
      ensureAppStylesLoaded();
      preloadAppModule(`focus:${triggerName}`);
    }, { once: true });
    el.addEventListener('touchstart', () => {
      markStartupDiag('appTrigger.touchstart', { trigger: triggerName });
      ensureAppStylesLoaded();
      preloadAppModule(`touchstart:${triggerName}`);
    }, { once: true, passive: true });
    el.addEventListener('click', () => {
      markStartupDiag('appTrigger.click', { trigger: triggerName });
      closeMobileMenu();
      showAppView(`click:${triggerName}`);
    });
  });

  // showLandingView triggers (prevent default for <a> tags)
  const landingViewTriggers = [
    document.getElementById('footerBrand'),
    document.getElementById('appHeaderBrand')
  ];
  landingViewTriggers.forEach(el => el?.addEventListener('click', (e) => {
    e.preventDefault();
    closeMobileMenu();
    showLandingView();
  }));

  mobileNav?.querySelectorAll('a, button').forEach(el => {
    el.addEventListener('click', closeMobileMenu);
  });

  // Hero mic icon hover sync with launch button
  const heroMicIcon = document.getElementById('heroMicIcon');
  const heroLaunchBtn = document.getElementById('heroLaunchBtn');
  if (heroMicIcon && heroLaunchBtn) {
    heroMicIcon.addEventListener('mouseenter', () => heroLaunchBtn.classList.add('mic-hover-active'));
    heroMicIcon.addEventListener('mouseleave', () => heroLaunchBtn.classList.remove('mic-hover-active'));
    // a11y: role=button klavye aktivasyonu (Enter/Space)
    heroMicIcon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        closeMobileMenu();
        markStartupDiag('appTrigger.keydown', { trigger: 'heroMicIcon', key: e.key });
        showAppView(`keydown:heroMicIcon:${e.key}`);
      }
    });
  }
}

// ============================================
// INITIALIZATION
// ============================================

function init() {
  markStartupDiag('landing.init.start', { readyState: document.readyState });
  // Initialize landing page features
  initNavbarScroll();
  initSmoothScroll();
  initWaveAnimation();
  initScrollReveal();
  bindNavigationEvents();
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
