"""Interleaved A/B benchmark of the extra pre-call ensure_service probe."""
import json
import math
import statistics
import time

import test_runtime_connection_budget as harness

SAMPLE_COUNT = 200
WARMUP_PAIRS = 10


def percentile(values, quantile):
    ordered = sorted(values)
    rank = max(1, int(math.ceil(quantile * len(ordered))))
    return ordered[rank - 1]


def run_arm(label, fixture):
    before = dict(fixture.monitor.metrics)
    started = time.perf_counter_ns()
    if label == "A":
        # Reproduce the pre-change NativeProfileRuntime.call outer probe.
        fixture.client_module.ensure_service(fixture.home)
    result = fixture.profile.call("health", {})
    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0
    if result != harness.HEALTH_RESULT:
        raise AssertionError("A/B health RPC returned a different result")
    after = dict(fixture.monitor.metrics)
    delta = {key: after[key] - before[key] for key in after}
    return elapsed_ms, delta


def main():
    fixture = harness.NativeRuntimeConnectionBudgetTests(
        "test_healthy_rpc_uses_one_probe_and_one_rpc_connection"
    )
    fixture.setUp()
    try:
        fixture.client_module.ensure_service(fixture.home)
        for _ in range(WARMUP_PAIRS):
            run_arm("A", fixture)
            run_arm("B", fixture)
        fixture.monitor.reset()

        samples = {"A": [], "B": []}
        totals = {
            label: {key: 0 for key in fixture.monitor.metrics}
            for label in ("A", "B")
        }
        for index in range(SAMPLE_COUNT):
            order = ("A", "B") if index % 2 == 0 else ("B", "A")
            for label in order:
                elapsed_ms, delta = run_arm(label, fixture)
                samples[label].append(elapsed_ms)
                for key, value in delta.items():
                    totals[label][key] += value

        report = {
            "sampleCountPerArm": SAMPLE_COUNT,
            "warmupPairs": WARMUP_PAIRS,
            "scenario": "healthy scratch daemon; NativeProfileRuntime.call('health', {})",
            "pairing": "same daemon and result; A/B order alternated per pair",
            "A": {
                "behavior": "pre-change outer ensure_service(home) + NativeProfileRuntime.call",
                "p50Ms": round(statistics.median(samples["A"]), 6),
                "p95MsNearestRank": round(percentile(samples["A"], 0.95), 6),
                "meanConnectionsPerCall": round(totals["A"]["successful_connections"] / SAMPLE_COUNT, 3),
                "meanHealthProbesPerCall": round(totals["A"]["health_probe_requests"] / SAMPLE_COUNT, 3),
                "meanProbeCallsPerCall": round(totals["A"]["probe_calls"] / SAMPLE_COUNT, 3),
                "allCallsSucceeded": len(samples["A"]) == SAMPLE_COUNT,
            },
            "B": {
                "behavior": "current NativeProfileRuntime.call without outer ensure_service",
                "p50Ms": round(statistics.median(samples["B"]), 6),
                "p95MsNearestRank": round(percentile(samples["B"], 0.95), 6),
                "meanConnectionsPerCall": round(totals["B"]["successful_connections"] / SAMPLE_COUNT, 3),
                "meanHealthProbesPerCall": round(totals["B"]["health_probe_requests"] / SAMPLE_COUNT, 3),
                "meanProbeCallsPerCall": round(totals["B"]["probe_calls"] / SAMPLE_COUNT, 3),
                "allCallsSucceeded": len(samples["B"]) == SAMPLE_COUNT,
            },
        }
        report["latencyChangePctBvsA"] = {
            "p50": round((report["B"]["p50Ms"] / report["A"]["p50Ms"] - 1) * 100, 2),
            "p95": round((report["B"]["p95MsNearestRank"] / report["A"]["p95MsNearestRank"] - 1) * 100, 2),
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
    finally:
        fixture.tearDown()


if __name__ == "__main__":
    main()
