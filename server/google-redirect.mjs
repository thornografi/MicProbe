// Google POSTs across sites. This document makes the final exchange from our
// own origin so the original SameSite=Lax session and nonce cookies are present.
// Credentials stay in this response and the exchange body, never URLs/storage.
export const GOOGLE_REDIRECT_PATH = '/api/account/google/redirect';
const clientPath = `${GOOGLE_REDIRECT_PATH}/client.js`;
const client = `
const input = document.querySelector('input');
const credential = input.value;
input.remove();
try {
  const response = await fetch('${GOOGLE_REDIRECT_PATH}/finish', {
    method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-MicProbe-Request': '1' },
    body: JSON.stringify({ credential })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || 'sign_in_check_account');
  location.replace('/app#google_return=' + encodeURIComponent(result.redirect.nonce)
    + '&owner=' + encodeURIComponent(result.user.id) + '&mode=' + result.redirect.mode);
} catch (error) {
  const codes = ['account_changed', 'portal_account_mismatch', 'sign_in_expired',
    'sign_in_cookies_required', 'invalid_identity', 'google_temporarily_unavailable'];
  location.replace('/app#google_error=' + (codes.includes(error.message) ? error.message : 'sign_in_check_account'));
}
`;
const headers = type => ({
    'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff'
});
const escapeAttribute = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export async function googleRedirectRelay(request) {
    const path = new URL(request.url).pathname;
    if (path === clientPath && request.method === 'GET') return new Response(client, { headers: headers('text/javascript; charset=utf-8') });
    if (path !== GOOGLE_REDIRECT_PATH || request.method !== 'POST') return null;
    const fail = () => new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in interrupted</title><p>Google sign-in could not be completed. Allow cookies for MicProbe and try again.</p><a href="/app#google_error=sign_in_cookies_required">Return to MicProbe</a></html>', {
        status: 400, headers: headers('text/html; charset=utf-8')
    });
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
        || Number(request.headers.get('Content-Length')) > 32768) return fail();
    const reader = request.body?.getReader();
    if (!reader) return fail();
    let body = '', size = 0;
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 32768) { await reader.cancel(); return fail(); }
            body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
    } finally { reader.releaseLock(); }
    const form = new URLSearchParams(body);
    const csrfCookies = (request.headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith('g_csrf_token='));
    const csrf = form.get('g_csrf_token');
    const credential = form.get('credential');
    if (csrfCookies.length !== 1 || !csrf || csrf.length > 512 || csrfCookies[0].slice(13) !== csrf
        || form.getAll('g_csrf_token').length !== 1 || form.getAll('credential').length !== 1
        || !credential || credential.length > 12288) return fail();
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Returning to MicProbe</title><p>Completing Google sign-in…</p><input type="hidden" value="${escapeAttribute(credential)}"><script type="module" src="${clientPath}"></script><noscript>Enable JavaScript, then <a href="/app">return to MicProbe</a> to try again.</noscript></html>`, {
        headers: headers('text/html; charset=utf-8')
    });
}
