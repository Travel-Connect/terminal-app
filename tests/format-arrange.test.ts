/**
 * タイルの並べ替え（260906_1）の純関数（renderer 側 format.ts）。
 * - autoArrangeIds: 自動整列 = 接続中のプロジェクトを先頭（左上）へ。各グループ内の相対順は保つ
 * - moveProjectId: D&D の移動 = from を to の前／後へ挿入した新しい順序を返す（元配列は変えない）
 * - projectLinked: プロジェクト単位の「接続中」判定（分割タイルはいずれかのセッションが接続中なら接続中）
 */
import { describe, expect, it } from "vitest";
import { autoArrangeIds, moveProjectId, projectLinked } from "../src/renderer/format";

describe("autoArrangeIds（260906_1: 自動整列）", () => {
  it("接続中のプロジェクトを先頭へ移し、未接続は後ろへ。それぞれの相対順は保つ", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const linked = { a: false, b: true, c: false, d: true, e: true };
    expect(autoArrangeIds(ids, linked)).toEqual(["b", "d", "e", "a", "c"]);
  });

  it("すべて接続中なら順序は変わらない", () => {
    expect(autoArrangeIds(["a", "b", "c"], { a: true, b: true, c: true })).toEqual(["a", "b", "c"]);
  });

  it("判定が無い id（undefined）は接続中扱い（判定不能は隠さない側 = isUnlinked と同じ安全側）", () => {
    expect(autoArrangeIds(["a", "b", "c"], { b: false })).toEqual(["a", "c", "b"]);
  });

  it("空配列は空配列を返し、元配列は変更しない", () => {
    expect(autoArrangeIds([], {})).toEqual([]);
    const ids = ["a", "b"];
    autoArrangeIds(ids, { a: false, b: true });
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("moveProjectId（260906_1: D&D 並べ替え）", () => {
  const ids = ["a", "b", "c", "d"];

  it("後ろの要素を前の要素の手前へ挿入する", () => {
    expect(moveProjectId(ids, "d", "b", false)).toEqual(["a", "d", "b", "c"]);
  });

  it("前の要素を後ろの要素の直後へ挿入する", () => {
    expect(moveProjectId(ids, "a", "c", true)).toEqual(["b", "c", "a", "d"]);
  });

  it("前の要素を後ろの要素の手前へ挿入する（右方向への移動でも位置がずれない）", () => {
    expect(moveProjectId(ids, "a", "c", false)).toEqual(["b", "a", "c", "d"]);
  });

  it("後ろの要素を前の要素の直後へ挿入する", () => {
    expect(moveProjectId(ids, "d", "a", true)).toEqual(["a", "d", "b", "c"]);
  });

  it("自分自身への移動・未知の id は順序を変えない", () => {
    expect(moveProjectId(ids, "b", "b", true)).toEqual(ids);
    expect(moveProjectId(ids, "x", "b", true)).toEqual(ids);
    expect(moveProjectId(ids, "b", "x", false)).toEqual(ids);
  });

  it("元配列は変更しない", () => {
    const src = ["a", "b", "c"];
    moveProjectId(src, "c", "a", false);
    expect(src).toEqual(["a", "b", "c"]);
  });
});

describe("projectLinked（260906_1: プロジェクト単位の接続中判定）", () => {
  it("ウィンドウ無し＋待機・完了は未接続（false）", () => {
    expect(projectLinked(false, [undefined])).toBe(false);
    expect(projectLinked(false, ["done"])).toBe(false);
  });

  it("ウィンドウ無しでも実行中・確認待ちのセッションが 1 本でもあれば接続中", () => {
    expect(projectLinked(false, ["done", "running"])).toBe(true);
    expect(projectLinked(false, ["confirm"])).toBe(true);
  });

  it("ウィンドウあり・判定不能は状態によらず接続中", () => {
    expect(projectLinked(true, ["done"])).toBe(true);
    expect(projectLinked(undefined, [undefined])).toBe(true);
  });

  it("セッション一覧が空（表示セッション無し）は待機 1 タイルとして判定する", () => {
    expect(projectLinked(false, [])).toBe(false);
    expect(projectLinked(true, [])).toBe(true);
  });
});
