# Benchmarking

`npm run benchmark` runs a deterministic appointment-service workload against isolated in-memory SQLite databases. It writes raw results to `bench/results/latest.json`.

Useful controls:

```text
BENCHMARK_ITERATIONS=10000 BENCHMARK_RUNS=5 npm run benchmark
```

The benchmark intentionally does not compare against the legacy router: the original `npm test` command is a deliberate failure and the legacy app depends on undeclared modules and a live MongoDB instance. A broken baseline is documented rather than converted into invented throughput numbers.
