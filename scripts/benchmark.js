const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pino = require('pino');
const { createApp } = require('../src/http/app');
const { seedDemoData } = require('../src/seed');

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function runOnce(iterations) {
  const system = createApp({
    config: { dbPath: ':memory:', nodeEnv: 'benchmark', logLevel: 'silent' },
    logger: pino({ level: 'silent' }),
  });
  seedDemoData({ db: system.db, config: system.config });
  const actor = system.auth.authenticate('patient@health.local', 'ChangeMe123!');
  const latencies = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    system.appointments.createAppointment(actor, {
      phone: '9508532340',
      age: 19,
      symptoms: `Benchmark symptom ${index}`,
      daysWithSymptoms: index % 10,
    }, `benchmark-${index}`);
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const result = {
    iterations,
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    minMs: Math.min(...latencies),
    maxMs: Math.max(...latencies),
    appointments: system.appointments.countAppointments(),
  };
  system.close();
  return result;
}

function main() {
  const iterations = Number(process.env.BENCHMARK_ITERATIONS || 1000);
  const runs = Number(process.env.BENCHMARK_RUNS || 3);
  if (!Number.isInteger(iterations) || iterations < 10) throw new Error('BENCHMARK_ITERATIONS must be an integer >= 10');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('BENCHMARK_RUNS must be an integer >= 1');
  const results = Array.from({ length: runs }, () => runOnce(iterations));
  const output = {
    generatedAt: new Date().toISOString(),
    workload: 'create appointment service with unique idempotency keys in an isolated in-memory SQLite database',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    limitations: [
      'This is a single-process local benchmark, not a capacity claim for a production deployment.',
      'The original implementation has no runnable test or benchmark baseline; no fabricated baseline is included.',
      'The measured path includes SQLite transaction and outbox writes but no external notification provider.',
    ],
    runs: results,
  };
  const outputDir = path.join(process.cwd(), 'bench', 'results');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'latest.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...output }, null, 2));
}

main();
