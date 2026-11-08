# Benchmarking

`npm run benchmark` runs a deterministic appointment-service workload against isolated in-memory SQLite databases. It writes raw results to `bench/results/latest.json`.

Useful controls:

```text
BENCHMARK_ITERATIONS=10000 BENCHMARK_RUNS=5 npm run benchmark
```

The benchmark intentionally does not compare against the legacy router: the original `npm test` command is a deliberate failure and the legacy app depends on undeclared modules and a live MongoDB instance. A broken baseline is documented rather than converted into invented throughput numbers.

`npm run benchmark:http` starts the real Express app on loopback and measures authenticated appointment requests against a fresh file-backed SQLite database in the system temporary directory. Raw results go to `bench/results/http-latest.json`; this does not overwrite the service benchmark output. Use `HTTP_BENCHMARK_ITERATIONS` and `HTTP_BENCHMARK_RUNS` to adjust the workload.
