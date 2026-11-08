# Benchmark report

## Run captured

- **Command:** `npm run benchmark`
- **Captured:** October 26, 2026 at `10:49:13.017Z` (UTC)
- **Runtime:** Node `v18.12.0`, Windows `x64`, 16 logical CPUs
- **Workload:** 1,000 appointment creations per run, 3 independent runs, unique idempotency keys, in-memory SQLite, one transaction per appointment, appointment row + idempotency row + outbox row + audit row.
- **Raw output:** `bench/results/latest.json`

## Results

| Run | p50 (ms) | p95 (ms) | p99 (ms) | min (ms) | max (ms) | rows |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.1852 | 0.2650 | 0.3265 | 0.1533 | 15.0046 | 1,000 |
| 2 | 0.1951 | 0.2795 | 0.4374 | 0.1541 | 8.7861 | 1,000 |
| 3 | 0.1736 | 0.2406 | 0.3070 | 0.1468 | 6.3902 | 1,000 |

## Interpretation

This measures the local service and transaction path, not HTTP latency, disk durability under a real filesystem workload, SMTP delivery, or a horizontally scaled deployment. The p99 tail is visibly higher than the typical operation because the benchmark includes process scheduling and native SQLite calls; it should not be used as a capacity promise.

There is no honest legacy comparison number. The original repository's test command was a placeholder that exited 1, and the legacy runtime required undeclared packages plus a live MongoDB instance. The absence of a baseline is a finding, not a reason to invent one.

## Reproduce

```bash
npm ci
BENCHMARK_ITERATIONS=1000 BENCHMARK_RUNS=3 npm run benchmark
```

For a larger workload:

```bash
BENCHMARK_ITERATIONS=10000 BENCHMARK_RUNS=5 npm run benchmark
```

## Service benchmark re-run

The service benchmark was rerun on November 9, 2026 with the same 1,000-appointment, three-run workload. The prior raw output was preserved locally as `bench/results/service-baseline-2026-10-26.json`; the latest raw output remains `bench/results/latest.json`.

| Run | p50 (ms) | p95 (ms) | p99 (ms) | min (ms) | max (ms) | appointments |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.1940 | 0.2763 | 0.3370 | 0.1602 | 14.9093 | 1,000 |
| 2 | 0.1923 | 0.2754 | 0.3244 | 0.1578 | 8.6057 | 1,000 |
| 3 | 0.1779 | 0.2701 | 0.3533 | 0.1468 | 3.2481 | 1,000 |

This is still an in-memory service-path measurement. Compare it only with runs made under the same runtime and host; it is not an HTTP or disk durability claim.

## HTTP benchmark

### Run captured

- **Command:** `npm run benchmark:http`
- **Captured:** November 9, 2026 (local run; raw timestamp `2026-11-08T20:34:39.876Z`)
- **Runtime:** Node `v18.12.0`, Windows `x64`, 16 logical CPUs
- **Workload:** 1,000 authenticated `POST /api/appointments` requests per run, 3 independent runs. Each request exercises Express routing, session and CSRF checks, validation, and the transactional appointment, idempotency, outbox, and audit writes. Each run uses a fresh temporary file-backed SQLite database.
- **Raw output:** `bench/results/http-latest.json`

| Run | p50 (ms) | p95 (ms) | p99 (ms) | min (ms) | max (ms) | appointments |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1.8847 | 3.5879 | 6.6391 | 1.5190 | 8.1530 | 1,000 |
| 2 | 1.6972 | 2.2767 | 6.1869 | 1.3104 | 7.4182 | 1,000 |
| 3 | 1.5590 | 2.1193 | 6.2118 | 1.2087 | 11.9405 | 1,000 |

These are same-machine loopback measurements with the benchmark instance's rate limit raised above the workload. They include client and server work on one process host, and do not measure external notification delivery, production storage, or a realistic network. Treat them as a reproducible local comparison point, not a capacity promise.
