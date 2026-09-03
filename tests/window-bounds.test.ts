/**
 * ウィンドウ位置の記憶（260904_1 #3）: projects.json に載る WindowBounds の検証・整形。
 * 壊れた保存値で SetWindowPlacement を呼ばない（= 検証で落とす）ことを境界値で確認する。
 */
import { describe, expect, it } from "vitest";
import { boundsEqual, fmtWindowBounds, MAX_COORD, MIN_WINDOW_SIZE, parseWindowBounds } from "../src/main/window-bounds";

describe("parseWindowBounds", () => {
  it("正常値はそのまま（負座標 = セカンドモニタ左側も許す）", () => {
    expect(parseWindowBounds({ x: -1920, y: -200, width: 1280, height: 1040, maximized: true, savedAt: "2026-09-04T00:00:00.000Z" })).toEqual({
      x: -1920,
      y: -200,
      width: 1280,
      height: 1040,
      maximized: true,
      savedAt: "2026-09-04T00:00:00.000Z",
    });
  });

  it("maximized / savedAt 欠落は false / 空文字で補う", () => {
    expect(parseWindowBounds({ x: 0, y: 0, width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 800, height: 600, maximized: false, savedAt: "" });
  });

  it("小さすぎる・大きすぎる・非整数・座標範囲外・非オブジェクトは null", () => {
    expect(parseWindowBounds({ x: 0, y: 0, width: MIN_WINDOW_SIZE - 1, height: 600 })).toBe(null);
    expect(parseWindowBounds({ x: 0, y: 0, width: 800, height: MAX_COORD + 1 })).toBe(null);
    expect(parseWindowBounds({ x: 0.5, y: 0, width: 800, height: 600 })).toBe(null);
    expect(parseWindowBounds({ x: "0", y: 0, width: 800, height: 600 })).toBe(null);
    expect(parseWindowBounds({ x: -(MAX_COORD + 1), y: 0, width: 800, height: 600 })).toBe(null);
    expect(parseWindowBounds(null)).toBe(null);
    expect(parseWindowBounds([0, 0, 800, 600])).toBe(null);
    expect(parseWindowBounds("x")).toBe(null);
  });

  it("境界値: 最小サイズちょうど・座標上限ちょうどは受理", () => {
    expect(parseWindowBounds({ x: MAX_COORD, y: -MAX_COORD, width: MIN_WINDOW_SIZE, height: MIN_WINDOW_SIZE })).not.toBe(null);
  });
});

describe("fmtWindowBounds / boundsEqual", () => {
  const a = { x: 1920, y: 0, width: 1280, height: 1040, maximized: false, savedAt: "t1" };
  it("表記は (x, y) 幅×高さ（最大化なら注記）", () => {
    expect(fmtWindowBounds(a)).toBe("(1920, 0) 1280×1040");
    expect(fmtWindowBounds({ ...a, maximized: true })).toBe("(1920, 0) 1280×1040・最大化");
  });
  it("savedAt の違いは無視し、位置・サイズ・最大化で比較する", () => {
    expect(boundsEqual(a, { ...a, savedAt: "t2" })).toBe(true);
    expect(boundsEqual(a, { ...a, x: 1921 })).toBe(false);
    expect(boundsEqual(a, { ...a, maximized: true })).toBe(false);
  });
});
