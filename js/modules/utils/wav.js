/**
 * WAV/PCM Helper Functions
 */

const WAV_WORKER_URL = new URL('../../workers/wav-worker.js', import.meta.url).href;
const WAV_WORKER_TIMEOUT_MS = 30000;

/**
 * Float32 PCM data'dan WAV blob olustur (Worker ile - non-blocking)
 * Chunk birlestirme (native memcpy) main thread'de, Int16 donusumu Worker'da yapilir.
 * @param {Float32Array[]} pcmChunks - PCM data chunk'lari
 * @param {number} sampleRate - Ornekleme hizi
 * @param {number} channels - Kanal sayisi
 * @returns {Promise<Blob>} - WAV formatinda blob
 */
export async function createWavBlob(pcmChunks, sampleRate, channels = 1) {
  // Chunk'lari tek Float32Array'e birleştir (native set() — hizli)
  const totalLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const mergedFloat32 = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    mergedFloat32.set(chunk, offset);
    offset += chunk.length;
  }

  // Int16 donusumu + WAV header → Worker thread
  return new Promise((resolve, reject) => {
    const worker = new Worker(WAV_WORKER_URL);
    const finish = (error, blob) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else resolve(blob);
    };
    const timeout = setTimeout(() => finish(new Error('WAV encoding timed out')), WAV_WORKER_TIMEOUT_MS);

    worker.onmessage = (e) => {
      if (e.data.type === 'done') {
        finish(null, new Blob([e.data.header, e.data.pcmData], { type: 'audio/wav' }));
      } else if (e.data.error) {
        finish(new Error('WAV Worker error: ' + e.data.error));
      }
    };

    worker.onerror = (err) => {
      finish(new Error('WAV Worker error: ' + err.message));
    };

    try {
      worker.postMessage(
        { type: 'createWav', pcmBuffer: mergedFloat32.buffer, sampleRate, channels },
        [mergedFloat32.buffer]
      );
    } catch (error) { finish(error); }
  });
}
