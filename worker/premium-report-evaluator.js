// Wrangler bundles the private CommonJS source; it is not a browser asset.
import premiumReport from '../server/premium-report-evaluator.js';

export const { evaluatePremiumReport, isDetailedReportInput } = premiumReport;
