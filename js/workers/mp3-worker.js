/**
 * MP3 Encoding Worker
 * lamejs kutuphanesini Worker thread'de calistirarak main thread'i bloke etmez.
 *
 * Mesaj protokolu:
 *   IN:  { type:'encode', leftChannel:ArrayBuffer, rightChannel:ArrayBuffer|null, sampleRate, bitrate, lameUrl }
 *   OUT: { type:'progress', percent }  |  { type:'done', mp3Data:ArrayBuffer }
 */

let lameLoaded = false;

self.onmessage = function (e) {
  const { type, leftChannel, rightChannel, sampleRate, bitrate, lameUrl } = e.data;
  if (type !== 'encode') return;

  if (!lameLoaded) {
    importScripts(lameUrl);
    lameLoaded = true;
  }

  const channels = rightChannel ? 2 : 1;

  // Float32 -> Int16
  const left = floatTo16Bit(new Float32Array(leftChannel));
  const right = rightChannel ? floatTo16Bit(new Float32Array(rightChannel)) : null;

  const samples = left.length;
  const mp3Encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitrate);
  const mp3Chunks = [];
  const blockSize = 1152;
  const totalBlocks = Math.ceil(samples / blockSize);
  let lastPercent = -1;

  for (let i = 0, block = 0; i < samples; i += blockSize, block++) {
    const leftChunk = left.subarray(i, i + blockSize);
    let mp3buf;

    if (right) {
      mp3buf = mp3Encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize));
    } else {
      mp3buf = mp3Encoder.encodeBuffer(leftChunk);
    }

    if (mp3buf.length > 0) {
      mp3Chunks.push(new Uint8Array(mp3buf));
    }

    const percent = Math.round((block / totalBlocks) * 100);
    if (percent !== lastPercent) {
      lastPercent = percent;
      self.postMessage({ type: 'progress', percent });
    }
  }

  const end = mp3Encoder.flush();
  if (end.length > 0) {
    mp3Chunks.push(new Uint8Array(end));
  }

  // Combine chunks
  const totalSize = mp3Chunks.reduce((sum, c) => sum + c.length, 0);
  const mp3Data = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of mp3Chunks) {
    mp3Data.set(chunk, offset);
    offset += chunk.length;
  }

  self.postMessage({ type: 'done', mp3Data: mp3Data.buffer }, [mp3Data.buffer]);
};

function floatTo16Bit(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16;
}
