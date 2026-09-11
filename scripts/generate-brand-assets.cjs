// Render the existing brand mark and landing photo; no external fonts or network.
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { chromium } = require('playwright');
const root = resolve(__dirname, '..');
const output = resolve(root, 'public');

(async () => {
  await mkdir(output, { recursive: true });
  const mark = await readFile(resolve(root, 'assets/micprobe-mark.svg'), 'utf8');
  // Preserve the root fill="none": extracting only the paths fills open arcs black.
  const icon = mark.replace('width="32" height="32"', 'width="96" height="96"')
    .replace('viewBox="0 0 32 32"', 'viewBox="0 0 32 34"');
  await writeFile(resolve(output, 'favicon.svg'), icon + '\n');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const pngs = [];
    for (const [size, filename] of [[16, null], [32, null], [48, null], [96, 'favicon-96.png'], [180, 'apple-touch-icon.png'], [512, 'logo.png']]) {
      await page.setViewportSize({ width: size, height: size });
      const touch = filename === 'apple-touch-icon.png';
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:${touch ? '#15171c' : 'transparent'}}body{box-sizing:border-box;padding:${touch ? '12%' : '0'}}svg{width:100%;height:100%;display:block}</style>${icon}`);
      const png = await page.screenshot({ type: 'png', omitBackground: !touch });
      if (filename) await writeFile(resolve(output, filename), png);
      else pngs.push({ size, png });
    }
    // ICO supports PNG payloads; keep the small bookmark sizes in one file.
    const header = Buffer.alloc(6 + 16 * pngs.length);
    header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
    let offset = header.length;
    pngs.forEach(({ size, png }, index) => {
      const entry = 6 + index * 16;
      header[entry] = size; header[entry + 1] = size;
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
      header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
      offset += png.length;
    });
    await writeFile(resolve(output, 'favicon.ico'), Buffer.concat([header, ...pngs.map(item => item.png)]));
    const photo = (await readFile(resolve(root, 'assets/landing/microphone-check-v2.webp'))).toString('base64');
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#15171c;color:#f1f0f5;font-family:Arial,sans-serif;display:grid;grid-template-columns:650px 550px}
      main{padding:56px 48px 48px 60px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:14px;font-size:36px;letter-spacing:-1.4px}.brand svg{width:44px;height:44px}.brand b{font-weight:600}.brand span{color:#b892f4}
      h1{font-size:70px;line-height:1.04;letter-spacing:-3px;font-weight:600;margin:66px 0 24px}p{font-size:25px;line-height:1.45;color:#c5c4cf;margin:0;max-width:470px}.address{margin-top:auto;font-size:21px;color:#b892f4}.photo{width:550px;height:630px;object-fit:cover;object-position:62% center}
      </style><main><div class="brand">${mark}<div><b>Mic</b><span>Probe</span></div></div><h1>Hear your<br>microphone.</h1><p>Record a short sample.<br>Find what to improve before a call.</p><div class="address">micprobe.com</div></main><img class="photo" src="data:image/webp;base64,${photo}" alt="A person checking a microphone before a call"></html>`);
    await page.locator('.photo').evaluate(image => image.decode());
    await page.screenshot({ path: resolve(output, 'social-card.png'), type: 'png' });
    console.log('Generated favicon SVG/ICO/PNG, touch icon, logo and 1200 x 630 sharing image.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
