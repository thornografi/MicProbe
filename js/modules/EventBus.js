/**
 * EventBus - Moduller arasi iletisim icin
 * OCP: Yeni event tipleri eklenebilir, mevcut kod degismez
 */
class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return () => this.off(event, callback);
  }

  // Tek seferlik event listener - otomatik temizlenir
  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    this.on(event, wrapper);
    return () => this.off(event, wrapper);
  }

  off(event, callback) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) callbacks.splice(index, 1);
    }
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      [...callbacks].forEach(cb => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[EventBus] Listener error [${event}]:`, err);
        }
      });
    }
  }
}

// Singleton export
const eventBus = new EventBus();
export default eventBus;
