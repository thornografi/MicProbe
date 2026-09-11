// Retain the measured result, never its audio, diagnostic logs or accepted
// server response. The duplicated PCM metrics have a single archive owner.
export function projectArchiveReport(report) {
  const fields = ['version', 'generatedAt', 'sessionId', 'run', 'environment', 'device', 'profile',
    'communicationContext', 'troubleshooting', 'recording', 'loopback', 'audioMetrics', 'deepAnalysis', 'captureContext', 'system', 'sanityCheck'];
  const result = structuredClone(Object.fromEntries(fields.filter(key => Object.hasOwn(report, key)).map(key => [key, report[key]])));
  if (result.deepAnalysis) delete result.deepAnalysis.audioMetrics;
  return result;
}
