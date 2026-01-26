/**
 * StreamHelper - Ortak stream islemleri
 * requestStream fonksiyonu Monitor ve Recorder tarafindan kullanilir
 */
import eventBus from './EventBus.js';
import { log } from './utils.js';

const DEFAULT_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

/**
 * Mikrofon stream'i iste
 * @param {Object} constraints - Audio constraints (EC, NS, AGC)
 * @returns {Promise<MediaStream>} - Mikrofon stream'i
 */
export async function requestStream(constraints = {}) {
  const merged = { ...DEFAULT_CONSTRAINTS, ...constraints };

  const deviceLabel = merged.deviceId ? `[${typeof merged.deviceId === 'object' ? merged.deviceId.exact || merged.deviceId : merged.deviceId}]` : '[varsayilan]';
  log.stream(`Mikrofon isteniyor... ${deviceLabel} EC:${merged.echoCancellation} NS:${merged.noiseSuppression} AGC:${merged.autoGainControl}`);

  // Detayli log
  log.stream('getUserMedia cagriliyor', { constraints: merged });

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: merged,
      video: false
    });

    const track = stream.getAudioTracks()[0];
    // GUARD: Audio track yoksa hata
    if (!track) {
      throw new Error('Stream\'de audio track bulunamadi');
    }
    const settings = track.getSettings();

    // Gercek ayarlari logla - tarayici farkli deger uygulayabilir
    log.stream(`Gercek Track Ayarlari: device=${track.label || settings.deviceId || 'N/A'}, EC=${settings.echoCancellation}, NS=${settings.noiseSuppression}, AGC=${settings.autoGainControl}, sampleRate=${settings.sampleRate || 'N/A'}Hz, channelCount=${settings.channelCount || 'N/A'}`);

    // Constraint mismatch kontrolu - istenen vs gercek
    // NOT: Bazi tarayicilar (Safari, mobile) constraint degerlerini raporlamiyor (undefined doner)
    // Bu durumda yanlis pozitif onlemek icin actual !== undefined kontrolu eklendi
    const mismatches = [];
    if (merged.echoCancellation !== undefined && settings.echoCancellation !== undefined && settings.echoCancellation !== merged.echoCancellation) {
      mismatches.push({ name: 'echoCancellation', requested: merged.echoCancellation, actual: settings.echoCancellation });
    }
    if (merged.noiseSuppression !== undefined && settings.noiseSuppression !== undefined && settings.noiseSuppression !== merged.noiseSuppression) {
      mismatches.push({ name: 'noiseSuppression', requested: merged.noiseSuppression, actual: settings.noiseSuppression });
    }
    if (merged.autoGainControl !== undefined && settings.autoGainControl !== undefined && settings.autoGainControl !== merged.autoGainControl) {
      mismatches.push({ name: 'autoGainControl', requested: merged.autoGainControl, actual: settings.autoGainControl });
    }
    // sampleRate mismatch kontrolu
    if (merged.sampleRate !== undefined && settings.sampleRate !== undefined && settings.sampleRate !== merged.sampleRate) {
      mismatches.push({ name: 'sampleRate', requested: merged.sampleRate, actual: settings.sampleRate });
    }
    // channelCount mismatch kontrolu
    if (merged.channelCount !== undefined && settings.channelCount !== undefined && settings.channelCount !== merged.channelCount) {
      mismatches.push({ name: 'channelCount', requested: merged.channelCount, actual: settings.channelCount });
    }

    if (mismatches.length > 0) {
      const mismatchNames = mismatches.map(m => m.name).join(', ');
      log.warning(`Constraint uyumsuzlugu: ${mismatchNames}`, { mismatches, requested: merged, actual: settings });
      eventBus.emit('constraint:mismatch', { mismatches, requested: merged, actual: settings });
    }

    // Detayli log
    log.stream('MediaStream olusturuldu', {
      streamId: stream.id,
      trackId: track.id,
      trackLabel: track.label,
      trackSettings: settings,
      trackConstraints: track.getConstraints(),
      trackCapabilities: track.getCapabilities?.() || 'N/A'
    });

    return stream;
  } catch (err) {
    log.error('Mikrofon erisimi basarisiz - ' + err.message);
    log.error('getUserMedia hatasi', { error: err.message, name: err.name });
    throw err;
  }
}

// stopStream() - KALDIRILDI: Kullanilmiyordu, inline pattern kullaniliyor
