// A result has exactly one measurement input. Archive contents, notes and user
// answers are intentionally absent from this contract. No provider calls here.
const reportEvaluator = require('../js/modules/ReportEvaluator.js').default;
const { usableReport } = require('../js/modules/MeasurementValidity.js');
const { evaluatePremiumReport } = require('./premium-report-evaluator.js');

const EVALUATION_VERSION = 'independent-6';
function evaluateIndependentReport(report, catalogs, { legacy = false } = {}) {
  const checked = usableReport(report);
  const detailed = evaluatePremiumReport(report, catalogs);
  const free = reportEvaluator.evaluateFree(report, detailed.platform);
  const observations = free.findings.filter(item => item.expectation !== 'within-reference'
    && item.id !== 'SILENCE' && ['warning', 'critical'].includes(item.severity));
  const publicResult = { overall: free.overall, summary: free.summary, scope: [free.scope,
    ...(legacy ? ['Details for this earlier recording were prepared when it was reopened. The original measurements are unchanged.'] : [])].join(' '),
    nextStep: free.nextStep, scopeSummary: free.scopeSummary, assessment: free.assessment, platform: detailed.platform || null };
  return {
    version: EVALUATION_VERSION, runId: report.run?.id, evaluatedAt: new Date().toISOString(),
    source: 'measurement-rules', legacy, public: publicResult,
    invalidFields: checked.invalid,
    blockedClaims: ['physical-root-cause', 'speech-intelligibility', 'actual-app-behavior', 'recipient-audio'],
    explanation: { source: 'measurement-rules', status: 'ready',
      evidenceVersion: EVALUATION_VERSION, ai: { available: false, reason: 'provider-not-connected',
        evidenceEligible: checked.valid && observations.length > 0 } },
    detailed: { ...detailed, summary: publicResult, findings: free.findings, evaluationVersion: EVALUATION_VERSION }
  };
}

function reportListSummary(report, evaluation) {
  return { run: { id: report.run.id, type: report.run.type }, generatedAt: report.generatedAt,
    profile: { id: report.profile?.id || null, label: report.profile?.label || null },
    device: { micName: report.device?.micName || null },
    result: evaluation?.public || null, explanationReady: !!evaluation?.explanation,
    legacy: !evaluation || evaluation.legacy === true };
}
module.exports = { evaluateIndependentReport, reportListSummary, EVALUATION_VERSION };
