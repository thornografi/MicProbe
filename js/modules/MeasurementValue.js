/** Four significant digits preserve small nonzero measurements; fixed decimal
 * places can falsely turn a nonzero sample share into zero. */
export function formatMeasurementValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toPrecision(4))) : String(value);
}

// independent-1 spread the scope string into characters before appending an
// optional legacy sentence. Repair presentation without rewriting saved results.
export function formatReportScope(scope) {
  if (typeof scope === 'string') return scope;
  if (!Array.isArray(scope) || !scope.every(part => typeof part === 'string')) return '';
  const sentence = scope.findIndex(part => part.length > 1);
  return sentence < 0 ? scope.join('')
    : [scope.slice(0, sentence).join(''), ...scope.slice(sentence)].filter(Boolean).join(' ');
}
