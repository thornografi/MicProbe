/**
 * OpusWorkerHelper - opus-recorder WASM Encoder ile entegrasyon
 *
 * opus-recorder (chris-rudmin/opus-recorder) kullanir
 * WhatsApp Web pattern: ScriptProcessorNode(4096, 1, 1) + WASM Opus
 */

// opus-recorder worker path
const OPUS_ENCODER_WORKER_URL = new URL('../lib/opus/encoderWorker.min.js', import.meta.url).href;

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
 * @param {number} options.bitRate - Hedef bitrate bps (default: 16000)
 * @param {number} options.encoderApplication - 2048=Voice, 2049=FullBand, 2051=LowDelay (default: 2048)
 * @returns {Promise<OpusRecorderWrapper>}
 */
export async function createOpusWorker(options = {}) {
  const {
    sampleRate = 48000,
    channels = 1,
    encoderApplication = 2048 // Voice
  } = options;

  // VBR destegi:
  // - options.bitrate === undefined veya null → VBR (encoderBitRate gonderme)
  // - options.bitrate === 0 → VBR (encoderBitRate gonderme)
  // - options.bitrate > 0 → CBR (sabit bitrate)
  // NOT: Eski default 16000 kaldırıldı - VBR varsayılan olmalı
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

  // VBR: encoderBitRate gonderilmezse opus-recorder VBR kullanir
  // actualBitRate === null → VBR modu
  // actualBitRate > 0 → CBR modu (sabit bitrate)
  if (actualBitRate !== null && actualBitRate > 0) {
    initConfig.encoderBitRate = actualBitRate;
  }

  const wrapper = new OpusRecorderWrapper();
  await wrapper.init(initConfig);

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

    // Callback'ler
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;

    // Promise resolver'lar
    this._initResolver = null;
    this._finishResolver = null;
    this._initTimeout = null;
    this._finishTimeout = null;

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
   * @param {Float32Array} pcmData - Mono PCM samples
   */
  encode(pcmData) {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    // opus-recorder format: { command: 'encode', buffers: [channelData, ...] }
    // Mono icin tek kanal
    this.worker.postMessage({
      command: 'encode',
      buffers: [pcmData]
    });

    this.totalSamples += pcmData.length;
  }

  /**
   * Encoding'i bitir ve Blob al
   * @returns {Promise<{blob: Blob, duration: number, pageCount: number}>}
   */
  async finish() {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not initialized'));
        return;
      }
      if (this._finishResolver) {
        reject(new Error('Opus Worker finish already in progress'));
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
        this.worker.postMessage({ command: 'done' });
      } catch (error) {
        this._clearFinishTimeout();
        this._finishResolver = null;
        reject(error);
      }
    });
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
    const preSkip = 312; // Opus encoder delay (~6.5ms @ 48kHz)

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
    if (!audioPages || audioPages.length === 0) {
      // Bos kayit - sadece header'lar
      const emptyHead = this._createOpusHeadPage();
      const emptyTags = this._createOpusTagsPage();
      return [emptyHead, emptyTags];
    }

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
        const newPage = new Uint8Array(audioPages[idx]);

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
        if (idx === audioPages.length - 1) {
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
      }

      // Yield to event loop between chunks
      if (end < audioPages.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return [opusHeadPage, opusTagsPage, ...fixedAudioPages];
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
