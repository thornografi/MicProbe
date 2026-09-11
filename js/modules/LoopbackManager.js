/**
 * LoopbackManager - WebRTC Loopback yonetimi
 * OCP: Loopback ile ilgili tum state ve fonksiyonlar tek yerde
 * DRY: Tekrarlanan WebRTC/AudioContext islemleri merkezi
 */

import eventBus from './EventBus.js';
import { createAudioContext, getAudioContextOptions, stopStreamTracks, disconnectNodes, log } from './utils.js';
import { LOOPBACK, PIPELINE_TYPES, EVENTS } from './constants.js';
import { createPassthroughWorkletNode, ensurePassthroughWorklet } from './WorkletHelper.js';
import { summarizeLoopbackStats } from './utils/loopbackStats.js';

/**
 * LoopbackManager class - WebRTC loopback state ve islemlerini yonetir
 */
class LoopbackManager {
  constructor() {
    // WebRTC state
    this.pc1 = null;
    this.pc2 = null;
    this.localStream = null;
    this.remoteStream = null;
    this.audioCtx = null;

    // Stats polling state
    this.statsInterval = null;
    this._isCleaningUp = false; // Race condition guard for async stats polling
    this._lifecycleVersion = 0;
  }

  /**
   * SDP'yi Opus bitrate ile modifiye et
   * @param {string} sdp - Orijinal SDP
   * @param {number} bitrate - Hedef bitrate (bps)
   * @returns {string} Modifiye edilmis SDP
   */
  setOpusBitrate(sdp, bitrate, channelCount = 1, preferences = {}) {
    const lines = sdp.split('\r\n');

    // Opus payload type'ini bul (a=rtpmap:111 opus/48000/2)
    let opusPayloadType = null;
    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
      if (match) {
        opusPayloadType = match[1];
        break;
      }
    }

    // Opus bulunamadiysa SDP'yi degistirme
    if (!opusPayloadType) {
      return sdp;
    }

    let found = false;
    const requested = {
      maxaveragebitrate: Math.max(6000, Math.min(510000, bitrate)),
      stereo: channelCount === 2 ? 1 : 0,
      'sprop-stereo': channelCount === 2 ? 1 : 0
    };
    for (const [key, parameter] of [['dtx', 'usedtx'], ['fec', 'useinbandfec']]) {
      if (typeof preferences?.[key] === 'boolean') requested[parameter] = Number(preferences[key]);
    }
    const parameters = Object.entries(requested).map(([key, value]) => `${key}=${value}`).join(';');
    const modifiedLines = lines.map(line => {
      // Opus fmtp satirini bul (payload type ile eslesme)
      if (line.startsWith(`a=fmtp:${opusPayloadType} `)) {
        found = true;
        const existing = line.slice(line.indexOf(' ') + 1).split(';')
          .filter(part => !Object.hasOwn(requested, part.split('=')[0].trim().toLowerCase()));
        return `a=fmtp:${opusPayloadType} ${[...existing, parameters].filter(Boolean).join(';')}`;
      }
      return line;
    });

    if (!found) modifiedLines.splice(modifiedLines.findIndex(line => line.startsWith(`a=rtpmap:${opusPayloadType} `)) + 1, 0, `a=fmtp:${opusPayloadType} ${parameters}`);
    return modifiedLines.join('\r\n');
  }

  /**
   * WebRTC loopback baglantisi kurar
   * @param {MediaStream} localStream - Mikrofon stream
   * @param {Object} options - Seçenekler
   * @param {boolean} options.useWebAudio - WebAudio pipeline kullanılsın mı
   * @param {number} options.opusBitrate - Opus bitrate (bps)
   * @returns {Promise<MediaStream>} Remote stream (WebRTC'den gelen ses)
   * @throws {Error} ICE baglantisi basarisiz olursa veya remote stream olusturulamazsa
   */
  async setup(localStream, options = {}) {
    const { useWebAudio = false, opusBitrate = 32000, opusPreferences = null, pipeline = PIPELINE_TYPES.STANDARD, runId = null } = options;
    const channelCount = localStream.getAudioTracks()[0]?.getSettings?.().channelCount === 2 ? 2 : 1;

    // cleanup detaches its resources before waiting; a later setup owns a new version.
    const retiring = this.cleanup();
    const version = this._lifecycleVersion;
    await retiring;
    if (version !== this._lifecycleVersion) throw new Error('Loopback setup cancelled');

    log.stream('WebRTC Loopback setting up', { useWebAudio, opusBitrate });

    this.localStream = localStream;
    this.runId = runId;
    const operation = new AbortController();
    this._setupAbort = operation;
    const assertCurrent = () => {
      if (this._setupAbort !== operation || operation.signal.aborted) throw new Error('Loopback setup cancelled');
    };
    this.actualPipeline = useWebAudio
      ? (pipeline === PIPELINE_TYPES.WORKLET ? PIPELINE_TYPES.WORKLET : PIPELINE_TYPES.STANDARD)
      : PIPELINE_TYPES.DIRECT;

    try {
    // WebAudio pipeline (opsiyonel)
    let sendStream = localStream;
    if (useWebAudio) {
      const acOptions = getAudioContextOptions(localStream);
      const context = await createAudioContext(acOptions, { signal: operation.signal });
      if (this._setupAbort !== operation || operation.signal.aborted) {
        await context.close().catch(() => {});
        throw new Error('Loopback setup cancelled');
      }
      this.audioCtx = context;

      const src = this.audioCtx.createMediaStreamSource(localStream);
      const dest = this.audioCtx.createMediaStreamDestination();
      dest.channelCount = channelCount;
      dest.channelCountMode = 'explicit';
      this.sendDestination = dest;
      if (pipeline === PIPELINE_TYPES.WORKLET) {
        await ensurePassthroughWorklet(this.audioCtx, operation.signal);
        assertCurrent();
        this.sendWorklet = createPassthroughWorkletNode(this.audioCtx, channelCount);
        src.connect(this.sendWorklet);
        this.sendWorklet.connect(dest);
      } else {
        src.connect(dest);
      }
      sendStream = dest.stream;

      const localTrack = localStream.getAudioTracks()[0];
      const localSampleRate = localTrack?.getSettings()?.sampleRate;

      log.webaudio('Loopback: WebAudio pipeline aktif', {
        contextSampleRate: this.audioCtx.sampleRate,
        micSampleRate: localSampleRate || 'N/A',
        sampleRateMatch: !localSampleRate || localSampleRate === this.audioCtx.sampleRate,
        state: this.audioCtx.state,
        sendStreamActive: sendStream.active
      });
    }

    // PeerConnection'lar
    const pc1 = this.pc1 = new RTCPeerConnection({ iceServers: [] });
    const pc2 = this.pc2 = new RTCPeerConnection({ iceServers: [] });

    // ICE candidate handler'lari - cleanup sirasinda gec gelen candidate'ler icin guard (DRY)
    this.pc1.onicecandidate = this._createIceCandidateHandler('pc2');
    this.pc2.onicecandidate = this._createIceCandidateHandler('pc1');

    // Track handler - WebRTC'nin sagladigi stream'i kullan
    this.pc2.ontrack = (e) => {
      if (this.pc2 !== pc2 || this._setupAbort !== operation) { e.track.stop(); return; }
      log.stream('Loopback: Remote track received', {
        trackKind: e.track.kind,
        trackId: e.track.id,
        trackEnabled: e.track.enabled,
        trackMuted: e.track.muted,
        trackReadyState: e.track.readyState,
        hasStreams: e.streams?.length > 0,
        streamId: e.streams?.[0]?.id
      });

      // KRITIK: WebRTC'nin sagladigi stream'i kullan, manuel olusturma!
      if (e.streams && e.streams.length > 0) {
        this.remoteStream = e.streams[0];
        log.stream('Loopback: Using WebRTC stream', { streamId: this.remoteStream.id, active: this.remoteStream.active });
      } else {
        // Fallback: Manuel stream olustur (eski yontem)
        if (!this.remoteStream) {
          this.remoteStream = new MediaStream();
        }
        this.remoteStream.addTrack(e.track);
        log.stream('Loopback: Manual stream created (fallback)', {});
      }
    };

    // Track ekle
    sendStream.getAudioTracks().forEach(track => {
      this.pc1.addTrack(track, sendStream);
    });

    // SDP exchange - TUM ADIMLARI AWAIT ILE BEKLE
    const offer = await pc1.createOffer({ offerToReceiveAudio: true });
    assertCurrent();

    // Offer SDP'yi Opus bitrate ile modifiye et
    const modifiedOfferSdp = this.setOpusBitrate(offer.sdp, opusBitrate, channelCount, opusPreferences);
    const modifiedOffer = { type: offer.type, sdp: modifiedOfferSdp };

    log.stream(`Loopback: Opus bitrate ayarlandi - ${opusBitrate / 1000} kbps`, { opusBitrate, sdpModified: modifiedOfferSdp !== offer.sdp });

    await pc1.setLocalDescription(modifiedOffer);
    assertCurrent();
    await pc2.setRemoteDescription(modifiedOffer); // ontrack burada tetiklenir
    assertCurrent();

    const answer = await pc2.createAnswer();
    assertCurrent();

    // Answer SDP'yi de Opus bitrate ile modifiye et
    const modifiedAnswerSdp = this.setOpusBitrate(answer.sdp, opusBitrate, channelCount, opusPreferences);
    const modifiedAnswer = { type: answer.type, sdp: modifiedAnswerSdp };

    await pc2.setLocalDescription(modifiedAnswer);
    assertCurrent();
    await pc1.setRemoteDescription(modifiedAnswer);
    assertCurrent();

    // ICE baglanti durumunu bekle
    await this._waitForIceConnection();
    assertCurrent();

    // Stream kontrolu
    if (!this.remoteStream) {
      throw new Error('Remote stream olusturulamadi - ontrack tetiklenmedi');
    }

    const remoteTrack = this.remoteStream.getAudioTracks()[0];

    // Track muted ise unmute olmasini bekle
    if (remoteTrack && remoteTrack.muted) {
      await this._waitForTrackUnmute(remoteTrack);
      assertCurrent();
    }

    log.stream(`Loopback: WebRTC baglantisi kuruldu - ICE:${this.pc1.iceConnectionState}/${this.pc2.iceConnectionState} Track:${remoteTrack?.readyState} Muted:${remoteTrack?.muted}`, {
      pc1Ice: this.pc1.iceConnectionState,
      pc2Ice: this.pc2.iceConnectionState,
      remoteTrackCount: this.remoteStream.getAudioTracks().length,
      remoteTrackEnabled: remoteTrack?.enabled,
      remoteTrackReadyState: remoteTrack?.readyState,
      remoteTrackMuted: remoteTrack?.muted,
      remoteTrackLabel: remoteTrack?.label,
      streamActive: this.remoteStream.active
    });

    // WebRTC getStats ile gercek bitrate olcumu baslat
    this.startStatsPolling(opusBitrate);

    return this.remoteStream;
    } catch (error) {
      if (this._setupAbort === operation) await this.cleanup();
      throw error;
    }
  }

  /**
   * ICE candidate handler olustur (DRY: pc1/pc2 icin ayni logic)
   * @param {string} receiverPcKey - Candidate'i alacak peer ('pc1' veya 'pc2')
   * @returns {Function} onicecandidate handler
   * @private
   */
  _createIceCandidateHandler(receiverPcKey) {
    const receiver = this[receiverPcKey];
    return (e) => {
      if (e.candidate && receiver && this[receiverPcKey] === receiver && !this._isCleaningUp) {
        receiver.addIceCandidate(e.candidate).catch(err => {
          if (!this._isCleaningUp) {
            log.warning('ICE candidate error (' + receiverPcKey + ')', { error: err.message });
          }
        });
      }
    };
  }

  /**
   * ICE baglanti durumunu bekle
   * @private
   */
  async _waitForIceConnection() {
    const pc1 = this.pc1, pc2 = this.pc2, signal = this._setupAbort.signal;
    return new Promise((resolve, reject) => {
      const cleanupListeners = () => {
        pc1.removeEventListener('iceconnectionstatechange', checkConnection);
        pc2.removeEventListener('iceconnectionstatechange', checkConnection);
        signal.removeEventListener('abort', onAbort);
        clearTimeout(timeout);
      };
      const onAbort = () => { cleanupListeners(); reject(new Error('Loopback setup cancelled')); };

      const timeout = setTimeout(() => {
        cleanupListeners();
        log.error('Loopback: ICE baglanti zaman asimi', {
          pc1Ice: pc1.iceConnectionState,
          pc2Ice: pc2.iceConnectionState
        });
        reject(new Error('ICE connection timeout'));
      }, LOOPBACK.ICE_WAIT_MS);

      let lastIce1 = null;
      let lastIce2 = null;

      const checkConnection = () => {
        const ice1 = pc1.iceConnectionState;
        const ice2 = pc2.iceConnectionState;

        if (ice1 !== lastIce1 || ice2 !== lastIce2) {
          log.stream(`Loopback: ICE durumu ${ice1}/${ice2}`, { pc1Ice: ice1, pc2Ice: ice2 });
          lastIce1 = ice1;
          lastIce2 = ice2;
        }

        if ((ice1 === 'connected' || ice1 === 'completed') &&
            (ice2 === 'connected' || ice2 === 'completed')) {
          clearTimeout(timeout);
          cleanupListeners();
          resolve();
        } else if (['failed', 'closed'].includes(ice1) || ['failed', 'closed'].includes(ice2)) {
          clearTimeout(timeout);
          cleanupListeners();
          reject(new Error('ICE connection failed'));
        }
      };

      pc1.addEventListener('iceconnectionstatechange', checkConnection);
      pc2.addEventListener('iceconnectionstatechange', checkConnection);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      checkConnection();
    });
  }

  /**
   * Track unmute olmasini bekle
   * @private
   */
  async _waitForTrackUnmute(track) {
    log.stream('Loopback: Track muted, waiting for unmute...', { muted: track.muted });

    const signal = this._setupAbort.signal;
    return new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timeout);
        track.removeEventListener('unmute', onUnmute);
        track.removeEventListener('ended', onEnded);
        signal.removeEventListener('abort', onEnded);
        error ? reject(error) : resolve();
      };
      const onUnmute = () => finish();
      const onEnded = () => finish(new Error('Remote audio ended before it became ready'));
      const timeout = setTimeout(() => finish(new Error('Remote audio unmute timeout')), 5000);
      track.addEventListener('unmute', onUnmute);
      track.addEventListener('ended', onEnded);
      signal.addEventListener('abort', onEnded, { once: true });
      if (signal.aborted || track.readyState === 'ended') onEnded();
      else if (!track.muted) onUnmute();
    });
  }

  /**
   * WebRTC getStats ile gercek bitrate olcumu
   */
  startStatsPolling(requestedBitrate) {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    let previous = null;
    let statsErrorCount = 0;
    let pending = false;
    const pc1 = this.pc1, pc2 = this.pc2, runId = this.runId;

    this.statsInterval = setInterval(async () => {
      // Race condition guard: cleanup sırasında veya pc1 yoksa çık
      if (pending || this._isCleaningUp || this.pc1 !== pc1 || this.pc2 !== pc2) return;
      pending = true;
      try {
        const [sender, receiver] = await Promise.all([pc1.getStats(), pc2.getStats()]);
        if (this.pc1 !== pc1 || this.pc2 !== pc2 || this._isCleaningUp) return;
        const result = summarizeLoopbackStats(sender, receiver, previous);
        previous = result.previous;
        eventBus.emit(EVENTS.LOOPBACK_STATS, {
          ...result.stats, requestedCodec: 'audio/opus',
          requestedBitrate, requestedKbps: requestedBitrate / 1000, runId
        });
        statsErrorCount = 0;

      } catch (err) {
        if (this.pc1 !== pc1 || this.pc2 !== pc2) return;
        statsErrorCount++;
        if (statsErrorCount > 10) {
          clearInterval(this.statsInterval);
          this.statsInterval = null;
          log.error('Loopback stats: Too many errors, stopping polling', { errorCount: statsErrorCount, lastError: err.message });
        }
      } finally { pending = false; }
    }, LOOPBACK.STATS_INTERVAL_MS);
  }

  /**
   * Loopback kaynaklarini temizler
   */
  async cleanup() {
    // Race condition flag: stats polling'in cleanup sırasında çalışmasını engelle
    this._isCleaningUp = true;
    const version = ++this._lifecycleVersion;
    this._setupAbort?.abort();
    this._setupAbort = null;

    // Stats polling durdur
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // ICE handler'lari temizle - close() sonrasi gec gelen event'lerin referans tutmasini engelle
    if (this.pc1) {
      this.pc1.onicecandidate = null;
      this.pc1.oniceconnectionstatechange = null;
    }
    if (this.pc2) {
      this.pc2.onicecandidate = null;
      this.pc2.oniceconnectionstatechange = null;
      this.pc2.ontrack = null;
    }

    this.pc1?.close();
    this.pc2?.close();
    this.pc1 = null;
    this.pc2 = null;

    stopStreamTracks(this.remoteStream);
    this.remoteStream = null;
    disconnectNodes([this.sendWorklet, this.sendDestination]);
    stopStreamTracks(this.sendDestination?.stream);
    this.sendWorklet = null;
    this.sendDestination = null;

    const context = this.audioCtx;
    this.audioCtx = null;
    this.localStream = null;
    if (context) {
      try {
        await context.close();
      } catch (err) {
        log.error('Loopback: AudioContext close error', { error: err.message });
      }
    }

    log.stream('Loopback: Resources cleaned up', {});

    // Cleanup tamamlandı, flag'i sıfırla
    if (version === this._lifecycleVersion) this._isCleaningUp = false;
  }

  /**
   * Loopback aktif mi?
   */
  get isActive() {
    return this.pc1 !== null && this.pc2 !== null;
  }

  /**
   * Remote stream'i dondur
   */
  getRemoteStream() {
    return this.remoteStream;
  }
}

// Singleton export
const loopbackManager = new LoopbackManager();
export default loopbackManager;
