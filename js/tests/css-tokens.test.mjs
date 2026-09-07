import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Token sozlesmesi koruma testleri (css/variables.css basligindaki referanslarla ayni):
// - var(--x) referanslari tanimli olmali (variables.css, yerel tanim, runtime listesi) ya da fallback tasimali
// - transition: all yasak (B3/B7 sonrasi strict)
// - font-size literal'leri olcekte (B3 sonrasi strict)
// - @media esikleri 4 sinirli set (B6 sonrasi strict)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cssDir = path.join(root, 'css');
const cssFiles = readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => `css/${f}`);
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const sources = Object.fromEntries(cssFiles.map(f => [f, read(f)]));
const html = ['index.html', 'privacy.html', 'terms.html', 'micprobe.html'].map(read).join('\n');

// variables.css basligindaki RUNTIME DEGISKENLERI bloğu tek kaynak
const RUNTIME_VARS = new Set([...read('css/variables.css').matchAll(/--[a-z0-9-]+/g)].map(m => m[0]));

const defined = new Set();
for (const text of [...Object.values(sources), html]) {
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
}

test('every var(--x) reference without a fallback is defined somewhere (tokens, local vars or runtime list)', () => {
  const missing = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)) {
      const [, name, terminator] = m;
      if (terminator === ',') continue; // fallback korumali
      if (!defined.has(name) && !RUNTIME_VARS.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('no duplicate token definitions inside :root', () => {
  const rootBlock = read('css/variables.css');
  const start = rootBlock.indexOf(':root {');
  const end = rootBlock.indexOf('\n}', start);
  const names = [...rootBlock.slice(start, end).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, []);
});

test('transition: all is not used (explicit property lists only)', () => {
  const offenders = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/transition\s*:\s*all\b/g)) offenders.push(`${file}@${m.index}`);
  }
  assert.deepEqual(offenders, []);
});

test('font-size literals stay on the type scale', { skip: 'enabled after WP B3 (typography scale)' }, () => {
  const scale = new Set(['12px', '13px', '14px', '15px', '16px', '20px', '24px', '0']);
  const offenders = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/font-size\s*:\s*([^;]+);/g)) {
      const value = m[1].trim();
      if (value.startsWith('var(') || value.startsWith('clamp(') || value.startsWith('inherit') || value.startsWith('calc(')) continue;
      if (!scale.has(value)) offenders.push(`${file}: ${value}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('@media width queries use only the documented breakpoint set', () => {
  // Sinirlar: 479 | 767 | 1023 | 1199. (max-width: 1199px) = sm + lg birlesimi (yeni sinir degil).
  const allowed = new Set([
    '(max-width: 479px)',
    '(max-width: 767px)',
    '(max-width: 1199px)',
    '(min-width: 768px) and (max-width: 1023px)',
    '(min-width: 768px) and (max-width: 1199px)',
    '(min-width: 1200px)'
  ]);
  const offenders = [];
  for (const [file, raw] of Object.entries(sources)) {
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, ''); // yorumlardaki referans tablosu sayilmaz
    for (const m of text.matchAll(/@media\s+([^{]+)\{/g)) {
      const query = m[1].trim();
      if (!/width/.test(query)) continue;
      if (!allowed.has(query)) offenders.push(`${file}: ${query}`);
    }
  }
  assert.deepEqual(offenders, []);
});
