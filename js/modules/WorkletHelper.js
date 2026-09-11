/**
 * WorkletHelper - AudioWorkletNode basmakalip islemleri
 * DRY: ensurePassthroughWorklet, createPassthroughWorkletNode tek yerde
 */

import { abortable } from './utils/async.js';

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

export async function ensurePassthroughWorklet(audioContext, signal) {
  signal?.throwIfAborted();
  if (!audioContext?.audioWorklet?.addModule) {
    throw new Error('AudioWorklet not supported (audioContext.audioWorklet missing)');
  }

  if (loadedContexts.has(audioContext)) return;

  await abortable(audioContext.audioWorklet.addModule(PASSTHROUGH_WORKLET_URL), signal);
  loadedContexts.add(audioContext);
}

export function createPassthroughWorkletNode(audioContext, channelCount = null) {
  const options = channelCount ? { channelCount, channelCountMode: 'explicit', outputChannelCount: [channelCount] } : {};
  return new AudioWorkletNode(audioContext, PASSTHROUGH_PROCESSOR_NAME, options);
}
