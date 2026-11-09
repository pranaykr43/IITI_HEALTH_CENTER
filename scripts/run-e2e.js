const http = require('node:http');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const E2E_HOST = '127.0.0.2';

function findPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, E2E_HOST, () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function getReady(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: E2E_HOST, port, path: '/readyz', timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', (error) => (error.code === 'ECONNREFUSED' ? resolve(false) : reject(error)));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function stopServer(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: E2E_HOST, port, path: '/__e2e/shutdown', method: 'POST', timeout: 2_000 }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function runPlaywright(port, args) {
  const cli = require.resolve('@playwright/test/cli');
  const child = spawn(process.execPath, [cli, 'test', ...args], {
    stdio: 'inherit',
    env: { ...process.env, E2E_PORT: String(port) },
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function main() {
  const port = await findPort();
  const env = { ...process.env, E2E_PORT: String(port) };
  const server = spawn(process.execPath, [path.join(__dirname, 'e2e-server.js')], {
    stdio: 'inherit',
    env,
  });
  let exitCode = 1;
  try {
    let ready = false;
    const deadline = Date.now() + 30_000;
    while (!ready && Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`E2E server exited before readiness (code ${server.exitCode})`);
      ready = await getReady(port);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('E2E server did not become ready within 30 seconds');
    exitCode = await runPlaywright(port, process.argv.slice(2));
  } finally {
    await stopServer(port);
    if (!(await waitForExit(server, 5_000))) {
      server.kill('SIGTERM');
      if (!(await waitForExit(server, 2_000))) server.kill('SIGKILL');
    }
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
