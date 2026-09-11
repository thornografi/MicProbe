import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// CSS yukleme sozlesmesi: <head> sirasi (variables -> shared -> landing) ve
// app CSS sirasi, native yukleme listesi ve derleme barrel'inde aynidir.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

function headStylesheets(html) {
  const head = html.slice(0, html.indexOf('</head>'));
  return [...head.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
    .map(m => m[1])
    .filter(href => !href.startsWith('http'))
    .map(href => href.replace(/^\/?css\//, ''));
}

test('index.html head loads variables, shared and landing CSS in that order', () => {
  assert.deepEqual(headStylesheets(read('index.html')), ['variables.css', 'shared.css', 'landing.css']);
});

test('static pages load the shared foundation (variables + shared) and nothing app-specific', () => {
  for (const page of ['privacy.html', 'terms.html', 'micprobe.html']) {
    assert.deepEqual(headStylesheets(read(page)), ['variables.css', 'shared.css'], page);
  }
});

test('native lazy styles and the build barrel have the same order', () => {
  const barrel = [...read('css/style.css').matchAll(/@import url\('([^']+)'\)/g)].map(m => m[1]);
  const loader = [...read('js/app-styles.js').matchAll(/'\/css\/([^']+)'/g)].map(m => m[1]);
  assert.ok(barrel.length > 0);
  assert.deepEqual(loader, barrel);
  assert.equal(new Set(barrel).size, barrel.length);
  assert.ok(!barrel.includes('variables.css') && !barrel.includes('shared.css') && !barrel.includes('landing.css'),
    'head stylesheets are not part of the lazy app list');
});
