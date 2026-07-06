/**
 * Mp3Converter - Audio blob'u MP3'e donusturur
 * Encoding islemini Web Worker'da yaparak main thread'i bloke etmez.
 */

const LAME_URL = new URL('../lib/lame/lame.min.js', import.meta.url).href;
const WORKER_URL = new URL('../workers/mp3-worker.js', import.meta.url).href;

/**
 * Audio blob'u MP3'e donustur (Worker thread'de)
 * @param {Blob} blob - Kaynak audio blob (webm, ogg, wav vb.)
 * @param {Object} options - { bitrate: 128, onProgress: fn(percent) }
 * @returns {Promise<Blob>} MP3 blob
 */
export async function convertToMp3(blob, options = {}) {
  const { bitrate = 128, onProgress } = options;

  // Blob -> AudioBuffer (async, main thread'i bloke etmez)
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();

  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    await ctx.close().catch(() => {});
  }

  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;

  // Channel data kopyala (AudioBuffer'in backing store'u paylasimli, transfer edilemez)
  const leftData = audioBuffer.getChannelData(0).slice();
  const rightData = channels > 1 ? audioBuffer.getChannelData(1).slice() : null;

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress' && onProgress) {
        onProgress(msg.percent);
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(new Blob([msg.mp3Data], { type: 'audio/mpeg' }));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error('MP3 Worker error: ' + err.message));
    };

    const transferList = [leftData.buffer];
    if (rightData) transferList.push(rightData.buffer);

    worker.postMessage({
      type: 'encode',
      leftChannel: leftData.buffer,
      rightChannel: rightData?.buffer ?? null,
      sampleRate,
      bitrate,
      lameUrl: LAME_URL
    }, transferList);
  });
}
