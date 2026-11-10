const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const pino = require('pino');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
  });
}

async function runOnce(iterations) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-centre-http-bench-'));
  const dbPath = path.join(tempDir, 'health-centre.sqlite');
  const system = createApp({
    config: { dbPath, nodeEnv: 'benchmark', logLevel: 'silent' },
    logger: pino({ level: 'silent' }),
    rateLimitLimit: iterations + 10,
  });
  const server = http.createServer(system.app);

  try {
    seedDemoData({ db: system.db, config: system.config });
    const origin = await listen(server);
    const loginResponse = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'patient@health.local', password: 'ChangeMe123!' }),
    });
    if (!loginResponse.ok) throw new Error(`Benchmark login failed with HTTP ${loginResponse.status}`);
    const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
    const { csrfToken } = await loginResponse.json();
    if (!sessionCookie || !csrfToken) throw new Error('Benchmark login did not return a session and CSRF token');

    const latenciesMs = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const response = await fetch(`${origin}/api/appointments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'idempotency-key': `http-benchmark-${index}`,
        },
        body: JSON.stringify({
          phone: '9508532340',
          age: 19,
          symptoms: `Synthetic HTTP benchmark request ${index}`,
          daysWithSymptoms: index % 10,
        }),
      });
      if (response.status !== 201) throw new Error(`Appointment request ${index} returned HTTP ${response.status}`);
      await response.arrayBuffer();
      latenciesMs.push(performance.now() - started);
    }

    return {
      iterations,
      p50Ms: percentile(latenciesMs, 0.50),
      p95Ms: percentile(latenciesMs, 0.95),
      p99Ms: percentile(latenciesMs, 0.99),
      minMs: Math.min(...latenciesMs),
      maxMs: Math.max(...latenciesMs),
      appointments: system.appointments.countAppointments(),
      database: 'file-backed SQLite in a temporary local directory',
    };
  } finally {
    if (server.listening) await closeServer(server);
    system.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const iterations = Number(process.env.HTTP_BENCHMARK_ITERATIONS || 1000);
  const runs = Number(process.env.HTTP_BENCHMARK_RUNS || 3);
  if (!Number.isInteger(iterations) || iterations < 10) throw new Error('HTTP_BENCHMARK_ITERATIONS must be an integer >= 10');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('HTTP_BENCHMARK_RUNS must be an integer >= 1');

  const output = {
    generatedAt: new Date().toISOString(),
    workload: 'Authenticated HTTP POST /api/appointments requests, including routing, validation, session and CSRF checks, and transactional SQLite writes',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    limitations: [
      'Single-process loopback measurements include client and server work on the same machine.',
      'Each run uses a fresh temporary file-backed database and synthetic demo data.',
      'The rate limit is raised only for the benchmark instance so the workload measures request latency rather than throttling.',
      'This benchmark does not measure external notification delivery or production storage hardware.',
    ],
    runs: [],
  };

  for (let run = 0; run < runs; run += 1) output.runs.push(await runOnce(iterations));
  const outputDir = path.join(process.cwd(), 'bench', 'results');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'http-latest.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...output }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
