import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseAccessNotice } from '../modules/PurchaseAccessNotice.js';
import ReportEvaluator from '../modules/ReportEvaluator.js';

test('connection recovery takes priority over pending and inactive access in both surfaces', () => {
  for (const purchaseLinked of [false, true]) for (const pending of [false, true]) {
    assert.equal(purchaseAccessNotice({ purchaseLinked, pending, connectionError: true }).action, 'Retry account connection');
  }
  assert.equal(purchaseAccessNotice({ purchaseLinked: true, pending: true }).action, 'Retry purchase verification');
});

test('linked licenses offer access recovery and never infer cancellation from an unknown result', () => {
  const unknown = purchaseAccessNotice({ purchaseLinked: true });
  assert.equal(unknown.action, 'Recheck Premium access');
  assert.doesNotMatch(unknown.description, /cancel|refund|another payment/);
  assert.match(purchaseAccessNotice({ purchaseLinked: true, inactiveReason: 'license_plan_mismatch' }).description, /configured on this site/);
  assert.match(purchaseAccessNotice({ purchaseLinked: true, inactiveReason: 'license_inactive' }).description, /last reported/);
  assert.deepEqual(purchaseAccessNotice({ purchaseLinked: true, inactiveReason: '<untrusted>' }), unknown);
  assert.equal(purchaseAccessNotice({ purchaseLinked: true, unlocked: true }), null);
  assert.equal(purchaseAccessNotice({ purchaseLinked: false }), null);
});

test('warning-free copy limits its claim to measured checks', () => {
  const result = ReportEvaluator._calculateOverall([]);
  assert.equal(result.label, 'No warnings found in this recording');
  assert.equal(result.score, 'limited');
  assert.match(ReportEvaluator._generateSummary([]), /Unavailable measurements are not assessed/);
});
