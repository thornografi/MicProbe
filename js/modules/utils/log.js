/**
 * Log Helper - Kategorize log helper objesi
 * Kullanim: log.webaudio('Mesaj', { detail: value })
 */
import eventBus from '../EventBus.js';
import { EVENTS } from '../constants.js';

const LOG_CATEGORIES = [
  'webaudio', 'stream', 'recorder', 'error', 'warning', 'ui', 'audio',
  'system', 'loopback', 'player', 'pipeline', 'encoder', 'device',
  'constraint', 'profile', 'vumeter'
];

export const log = Object.fromEntries(
  LOG_CATEGORIES.map(cat => [
    cat,
    (message, details = {}) => eventBus.emit(EVENTS[`LOG_${cat.toUpperCase()}`], { message, details })
  ])
);
