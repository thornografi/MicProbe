const routes = Object.freeze({ signin: '#signin', switch: '#switch-account', account: '#account', reports: '#reports', checkout: '#premium' });

export function accountIntent(value) {
  if (value === 'history') return 'reports';
  return Object.hasOwn(routes, value) || ['test-limit', 'report'].includes(value) ? value : 'account';
}
export function accountHash(intent) { return routes[accountIntent(intent)] || '#signin'; }
export function accountIntentFromHash(hash) { return Object.keys(routes).find(key => routes[key] === hash) || null; }
