// Read-only checks: never sends mail, changes provider settings or enables dispatch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { Resolver } from 'node:dns/promises';
import { readEmailConfig } from '../server/account-email.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: options } = parseArgs({ options: {
    cloud: { type: 'boolean' }, email: { type: 'boolean' },
    environment: { type: 'string', default: 'dev' },
    'local-origin': { type: 'string', default: 'http://localhost:8080' },
    'resend-domain-id': { type: 'string' }
} });
const env = { ...['.env', '.env.local'].reduce((all, name) => {
    const file = path.join(root, name);
    return { ...all, ...(fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {}) };
}, {}), ...process.env };
const deployment = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8')).env[options.environment];
if (!deployment) throw new Error('Unknown Wrangler environment');
const email = readEmailConfig(env);
const expected = deployment.vars;
const origin = new URL(expected.MICPROBE_PUBLIC_ORIGIN).origin;
const results = [];
function check(name, passed, detail) { results.push({ name, status: passed ? 'pass' : 'fail', detail }); }
async function section(name, work) {
    try { await work(); } catch (error) {
        results.push({ name, status: 'fail', detail: error.message });
    }
}
async function api(url, token, body) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`${new URL(url).hostname}${new URL(url).pathname}: HTTP ${response.status}`);
    const data = await response.json();
    if (data.success === false) throw new Error(`Provider rejected read: ${data.errors?.[0]?.code || 'unknown'}`);
    return data;
}

check('local email credentials', Boolean(email.apiKey && email.webhookSecret), 'Values are never printed.');
check('local sandbox recipients', !email.sandbox || email.sandboxRecipients.length > 0,
    { sandbox: email.sandbox, recipientCount: email.sandboxRecipients.length, sendingEnabled: email.enabled });
for (const [label, base] of [['local', options['local-origin']], ['deployed', origin]]) {
    await section(`${label} checkout`, async () => {
        const data = await api(new URL('/api/freemius/config', base));
        const mode = label === 'local' ? env.MICPROBE_FREEMIUS_MODE : expected.MICPROBE_FREEMIUS_MODE;
        const prefix = `MICPROBE_FREEMIUS_${mode.toUpperCase()}_`;
        check(`${label} checkout config`, data.mode === mode && data.successUrl === `${origin}/app`
            && data.productId === (label === 'local' ? env : expected)[`${prefix}PRODUCT_ID`]
            && !(data.issues?.length), { mode: data.mode, successUrl: data.successUrl, issues: data.issues });
        if (mode === 'sandbox') {
            const url = new URL(data.checkoutUrl);
            const proof = crypto.createHash('md5').update(`${url.searchParams.get('s_ctx_ts')}${env[`${prefix}PRODUCT_ID`]}${env[`${prefix}PRODUCT_SECRET`]}${env[`${prefix}PUBLIC_KEY`]}checkout`).digest('hex');
            check(`${label} sandbox signature`, Boolean(env[`${prefix}PRODUCT_SECRET`])
                && proof === url.searchParams.get('sandbox'), 'Compared with local canonical product credentials.');
        }
    });
}
if (options.cloud) await section('Cloudflare', async () => {
    const authPath = env.MICPROBE_WRANGLER_AUTH_FILE || path.join(env.APPDATA || '', 'xdg.config/.wrangler/config/default.toml');
    const token = env.CLOUDFLARE_API_TOKEN || (fs.existsSync(authPath)
        ? fs.readFileSync(authPath, 'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1] : '');
    if (!token) throw new Error('Cloudflare read credentials unavailable');
    const cf = (route, body) => api(`https://api.cloudflare.com/client/v4${route}`, token, body);
    let account = env.CLOUDFLARE_ACCOUNT_ID;
    if (!account) {
        const accounts = (await cf('/accounts')).result;
        if (accounts.length !== 1) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to select the account');
        account = accounts[0].id;
    }
    const base = `/accounts/${account}/workers/scripts/${deployment.name}`;
    const settings = (await cf(`${base}/settings`)).result;
    const bindings = settings.bindings;
    const actual = Object.fromEntries(bindings.filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
    const differences = Object.keys(expected).filter(key => expected[key] !== actual[key]);
    check('deployed variables match repository', differences.length === 0, differences);
    const mode = expected.MICPROBE_FREEMIUS_MODE.toUpperCase();
    const required = ['MICPROBE_RESEND_API_KEY', 'MICPROBE_RESEND_WEBHOOK_SECRET',
        `MICPROBE_FREEMIUS_${mode}_API_TOKEN`, `MICPROBE_FREEMIUS_${mode}_PRODUCT_SECRET`,
        ...(mode === 'SANDBOX' ? ['MICPROBE_EMAIL_SANDBOX_RECIPIENTS'] : [])];
    const missing = required.filter(name => !bindings.some(b => b.name === name && b.type === 'secret_text'));
    check('deployed secrets', missing.length === 0, { missing });
    for (const [key, type, field, remote] of [['d1_databases', 'd1', 'database_id', 'id'], ['kv_namespaces', 'kv_namespace', 'id', 'namespace_id']]) {
        check(`deployed ${type} bindings`, (deployment[key] || []).every(item =>
            bindings.some(b => b.name === item.binding && b.type === type && b[remote] === item[field])), 'Compared with Wrangler configuration.');
    }
    const schedules = (await cf(`${base}/schedules`)).result.schedules;
    check('email recovery schedule', (deployment.triggers?.crons || []).every(cron => schedules.some(s => s.cron === cron)), 'Compared with Wrangler configuration.');
    const database = deployment.d1_databases.find(b => b.binding === 'MICPROBE_ACCOUNTS');
    const rows = (await cf(`/accounts/${account}/d1/database/${database.database_id}/query`,
        { sql: 'SELECT name FROM d1_migrations', params: [] })).result.flatMap(r => r.results);
    const missingMigrations = fs.readdirSync(path.join(root, database.migrations_dir)).filter(name =>
        name.endsWith('.sql') && !rows.some(row => row.name === name));
    check('deployed migrations match repository', missingMigrations.length === 0, missingMigrations);
    const release = (await cf(`${base}/deployments`)).result.deployments[0];
    results.push({ name: 'deployed release', status: 'info', detail: release.versions });
    results.push({ name: 'automatic sending', status: 'info', detail: actual.MICPROBE_EMAIL_ENABLED });
});
if (options.email) await section('Resend', async () => {
    const key = env.RESEND_MANAGEMENT_API_KEY;
    const domainId = options['resend-domain-id'] || env.MICPROBE_RESEND_DOMAIN_ID;
    if (!key || !domainId) throw new Error('Set RESEND_MANAGEMENT_API_KEY and MICPROBE_RESEND_DOMAIN_ID (or --resend-domain-id); sending-only keys cannot read domain status.');
    const domain = await api(`https://api.resend.com/domains/${encodeURIComponent(domainId)}`, key);
    check('Resend domain verified', domain.name === new URL(origin).hostname && domain.status === 'verified',
        { domain: domain.name, status: domain.status, records: domain.records.map(({ name, type, status }) => ({ name, type, status })) });
    for (const server of ['1.1.1.1', '8.8.8.8']) {
        const resolver = new Resolver({ timeout: 5000, tries: 1 }); resolver.setServers([server]);
        for (const record of domain.records) await section(`DNS ${server} ${record.name}`, async () => {
            const name = record.name.endsWith(`.${domain.name}`) || record.name === domain.name ? record.name : `${record.name}.${domain.name}`;
            const answers = await resolver.resolve(name, record.type);
            const clean = value => value.replace(/\.$/, '').toLowerCase();
            check(`DNS ${server} ${name} ${record.type}`, answers.some(answer => record.type === 'TXT'
                ? answer.join('') === record.value : record.type === 'MX'
                    ? clean(answer.exchange) === clean(record.value) && answer.priority === record.priority
                    : typeof answer === 'string' && clean(answer) === clean(record.value)), 'Exact provider record match.');
        });
    }
});
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), environment: options.environment,
    checks: results, limitations: ['Does not prove Google sign-in, purchase completion, provider-originated delivery or Gmail sender verification.',
        'Compares deployed configuration and migrations; does not claim source bundle or asset parity.'] }, null, 2));
process.exitCode = results.some(check => check.status === 'fail') ? 1 : 0;
