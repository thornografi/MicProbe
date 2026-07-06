/**
 * WAV/PCM Helper Functions
 */

const WAV_WORKER_URL = new URL('../../workers/wav-worker.js', import.meta.url).href;

/**
 * Float32 PCM data'yi Int16'ya donustur
 * @param {Float32Array} float32Array - Kaynak PCM data
 * @returns {Int16Array} - 16-bit PCM data
 */
export function float32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
  }
  return int16Array;
}

/**
 * DataView'a string yaz (WAV header icin)
 * @private
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * WAV dosya header'i olustur (44 byte)
 * @param {number} dataLength - PCM data uzunlugu (byte cinsinden)
 * @param {number} sampleRate - Ornekleme hizi (Hz)
 * @param {number} channels - Kanal sayisi (1=mono, 2=stereo)
 * @param {number} bitsPerSample - Bit derinligi (16)
 * @returns {ArrayBuffer} - 44 byte WAV header
 */
export function createWavHeader(dataLength, sampleRate, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  return buffer;
}

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

    worker.onmessage = (e) => {
      if (e.data.type === 'done') {
        worker.terminate();
        resolve(new Blob([e.data.header, e.data.pcmData], { type: 'audio/wav' }));
      }
    };

    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error('WAV Worker error: ' + err.message));
    };

    worker.postMessage(
      { type: 'createWav', pcmBuffer: mergedFloat32.buffer, sampleRate, channels },
      [mergedFloat32.buffer]
    );
  });
}
