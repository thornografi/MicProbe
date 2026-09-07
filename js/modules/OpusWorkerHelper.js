/**
 * OpusWorkerHelper - opus-recorder WASM Encoder ile entegrasyon
 *
 * opus-recorder (chris-rudmin/opus-recorder) kullanir
 * Yerel voice-note senaryolarinda ScriptProcessor/Worklet PCM verisini Opus'a kodlar.
 * Bir platform istemcisinin tum ses zincirini yeniden olusturmaz.
 */

// opus-recorder worker path
const OPUS_ENCODER_WORKER_URL = new URL('../workers/opus-encoder-worker.js', import.meta.url).href;

// Ogg Opus header constants
const OPUS_HEAD_SIGNATURE = [0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
const OPUS_TAGS_SIGNATURE = [0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]; // "OpusTags"
const VENDOR_STRING = 'MicProbe WASM Opus';
const OPUS_INIT_TIMEOUT_MS = 5000;
const OPUS_FINISH_TIMEOUT_MS = 10000;

/**
 * WASM Opus destegi kontrolu
 * @returns {boolean}
 */
export function isWasmOpusSupported() {
  // WebAssembly destegi
  const hasWebAssembly = typeof WebAssembly !== 'undefined' &&
                         typeof WebAssembly.instantiate === 'function';

  // Worker destegi
  const hasWorker = typeof Worker !== 'undefined';

  // ScriptProcessorNode destegi (eski API ama hala calisir)
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const hasScriptProcessor = AudioContextCtor &&
                             typeof AudioContextCtor.prototype.createScriptProcessor === 'function';

  return hasWebAssembly && hasWorker && hasScriptProcessor;
}

/**
 * Opus encoder worker olustur ve initialize et
 *
 * @param {Object} options - Encoder ayarlari
 * @param {number} options.sampleRate - Input sample rate (default: 48000)
 * @param {number} options.channels - Kanal sayisi (default: 1)
 * @param {number} options.bitrate - Requested average bitrate; 0/omitted keeps encoder default.
 * @param {number} options.encoderApplication - 2048=Voice, 2049=FullBand, 2051=LowDelay (default: 2048)
 * @returns {Promise<OpusRecorderWrapper>}
 */
export async function createOpusWorker(options = {}) {
  const {
    sampleRate = 48000,
    channels = 1,
    encoderApplication = 2048 // Voice
  } = options;

  // encoderBitRate requests an average rate; it does not disable variable bitrate.
  const actualBitRate = (options.bitrate === undefined || options.bitrate === null || options.bitrate === 0)
    ? null  // VBR - encoderBitRate gönderilmeyecek
    : options.bitrate;

  const initConfig = {
    originalSampleRate: sampleRate,
    numberOfChannels: channels,
    encoderSampleRate: 48000, // Opus her zaman 48kHz kullanir
    encoderApplication,
    encoderFrameSize: 20, // 20ms frames (standart)
    encoderComplexity: 5, // 0-10, varsayilan 5
    streamPages: true, // Page-by-page output
    // AudioInspector detection icin encoder path bilgisi
    encoderPath: OPUS_ENCODER_WORKER_URL
  };

  // Omit unspecified bitrate rather than inventing a target.
  if (actualBitRate !== null && actualBitRate > 0) {
    initConfig.encoderBitRate = actualBitRate;
  }

  const wrapper = new OpusRecorderWrapper();
  try {
    await wrapper.init(initConfig);
  } catch (error) {
    wrapper.terminate();
    throw error;
  }

  return wrapper;
}

/**
 * OpusRecorderWrapper - opus-recorder worker ile iletisim
 *
 * opus-recorder message protocol:
 * IN:  { command: 'init', ...config }
 * IN:  { command: 'encode', buffers: [Float32Array, ...] }
 * IN:  { command: 'done' }
 *
 * OUT: { message: 'ready' }
 * OUT: { message: 'page', page: Uint8Array, samplePosition: number }
 * OUT: { message: 'done' }
 */
export class OpusRecorderWrapper {
  constructor() {
    this.worker = null;
    this.config = null;
    this.pages = []; // Collected Ogg pages
    this.totalSamples = 0;
    this.paddingSamples = 0;
    this._inputBlockLength = null;
    this._preSkip = null;

    // Callback'ler
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;

    // Promise resolver'lar
    this._initResolver = null;
    this._finishResolver = null;
    this._initTimeout = null;
    this._finishTimeout = null;
    this._finishPromise = null;

    // Ogg serial number (consistent across all pages)
    this._serialNumber = null;
  }

  _clearInitTimeout() {
    if (this._initTimeout) {
      clearTimeout(this._initTimeout);
      this._initTimeout = null;
    }
  }

  _clearFinishTimeout() {
    if (this._finishTimeout) {
      clearTimeout(this._finishTimeout);
      this._finishTimeout = null;
    }
  }

  /**
   * Worker'i baslat ve hazir olmasini bekle
   * @param {Object} config - opus-recorder config
   * @returns {Promise<void>}
   */
  async init(config) {
    return new Promise((resolve, reject) => {
      this._initResolver = { resolve, reject };

      // Init timeout: WASM yuklenemezse 5 saniye sonra reject
      this._initTimeout = setTimeout(() => {
        if (this._initResolver) {
          this._initResolver.reject(new Error('Opus Worker init timeout (5s)'));
          this._initResolver = null;
        }
      }, OPUS_INIT_TIMEOUT_MS);

      try {
        this.worker = new Worker(OPUS_ENCODER_WORKER_URL);
        this.config = config;
        this.pages = [];
        this.totalSamples = 0;
        this.paddingSamples = 0;
        this._inputBlockLength = null;
        this._preSkip = null;
        this._finishPromise = null;

        this.worker.onmessage = this._handleMessage.bind(this);
        this.worker.onerror = (e) => {
          const error = new Error(`Opus Worker error: ${e.message}`);
          this._clearInitTimeout();
          this._clearFinishTimeout();
          if (this._initResolver) {
            this._initResolver.reject(error);
            this._initResolver = null;
          }
          if (this._finishResolver) {
            this._finishResolver.reject(error);
            this._finishResolver = null;
          }
          if (this.onError) this.onError(error);
        };

        // opus-recorder init mesaji
        this.worker.postMessage({
          command: 'init',
          ...config
        });

      } catch (error) {
        this._clearInitTimeout();
        reject(error);
      }
    });
  }

  /**
   * PCM verisini encode icin gonder
   * @param {Float32Array[]|Float32Array} pcmData - One equally sized buffer per channel.
   */
  encode(pcmData, validFrames = null) {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }
    if (this._finishPromise) throw new Error('Encoding already finished or finishing');

    const buffers = Array.isArray(pcmData) ? pcmData : [pcmData];
    if (buffers.length !== this.config.numberOfChannels ||
        buffers.some(buffer => !(buffer instanceof Float32Array) || buffer.length !== buffers[0].length)) {
      throw new Error('PCM channel count or frame lengths do not match the encoder configuration');
    }
    const frameCount = validFrames ?? buffers[0].length;
    if (!Number.isInteger(frameCount) || frameCount < 0 || frameCount > buffers[0].length) {
      throw new Error('Invalid captured PCM frame count');
    }
    // The bundled stereo interleaver caches its first block size.
    if (buffers.length > 1 && this._inputBlockLength !== null && buffers[0].length !== this._inputBlockLength) {
      throw new Error('Stereo Opus input block length must stay constant');
    }
    this._inputBlockLength = buffers[0].length;

    // opus-recorder format: { command: 'encode', buffers: [channelData, ...] }
    this.worker.postMessage({
      command: 'encode',
      buffers
    });

    this.totalSamples += frameCount;
    this.paddingSamples += buffers[0].length - frameCount;
  }

  /**
   * Encoding'i bitir ve Blob al
   * @returns {Promise<{blob: Blob, duration: number, pageCount: number}>}
   */
  finish() {
    if (this._finishPromise) return this._finishPromise;
    this._finishPromise = new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }
      this._finishResolver = { resolve, reject };
      this._finishTimeout = setTimeout(() => {
        if (!this._finishResolver) return;

        const error = new Error('Opus Worker finish timeout (10s)');
        this._finishResolver.reject(error);
        this._finishResolver = null;
        this._clearFinishTimeout();
        if (this.onError) this.onError(error);
        this.terminate();
      }, OPUS_FINISH_TIMEOUT_MS);

      // opus-recorder done komutu
      try {
        this.worker.postMessage({ command: 'done', sampleCount: this.totalSamples });
      } catch (error) {
        this._clearFinishTimeout();
        this._finishResolver = null;
        reject(error);
      }
    });
    return this._finishPromise;
  }

  /**
   * Worker'i sonlandir
   */
  terminate() {
    this._clearInitTimeout();
    this._clearFinishTimeout();
    // BUG-8 fix: Pending promise'leri reject et (askida kalma onleme)
    if (this._initResolver) {
      this._initResolver.reject?.(new Error('Worker terminated'));
      this._initResolver = null;
    }
    if (this._finishResolver) {
      this._finishResolver.reject?.(new Error('Worker terminated'));
      this._finishResolver = null;
    }

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.config = null;
    this.pages = [];
    this.totalSamples = 0;
  }

  /**
   * Encoder type (opus-recorder = wasm)
   */
  get encoderType() {
    return 'wasm';
  }

  /**
   * OpusHead header page olustur
   * @private
   */
  _createOpusHeadPage() {
    const sampleRate = this.config?.originalSampleRate || 48000;
    const channels = this.config?.numberOfChannels || 1;
    const preSkip = this._preSkip;
    if (!Number.isInteger(preSkip) || preSkip < 0 || preSkip > 65535) {
      throw new Error('Opus encoder delay is unavailable');
    }

    // OpusHead structure (19 bytes)
    const header = new Uint8Array(19);
    let offset = 0;

    // Signature "OpusHead"
    header.set(OPUS_HEAD_SIGNATURE, offset);
    offset += 8;

    // Version (must be 1)
    header[offset++] = 1;

    // Channel count
    header[offset++] = channels;

    // Pre-skip (little-endian)
    header[offset++] = preSkip & 0xFF;
    header[offset++] = (preSkip >> 8) & 0xFF;

    // Input sample rate (little-endian)
    header[offset++] = sampleRate & 0xFF;
    header[offset++] = (sampleRate >> 8) & 0xFF;
    header[offset++] = (sampleRate >> 16) & 0xFF;
    header[offset++] = (sampleRate >> 24) & 0xFF;

    // Output gain (0)
    header[offset++] = 0;
    header[offset++] = 0;

    // Channel mapping family (0 = mono/stereo)
    header[offset++] = 0;

    return this._createOggPage([header], 0n, true, false, 0);
  }

  /**
   * OpusTags header page olustur
   * @private
   */
  _createOpusTagsPage() {
    const vendorBytes = new TextEncoder().encode(VENDOR_STRING);
    const tagsSize = 8 + 4 + vendorBytes.length + 4;

    const tags = new Uint8Array(tagsSize);
    let offset = 0;

    // Signature "OpusTags"
    tags.set(OPUS_TAGS_SIGNATURE, offset);
    offset += 8;

    // Vendor string length (little-endian)
    tags[offset++] = vendorBytes.length & 0xFF;
    tags[offset++] = (vendorBytes.length >> 8) & 0xFF;
    tags[offset++] = (vendorBytes.length >> 16) & 0xFF;
    tags[offset++] = (vendorBytes.length >> 24) & 0xFF;

    // Vendor string
    tags.set(vendorBytes, offset);
    offset += vendorBytes.length;

    // User comment list length (0)
    tags[offset++] = 0;
    tags[offset++] = 0;
    tags[offset++] = 0;
    tags[offset++] = 0;

    return this._createOggPage([tags], 0n, false, false, 1);
  }

  /**
   * Ogg page olustur
   * @private
   */
  _createOggPage(segments, granulePos, bos, eos, pageSeq) {
    // Segment table
    const segmentTable = [];
    const segmentData = [];

    for (const segment of segments) {
      let remaining = segment.length;
      let off = 0;

      while (remaining > 0) {
        const lacingValue = Math.min(remaining, 255);
        segmentTable.push(lacingValue);
        segmentData.push(segment.slice(off, off + lacingValue));
        remaining -= lacingValue;
        off += lacingValue;

        if (lacingValue === 255 && remaining === 0) {
          segmentTable.push(0);
        }
      }
    }

    const headerSize = 27 + segmentTable.length;
    const dataSize = segmentData.reduce((sum, s) => sum + s.length, 0);
    const page = new Uint8Array(headerSize + dataSize);

    let offset = 0;

    // "OggS"
    page[offset++] = 0x4F;
    page[offset++] = 0x67;
    page[offset++] = 0x67;
    page[offset++] = 0x53;

    // Version
    page[offset++] = 0;

    // Header type
    let headerType = 0;
    if (bos) headerType |= 0x02;
    if (eos) headerType |= 0x04;
    page[offset++] = headerType;

    // Granule position (8 bytes little-endian)
    const granule = BigInt(granulePos);
    for (let i = 0; i < 8; i++) {
      page[offset++] = Number((granule >> BigInt(i * 8)) & 0xFFn);
    }

    // Serial number - use random but consistent
    if (!this._serialNumber) {
      this._serialNumber = Math.floor(Math.random() * 0xFFFFFFFF);
    }
    page[offset++] = this._serialNumber & 0xFF;
    page[offset++] = (this._serialNumber >> 8) & 0xFF;
    page[offset++] = (this._serialNumber >> 16) & 0xFF;
    page[offset++] = (this._serialNumber >> 24) & 0xFF;

    // Page sequence
    page[offset++] = pageSeq & 0xFF;
    page[offset++] = (pageSeq >> 8) & 0xFF;
    page[offset++] = (pageSeq >> 16) & 0xFF;
    page[offset++] = (pageSeq >> 24) & 0xFF;

    // CRC placeholder
    const crcOffset = offset;
    page[offset++] = 0;
    page[offset++] = 0;
    page[offset++] = 0;
    page[offset++] = 0;

    // Segment count
    page[offset++] = segmentTable.length;

    // Segment table
    for (const lacing of segmentTable) {
      page[offset++] = lacing;
    }

    // Data
    for (const seg of segmentData) {
      page.set(seg, offset);
      offset += seg.length;
    }

    // CRC32
    const crc = this._calculateCRC32(page);
    page[crcOffset] = crc & 0xFF;
    page[crcOffset + 1] = (crc >> 8) & 0xFF;
    page[crcOffset + 2] = (crc >> 16) & 0xFF;
    page[crcOffset + 3] = (crc >> 24) & 0xFF;

    return page;
  }

  /**
   * opus-recorder page'lerini duzelt: header ekle, serial/pageseq tutarli yap
   * RFC 7845: Ogg Opus stream = OpusHead(pageSeq=0) + OpusTags(pageSeq=1) + audio(pageSeq=2+)
   * Ogg page yapisi: capture_pattern[0-3], version[4], flags[5], granule[6-13],
   * serial[14-17], pageSeq[18-21], CRC32[22-25], segments[26], segTable[27+]
   * @private
   */
  async _fixOggStream(audioPages) {
    // An empty EOS page may follow an already-flushed audio page. EOS belongs
    // on the page containing the final retained packet, never on that empty page.
    audioPages = (audioPages || []).filter(page => page[26] > 0);
    if (!audioPages.length) throw new Error('Opus encoder produced no audio packets');
    const endGranule = BigInt(Math.round(this.totalSamples * 48000 / this.config.originalSampleRate) + this._preSkip);
    const frameSamples = this.config.encoderFrameSize * 48;

    // opus-recorder'in serial number'ini ilk page'den oku (offset 14-17)
    const firstPage = audioPages[0];
    const serialNumber = firstPage[14] | (firstPage[15] << 8) | (firstPage[16] << 16) | (firstPage[17] << 24);
    this._serialNumber = serialNumber >>> 0; // unsigned yap

    // Header page'leri olustur (pageSeq 0 ve 1)
    const opusHeadPage = this._createOpusHeadPage();
    const opusTagsPage = this._createOpusTagsPage();

    // Audio page'leri chunked olarak isle (main thread'i bloke etmemek icin)
    const CHUNK_SIZE = 1000;
    const fixedAudioPages = [];

    for (let start = 0; start < audioPages.length; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, audioPages.length);

      for (let idx = start; idx < end; idx++) {
        let newPage = new Uint8Array(audioPages[idx]);
        const originalGranule = new DataView(newPage.buffer).getBigInt64(6, true);
        const isLast = originalGranule >= endGranule;
        if (isLast) {
          // Drop whole padding packets before setting the final granule. Merely
          // rewriting the final emitted page can move time backwards across pages.
          const count = newPage[26];
          let complete = 0;
          for (let segment = 0; segment < count; segment++) if (newPage[27 + segment] < 255) complete++;
          let packetEnd = originalGranule - BigInt(complete * frameSamples);
          let dataBytes = 0;
          for (let segment = 0; segment < count; segment++) {
            const length = newPage[27 + segment];
            dataBytes += length;
            if (length < 255) packetEnd += BigInt(frameSamples);
            if (length < 255 && packetEnd >= endGranule) {
              const trimmed = new Uint8Array(27 + segment + 1 + dataBytes);
              trimmed.set(newPage.subarray(0, 27 + segment + 1));
              trimmed[26] = segment + 1;
              trimmed.set(newPage.subarray(27 + count, 27 + count + dataBytes), 27 + segment + 1);
              newPage = trimmed;
              break;
            }
          }
          new DataView(newPage.buffer).setBigInt64(6, endGranule, true);
        }

        // Serial number guncelle (offset 14-17)
        newPage[14] = this._serialNumber & 0xFF;
        newPage[15] = (this._serialNumber >> 8) & 0xFF;
        newPage[16] = (this._serialNumber >> 16) & 0xFF;
        newPage[17] = (this._serialNumber >> 24) & 0xFF;

        // Page sequence guncelle (offset 18-21) - 2'den basla
        const newPageSeq = idx + 2;
        newPage[18] = newPageSeq & 0xFF;
        newPage[19] = (newPageSeq >> 8) & 0xFF;
        newPage[20] = (newPageSeq >> 16) & 0xFF;
        newPage[21] = (newPageSeq >> 24) & 0xFF;

        // Son page'e EOS flag ekle
        newPage[5] &= ~0x04;
        if (isLast) {
          newPage[5] |= 0x04; // EOS flag
        }

        // CRC sifirla ve yeniden hesapla (offset 22-25)
        newPage[22] = 0;
        newPage[23] = 0;
        newPage[24] = 0;
        newPage[25] = 0;

        const crc = this._calculateCRC32(newPage);
        newPage[22] = crc & 0xFF;
        newPage[23] = (crc >> 8) & 0xFF;
        newPage[24] = (crc >> 16) & 0xFF;
        newPage[25] = (crc >> 24) & 0xFF;

        fixedAudioPages.push(newPage);
        if (isLast) return [opusHeadPage, opusTagsPage, ...fixedAudioPages];
      }

      // Yield to event loop between chunks
      if (end < audioPages.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    throw new Error('Opus encoder did not flush the complete recording');
  }

  /**
   * Ogg CRC32
   * @private
   */
  _calculateCRC32(data) {
    if (!OpusRecorderWrapper._crcTable) {
      const table = new Uint32Array(256);
      const polynomial = 0x04c11db7;

      for (let i = 0; i < 256; i++) {
        let r = i << 24;
        for (let j = 0; j < 8; j++) {
          if (r & 0x80000000) {
            r = (r << 1) ^ polynomial;
          } else {
            r <<= 1;
          }
        }
        table[i] = r >>> 0;
      }
      OpusRecorderWrapper._crcTable = table;
    }

    let crc = 0;
    for (let i = 0; i < data.length; i++) {
      crc = (crc << 8) ^ OpusRecorderWrapper._crcTable[((crc >>> 24) & 0xFF) ^ data[i]];
    }
    return crc >>> 0;
  }

  /**
   * Worker mesaj handler
   * @private
   */
  async _handleMessage(e) {
    try {
      const data = e.data;

      // Guard: data veya data.message undefined olabilir
      if (!data) return;

      switch (data.message) {
        case 'ready':
          if (!Number.isInteger(data.preSkip) || data.preSkip < 0 || data.preSkip > 65535) {
            throw new Error('Opus encoder delay is unavailable');
          }
          this._preSkip = data.preSkip;
          this._clearInitTimeout();
          if (this._initResolver) {
            this._initResolver.resolve();
            this._initResolver = null;
          }
          break;

        case 'page':
          // Ogg page geldi - kaydet
          if (data.page) {
            this.pages.push(data.page);
          }

          // Progress callback
          if (this.onProgress) {
            const sampleRate = this.config?.encoderSampleRate || 48000;
            this.onProgress({
              samplePosition: data.samplePosition,
              estimatedDuration: data.samplePosition / sampleRate,
              pageCount: this.pages.length
            });
          }
          break;

        case 'done':
          // Encoding tamamlandi - header page'lerini ekle ve blob olustur
          // opus-recorder sadece audio data page'leri veriyor, OpusHead/OpusTags yok

          // opus-recorder'in serial number'ini oku (ilk page'den)
          // ve tum page'leri ayni serial + ardisik page sequence ile yeniden yaz
          const fixedPages = await this._fixOggStream(this.pages);

          const blob = new Blob(fixedPages, { type: 'audio/ogg; codecs=opus' });
          const duration = this.totalSamples / (this.config?.originalSampleRate || 48000);

          this._clearFinishTimeout();
          if (this._finishResolver) {
            this._finishResolver.resolve({
              blob,
              duration,
              sampleCount: this.totalSamples,
              sampleRate: this.config.originalSampleRate,
              channels: this.config.numberOfChannels,
              encoderPaddingFrames: this.paddingSamples,
              pageCount: this.pages.length,
              encoderType: 'wasm'
            });
            this._finishResolver = null;
          }

          if (this.onComplete) {
            this.onComplete({
              blob,
              duration,
              pageCount: this.pages.length
            });
          }

          // Cleanup
          this.pages = [];
          break;

        default:
          // Bilinmeyen mesaj - error olabilir
          if (data.error) {
            const error = new Error(data.error);
            this._clearInitTimeout();
            this._clearFinishTimeout();
            if (this._initResolver) {
              this._initResolver.reject(error);
              this._initResolver = null;
            }
            if (this._finishResolver) {
              this._finishResolver.reject(error);
              this._finishResolver = null;
            }
            if (this.onError) {
              this.onError(error);
            }
          }
      }
    } catch (err) {
      // Worker message handling hatasi - sessizce yoksayma, logla
      console.error('[OpusWorkerHelper] _handleMessage error:', err);
      this._clearInitTimeout();
      this._clearFinishTimeout();
      if (this._initResolver) {
        this._initResolver.reject(err);
        this._initResolver = null;
      }
      if (this._finishResolver) {
        this._finishResolver.reject(err);
        this._finishResolver = null;
      }
      if (this.onError) {
        this.onError(err);
      }
    }
  }
}

// Static CRC table
OpusRecorderWrapper._crcTable = null;

export default {
  isWasmOpusSupported,
  createOpusWorker,
  OpusRecorderWrapper
};
