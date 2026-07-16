/**
 * LoopbackManager - WebRTC Loopback yonetimi
 * OCP: Loopback ile ilgili tum state ve fonksiyonlar tek yerde
 * DRY: Tekrarlanan WebRTC/AudioContext islemleri merkezi
 */

import eventBus from './EventBus.js';
import { createAudioContext, getAudioContextOptions, stopStreamTracks, createAndPlayActivatorAudio, cleanupActivatorAudio, disconnectNodes, log } from './utils.js';
import { DELAY, BUFFER, LOOPBACK, PIPELINE_TYPES, EVENTS } from './constants.js';
import { createPassthroughWorkletNode, ensurePassthroughWorklet } from './WorkletHelper.js';

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

    // Monitor playback state
    this.monitorCtx = null;
    this.monitorSrc = null;
    this.monitorProc = null;
    this.monitorWorklet = null;
    this.monitorDelay = null;
    this.monitorMode = null;

    // Stats polling state
    this.statsInterval = null;
    this.signalCheckTimeout = null;
    this.lastBytesSent = 0;
    this.lastStatsTimestamp = 0;
    this._isCleaningUp = false; // Race condition guard for async stats polling

    // Worklet support flag (dısarıdan set edilir)
    this.workletSupported = true;
  }

  /**
   * SDP'yi Opus bitrate ile modifiye et
   * @param {string} sdp - Orijinal SDP
   * @param {number} bitrate - Hedef bitrate (bps)
   * @returns {string} Modifiye edilmis SDP
   */
  setOpusBitrate(sdp, bitrate) {
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

    const modifiedLines = lines.map(line => {
      // Opus fmtp satirini bul (payload type ile eslesme)
      if (line.startsWith(`a=fmtp:${opusPayloadType}`)) {
        // Mevcut maxaveragebitrate varsa kaldir
        let newLine = line.replace(/;?maxaveragebitrate=\d+/g, '');
        // Yeni bitrate ekle
        newLine += `;maxaveragebitrate=${bitrate}`;
        return newLine;
      }
      return line;
    });

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
    const { useWebAudio = false, opusBitrate = 32000 } = options;

    // BUG-4 fix: Onceki baglanti aciksa once temizle (double-setup leak onleme)
    if (this.pc1) {
      log.stream('LoopbackManager: Previous connection still open, cleaning up first');
      await this.cleanup();
    }

    log.stream('WebRTC Loopback setting up', { useWebAudio, opusBitrate });

    this.localStream = localStream;

    // WebAudio pipeline (opsiyonel)
    let sendStream = localStream;
    if (useWebAudio) {
      const acOptions = getAudioContextOptions(localStream);
      this.audioCtx = await createAudioContext(acOptions);

      const src = this.audioCtx.createMediaStreamSource(localStream);
      const dest = this.audioCtx.createMediaStreamDestination();
      src.connect(dest);
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
    this.pc1 = new RTCPeerConnection({ iceServers: [] });
    this.pc2 = new RTCPeerConnection({ iceServers: [] });

    // ICE candidate handler'lari - cleanup sirasinda gec gelen candidate'ler icin guard (DRY)
    this.pc1.onicecandidate = this._createIceCandidateHandler('pc2');
    this.pc2.onicecandidate = this._createIceCandidateHandler('pc1');

    // Track handler - WebRTC'nin sagladigi stream'i kullan
    this.pc2.ontrack = (e) => {
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
    const offer = await this.pc1.createOffer({ offerToReceiveAudio: true });

    // Offer SDP'yi Opus bitrate ile modifiye et
    const modifiedOfferSdp = this.setOpusBitrate(offer.sdp, opusBitrate);
    const modifiedOffer = { type: offer.type, sdp: modifiedOfferSdp };

    log.stream(`Loopback: Opus bitrate ayarlandi - ${opusBitrate / 1000} kbps`, { opusBitrate, sdpModified: modifiedOfferSdp !== offer.sdp });

    await this.pc1.setLocalDescription(modifiedOffer);
    await this.pc2.setRemoteDescription(modifiedOffer); // ontrack burada tetiklenir

    const answer = await this.pc2.createAnswer();

    // Answer SDP'yi de Opus bitrate ile modifiye et
    const modifiedAnswerSdp = this.setOpusBitrate(answer.sdp, opusBitrate);
    const modifiedAnswer = { type: answer.type, sdp: modifiedAnswerSdp };

    await this.pc2.setLocalDescription(modifiedAnswer);
    await this.pc1.setRemoteDescription(modifiedAnswer);

    // ICE baglanti durumunu bekle
    await this._waitForIceConnection();

    // Stream kontrolu
    if (!this.remoteStream) {
      throw new Error('Remote stream olusturulamadi - ontrack tetiklenmedi');
    }

    const remoteTrack = this.remoteStream.getAudioTracks()[0];

    // Track muted ise unmute olmasini bekle
    if (remoteTrack && remoteTrack.muted) {
      await this._waitForTrackUnmute(remoteTrack);
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
  }

  /**
   * ICE candidate handler olustur (DRY: pc1/pc2 icin ayni logic)
   * @param {string} receiverPcKey - Candidate'i alacak peer ('pc1' veya 'pc2')
   * @returns {Function} onicecandidate handler
   * @private
   */
  _createIceCandidateHandler(receiverPcKey) {
    return (e) => {
      if (e.candidate && this[receiverPcKey] && !this._isCleaningUp) {
        this[receiverPcKey].addIceCandidate(e.candidate).catch(err => {
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
    return new Promise((resolve, reject) => {
      let pollTimer = null;

      const cleanupListeners = () => {
        this.pc1.oniceconnectionstatechange = null;
        this.pc2.oniceconnectionstatechange = null;
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      };

      const timeout = setTimeout(() => {
        cleanupListeners();
        log.error('Loopback: ICE baglanti zaman asimi', {
          pc1Ice: this.pc1.iceConnectionState,
          pc2Ice: this.pc2.iceConnectionState
        });
        reject(new Error('ICE connection timeout'));
      }, LOOPBACK.ICE_WAIT_MS);

      let lastIce1 = null;
      let lastIce2 = null;

      const checkConnection = () => {
        const ice1 = this.pc1.iceConnectionState;
        const ice2 = this.pc2.iceConnectionState;

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
        } else if (ice1 === 'failed' || ice2 === 'failed') {
          clearTimeout(timeout);
          cleanupListeners();
          reject(new Error('ICE connection failed'));
        } else {
          pollTimer = setTimeout(checkConnection, 100);
        }
      };

      this.pc1.oniceconnectionstatechange = checkConnection;
      this.pc2.oniceconnectionstatechange = checkConnection;
      checkConnection();
    });
  }

  /**
   * Track unmute olmasini bekle
   * @private
   */
  async _waitForTrackUnmute(track) {
    log.stream('Loopback: Track muted, waiting for unmute...', { muted: track.muted });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        log.error('Loopback: Track unmute zaman asimi', { stillMuted: track.muted });
        resolve();
      }, 5000);

      track.onunmute = () => {
        clearTimeout(timeout);
        log.stream('Loopback: Track unmuted!', { muted: track.muted });
        resolve();
      };

      if (!track.muted) {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  /**
   * WebRTC getStats ile gercek bitrate olcumu
   */
  startStatsPolling(requestedBitrate) {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }

    this.lastBytesSent = 0;
    this.lastStatsTimestamp = Date.now();
    let statsErrorCount = 0;
    let measurementCount = 0;
    const GRACE_MEASUREMENTS = 12; // Ilk 12 olcum (6 saniye @ 500ms) - ramp-up periyodu

    this.statsInterval = setInterval(async () => {
      // Race condition guard: cleanup sırasında veya pc1 yoksa çık
      if (this._isCleaningUp || !this.pc1) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
        return;
      }

      try {
        const stats = await this.pc1.getStats();
        let currentBytesSent = 0;
        let rtt = null;
        let jitter = null;
        let packetsLost = 0;
        let packetsReceived = 0;
        // Sistem/performans proxy sinyalleri (SystemProbeCollector tuketir)
        let jitterBufferDelay = null;
        let jitterBufferEmittedCount = null;
        let concealedSamples = null;
        let concealmentEvents = null;
        let insertedSamplesForDeceleration = null;
        let removedSamplesForAcceleration = null;
        let totalSamplesReceived = null;

        stats.forEach(report => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            currentBytesSent = report.bytesSent || 0;
          }
          if (report.type === 'remote-inbound-rtp') {
            rtt = report.roundTripTime ?? null;
            jitter = report.jitter ?? null;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsLost = report.packetsLost || 0;
            packetsReceived = report.packetsReceived || 0;
            // Chrome-only glitch/jitter-buffer alanlari (feature-detect: ?? null)
            jitterBufferDelay = report.jitterBufferDelay ?? null;
            jitterBufferEmittedCount = report.jitterBufferEmittedCount ?? null;
            concealedSamples = report.concealedSamples ?? null;
            concealmentEvents = report.concealmentEvents ?? null;
            insertedSamplesForDeceleration = report.insertedSamplesForDeceleration ?? null;
            removedSamplesForAcceleration = report.removedSamplesForAcceleration ?? null;
            totalSamplesReceived = report.totalSamplesReceived ?? null;
          }
        });

        const now = Date.now();
        const timeDelta = (now - this.lastStatsTimestamp) / 1000;

        if (this.lastBytesSent > 0 && timeDelta > 0) {
          const bytesDelta = currentBytesSent - this.lastBytesSent;
          const actualBitrate = Math.round((bytesDelta * 8) / timeDelta);
          const actualKbps = (actualBitrate / 1000).toFixed(1);
          const requestedKbps = (requestedBitrate / 1000).toFixed(0);

          const isDtxActive = actualBitrate < 2000;
          const totalPackets = packetsReceived + packetsLost;
          const lossRate = totalPackets > 0 ? packetsLost / totalPackets : null;

          // Stats event'i her zaman emit et (UI icin)
          eventBus.emit(EVENTS.LOOPBACK_STATS, {
            requestedBitrate,
            actualBitrate,
            requestedKbps,
            actualKbps,
            rttMs: rtt !== null ? +(rtt * 1000).toFixed(1) : null,
            jitterMs: jitter !== null ? +(jitter * 1000).toFixed(2) : null,
            packetLossRate: lossRate !== null ? +lossRate.toFixed(4) : null,
            isDtxActive,
            // Sistem/performans proxy sinyalleri (feature-detect; desteklenmeyen tarayicida null)
            jitterBufferDelayMsAvg: (jitterBufferDelay != null && jitterBufferEmittedCount) ? +((jitterBufferDelay / jitterBufferEmittedCount) * 1000).toFixed(2) : null,
            concealedSamples,
            concealmentEvents,
            insertedSamplesForDeceleration,
            removedSamplesForAcceleration,
            totalSamplesReceived
          });

          // Sapma uyarisi: Ramp-up ve DTX periyodunda bastir
          measurementCount++;
          if (measurementCount > GRACE_MEASUREMENTS) {
            const deviation = Math.abs(actualBitrate - requestedBitrate) / requestedBitrate;
            if (deviation > 0.5 && !isDtxActive) {
              log.warning(`WebRTC bitrate deviation: Requested ${requestedKbps}kbps, Actual ~${actualKbps}kbps`, { requestedBitrate, actualBitrate, deviation: (deviation * 100).toFixed(0) + '%' });
            }
          }
        }

        this.lastBytesSent = currentBytesSent;
        this.lastStatsTimestamp = now;
        statsErrorCount = 0;

      } catch (err) {
        statsErrorCount++;
        if (statsErrorCount > 10) {
          clearInterval(this.statsInterval);
          this.statsInterval = null;
          log.error('Loopback stats: Too many errors, stopping polling', { errorCount: statsErrorCount, lastError: err.message });
        }
      }
    }, 500);
  }

  /**
   * Loopback kaynaklarini temizler
   */
  async cleanup() {
    // Race condition flag: stats polling'in cleanup sırasında çalışmasını engelle
    this._isCleaningUp = true;

    // Stats polling durdur
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // Signal check timeout durdur
    if (this.signalCheckTimeout) {
      clearTimeout(this.signalCheckTimeout);
      this.signalCheckTimeout = null;
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

    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch (err) {
        log.error('Loopback: AudioContext close error', { error: err.message });
      }
      this.audioCtx = null;
    }

    log.stream('Loopback: Resources cleaned up', {});

    // Cleanup tamamlandı, flag'i sıfırla
    this._isCleaningUp = false;
  }

  /**
   * Monitor playback kaynaklarini temizle
   * DRY: disconnectNodes helper ile node disconnect
   */
  async cleanupMonitorPlayback() {
    // ScriptProcessor onaudioprocess temizle (disconnect oncesi)
    if (this.monitorProc?.onaudioprocess) {
      this.monitorProc.onaudioprocess = null;
    }

    // DRY: disconnectNodes helper ile tum node'lari temizle
    disconnectNodes([
      this.monitorProc,
      this.monitorWorklet,
      this.monitorDelay,
      this.monitorSrc
    ]);

    // Node referanslarini temizle
    this.monitorProc = null;
    this.monitorWorklet = null;
    this.monitorDelay = null;
    this.monitorSrc = null;

    // AudioContext kapat
    if (this.monitorCtx) {
      try {
        const prevState = this.monitorCtx.state;
        await this.monitorCtx.close();
        log.webaudio('Loopback Monitor: AudioContext closed', { previousState: prevState, newState: 'closed' });
      } catch (err) {
        log.error('Loopback Monitor: AudioContext close error', { error: err.message });
      } finally {
        this.monitorCtx = null;
      }
    }

    // DRY: Activator audio temizle
    cleanupActivatorAudio(window._loopbackMonitorActivatorAudio);
    window._loopbackMonitorActivatorAudio = null;

    this.monitorMode = null;
  }

  /**
   * Monitor playback baslat
   * @param {MediaStream} remoteStream - WebRTC remote stream
   * @param {Object} options - Seçenekler
   * @param {string} options.mode - Processing mode (direct, standard, scriptprocessor, worklet)
   * @param {number} options.bufferSize - Buffer size (for scriptprocessor)
   * @throws {Error} Remote stream yoksa
   */
  async startMonitorPlayback(remoteStream, options = {}) {
    await this.cleanupMonitorPlayback();

    if (!remoteStream) {
      throw new Error('Loopback Monitor: remote stream yok');
    }

    const { mode: requestedMode = PIPELINE_TYPES.STANDARD, bufferSize = BUFFER.DEFAULT_SIZE } = options;

    const safeMode = (() => {
      // Loopback monitoring icin izin verilen modlar (ScriptProcessor YASAK - sadece record icin)
      const allowed = new Set([PIPELINE_TYPES.DIRECT, PIPELINE_TYPES.STANDARD, PIPELINE_TYPES.WORKLET]);
      if (!allowed.has(requestedMode)) return PIPELINE_TYPES.STANDARD;
      if (requestedMode === PIPELINE_TYPES.WORKLET && !this.workletSupported) return PIPELINE_TYPES.STANDARD;
      return requestedMode;
    })();

    this.monitorMode = safeMode;

    // DRY: Chrome/WebRTC activator audio helper kullan
    window._loopbackMonitorActivatorAudio = await createAndPlayActivatorAudio(remoteStream, 'Loopback Monitor');

    // Remote track sample rate (varsa) ile context olustur
    const acOptions = getAudioContextOptions(remoteStream);
    this.monitorCtx = await createAudioContext(acOptions);

    this.monitorSrc = this.monitorCtx.createMediaStreamSource(remoteStream);

    // DelayNode olustur - gecikme (feedback onleme)
    this.monitorDelay = this.monitorCtx.createDelay(DELAY.MAX_SECONDS);
    this.monitorDelay.delayTime.value = DELAY.DEFAULT_SECONDS;

    const delaySeconds = this.monitorDelay.delayTime.value;

    if (safeMode === PIPELINE_TYPES.WORKLET) {
      await ensurePassthroughWorklet(this.monitorCtx);
      this.monitorWorklet = createPassthroughWorkletNode(this.monitorCtx);
      this.monitorSrc.connect(this.monitorWorklet);
      this.monitorWorklet.connect(this.monitorDelay);
    } else {
      // direct / standard: Source -> Delay
      this.monitorSrc.connect(this.monitorDelay);
    }

    this.monitorDelay.connect(this.monitorCtx.destination);

    const remoteTrack = remoteStream.getAudioTracks?.()?.[0];
    const remoteSampleRate = remoteTrack?.getSettings?.()?.sampleRate;

    const graphByMode = {
      direct: `WebRTC RemoteStream -> Source -> DelayNode(${delaySeconds}s) -> Destination`,
      standard: `WebRTC RemoteStream -> Source -> DelayNode(${delaySeconds}s) -> Destination`,
      worklet: `WebRTC RemoteStream -> Source -> AudioWorklet(passthrough) -> DelayNode(${delaySeconds}s) -> Destination`
    };

    log.webaudio('Loopback Monitor: Playback graph complete', {
      mode: safeMode,
      contextSampleRate: this.monitorCtx.sampleRate,
      remoteSampleRate: remoteSampleRate || 'N/A',
      delaySeconds,
      graph: graphByMode[safeMode] || graphByMode.standard
    });

    eventBus.emit(EVENTS.MONITOR_STARTED, { mode: safeMode, delaySeconds, loopback: true });
    log.loopback(`Loopback monitor aktif (${safeMode} + ${delaySeconds.toFixed(1)}s Delay -> Speaker)`);
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
