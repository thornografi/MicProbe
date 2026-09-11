// Test the actual compiled UI at localhost:8080 with isolated HTTP/provider fixtures.
// Static responses use the build directory, so an existing development server stays untouched.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { access } = require('node:fs/promises');
const BASE = 'http://localhost:8080';
const BUILD = path.resolve(__dirname, '../../.tmp/cloudflare-dev-assets');

async function open(browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.__oneTap = { loads: 0, prompts: 0, microphone: [] };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__oneTap.microphone.push({ promptVisible: !!document.querySelector('#oneTapFixture') });
      throw new DOMException('Permission deliberately denied by the test fixture', 'NotAllowedError');
    };
  });
  const page = await context.newPage(), errors = [], choices = [];
  let signedIn = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.href === 'https://accounts.google.com/gsi/client') return route.fulfill({ contentType: 'application/javascript', body: `
      window.__oneTap.loads++;
      google = {accounts:{id:{
        initialize(options){this.options=options;window.__oneTap.options=options;},
        cancel(){document.getElementById('oneTapFixture')?.remove();}, disableAutoSelect(){},
        prompt(){window.__oneTap.prompts++;this.renderButton(document.body,true);},
        renderButton(container,prompt=false){
          prompt=prompt===true;
          const callback=this.options.callback;
          const button=document.createElement('button');button.id=prompt?'oneTapFixture':'googleButtonFixture';
          button.textContent='Continue with Google (fixture)';
          button.onclick=()=>callback({credential:'fixture-proof'});container.append(button);
          if(prompt)window.__oneTap.late=button.onclick;
        }
      }}};` });
    if (url.origin !== BASE) return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.pathname.startsWith('/api/')) {
      let json;
      if (url.pathname === '/api/account/google') {
        const body = request.postDataJSON();
        assert.equal(body.credential, 'fixture-proof'); choices.push(body.rememberMe); signedIn = true;
      }
      if (url.pathname === '/api/account/logout') signedIn = false;
      if (url.pathname === '/api/account/config') json = { configured: true, googleClientId: 'fixture-client', nonce: 'fixture-nonce' };
      else if (url.pathname === '/api/account/reports') json = { reports: [], nextCursor: null };
      else if (url.pathname === '/api/freemius/config') json = { configured: false, mode: 'sandbox' };
      else json = { user: signedIn ? { id: 'fixture-user', name: 'Fixture user' } : null, premium: { unlocked: false, mode: 'sandbox' } };
      return route.fulfill({ json: { ok: true, ...json } });
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname === '/app' ? 'app.html' : decodeURIComponent(url.pathname).slice(1);
    const file = path.resolve(BUILD, relative);
    assert.ok(file.startsWith(BUILD + path.sep), 'Static fixture stays within the compiled build');
    try { await access(file); return await route.fulfill({ path: file }); }
    catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  return { context, page, choices, errors };
}
async function ready(page) {
  await page.waitForFunction(() => document.body.classList.contains('app-mode'));
  await page.locator('#accountMenuBtn').waitFor({ state: 'visible' });
}

(async () => {
  await access(path.join(BUILD, 'app.html'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const env = await open(browser); const { page } = env;
    try {
      await page.goto(BASE);
      assert.equal(await page.locator('script[src^="/assets/index-"]').count(), 1);
      assert.equal(await page.evaluate(() => window.__oneTap.loads), 0);
      await page.locator('#navbarCta').click(); await ready(page);
      await page.locator('#oneTapFixture').waitFor();
      assert.deepEqual(env.choices, [], 'Showing a prompt must not sign the visitor in');
      assert.equal(await page.evaluate(() => window.__oneTap.options.auto_select), false);
      await page.locator('#oneTapFixture').click();
      await page.getByRole('button', { name: 'Account', exact: true }).waitFor();
      assert.deepEqual(env.choices, [false], 'One Tap must not select persistent remember-me');
      assert.equal(await page.locator('#accountDialog').evaluate(node => node.open), false);
      await page.locator('#accountMenuBtn').click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.keyboard.press('Escape'); await page.reload(); await ready(page);
      assert.equal(await page.evaluate(() => window.__oneTap.loads), 0, 'Reload after sign-out must not reoffer');
      await page.locator('#accountMenuBtn').click();
      await page.locator('#googleButtonFixture').click();
      await page.getByRole('button', { name: 'Account', exact: true }).waitFor();
      assert.deepEqual(env.choices, [false, false]);
      assert.deepEqual(env.errors, []);
      console.log('PASS compiled landing, explicit One Tap, session-only login, logout/reload suppression and manual fallback');
    } finally { await env.context.close(); }
    for (const [profile, control] of [['raw', '#recordToggle'], ['discord', '#testBtn']]) {
      const env = await open(browser); const { page } = env;
      try {
        await page.goto(BASE + '/app'); await ready(page);
        await page.locator('#oneTapFixture').waitFor();
        await page.locator(`#scenarioChoices [data-profile="${profile}"]`).click();
        await page.locator(control).click();
        await page.waitForFunction(() => window.__oneTap.microphone.length > 0);
        assert.deepEqual(await page.evaluate(() => window.__oneTap.microphone), [{ promptVisible: false }]);
        await page.evaluate(() => window.__oneTap.late());
        assert.deepEqual(env.choices, [], 'A callback from the cancelled prompt cannot sign in during capture');
        assert.deepEqual(env.errors, []);
        console.log(`PASS compiled ${profile}: Google UI cancelled before microphone permission; late credential ignored`);
      } finally { await env.context.close(); }
    }
    const navigation = await open(browser);
    try {
      await navigation.page.goto(BASE);
      await navigation.page.locator('#navbarCta').click(); await ready(navigation.page);
      await navigation.page.locator('#oneTapFixture').waitFor();
      await navigation.page.goBack();
      await navigation.page.waitForFunction(() => !document.body.classList.contains('app-mode'));
      assert.equal(await navigation.page.locator('#oneTapFixture').count(), 0);
      await navigation.page.goForward(); await ready(navigation.page);
      assert.equal(await navigation.page.evaluate(() => window.__oneTap.prompts), 1);
      assert.deepEqual(navigation.errors, []);
      console.log('PASS compiled navigation cancels One Tap and does not repeat it on returning');
    } finally { await navigation.context.close(); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
