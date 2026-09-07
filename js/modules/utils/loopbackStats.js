// A codec capability in the report is not evidence of use: follow the RTP codecId.
function getRtpCodec(stats, rtp) {
  if (!rtp?.codecId) return null;
  let codec = null;
  stats?.forEach(report => {
    if (report?.type === 'codec' && report.id === rtp.codecId) codec = report;
  });
  if (!codec) return null;
  return {
    source: 'rtc-codec-stats',
    mimeType: typeof codec.mimeType === 'string' && codec.mimeType ? codec.mimeType : null,
    clockRate: Number.isFinite(codec.clockRate) && codec.clockRate > 0 ? codec.clockRate : null,
    channels: Number.isInteger(codec.channels) && codec.channels > 0 ? codec.channels : null,
    payloadType: Number.isInteger(codec.payloadType) && codec.payloadType >= 0 ? codec.payloadType : null,
    sdpFmtpLine: typeof codec.sdpFmtpLine === 'string' ? codec.sdpFmtpLine : null
  };
}

// Sender throughput and receiver quality belong to different peer connections.
export function summarizeLoopbackStats(senderStats, receiverStats, previous = null) {
  let outbound = null, inbound = null, remoteInbound = null;
  senderStats?.forEach(report => {
    if (!report) return;
    if (report.type === 'outbound-rtp' && (report.kind || report.mediaType) === 'audio') outbound = report;
    if (report.type === 'remote-inbound-rtp' && (report.kind || report.mediaType) === 'audio') remoteInbound = report;
  });
  receiverStats?.forEach(report => {
    if (!report) return;
    if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'audio') inbound = report;
  });
  const elapsed = outbound && previous && previous.id === outbound.id ? (outbound.timestamp - previous.timestamp) / 1000 : 0;
  const delta = outbound && previous ? outbound.bytesSent - previous.bytesSent : -1;
  const actualBitrate = elapsed > 0 && delta >= 0 ? Math.round(delta * 8 / elapsed) : null;
  const lost = inbound?.packetsLost;
  const received = inbound?.packetsReceived;
  const total = Number.isFinite(lost) && Number.isFinite(received) ? Math.max(0, lost) + received : 0;
  return {
    previous: outbound ? { id: outbound.id, bytesSent: outbound.bytesSent, timestamp: outbound.timestamp } : null,
    stats: {
      timestamp: inbound?.timestamp ?? outbound?.timestamp ?? null,
      senderCodec: getRtpCodec(senderStats, outbound),
      receiverCodec: getRtpCodec(receiverStats, inbound),
      actualBitrate, actualKbps: actualBitrate == null ? null : actualBitrate / 1000,
      rttMs: remoteInbound?.roundTripTime == null ? null : remoteInbound.roundTripTime * 1000,
      jitterMs: inbound?.jitter == null ? null : inbound.jitter * 1000,
      packetLossRate: total > 0 ? Math.max(0, lost) / total : null,
      jitterBufferDelayMsAvg: inbound?.jitterBufferEmittedCount > 0 ? inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount * 1000 : null,
      concealedSamples: inbound?.concealedSamples ?? null,
      concealmentEvents: inbound?.concealmentEvents ?? null,
      insertedSamplesForDeceleration: inbound?.insertedSamplesForDeceleration ?? null,
      removedSamplesForAcceleration: inbound?.removedSamplesForAcceleration ?? null,
      totalSamplesReceived: inbound?.totalSamplesReceived ?? null,
      isDtxActive: null,
      receive: inbound ? { packetsLost: lost ?? null, packetsReceived: received ?? null } : null
    }
  };
}
