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

// ============================================
// STATE
// ============================================
let appModule = null;
let appLoading = false;
let initialRouteHandled = false;

// ============================================
// VIEW SWITCHING
// ============================================

/**
 * Show App View with lazy loading
 */
export async function showAppView() {
  // Prevent double loading
  if (appLoading) return;

  // Update UI — body.app-mode controls visibility, .hidden only for initial load
  document.body.classList.add('app-mode');
  const appView = document.getElementById('app-view');
  appView.classList.remove('hidden');
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
  const newUrl = window.location.origin + '/app';
  if (window.location.href !== newUrl) {
    history.pushState({ view: 'app' }, '', newUrl);
  }

  // Lazy load app.js if not already loaded
  if (!appModule) {
    appLoading = true;
    try {
      appModule = await import('./app.js');
    } catch (err) {
      console.error('[Landing] Failed to load app module:', err);
    } finally {
      appLoading = false;
    }
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

  // Path-based routing (preferred)
  if (path === '/app' || path === '/app/') {
    showAppView();
    return;
  }

  // Hash-based routing (fallback for static hosting)
  if (hash === '#app') {
    showAppView();
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
  // showAppView triggers
  const appViewTriggers = [
    document.getElementById('navbarCta'),
    document.getElementById('heroLaunchBtn'),
    document.getElementById('heroMicIcon')
  ];
  appViewTriggers.forEach(el => el?.addEventListener('click', showAppView));

  // showLandingView triggers (prevent default for <a> tags)
  const landingViewTriggers = [
    document.getElementById('footerBrand'),
    document.getElementById('appHeaderBrand')
  ];
  landingViewTriggers.forEach(el => el?.addEventListener('click', (e) => {
    e.preventDefault();
    showLandingView();
  }));

  // Hero mic icon hover sync with launch button
  const heroMicIcon = document.getElementById('heroMicIcon');
  const heroLaunchBtn = document.getElementById('heroLaunchBtn');
  if (heroMicIcon && heroLaunchBtn) {
    heroMicIcon.addEventListener('mouseenter', () => heroLaunchBtn.classList.add('mic-hover-active'));
    heroMicIcon.addEventListener('mouseleave', () => heroLaunchBtn.classList.remove('mic-hover-active'));
  }
}

// ============================================
// INITIALIZATION
// ============================================

function init() {
  // Initialize landing page features
  initNavbarScroll();
  initSmoothScroll();
  initWaveAnimation();
  initScrollReveal();
  bindNavigationEvents();

  // Handle initial route (skip animation on first load)
  handleRoute();
  initialRouteHandled = true;
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
