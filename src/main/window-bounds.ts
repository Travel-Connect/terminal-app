/**
 * ウィンドウ位置の記憶（260904_1 #3）: projects.json に保存する WindowBounds の検証・整形（純関数）。
 * Win32 呼び出し（GetWindowPlacement / SetWindowPlacement）は window-control.ts 側。
 */
import type { WindowBounds } from "../shared/types";

/** 幅・高さの下限（これ未満は壊れた値とみなす） */
export const MIN_WINDOW_SIZE = 100;
/** 座標の絶対値上限（Win32 の座標範囲。仮想スクリーンの負座標も許す） */
export const MAX_COORD = 32767;

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/**
 * projects.json 由来の値を検証して WindowBounds に整える。壊れていれば null（保存値を捨てる側に倒す）。
 * maximized 欠落は false、savedAt 欠落は空文字で補う（旧形式との互換）。
 */
export function parseWindowBounds(raw: unknown): WindowBounds | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return null;
  if (Math.abs(r.x) > MAX_COORD || Math.abs(r.y) > MAX_COORD) return null;
  if (r.width < MIN_WINDOW_SIZE || r.height < MIN_WINDOW_SIZE || r.width > MAX_COORD || r.height > MAX_COORD) return null;
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    maximized: r.maximized === true,
    savedAt: typeof r.savedAt === "string" ? r.savedAt : "",
  };
}

/** ログ・ステータスバー用の短い表記（例「(1920, 0) 1280×1040・最大化」） */
export function fmtWindowBounds(b: WindowBounds): string {
  return `(${b.x}, ${b.y}) ${b.width}×${b.height}${b.maximized ? "・最大化" : ""}`;
}

/** 位置・サイズ・最大化が同じか（savedAt は比較しない。復元後の照合用） */
export function boundsEqual(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.maximized === b.maximized;
}
