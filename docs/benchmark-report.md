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
