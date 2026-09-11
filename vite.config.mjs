import { defineConfig } from 'vite';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  publicDir: 'public',
  build: {
    outDir: '.tmp/cloudflare-dev-assets',
    // Worklets and classic workers need real same-origin URLs under the CSP.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: ['index.html', 'micprobe.html', 'privacy.html', 'terms.html', '404.html'].map(file => resolve(root, file))
    }
  },
  plugins: [{
    name: 'micprobe-runtime-assets',
    apply: 'build',
    load(id) {
      if (id === resolve(root, 'js/app-styles.js').replaceAll('\\', '/')) {
        return 'import href from "../css/style.css?url"; export default [href];';
      }
    },
    writeBundle(options) {
      // importScripts cannot consume an ESM wrapper. Preserve the vendor runtime
      // as-is; tests, server code and unused assets stay out.
      const target = resolve(options.dir, 'js/lib/opus');
      mkdirSync(target, { recursive: true });
      cpSync(resolve(root, 'js/lib/opus'), target, { recursive: true });
      // One application document, two entry URLs. Give non-JavaScript crawlers
      // the correct /app metadata without maintaining a second copy of the UI.
      const appDocument = readFileSync(resolve(options.dir, 'index.html'), 'utf8')
        .replace(/<title>[^<]*<\/title>/, '<title>MicProbe — Microphone test</title>')
        .replace(/(rel="canonical" href=")[^"]+/, '$1https://micprobe.com/app')
        .replace(/(property="og:url" content=")[^"]+/, '$1https://micprobe.com/app')
        .replace(/(property="og:title" content=")[^"]+/, '$1MicProbe — Microphone test');
      writeFileSync(resolve(options.dir, 'app.html'), appDocument);
    }
  }]
});
