/** Shared account/report copy; this presentation never grants entitlement. */
export function purchaseAccessNotice(state) {
  if (state.connectionError) return {
    title: 'Connection unavailable', action: 'Retry account connection',
    description: 'Reconnect to check your account and existing purchase. No new payment is needed to retry.'
  };
  if (state.pending) return {
    title: 'Purchase verification pending', action: 'Retry purchase verification',
    description: 'Your purchase has not been confirmed yet. Retry verification; do not pay again while it is pending.'
  };
  if (!state.purchaseLinked || state.unlocked) return null;
  const reasons = {
    license_inactive: 'The purchase provider last reported this license as inactive.',
    license_not_found: 'The purchase provider could not find the linked license.',
    lifetime_license_required: 'The linked license did not meet the Lifetime Premium requirement.',
    license_owner_changed: 'The linked license could not be verified for its original purchase owner.',
    license_product_mismatch: 'The linked license could not be verified for MicProbe.',
    license_mode_mismatch: 'The linked license belongs to a different purchase environment.',
    license_plan_mismatch: 'The linked license does not match the Premium plan configured on this site.',
    license_pricing_mismatch: 'The linked license does not match the purchase configuration on this site.'
  };
  return {
    title: 'Premium access needs checking', action: 'Recheck Premium access',
    description: `${reasons[state.inactiveReason] || 'A purchase is linked, but its access status needs to be checked.'} Recheck access or use Manage purchase in your account for help.`
  };
}
