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

The service benchmark was rerun on November 9, 2026 at `10:30:08.770Z` with the same 1,000-appointment, three-run workload. The raw output remains `bench/results/latest.json`. The pre-run ignored output was preserved locally as `bench/results/service-before-final-2026-11-09.json` and the older baseline as `bench/results/service-baseline-2026-10-26.json`.

| Run | p50 (ms) | p95 (ms) | p99 (ms) | min (ms) | max (ms) | appointments |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0.2043 | 0.2846 | 0.3479 | 0.1635 | 15.6050 | 1,000 |
| 2 | 0.2419 | 0.3730 | 0.4622 | 0.1951 | 8.6063 | 1,000 |
| 3 | 0.1926 | 0.2793 | 0.3572 | 0.1508 | 22.9681 | 1,000 |

This is still an in-memory service-path measurement. Compare it only with runs made under the same runtime and host; it is not an HTTP or disk durability claim.

## HTTP benchmark

### Run captured

- **Command:** `npm run benchmark:http`
- **Captured:** November 9, 2026 (raw timestamp `2026-11-09T10:30:06.700Z`)
- **Runtime:** Node `v18.12.0`, Windows `x64`, 16 logical CPUs
- **Workload:** 1,000 authenticated `POST /api/appointments` requests per run, 3 independent runs. Each request exercises Express routing, session and CSRF checks, validation, and the transactional appointment, idempotency, outbox, and audit writes. Each run uses a fresh temporary file-backed SQLite database.
- **Raw output:** `bench/results/http-latest.json`
- **Prior local raw output preserved:** `bench/results/http-before-final-2026-11-09.json`

| Run | p50 (ms) | p95 (ms) | p99 (ms) | min (ms) | max (ms) | appointments |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1.9420 | 3.4994 | 10.8540 | 1.5039 | 14.4755 | 1,000 |
| 2 | 1.7744 | 2.5000 | 10.6814 | 1.3795 | 13.9095 | 1,000 |
| 3 | 1.6260 | 2.1961 | 10.2605 | 1.3102 | 14.8721 | 1,000 |

These are same-machine loopback measurements with the benchmark instance's rate limit raised above the workload. They include client and server work on one process host, and do not measure external notification delivery, production storage, or a realistic network. Treat them as a reproducible local comparison point, not a capacity promise.
