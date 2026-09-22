#!/usr/bin/env python3
"""Extract actual XCTest samples; compare like-for-like simulator/device runs.

Usage: message-performance-report.py before.log after.log output.json [budgets.json]
Comma-separated logs may combine separately passing benchmark cases. Samples
from failed/incomplete cases are explicitly excluded and recorded in the report.
This deliberately does not turn XCTest wall time or signpost duration into FPS.
"""
import json
import re
import statistics
import sys
from pathlib import Path


def results(paths):
    tests, excluded = {}, []
    for path in paths.split(","):
        text = Path(path).read_text()
        statuses = dict(re.findall(
            r"Test Case '-\[OpenTeamNativeUITests.MessagePerformanceUITests (test\w+)\]' (passed|failed)", text))
        measured = {}
        pattern = r"MessagePerformanceUITests (test\w+)\]' measured \[(.*?)\] average: .*?values: \[([^]]+)\]"
        for test, metric, values in re.findall(pattern, text):
            samples = [float(value) for value in values.split(",")]
            measured.setdefault(test, {})[metric] = {"samples": samples, "mean": statistics.mean(samples)}
        for test, metrics in measured.items():
            if statuses.get(test) != "passed":
                excluded.append({"source": path, "test": test, "status": statuses.get(test, "incomplete")})
                continue
            tests[test] = metrics
    if len(tests) != 2 or any(len(v["samples"]) < 3 for t in tests.values() for v in t.values()):
        raise SystemExit(f"Missing passing benchmark samples: {paths}")
    return tests, excluded


(before, excluded_before), (after, excluded_after) = results(sys.argv[1]), results(sys.argv[2])
comparison = {}
for test, metrics in after.items():
    comparison[test] = {}
    for metric in ["CPU Time (swift), s", "Memory Peak Physical (swift), kB", "Clock Monotonic Time, s"]:
        old, new = before[test][metric]["mean"], metrics[metric]["mean"]
        comparison[test][metric] = {"before": old, "after": new, "changePercent": (new / old - 1) * 100}

report = {
    "scope": "Debug build; same iPhone 16 Pro Max / iOS 26.5 simulator; 3 recorded samples plus XCTest warm-up; 6 identical drag gestures per sample",
    "limits": ["CPU/wall time include XCTest accessibility work between gestures.",
               "Memory is the app process, excluding WebKit subprocesses.",
               "Simulator scrolling signposts expose duration here, not display hitch rate. These measurements do not certify physical iPhone FPS."],
    "sourceRuns": {"before": sys.argv[1].split(","), "after": sys.argv[2].split(",")},
    "excludedFailedSamples": excluded_before + excluded_after,
    "before": before, "after": after, "comparison": comparison,
}
failures = []
if len(sys.argv) > 4:
    budgets = json.loads(Path(sys.argv[4]).read_text())
    report["budgets"] = budgets
    for test, limits in budgets["tests"].items():
        for metric, limit in limits.items():
            actual = after[test][metric]["mean"]
            if actual > limit:
                failures.append(f"{test}: {metric} {actual:.3f} exceeds {limit}")
    report["budgetFailures"] = failures
Path(sys.argv[3]).write_text(json.dumps(report, indent=2) + "\n")
for test, metrics in comparison.items():
    print(test)
    for metric, values in metrics.items():
        print(f"  {metric}: {values['before']:.3f} -> {values['after']:.3f} ({values['changePercent']:+.1f}%)")
if failures:
    raise SystemExit("\n".join(failures))
