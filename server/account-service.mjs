import { AccountStore, accountError } from './account-store.mjs';
import { createTroubleshootingContext } from '../js/modules/TroubleshootingContext.js';

const SESSION_COOKIE = 'micprobe_session';
const NONCE_COOKIE = 'micprobe_login_nonce';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_JSON_BYTES = 256 * 1024;
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const REPORT_FIELDS = ['version', 'generatedAt', 'sessionId', 'run', 'environment', 'device', 'profile', 'communicationContext', 'troubleshooting', 'recording', 'loopback', 'audioMetrics', 'deepAnalysis', 'system', 'sanityCheck', 'logs'];
let googleKeysCache = { keys: [], expiresAt: 0 };
let googleKeysRequest = null;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const hashToken = async token => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
const readCookie = (request, name) => request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const cookie = (request, name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
const isToken = token => /^[A-Za-z0-9_-]{43}$/.test(token);

export function isAccountMutationAllowed(request, origin) {
    const expected = origin ? new URL(origin).origin : new URL(request.url).origin;
    return request.headers.get('Origin') === expected && request.headers.get('X-MicProbe-Request') === '1'
        && !['cross-site', 'none'].includes(request.headers.get('Sec-Fetch-Site'));
}

export function requireAccountUser(request, user) {
    if (!user) throw accountError(401, 'sign_in_required', 'Sign in to view your saved tests.');
    if (request.headers.get('X-MicProbe-Account') !== user.id) {
        throw accountError(409, 'account_changed', 'The signed-in account changed. Review the current account before trying again.');
    }
    return user;
}

async function readJson(request, maximum = MAX_JSON_BYTES) {
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw accountError(415, 'json_required', 'Send this request as JSON.');
    }
    if (Number(request.headers.get('Content-Length')) > maximum) throw accountError(413, 'request_too_large', 'This request is too large.');
    const reader = request.body?.getReader();
    if (!reader) throw accountError(400, 'invalid_json', 'A JSON request body is required.');
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximum) {
                await reader.cancel();
                throw accountError(413, 'request_too_large', 'This request is too large.');
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        return value;
    } catch { throw accountError(400, 'invalid_json', 'The request body is not a valid JSON object.'); }
}

function decodeBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid token encoding');
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}

async function getGoogleKeys() {
    if (googleKeysCache.expiresAt > Date.now()) return googleKeysCache.keys;
    if (!googleKeysRequest) googleKeysRequest = (async () => {
        const response = await fetch(GOOGLE_KEYS_URL, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Google key service unavailable');
        const { keys } = await response.json();
        if (!Array.isArray(keys) || !keys.length) throw new Error('Google keys unavailable');
        const maxAge = Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] || 300);
        googleKeysCache = { keys, expiresAt: Date.now() + Math.min(maxAge, 21600) * 1000 };
        return keys;
    })().finally(() => { googleKeysRequest = null; });
    return googleKeysRequest;
}

async function verifyGoogleSignature(credential) {
    const pieces = credential.split('.');
    if (pieces.length !== 3) throw new Error('Invalid ID token');
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(pieces[0])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported ID token');
    const keys = await getGoogleKeys();
    const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (!jwk) throw new Error('Unknown signing key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(pieces[2]), new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`))) {
        throw new Error('Invalid ID token signature');
    }
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(pieces[1])));
}

function validateGoogleClaims(claims, clientId, nonce) {
    const now = Date.now() / 1000;
    const audienceMatches = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId) && claims.azp === clientId);
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || !audienceMatches
        || (claims.azp && claims.azp !== clientId) || claims.nonce !== nonce
        || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat)
        || claims.iat > now + 60 || claims.iat < now - 3660 || claims.exp <= claims.iat
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 60))
        || claims.email_verified !== true || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255
        || typeof claims.email !== 'string' || claims.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(claims.email)) {
        throw new Error('Invalid Google identity');
    }
    // Email is display data. Only Google's stable subject owns the account.
    const authoritativeEmail = claims.email.toLowerCase().endsWith('@gmail.com') || (typeof claims.hd === 'string' && !!claims.hd.trim());
    return { sub: claims.sub, email: claims.email, authoritativeEmail,
        name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : '' };
}

function validateReport(report) {
    if (!report || Array.isArray(report) || typeof report !== 'object' || !report.run
        || typeof report.run.id !== 'string' || !report.run.id || report.run.id.length > 160
        || !['test', 'record', 'troubleshooting'].includes(report.run.type) || typeof report.version !== 'string'
        || !Number.isFinite(Date.parse(report.generatedAt))) {
        throw accountError(400, 'invalid_report', 'This test report is incomplete.');
    }
    const inspect = (value, depth = 0) => {
        if (depth > 16 || (typeof value === 'string' && value.length > 16384) || (Array.isArray(value) && value.length > 4096)) {
            throw accountError(400, 'invalid_report', 'This report contains unsupported data.');
        }
        if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
            if (['__proto__', 'prototype', 'constructor', 'pcm', 'pcmData', 'audioData', 'audioBlob', 'recordingBlob', 'base64'].includes(key)) {
                throw accountError(400, 'invalid_report', 'Only test measurements and settings can be saved.');
            }
            inspect(child, depth + 1);
        }
    };
    // Client-supplied premium results and account identifiers are never persisted.
    const safe = Object.fromEntries(REPORT_FIELDS.filter(field => Object.hasOwn(report, field)).map(field => [field, report[field]]));
    inspect(safe);
    if (Object.hasOwn(safe, 'troubleshooting')) safe.troubleshooting = createTroubleshootingContext({ input: safe.troubleshooting });
    return safe;
}

function validateNote(note = '') {
    if (typeof note !== 'string' || note.length > 2000) throw accountError(400, 'invalid_note', 'Notes can contain up to 2,000 characters.');
    return note;
}

function timestamp(value) {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(parsed)) throw accountError(400, 'invalid_license', 'A verified purchase timestamp is required.');
    return parsed;
}

function normalizeLicense(license, mode) {
    if (!license || (license.mode && license.mode !== mode) || !/^\d{1,30}$/.test(String(license.licenseId || '')) || typeof license.active !== 'boolean') {
        throw accountError(400, 'invalid_license', 'The verified purchase is not valid for this environment.');
    }
    return { ...license, mode, licenseId: String(license.licenseId), freemiusUserId: license.freemiusUserId ? String(license.freemiusUserId) : null, verifiedAt: timestamp(license.verifiedAt) };
}

export function createAccountService({ db, googleClientId = '', mode = 'sandbox', origin, verifyGoogleToken = verifyGoogleSignature } = {}) {
    if (!['sandbox', 'production'].includes(mode)) throw new Error('Unsupported Freemius account mode');
    const configured = !!db && typeof googleClientId === 'string' && !!googleClientId.trim();
    const store = db ? new AccountStore(db, mode) : null;
    const requireConfigured = () => { if (!configured) throw accountError(503, 'account_unavailable', 'Account sign-in is not configured yet.'); };

    async function getUser(request) {
        if (!configured) return null;
        const token = readCookie(request, SESSION_COOKIE);
        return isToken(token) ? store.getUser(await hashToken(token)) : null;
    }

    async function snapshot(user) {
        const license = user ? await store.getLicense(user.id) : null;
        return { ok: true, user: user ? { id: user.id, email: user.email, name: user.name } : null,
            premium: { unlocked: license?.active === true,
                pending: license?.active === false && Date.parse(license.verifiedAt) === 0, mode } };
    }

    async function handle(request) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/api/account/')) return null;
        try {
            if (!['GET', 'HEAD'].includes(request.method) && !isAccountMutationAllowed(request, origin)) {
                throw accountError(403, 'request_origin', 'Refresh this page and try again.');
            }
            if (googleClientId && !db) throw accountError(503, 'account_unavailable', 'The account database is unavailable. Please try again later.');
            if (url.pathname === '/api/account/config' && request.method === 'GET') {
                if (!configured) return json({ ok: true, configured: false, googleClientId: null, nonce: null });
                // Routine session/config refreshes do not own a Google button.
                if (url.searchParams.get('challenge') === '0') return json({ ok: true, configured: true, googleClientId, nonce: null });
                const nonce = randomToken();
                await store.addChallenge(await hashToken(nonce), Date.now() + 600000);
                // Each outstanding button owns a separate browser cookie. Even
                // simultaneous first visits cannot replace another tab's proof.
                return json({ ok: true, configured: true, googleClientId, nonce }, 200, { 'Set-Cookie': cookie(request, `${NONCE_COOKIE}_${nonce}`, nonce, 600) });
            }
            if (url.pathname === '/api/account/session' && request.method === 'GET') return json(await snapshot(await getUser(request)));
            requireConfigured();
            if (url.pathname === '/api/account/google' && request.method === 'POST') {
                const { credential } = await readJson(request, 16384);
                if (typeof credential !== 'string' || credential.length > 12288) throw accountError(401, 'sign_in_expired', 'Sign-in expired. Please try again.');
                let identity;
                let nonce;
                try {
                    const claims = await verifyGoogleToken(credential, { audience: googleClientId });
                    nonce = claims.nonce;
                    if (!isToken(nonce) || readCookie(request, `${NONCE_COOKIE}_${nonce}`) !== nonce) throw new Error('Missing browser proof');
                    identity = validateGoogleClaims(claims, googleClientId, nonce);
                }
                catch { throw accountError(401, 'invalid_identity', 'Google sign-in could not be verified. Please try again.'); }
                if (!await store.consumeChallenge(await hashToken(nonce))) throw accountError(401, 'sign_in_expired', 'Sign-in expired. Please try again.');
                const user = await store.upsertUser(identity);
                const token = randomToken();
                const oldToken = readCookie(request, SESSION_COOKIE);
                await store.addSession(await hashToken(token), user.id, Date.now() + SESSION_SECONDS * 1000, isToken(oldToken) ? await hashToken(oldToken) : null);
                const response = json(await snapshot(user));
                response.headers.append('Set-Cookie', cookie(request, SESSION_COOKIE, token, SESSION_SECONDS));
                response.headers.append('Set-Cookie', cookie(request, `${NONCE_COOKIE}_${nonce}`, '', 0));
                return response;
            }
            if (url.pathname === '/api/account/logout' && request.method === 'POST') {
                const user = await getUser(request);
                if (user) requireAccountUser(request, user);
                const token = readCookie(request, SESSION_COOKIE);
                if (isToken(token)) await store.deleteSession(await hashToken(token));
                return json(await snapshot(null), 200, { 'Set-Cookie': cookie(request, SESSION_COOKIE, '', 0) });
            }
            const user = requireAccountUser(request, await getUser(request));
            if (url.pathname === '/api/account/reports' && request.method === 'GET') {
                const requestedLimit = Number(url.searchParams.get('limit') || 20);
                if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw accountError(400, 'invalid_limit', 'Invalid page size.');
                let cursor = null;
                if (url.searchParams.has('cursor')) {
                    try {
                        const value = url.searchParams.get('cursor');
                        if (value.length > 256) throw new Error();
                        cursor = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
                        if (!Number.isSafeInteger(cursor.time) || typeof cursor.id !== 'string' || cursor.id.length > 64) throw new Error();
                    } catch { throw accountError(400, 'invalid_cursor', 'Invalid history page.'); }
                }
                const result = await store.listReports(user.id, Math.min(requestedLimit, 50), cursor);
                return json({ ok: true, reports: result.reports, nextCursor: result.cursor ? encode(new TextEncoder().encode(JSON.stringify(result.cursor))) : null });
            }
            if (url.pathname === '/api/account/reports' && request.method === 'POST') {
                const body = await readJson(request);
                return json({ ok: true, report: await store.saveReport(user.id, validateReport(body.report), validateNote(body.note)) });
            }
            const reportId = url.pathname.match(/^\/api\/account\/reports\/([a-zA-Z0-9-]{1,64})$/)?.[1];
            if (reportId && request.method === 'DELETE') {
                if (!await store.deleteReport(user.id, reportId)) throw accountError(404, 'report_not_found', 'This saved test was not found.');
                return json({ ok: true });
            }
            if (reportId && request.method === 'PATCH') {
                const body = await readJson(request, 16384);
                const report = await store.updateReportNote(user.id, reportId, validateNote(body.note));
                if (!report) throw accountError(404, 'report_not_found', 'This saved test was not found.');
                return json({ ok: true, report });
            }
            return json({ ok: false, error: 'not_found', message: 'Account endpoint not found.' }, 404);
        } catch (error) {
            return json({ ok: false, error: error.code || 'account_error', message: error.status ? error.message : 'The account service is temporarily unavailable. Please try again.' }, error.status || 503);
        }
    }

    return {
        configured, handle, getUser,
        getLicense: async userId => store ? store.getLicense(userId) : null,
        getLicenseById: async licenseId => store ? store.getLicenseById(String(licenseId)) : null,
        saveLicense: async (userId, license) => { requireConfigured(); return store.saveLicense(userId, normalizeLicense(license, mode)); },
        updateLicense: async (licenseId, data) => {
            requireConfigured();
            if (typeof data.active !== 'boolean') throw accountError(400, 'invalid_license', 'A verified purchase status is required.');
            return store.updateLicense(String(licenseId), { active: data.active, verifiedAt: timestamp(data.verifiedAt),
                checkedAt: data.checkedAt === undefined ? null : timestamp(data.checkedAt) });
        },
        createCheckout: async userId => {
            requireConfigured();
            const state = randomToken();
            await store.createCheckout(await hashToken(state), userId);
            return state;
        },
        getCheckout: async (state, userId) => configured && isToken(state) ? store.getCheckout(await hashToken(state), userId) : null,
        completeCheckout: async (state, userId, license) => {
            requireConfigured();
            if (!isToken(state)) throw accountError(400, 'invalid_checkout', 'This checkout could not be verified.');
            return store.completeCheckout(await hashToken(state), userId, normalizeLicense(license, mode));
        },
        recoverCheckout: async (license, { email, createdAt }) => {
            requireConfigured();
            const verified = normalizeLicense(license, mode);
            const created = timestamp(createdAt);
            if (!verified.active || created > Date.now() || typeof email !== 'string' || email.length > 320
                || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
            // Link verified purchase ownership first; billing rechecks the
            // provider after insertion before this new row can grant access.
            return store.recoverCheckout({ ...verified, active: false, verifiedAt: 0 }, email.toLowerCase(), created);
        }
    };
}
