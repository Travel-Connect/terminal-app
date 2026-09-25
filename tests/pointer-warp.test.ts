import { describe, expect, it } from "vitest";
import { POINTER_WARP_RETRY_DELAYS_MS, pointInRect } from "../src/main/window-control";

// タッチ後のポインター迷子対策（260925_1 追補）
describe("pointInRect", () => {
  const rc = { left: 100, top: 200, right: 300, bottom: 400 };
  it("矩形内なら true", () => {
    expect(pointInRect({ x: 200, y: 300 }, rc)).toBe(true);
    expect(pointInRect({ x: 100, y: 200 }, rc)).toBe(true);
  });
  it("右端・下端は含まない、外は false", () => {
    expect(pointInRect({ x: 300, y: 300 }, rc)).toBe(false);
    expect(pointInRect({ x: 200, y: 400 }, rc)).toBe(false);
    expect(pointInRect({ x: 50, y: 300 }, rc)).toBe(false);
  });
});

describe("POINTER_WARP_RETRY_DELAYS_MS", () => {
  it("即時 1 回 + 遅延つき再試行で、昇順かつ 1 秒程度で終える", () => {
    expect(POINTER_WARP_RETRY_DELAYS_MS[0]).toBe(0);
    expect(POINTER_WARP_RETRY_DELAYS_MS.length).toBeGreaterThan(1);
    for (let i = 1; i < POINTER_WARP_RETRY_DELAYS_MS.length; i++) {
      expect(POINTER_WARP_RETRY_DELAYS_MS[i]).toBeGreaterThan(POINTER_WARP_RETRY_DELAYS_MS[i - 1]);
    }
    expect(POINTER_WARP_RETRY_DELAYS_MS[POINTER_WARP_RETRY_DELAYS_MS.length - 1]).toBeLessThanOrEqual(1500);
  });
});
