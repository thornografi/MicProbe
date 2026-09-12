// A single public request: no account bootstrap, checkout token or app import.
export function createLandingPricing() {
  const output = document.getElementById('publicPrice');
  const price = document.getElementById('premiumPrice');
  const currency = document.getElementById('premiumPriceCurrency');
  const retry = document.getElementById('pricingRetry');
  async function load(force = false) {
    if (!output || output.dataset.state === 'loading' || (!force && output.dataset.state)) return;
    output.dataset.state = 'loading';
    output.setAttribute('aria-busy', 'true');
    price.textContent = 'Loading price…';
    retry.hidden = true;
    try {
      const response = await fetch('/api/pricing', { credentials: 'omit', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (data.billingCycle !== 'lifetime' || !Number.isFinite(data.amount) || data.amount <= 0
        || !['USD', 'EUR', 'GBP'].includes(data.currency)) throw new Error('unavailable');
      price.textContent = new Intl.NumberFormat('en', { style: 'currency', currency: data.currency }).format(data.amount);
      currency.textContent = data.currency;
      output.dataset.state = 'ready';
    } catch {
      price.textContent = 'Price available at checkout';
      currency.textContent = '';
      output.dataset.state = 'error';
      retry.hidden = false;
    } finally { output.setAttribute('aria-busy', 'false'); }
  }
  retry?.addEventListener('click', () => load(true));
  return load;
}
