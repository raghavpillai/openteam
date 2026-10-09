#!/usr/bin/env python3
"""Report visible scroll discontinuities in a DEBUG `--trace-scroll-frames` capture.

Usage:
  python3 apps/ios/scripts/scroll-frame-report.py <scroll-frames.json> [--verbose]
  python3 apps/ios/scripts/scroll-frame-report.py --simulator <udid> [--verbose]

The app writes `tmp/scroll-frames.json` in its data container once scrolling is
idle. Each frame holds on-screen row positions (committed geometry, or the
presentation of a running animation), the finger location and controller flags:
t tracking, d dragging, D decelerating, u snapshot update, p positioning,
s scrolling to a target, f following the latest message, a animating rows.

Reported kinds:
  layout-shift  rows that kept their size moved relative to each other, or a
                resized row moved both edges (a row grew into what is being read)
  frame-jump    content velocity deviated from both neighboring frames
  finger-drift  content stopped tracking the finger while dragging
  idle-move     visible content moved without a scroll or animation
  replaced      every visible row changed in one frame
  blank-doc     a WebKit document was on screen before it rendered
  dropped       display frames missed while content was moving

Simulator timing does not certify device frame rate. Fast synthesized swipes
(tens of points per frame) make finger-drift unreliable.
"""
import json
import statistics
import subprocess
import sys


def load(argv):
    if "--simulator" in argv:
        udid = argv[argv.index("--simulator") + 1]
        container = subprocess.check_output(
            ["xcrun", "simctl", "get_app_container", udid, "dev.openteam.mobile.swift", "data"], text=True).strip()
        return json.load(open(container + "/tmp/scroll-frames.json"))
    return json.load(open(next(a for a in argv[1:] if not a.startswith("--"))))


def analyze(data):
    frames = data["frames"]
    top, bottom = data["viewportTop"], data["viewportBottom"]
    issues = []
    drift, drifts, velocities = None, [], []
    for a, b in zip(frames, frames[1:]):
        ra = {r[0]: r for r in a["rows"] if r[1] + r[2] > top and r[1] < bottom}
        rb = {r[0]: r for r in b["rows"] if r[1] + r[2] > top and r[1] < bottom}
        common = [k for k in ra if k in rb]
        moving = any(c in b["flags"] for c in "dD")
        if ra and rb and not common:
            issues.append((b["t"], "replaced", 0, b["flags"]))
        same = [k for k in common if abs(rb[k][2] - ra[k][2]) <= 1.0] or common
        if not same:
            velocities.append(None)
            drift = None
            continue
        tops = [rb[k][1] - ra[k][1] for k in same]
        delta = statistics.median(tops)
        spread = max(tops) - min(tops)
        for k in common:
            if k in same:
                continue
            top_move = rb[k][1] - ra[k][1] - delta
            bottom_move = rb[k][1] + rb[k][2] - ra[k][1] - ra[k][2] - delta
            spread = max(spread, min(abs(top_move), abs(bottom_move)))
        if spread > 1.0:
            issues.append((b["t"], "layout-shift", spread, b["flags"]))
        if not moving and not any(c in b["flags"] for c in "sat") and abs(delta) > 1.5 and spread <= 1.0:
            issues.append((b["t"], "idle-move", delta, b["flags"]))
        if "finger" in a and "finger" in b and "d" in a["flags"] and "d" in b["flags"]:
            drift = (drift or 0) + delta - (b["finger"] - a["finger"])
            drifts.append((b["t"], drift, b["flags"]))
        else:
            drift = None
        dt = max(b["t"] - a["t"], 1 / 120)
        velocities.append((b["t"], delta / dt, dt, b["flags"]) if moving else None)
    for p, c, n in zip(velocities, velocities[1:], velocities[2:]):
        if p and c and n:
            expected = (p[1] + n[1]) / 2
            if abs(c[1] - expected) * c[2] > 20 and abs(p[1] - n[1]) * c[2] < 20:
                issues.append((c[0], "frame-jump", (c[1] - expected) * c[2], c[3]))
    for (t1, d1, _), (t2, d2, f2), (t3, d3, _) in zip(drifts, drifts[1:], drifts[2:]):
        if abs(d2 - d1) > 4 and abs(d3 - d1) > 4 and t3 - t1 < 0.1:
            issues.append((t2, "finger-drift", d2 - d1, f2))
    start = None
    for f in frames:
        if f.get("hiddenDocs", 0) and start is None:
            start = f["t"]
        elif not f.get("hiddenDocs", 0) and start is not None:
            issues.append((start, "blank-doc", (f["t"] - start) * 1000, f["flags"]))
            start = None
    for a, b in zip(frames, frames[1:]):
        dt = b["t"] - a["t"]
        if any(c in a["flags"] for c in "dD") and any(c in b["flags"] for c in "dD") and dt > 0.025:
            issues.append((b["t"], "dropped", round(dt * 60) - 1, b["flags"]))
    return sorted(issues), frames


def main(argv):
    issues, frames = analyze(load(argv))
    if not frames:
        print("No frames recorded.")
        return
    t0 = frames[0]["t"]
    summary = {}
    for _, kind, magnitude, _ in issues:
        count, largest = summary.get(kind, (0, 0))
        summary[kind] = (count + 1, max(largest, abs(magnitude)))
    print(f"{len(frames)} frames over {frames[-1]['t'] - t0:.1f}s")
    units = {"blank-doc": "ms", "dropped": " frames"}
    for kind, (count, largest) in sorted(summary.items()):
        print(f"  {kind:13} {count:5}  largest {largest:.0f}{units.get(kind, 'pt')}")
    if "--verbose" in argv:
        for t, kind, magnitude, flags in issues:
            print(f"  {t - t0:8.3f}s {kind:13} {magnitude:8.1f} [{flags}]")


if __name__ == "__main__":
    main(sys.argv)
