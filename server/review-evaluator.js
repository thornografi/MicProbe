// One evidence-led decision contract for both server runtimes. No provider call
// belongs here; entitlement, persistence and cost admission are separate gates.
const { analyzeMeasurements } = require('./premium-report-evaluator.js');
const { assessPlatformExpectations, applyPlatformExpectations, publicPlatformAssessment } = require('./platform-expectations.js');
const { normalizeEnvironment } = require('../js/modules/EnvironmentContext.js');
const { usableReport } = require('../js/modules/MeasurementValidity.js');
const { SUPPORT_QUESTIONS, SUPPORT_ACTIONS, resolvedContext, contextKey, wasTried, supportDecision, measuredAction, alternativeInput, silentInputDecision } = require('./review-guidance.js');
const VERSION = '3';
const CATALOG_VERSION = '2026-09-11.2';
const finite = Number.isFinite;
const options = values => values.map(([value, label]) => ({ value, label }));
const QUESTIONS = {
  ...SUPPORT_QUESTIONS,
  spoke: { id: 'spoke', text: 'Were you speaking during the speaking part of this recording?',
    options: options([['yes', 'Yes'], ['no', 'No'], ['unknown', 'Not sure']]) },
  sameProblem: { id: 'sameProblem', text: 'Can you hear the same problem in this recording?',
    options: options([['yes', 'Yes, in this recording'], ['external', 'Only in my actual app'], ['unknown', 'Not sure']]) },
  measuredPart: { id: 'measuredPart', text: 'Only the beginning of this recording was measured. Is the problem audible in that part?',
    options: options([['yes', 'Yes, in the measured part'], ['later', 'Only later in the recording'], ['unknown', 'Not sure']]) }
};
const ACTIONS = {
  ...SUPPORT_ACTIONS,
  inputLevel: { id: 'inputLevel', title: 'Check one input condition',
    instruction: 'If playback is too quiet, change either your speaking distance or one available input-level control. Keep the other unchanged.',
    purpose: 'Check whether the recorded level changes without adding distortion.',
    keep: 'Use the same microphone, profile, phrase and room. Keep all other controls unchanged.',
    outcomes: 'A level change describes this recording path. It does not by itself identify a faulty device or prove an improvement in your actual app.',
    changes: ['distance', 'input-level'], target: 'local' },
  headroom: { id: 'headroom', title: 'Check one input-level change',
    instruction: 'If playback sounds distorted, lower one available input-level control. If unavailable, use a slightly greater speaking distance instead.',
    purpose: 'Check whether the peak pattern changes while the recording stays audible.',
    keep: 'Use the same microphone, profile, phrase and room. Change only the selected condition.',
    outcomes: 'Fewer full-scale samples or a different peak pattern is a measured change, not proof of the original cause.',
    changes: ['input-level', 'distance'], target: 'local' },
  background: { id: 'background', title: 'Check one background condition',
    instruction: 'If background sound is troublesome, reduce one audible background source while keeping your speaking position and input controls unchanged.',
    purpose: 'Check the recorded quiet level and, where valid, its separation from the speaking segment.',
    keep: 'Use the same microphone, profile, phrase, distance and processing settings.',
    outcomes: 'A quieter background is useful only if your voice remains clear; different measurement methods are not interchangeable.',
    changes: ['background'], target: 'local' }
};
const FINDINGS = {
  LOW_RECORDED_LEVEL: { action: 'inputLevel', paths: ['signal.maxBlockRmsDb', 'lufs.integrated'] },
  FULL_SCALE_SAMPLES: { action: 'headroom', paths: ['clipping.rate'] },
  PINNED_CEILING: { action: 'headroom', paths: ['ceiling.nearCeilingRate', 'signal.crestFactorDb'] },
  TRUE_PEAK_OVER: { action: 'headroom', paths: ['truePeak.db'] },
  MEASURED_NOISE: { action: 'background', paths: ['noiseFloor.estimatedDb'] },
  MEASURED_LOW_SNR: { action: 'background', paths: ['snr.estimatedDb'] }
};

function validateAnswers(answers = {}) {
  if (!answers || Array.isArray(answers) || typeof answers !== 'object') throw new Error('invalid_review_answer');
  for (const [id, value] of Object.entries(answers)) {
    if (!QUESTIONS[id]?.options.some(option => option.value === value)) throw new Error('invalid_review_answer');
  }
  return { ...answers };
}

function evaluateReview(report, context = {}, catalogs) {
  const answers = validateAnswers(context.answers);
  const checked = usableReport(report);
  const platform = assessPlatformExpectations(checked.report, catalogs);
  const result = { version: VERSION, catalogVersion: CATALOG_VERSION, status: 'STOP', eligible: false, supportAvailable: checked.valid,
    reason: 'no-evidence', title: 'This recording cannot support a personal explanation yet.',
    observations: [], blockedClaims: ['physical-root-cause', 'speech-intelligibility', 'actual-app-behavior', 'recipient-audio'],
    invalidFields: checked.invalid, question: null, next: null,
    scope: 'These measurements describe the saved local recording. Your actual app and its recipient were not measured.',
    platformAssessment: platform, platform: publicPlatformAssessment(platform),
    ai: { available: false, reason: 'provider-not-connected' } };
  if (!checked.valid) {
    const canRecover = context.localAudioAvailable === true && !context.analysis && ['record', 'test'].includes(report?.run?.type);
    result.status = canRecover ? 'PREPARE' : 'STOP';
    result.reason = checked.invalid[0];
    result.title = 'There is not enough consistent recording evidence for a personal explanation.';
    if (canRecover) result.next = { id: 'analyse-existing', target: 'local-file',
      instruction: 'The existing recording can be analysed again; another recording is not required for that step.' };
    return result;
  }
  const findings = applyPlatformExpectations(analyzeMeasurements(checked.report).filter(item => FINDINGS[item.id]), platform);
  result.platform = publicPlatformAssessment(platform);
  const low = findings.find(item => item.id === 'LOW_RECORDED_LEVEL');
  // Near-silence alone cannot establish that a user attempted to speak. Other
  // independent, valid observations remain usable even when this one is held.
  const accepted = findings.filter(item => !item.nearSilent || answers.spoke === 'yes');
  result.observations = accepted.map(item => ({ id: item.id, kind: 'measured', text: item.reason,
    expectation: item.expectation || 'not-established',
    evidencePaths: item.evidencePaths || FINDINGS[item.id].paths, severity: item.severity }));
  const deviations = platform.comparisons.filter(item => item.status !== 'within');
  for (const comparison of deviations) result.observations.push({ id: `PLATFORM_DEVIATION:${comparison.path}`, kind: 'reference-comparison', severity: 'info',
    text: `${comparison.label} is ${comparison.status} the validated range for this local scenario. The comparison does not identify a physical cause.`,
    evidencePaths: [comparison.path] });
  const actionable = accepted.filter(item => item.expectation !== 'within-reference');
  // User-reported app trouble is a support route even with normal local audio.
  // It never becomes measured evidence or an AI admission signal.
  if (answers.sameProblem === 'external') return supportDecision(result, checked.report, context);
  if (context.hasComplaint === true && !actionable.length && !low?.nearSilent) {
    if (!Object.hasOwn(answers, 'sameProblem')) return { ...result, status: 'PREPARE', reason: 'complaint-scope',
      title: 'The recording has no finding that explains the reported problem.', question: QUESTIONS.sameProblem };
    return supportDecision(result, checked.report, context);
  }
  if (accepted.length && !actionable.length && !deviations.length && !low?.nearSilent) {
    return { ...result, status: 'SUMMARY', reason: 'expected-platform-behavior', title: 'The compared findings are expected for this local scenario.' };
  }
  if (deviations.length && !actionable.length && !low?.nearSilent) {
    return { ...result, status: 'EXPLAIN', eligible: true, reason: 'platform-deviation', title: 'A measured characteristic differs from this scenario’s validated reference.' };
  }
  if (!accepted.length) {
    if (low?.nearSilent && !Object.hasOwn(answers, 'spoke')) {
      return { ...result, status: 'PREPARE', reason: 'speech-context', title: 'Almost no input was captured; the recording does not show whether you spoke.', question: QUESTIONS.spoke };
    }
    if (context.hasComplaint === true && !Object.hasOwn(answers, 'sameProblem')) {
      return { ...result, status: 'PREPARE', reason: 'complaint-scope', title: 'The recording has no finding that explains the reported problem.', question: QUESTIONS.sameProblem };
    }
    return { ...result, status: low || context.hasComplaint || answers.sameProblem ? 'STOP' : 'SUMMARY',
      reason: low ? 'no-speech-evidence' : answers.sameProblem === 'external' ? 'outside-measured-scope' : 'no-supported-finding',
      title: low ? 'This sample does not support a cause or a setting change.'
        : answers.sameProblem === 'external' ? 'The problem in your actual app was not measured here.'
          : 'No recording warning supports an additional personal explanation.' };
  }
  result.status = 'EXPLAIN'; result.eligible = true; result.reason = 'measured-finding';
  result.title = 'There is a measured finding to explain.';
  const coverage = checked.report.audioMetrics.coverage;
  if (coverage?.truncated !== false) {
    result.scope = 'These findings describe only the measured part of the saved recording. They cannot establish what happened in the rest of it or in your actual app.';
  }
  // Questions appear only after an explicit Premium review, and only when the
  // answer changes whether a corrective check is relevant to this sample.
  if (!Object.hasOwn(answers, 'sameProblem')) {
    result.question = QUESTIONS.sameProblem;
    return result;
  }
  if (answers.sameProblem !== 'yes') {
    result.reason = answers.sameProblem === 'external' ? 'finding-not-linked-to-complaint' : 'complaint-link-unknown';
    return result;
  }
  if (coverage?.truncated !== false) {
    if (coverage?.truncated === true && finite(coverage.analyzedDurationSec) && !Object.hasOwn(answers, 'measuredPart')) {
      result.question = { ...QUESTIONS.measuredPart,
        text: `Only the first ${coverage.analyzedDurationSec} seconds were measured. Is the problem audible in that part?` };
    }
    if (coverage?.truncated !== true || answers.measuredPart !== 'yes') {
      result.reason = 'complaint-outside-known-coverage';
      return result;
    }
  }
  const tried = Array.isArray(context.attempts) ? context.attempts : [];
  if (low?.nearSilent && !accepted.some(item => FINDINGS[item.id].action === 'headroom')) return silentInputDecision(result, checked.report, context);
  const present = new Set(actionable.map(item => FINDINGS[item.id].action));
  const hasHeadroomFinding = accepted.some(item => FINDINGS[item.id].action === 'headroom');
  // A brief saturated peak and low sustained loudness can coexist. Do not then
  // propose raising input level, even after a headroom check was unavailable.
  const candidates = ['headroom', 'background', 'inputLevel'].filter(id => present.has(id)
    && !(id === 'inputLevel' && hasHeadroomFinding));
  const key = contextKey(resolvedContext(checked.report, answers));
  // An input-route answer selects an alternative; it does not reopen the same
  // unavailable system slider under a different context key.
  const primaryKey = contextKey({ ...resolvedContext(checked.report, answers), inputControl: 'unknown' });
  const action = candidates.find(id => !wasTried(tried, id, key) && !wasTried(tried, id, primaryKey));
  if (action) {
    result.status = 'REASON'; result.reason = 'bounded-check'; result.next = measuredAction(ACTIONS[action], checked.report, context);
  } else {
    const alternative = alternativeInput(checked.report, context, hasHeadroomFinding ? 'headroom' : 'inputLevel');
    if (alternative) return { ...result, status: alternative.question ? 'PREPARE' : 'REASON', reason: 'alternative-input-control', ...alternative };
    result.status = 'STOP'; result.eligible = false;
    result.reason = 'checks-exhausted'; result.title = 'The supported checks for this recording have been tried.';
  }
  return result;
}

function compareReviewReports(before, after, { change, sameMicrophone = false, sameConditions = false } = {}) {
  const a = usableReport(before), b = usableReport(after);
  const differences = [];
  if (!a.valid || !b.valid) return { status: 'unavailable', differences, cause: 'not-determined', reason: 'inconsistent-evidence' };
  const settings = ['sampleRate', 'channelCount', 'echoCancellation', 'noiseSuppression', 'autoGainControl'];
  const leftEnvironment = normalizeEnvironment(before.environment), rightEnvironment = normalizeEnvironment(after.environment);
  const sameEnvironment = leftEnvironment.os !== 'unknown' && leftEnvironment.browser !== 'unknown'
    && leftEnvironment.formFactor !== 'unknown' && leftEnvironment.browserMajor !== null
    && ['os', 'browser', 'browserMajor', 'formFactor'].every(key => leftEnvironment[key] === rightEnvironment[key]);
  const comparable = before.profile?.id === after.profile?.id && before.run?.type === after.run?.type
    && sameEnvironment
    && Date.parse(after.generatedAt) > Date.parse(before.generatedAt)
    && before.profile?.pipeline === after.profile?.pipeline && before.profile?.encoder === after.profile?.encoder
    && before.profile?.referenceVersion === after.profile?.referenceVersion
    && settings.every(key => before.profile?.appliedConstraints?.[key] != null
      && before.profile.appliedConstraints[key] === after.profile?.appliedConstraints?.[key])
    && before.audioMetrics?.coverage?.truncated === false && after.audioMetrics?.coverage?.truncated === false;
  for (const [key, unit, label] of [['signal.maxBlockRmsDb', 'dBFS', 'Loudest short-window level'], ['clipping.rate', 'ratio', 'Full-scale sample share'],
    ['noiseFloor.estimatedDb', 'dBFS', 'Recorded quiet level'], ['snr.estimatedDb', 'dB', 'Estimated signal / noise']]) {
    const [group, field] = key.split('.'), left = a.report.audioMetrics[group], right = b.report.audioMetrics[group];
    const measured = group === 'signal' ? left?.maxBlockRmsStatus === 'measured' && right?.maxBlockRmsStatus === 'measured'
      && finite(left.maxBlockRmsWindowMs) && left.maxBlockRmsWindowMs === right.maxBlockRmsWindowMs
      : left?.status === 'measured' && right?.status === 'measured' && left.method === right.method;
    if (measured && finite(left[field]) && finite(right[field])) differences.push({ key, label, before: left[field], after: right[field], delta: right[field] - left[field], unit });
  }
  return { status: comparable && sameMicrophone && sameConditions && ['distance', 'input-level', 'background'].includes(change)
    ? 'controlled-by-user-report' : 'descriptive', differences, cause: 'not-determined',
    reason: 'Measured changes do not establish perceptual improvement or a physical cause.' };
}

module.exports = { evaluateReview, compareReviewReports, validateAnswers, ACTIONS, QUESTIONS, VERSION, CATALOG_VERSION };
