// Account and report checkout entry points explain the same navigation boundary.
export function checkoutNotice() {
  const note = document.createElement('p');
  note.className = 'checkout-notice';
  note.append('Download any audio you want to keep before checkout. The return can restore your report, but not the recording. ');
  const link = document.createElement('a');
  link.textContent = 'Purchase & refund conditions';
  link.href = '/terms.html#refunds';
  link.target = '_blank';
  link.rel = 'noopener';
  link.setAttribute('aria-label', 'Purchase and refund conditions (opens in a new tab)');
  note.append(link);
  return note;
}
