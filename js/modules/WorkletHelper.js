/**
 * WorkletHelper - AudioWorkletNode basmakalip islemleri
 * DRY: ensurePassthroughWorklet, createPassthroughWorkletNode tek yerde
 */

const PASSTHROUGH_PROCESSOR_NAME = 'passthrough-processor';
const PASSTHROUGH_WORKLET_URL = new URL('../worklets/passthrough-processor.js', import.meta.url).href;

const loadedContexts = new WeakSet();

export function isAudioWorkletSupported() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return false;

  const proto = AudioContextCtor.prototype;
  const hasAudioWorklet = !!(proto && 'audioWorklet' in proto);

  return hasAudioWorklet && typeof window.AudioWorkletNode === 'function';
}

export async function ensurePassthroughWorklet(audioContext) {
  if (!audioContext?.audioWorklet?.addModule) {
    throw new Error('AudioWorklet desteklenmiyor (audioContext.audioWorklet yok)');
  }

  if (loadedContexts.has(audioContext)) return;

  await audioContext.audioWorklet.addModule(PASSTHROUGH_WORKLET_URL);
  loadedContexts.add(audioContext);
}

export function createPassthroughWorkletNode(audioContext) {
  return new AudioWorkletNode(audioContext, PASSTHROUGH_PROCESSOR_NAME);
}
