import { describe, expect, test } from "bun:test";
import {
  centreBias,
  downwardReach,
  mobileVoiceLevel,
  mobileVoiceProfile,
  processingSweep,
  sidePeakReach,
  voiceReach,
  voiceShape,
  voiceSidePeaks,
} from "../src/renderer/components/openteam/voice-memo/glow-motion";

describe("voice glow geometry", () => {
  test("mobile lobes flow horizontally with a continuous wrap", () => {
    const bands = [0.8, 0.3, 0.1];
    for (let x = 0; x <= 1; x += 0.01) {
      expect(mobileVoiceProfile(x, 0, bands)).toBeCloseTo(mobileVoiceProfile(x, 1, bands), 8);
      expect(mobileVoiceProfile(x, 0.5 - 0.00001, bands)).toBeCloseTo(
        mobileVoiceProfile(x, 0.5 + 0.00001, bands),
        3
      );
    }
    expect(mobileVoiceProfile(0.3, 0.25, bands)).not.toBeCloseTo(
      mobileVoiceProfile(0.3, 0, bands),
      2
    );
  });

  test("mobile's level response gives visible central height without expanding the ends", () => {
    expect(centreBias(0)).toBe(0);
    expect(centreBias(1)).toBeCloseTo(0, 8);
    expect(centreBias(0.5)).toBe(1);
    expect(centreBias(0.1)).toBeLessThan(0.2);
    expect(mobileVoiceLevel(0.03)).toBe(0);
    expect(mobileVoiceLevel(0.4)).toBeGreaterThan(0.7);
    expect(voiceReach(0.5, 1)).toBe(245);
    expect(voiceReach(0, 1)).toBe(5);
    expect(voiceReach(0.5, 0.8, 0.8) - voiceReach(0.5, 0.8, 0)).toBeGreaterThan(120);
    for (let x = 0; x <= 1; x += 0.01) {
      expect(voiceReach(x, 0)).toBe(3);
      for (const phase of [0, 0.25, 0.5, 0.75]) {
        const reach = voiceReach(x, mobileVoiceProfile(x, phase, [1, 1, 1]));
        expect(reach).toBeGreaterThanOrEqual(3);
        expect(reach).toBeLessThanOrEqual(245);
      }
    }
  });

  test("irregular side peaks stay low, fade continuously and leave the caps alone", () => {
    const peaks = voiceSidePeaks(2, 1);
    expect(peaks.slice(0, 6).every((p) => p.x < 0.36)).toBe(true);
    expect(peaks.slice(6).every((p) => p.x > 0.64)).toBe(true);
    expect(sidePeakReach(0, peaks)).toBe(0);
    expect(sidePeakReach(1, peaks)).toBeCloseTo(0, 8);
    expect(voiceSidePeaks(2, 0).every((p) => p.height === 0)).toBe(true);
    expect(voiceSidePeaks(5, 1)).not.toEqual(peaks);
    for (let x = 0; x <= 1; x += 0.01) {
      expect(sidePeakReach(x, peaks)).toBeLessThanOrEqual(48);
      expect(sidePeakReach(x, voiceSidePeaks(2.00001, 1))).toBeCloseTo(sidePeakReach(x, peaks), 2);
    }
  });

  test("lower reach stays small even when the upper crest is very tall", () => {
    for (const room of [0, 4, 12, 24, 100]) {
      for (const reach of [0, 5, 30, 245, 10000]) {
        expect(downwardReach(reach, room)).toBeGreaterThanOrEqual(0);
        expect(downwardReach(reach, room)).toBeLessThanOrEqual(Math.min(14, room));
      }
    }
    expect(downwardReach(245)).toBeCloseTo(14);
    expect(downwardReach(5)).toBeGreaterThan(4);
  });

  test("crest drifts and splits smoothly, with spectral balance biasing the asymmetry", () => {
    const shapes = Array.from({ length: 40 }, (_, i) => voiceShape(i / 2, 0.9, [0.8, 0.6, 0.3]));
    expect(shapes.some((s) => Math.abs(s.centre - 0.5) > 0.05)).toBe(true);
    expect(shapes.some((s) => s.split > 0.5)).toBe(true);
    const low = voiceShape(2, 0.9, [1, 0.5, 0]);
    const high = voiceShape(2, 0.9, [0, 0.5, 1]);
    expect(high.centre).toBeGreaterThan(low.centre);
    expect(low.left).toBeGreaterThan(high.left);
    expect(high.right).toBeGreaterThan(low.right);
    for (let x = 0; x <= 1; x += 0.01) {
      const a = voiceReach(x, 0.8, 0.9, voiceShape(2, 0.9, [0.8, 0.6, 0.3]));
      const b = voiceReach(x, 0.8, 0.9, voiceShape(2.00001, 0.9, [0.8, 0.6, 0.3]));
      expect(a).toBeCloseTo(b, 2);
    }
  });
});

describe("mobile transcription sweep parity", () => {
  test("gathers at centre, then sweeps both directions every 2.2 seconds", () => {
    expect(processingSweep(0)).toEqual({ gather: 0, offset: 0, stretch: 0 });
    expect(processingSweep(0.225).gather).toBeCloseTo(0.5);
    expect(processingSweep(0.55).offset).toBeCloseTo(0.85);
    expect(processingSweep(1.65).offset).toBeCloseTo(-0.85);
    expect(processingSweep(2.2).offset).toBeCloseTo(0);
  });

  test("reduced motion holds a centred beam", () => {
    for (const time of [0.5, 1, 2, 50]) {
      expect(processingSweep(time, true)).toEqual({ gather: 1, offset: 0, stretch: 0 });
    }
  });
});
