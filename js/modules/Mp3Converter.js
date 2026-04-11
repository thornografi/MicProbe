/**
 * Mp3Converter - Audio blob'u MP3'e donusturur (lamejs kullanarak)
 * Kullanim: Download butonunda blob -> MP3 donusumu
 */

let lameLib = null;

/**
 * lamejs kutuphanesini lazy-load et
 */
async function ensureLame() {
  if (lameLib) return lameLib;

  // lamejs script sonunda kendini cagirir: lamejs()
  // Bu cagri lamejs.Mp3Encoder ve lamejs.WavHeader'i ekler
  // Dolayisiyla lamejs fonksiyon objesi uzerinden erisim yeterli
  if (typeof lamejs === 'function' && lamejs.Mp3Encoder) {
    lameLib = lamejs;
    return lameLib;
  }

  // Script henuz yuklenmemisse yukle
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../lib/lame/lame.min.js', import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error('lamejs yuklenemedi'));
    document.head.appendChild(script);
  });

  lameLib = lamejs;
  return lameLib;
}

/**
 * Audio blob'u MP3'e donustur
 * @param {Blob} blob - Kaynak audio blob (webm, ogg, wav vb.)
 * @param {Object} options - { bitrate: 128 }
 * @returns {Promise<Blob>} MP3 blob
 */
export async function convertToMp3(blob, options = {}) {
  const { bitrate = 128 } = options;
  const lib = await ensureLame();

  // Blob -> ArrayBuffer -> AudioBuffer (PCM decode)
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
  const samples = audioBuffer.length;

  // Float32 -> Int16 donusumu
  const left = floatTo16Bit(audioBuffer.getChannelData(0));
  const right = channels > 1 ? floatTo16Bit(audioBuffer.getChannelData(1)) : null;

  // MP3 encode
  const mp3Encoder = new lib.Mp3Encoder(channels, sampleRate, bitrate);
  const mp3Chunks = [];
  const blockSize = 1152;

  for (let i = 0; i < samples; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    let mp3buf;

    if (right) {
      const rightChunk = right.subarray(i, i + blockSize);
      mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
    } else {
      mp3buf = mp3Encoder.encodeBuffer(leftChunk);
    }

    if (mp3buf.length > 0) {
      mp3Chunks.push(mp3buf);
    }
  }

  // Flush
  const end = mp3Encoder.flush();
  if (end.length > 0) {
    mp3Chunks.push(end);
  }

  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}

/**
 * Float32Array -> Int16Array donusumu
 */
function floatTo16Bit(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}
