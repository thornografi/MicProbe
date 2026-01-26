/**
 * Log Helper - Kategorize log helper objesi
 * Kullanim: log.webaudio('Mesaj', { detail: value })
 */
import eventBus from '../EventBus.js';

export const log = {
  webaudio: (message, details = {}) => eventBus.emit('log:webaudio', { message, details }),
  stream: (message, details = {}) => eventBus.emit('log:stream', { message, details }),
  recorder: (message, details = {}) => eventBus.emit('log:recorder', { message, details }),
  error: (message, details = {}) => eventBus.emit('log:error', { message, details }),
  warning: (message, details = {}) => eventBus.emit('log:warning', { message, details }),
  ui: (message, details = {}) => eventBus.emit('log:ui', { message, details }),
  audio: (message, details = {}) => eventBus.emit('log:audio', { message, details }),
  system: (message, details = {}) => eventBus.emit('log:system', { message, details }),
  loopback: (message, details = {}) => eventBus.emit('log:loopback', { message, details }),
  player: (message, details = {}) => eventBus.emit('log:player', { message, details }),
  pipeline: (message, details = {}) => eventBus.emit('log:pipeline', { message, details }),
  encoder: (message, details = {}) => eventBus.emit('log:encoder', { message, details }),
  device: (message, details = {}) => eventBus.emit('log:device', { message, details }),
  constraint: (message, details = {}) => eventBus.emit('log:constraint', { message, details }),
  profile: (message, details = {}) => eventBus.emit('log:profile', { message, details }),
  vumeter: (message, details = {}) => eventBus.emit('log:vumeter', { message, details })
};
