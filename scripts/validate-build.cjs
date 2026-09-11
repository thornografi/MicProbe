// Own the temporary server for a build check. Never reuse another process or port.
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const accounts = process.argv.includes('--accounts');

(async () => {
  const server = spawn(process.execPath, ['server.js', ...(accounts ? [] : ['--built'])], {
    cwd: root, windowsHide: true, env: { ...process.env, PORT: '8080', MICPROBE_STRICT_PORT: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', data => { stderr += data.toString(); });
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Built site did not start on localhost:8080')), 10000);
      const fail = error => { clearTimeout(timeout); reject(error); };
      server.once('error', fail);
      server.once('exit', code => fail(new Error(`Built server exited (${code}). ${stderr}`)));
      server.stdout.on('data', data => {
        if (data.toString().includes('Server running at http://localhost:8080/')) {
          clearTimeout(timeout); resolveReady();
        }
      });
    });
    const runner = spawn(process.execPath, accounts ? ['js/tests/account-browser-runner.cjs', '--all-browsers']
      : ['js/tests/build-browser-runner.cjs'], { cwd: root, windowsHide: true, stdio: 'inherit' });
    process.exitCode = await new Promise((resolveExit, reject) => {
      runner.once('error', reject);
      runner.once('exit', code => resolveExit(code ?? 1));
    });
  } finally { server.kill(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
