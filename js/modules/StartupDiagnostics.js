/**
 * StartupDiagnostics - landing -> app transition trace helper.
 *
 * Lightweight and dependency-free so it can run before app.js/logging loads.
 */

const TRACE_LIMIT = 400;
const RESOURCE_LIMIT = 300;
const LONG_TASK_LIMIT = 80;
const ERROR_LIMIT = 80;

const globalTrace = window.__micprobeStartupDiagnostics || {
  id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  createdAt: new Date().toISOString(),
  timeOrigin: performance.timeOrigin,
  entries: [],
  resources: [],
  longTasks: [],
  errors: [],
  observersStarted: false,
  marks: {}
};

window.__micprobeStartupDiagnostics = globalTrace;

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function bytesToKB(bytes) {
  return Number.isFinite(bytes) ? Math.round(bytes / 102.4) / 10 : 0;
}

function safeDetails(details = {}) {
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return { unserializable: true };
  }
}

function now() {
  return performance.now();
}

function firstEntryTime() {
  return globalTrace.entries[0]?.t ?? now();
}

function trim(list, limit) {
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
}

function normalizeResourceName(name) {
  try {
    const url = new URL(name, window.location.href);
    return url.origin === window.location.origin
      ? url.pathname.replace(/^\//, '')
      : url.hostname + url.pathname;
  } catch {
    return String(name);
  }
}

function captureResourceEntry(entry) {
  const resource = {
    name: normalizeResourceName(entry.name),
    type: entry.initiatorType || 'unknown',
    start: round(entry.startTime),
    end: round(entry.responseEnd),
    duration: round(entry.duration),
    transferKB: bytesToKB(entry.transferSize || 0),
    encodedKB: bytesToKB(entry.encodedBodySize || 0)
  };

  globalTrace.resources.push(resource);
  trim(globalTrace.resources, RESOURCE_LIMIT);
}

function captureResourceError(event) {
  const target = event.target;
  const url = target?.src || target?.href;
  if (!url) return;

  globalTrace.errors.push({
    type: 'resource',
    url: normalizeResourceName(url),
    tagName: target?.tagName,
    at: round(now())
  });
  trim(globalTrace.errors, ERROR_LIMIT);
}

function targetLabel(target) {
  if (!target || target === window) return 'window';
  if (target === document) return 'document';
  if (target.nodeType !== Node.ELEMENT_NODE) return String(target.nodeName || 'unknown');

  const element = target.closest?.('#navbarCta, #heroLaunchBtn, #heroMicIcon, button, a, [role="button"]') || target;
  const id = element.id ? `#${element.id}` : '';
  const tag = element.tagName?.toLowerCase() || 'element';
  const classes = typeof element.className === 'string'
    ? element.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    : '';
  const classLabel = classes ? `.${classes}` : '';
  const text = element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 48) || '';
  return `${tag}${id}${classLabel}${text ? ` "${text}"` : ''}`;
}

function inputDetails(event) {
  const eventStampDelay = Number.isFinite(event.timeStamp)
    ? round(now() - event.timeStamp)
    : null;

  return {
    target: targetLabel(event.target),
    pointerType: event.pointerType || null,
    button: Number.isFinite(event.button) ? event.button : null,
    buttons: Number.isFinite(event.buttons) ? event.buttons : null,
    key: event.key || null,
    clientX: Number.isFinite(event.clientX) ? Math.round(event.clientX) : null,
    clientY: Number.isFinite(event.clientY) ? Math.round(event.clientY) : null,
    isTrusted: !!event.isTrusted,
    eventStampDelay
  };
}

function captureInputEvent(event) {
  markStartupDiag(`input.${event.type}`, inputDetails(event));
}

function startBodyClassObserver() {
  const attach = () => {
    if (!document.body || globalTrace.bodyClassObserver) return;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.attributeName !== 'class') continue;
        markStartupDiag('body.class.changed', {
          appMode: document.body.classList.contains('app-mode'),
          className: document.body.className
        });
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    globalTrace.bodyClassObserver = observer;
  };

  if (document.body) {
    attach();
  } else {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  }
}

export function markStartupDiag(stage, details = {}) {
  const t = now();
  const entry = {
    stage,
    t: round(t),
    delta: round(t - firstEntryTime()),
    details: safeDetails(details)
  };

  globalTrace.entries.push(entry);
  globalTrace.marks[stage] = entry;
  trim(globalTrace.entries, TRACE_LIMIT);
  return entry;
}

export function markStartupFrameSequence(stage) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      markStartupDiag(`${stage}.raf1`);
      requestAnimationFrame(() => {
        const entry = markStartupDiag(`${stage}.raf2`);
        resolve(entry);
      });
    });
  });
}

export function startStartupDiagnostics() {
  if (globalTrace.observersStarted) return;
  globalTrace.observersStarted = true;

  markStartupDiag('diag.start', {
    url: window.location.href,
    readyState: document.readyState,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    dpr: window.devicePixelRatio || 1,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false
  });

  performance.getEntriesByType('resource').forEach(captureResourceEntry);

  if ('PerformanceObserver' in window) {
    try {
      const resourceObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach(captureResourceEntry);
      });
      resourceObserver.observe({ type: 'resource', buffered: true });
      globalTrace.resourceObserver = resourceObserver;
    } catch {
      markStartupDiag('diag.resourceObserver.unavailable');
    }

    try {
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        const longTaskObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            globalTrace.longTasks.push({
              start: round(entry.startTime),
              duration: round(entry.duration),
              name: entry.name
            });
          });
          trim(globalTrace.longTasks, LONG_TASK_LIMIT);
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
        globalTrace.longTaskObserver = longTaskObserver;
      }
    } catch {
      markStartupDiag('diag.longTaskObserver.unavailable');
    }
  }

  window.addEventListener('error', captureResourceError, true);

  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart', 'keydown'].forEach((eventName) => {
    window.addEventListener(eventName, captureInputEvent, { capture: true, passive: true });
  });

  startBodyClassObserver();
}

export function getStartupDiagnostics() {
  const nav = performance.getEntriesByType('navigation')[0];
  const navigation = nav ? {
    responseStart: round(nav.responseStart),
    responseEnd: round(nav.responseEnd),
    domContentLoaded: round(nav.domContentLoadedEventEnd),
    load: round(nav.loadEventEnd),
    transferKB: bytesToKB(nav.transferSize || 0),
    encodedKB: bytesToKB(nav.encodedBodySize || 0)
  } : null;

  return {
    id: globalTrace.id,
    createdAt: globalTrace.createdAt,
    exportedAt: new Date().toISOString(),
    url: window.location.href,
    navigation,
    entries: [...globalTrace.entries],
    resources: [...globalTrace.resources],
    longTasks: [...globalTrace.longTasks],
    errors: [...globalTrace.errors]
  };
}

function durationBetween(startStage, endStage) {
  const start = globalTrace.marks[startStage]?.t;
  const end = globalTrace.marks[endStage]?.t;
  return Number.isFinite(start) && Number.isFinite(end) ? round(end - start) : null;
}

function latestEntryAfter(stages, afterTime = 0) {
  const stageSet = new Set(stages);
  for (let index = globalTrace.entries.length - 1; index >= 0; index -= 1) {
    const entry = globalTrace.entries[index];
    if (stageSet.has(entry.stage) && entry.t >= afterTime - 0.1) {
      return entry;
    }
  }
  return null;
}

function latestEntryBefore(stages, beforeTime = Number.POSITIVE_INFINITY) {
  const stageSet = new Set(stages);
  for (let index = globalTrace.entries.length - 1; index >= 0; index -= 1) {
    const entry = globalTrace.entries[index];
    if (stageSet.has(entry.stage) && entry.t <= beforeTime + 0.1) {
      return entry;
    }
  }
  return null;
}

function resourceSummary(startTime = null, endTime = null) {
  const resources = startTime === null
    ? globalTrace.resources
    : globalTrace.resources.filter(resource => {
        const startsAfter = resource.start >= startTime - 1;
        const startsBefore = endTime === null || resource.start <= endTime + 1;
        return startsAfter && startsBefore;
      });

  const byKind = {
    js: resources.filter(resource => resource.name.startsWith('js/') || resource.name.endsWith('.js')),
    css: resources.filter(resource => resource.name.startsWith('css/') || resource.name.endsWith('.css')),
    font: resources.filter(resource => resource.name.includes('fonts.') || /\.(woff2?|ttf|otf)$/i.test(resource.name)),
    api: resources.filter(resource => resource.name.startsWith('api/'))
  };

  const summarize = (items) => ({
    count: items.length,
    encodedKB: bytesToKB(items.reduce((sum, item) => sum + (item.encodedKB * 1024), 0)),
    lastEnd: items.length ? Math.max(...items.map(item => item.end || 0)) : null
  });

  return {
    js: summarize(byKind.js),
    css: summarize(byKind.css),
    font: summarize(byKind.font),
    api: summarize(byKind.api)
  };
}

export function getStartupDiagnosticLogLines() {
  const snapshot = getStartupDiagnostics();
  const showStart = globalTrace.marks['showAppView.start']?.t ?? null;
  const resources = resourceSummary(showStart);
  const nav = snapshot.navigation || {};
  const latestShow = globalTrace.marks['showAppView.start'];
  const showTime = latestShow?.t ?? null;
  const stylesReady = latestEntryAfter(['showAppView.styles.ready'], showTime ?? 0);
  const appModeApplied = latestEntryAfter(['showAppView.appMode.applied'], showTime ?? 0);
  const appImportReady = latestEntryAfter(
    ['showAppView.appImport.resolved', 'showAppView.appImport.reused'],
    showTime ?? 0
  );
  const appSwapReady = latestEntryAfter(['showAppView.readyToSwap'], showTime ?? 0);
  const appComplete = latestEntryAfter(['showAppView.complete'], showTime ?? 0);
  const appPaint2 = latestEntryAfter(['showAppView.appMode.raf2'], showTime ?? 0);

  const showToStyles = latestShow && stylesReady ? round(stylesReady.t - latestShow.t) : null;
  const showToVisible = latestShow && appModeApplied ? round(appModeApplied.t - latestShow.t) : null;
  const showToImport = latestShow && appImportReady ? round(appImportReady.t - latestShow.t) : null;
  const showToSwapReady = latestShow && appSwapReady ? round(appSwapReady.t - latestShow.t) : null;
  const showToComplete = latestShow && appComplete ? round(appComplete.t - latestShow.t) : null;
  const moduleEvalToReady = durationBetween('app.module.evaluating', 'app.ready');
  const showToPaint2 = latestShow && appPaint2 ? round(appPaint2.t - latestShow.t) : null;

  const latestPointerStart = latestEntryBefore(
    ['input.pointerdown', 'input.mousedown', 'input.touchstart', 'input.keydown'],
    showTime ?? Number.POSITIVE_INFINITY
  );
  const latestClick = latestEntryBefore(['input.click'], showTime ?? Number.POSITIVE_INFINITY);
  const latestPrewarm = latestEntryBefore(
    ['appTrigger.pointerenter', 'appTrigger.focus', 'appTrigger.touchstart'],
    showTime ?? Number.POSITIVE_INFINITY
  );
  const trigger = latestShow?.details?.trigger || 'unknown';
  const appLoadKind = latestShow?.details?.appModuleLoaded ? 'cached-module' : 'fresh-import';
  const rawInputStage = latestPointerStart?.stage || 'n/a';
  const rawInputTarget = latestPointerStart?.details?.target || 'n/a';
  const inputToClick = latestPointerStart && latestClick ? round(latestClick.t - latestPointerStart.t) : null;
  const inputToHandler = latestPointerStart && latestShow ? round(latestShow.t - latestPointerStart.t) : null;
  const clickToHandler = latestClick && latestShow ? round(latestShow.t - latestClick.t) : null;
  const inputToVisible = latestPointerStart && appModeApplied
    ? round(appModeApplied.t - latestPointerStart.t)
    : null;
  const inputToPaint2 = latestPointerStart && appPaint2
    ? round(appPaint2.t - latestPointerStart.t)
    : null;
  const prewarmToHandler = latestPrewarm && latestShow ? round(latestShow.t - latestPrewarm.t) : null;
  const resourcesAfterInput = resourceSummary(latestPointerStart?.t ?? showStart);

  const longTasksAfterShow = showStart === null
    ? globalTrace.longTasks
    : globalTrace.longTasks.filter(task => task.start >= showStart);
  const longestTask = longTasksAfterShow.length
    ? Math.max(...longTasksAfterShow.map(task => task.duration || 0))
    : 0;

  return [
    `[StartupDiag:${globalTrace.id}] env url=${snapshot.url} viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio || 1} cores=${navigator.hardwareConcurrency || 'n/a'} mem=${navigator.deviceMemory || 'n/a'}GB`,
    `[StartupDiag:${globalTrace.id}] nav response=${nav.responseEnd ?? 'n/a'}ms dcl=${nav.domContentLoaded ?? 'n/a'}ms load=${nav.load ?? 'n/a'}ms transfer=${nav.transferKB ?? 0}KB`,
    `[StartupDiag:${globalTrace.id}] input raw=${rawInputStage} target=${rawInputTarget} rawToClick=${inputToClick ?? 'n/a'}ms rawToHandler=${inputToHandler ?? 'n/a'}ms clickToHandler=${clickToHandler ?? 'n/a'}ms rawToVisible=${inputToVisible ?? 'n/a'}ms rawToPaint2=${inputToPaint2 ?? 'n/a'}ms`,
    `[StartupDiag:${globalTrace.id}] transition trigger=${trigger} type=${appLoadKind} stylesWait=${showToStyles ?? 'n/a'}ms importReady=${showToImport ?? 'n/a'}ms swapReady=${showToSwapReady ?? 'n/a'}ms visible=${showToVisible ?? 'n/a'}ms paint2=${showToPaint2 ?? 'n/a'}ms complete=${showToComplete ?? 'n/a'}ms appInit=${moduleEvalToReady ?? 'n/a'}ms`,
    `[StartupDiag:${globalTrace.id}] prewarm latest=${latestPrewarm?.stage || 'none'} prewarmToHandler=${prewarmToHandler ?? 'n/a'}ms afterInput js=${resourcesAfterInput.js.count}/${resourcesAfterInput.js.encodedKB}KB css=${resourcesAfterInput.css.count}/${resourcesAfterInput.css.encodedKB}KB font=${resourcesAfterInput.font.count}/${resourcesAfterInput.font.encodedKB}KB`,
    `[StartupDiag:${globalTrace.id}] resources afterShow js=${resources.js.count}/${resources.js.encodedKB}KB css=${resources.css.count}/${resources.css.encodedKB}KB font=${resources.font.count}/${resources.font.encodedKB}KB api=${resources.api.count}/${resources.api.encodedKB}KB`,
    `[StartupDiag:${globalTrace.id}] tasks longAfterShow=${longTasksAfterShow.length} longest=${round(longestTask)}ms resourceErrors=${globalTrace.errors.length} traceEntries=${globalTrace.entries.length}`,
    `[StartupDiag:${globalTrace.id}] share: use Copy in the Console panel, or run copyStartupDiagnostics() for JSON`
  ];
}

export function exposeStartupDiagnostics() {
  window.getStartupDiagnostics = getStartupDiagnostics;
  window.copyStartupDiagnostics = async () => {
    const text = JSON.stringify(getStartupDiagnostics(), null, 2);
    await navigator.clipboard.writeText(text);
    return getStartupDiagnostics();
  };
}
