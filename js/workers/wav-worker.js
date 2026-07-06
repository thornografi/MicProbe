/**
 * WAV Processing Worker
 * Float32 -> Int16 donusumu ve WAV header olusturmayi
 * Worker thread'de yaparak main thread'i bloke etmez.
 *
 * Mesaj protokolu:
 *   IN:  { type:'createWav', pcmBuffer:ArrayBuffer, sampleRate, channels }
 *   OUT: { type:'progress', percent }  |  { type:'done', header:ArrayBuffer, pcmData:ArrayBuffer }
 */

self.onmessage = function (e) {
  const { type, pcmBuffer, sampleRate, channels } = e.data;
  if (type !== 'createWav') return;

  const float32Array = new Float32Array(pcmBuffer);
  const len = float32Array.length;

  // Float32 -> Int16 (agir islem — Worker'da yapilir)
  const int16Array = new Int16Array(len);
  let lastPercent = -1;

  for (let i = 0; i < len; i++) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;

    if (i % 500000 === 0) {
      const percent = Math.round((i / len) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        self.postMessage({ type: 'progress', percent });
      }
    }
  }

  // WAV header (44 byte)
  const bitsPerSample = 16;
  const dataLength = int16Array.length * 2;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  self.postMessage(
    { type: 'done', header, pcmData: int16Array.buffer },
    [header, int16Array.buffer]
  );
};

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
