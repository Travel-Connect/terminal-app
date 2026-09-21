/**
 * 確認待ちの自動先頭配置（260922_1）の純関数（renderer 側 format.ts）。
 * - confirmFirstIds: 確認待ちのプロジェクトを表示上だけ先頭（左上）へ。各グループ内の相対順は保つ。
 *   projects.json の並び（D&D 順）は変えない = 引数配列を変更せず、確認待ちが解けたら自然に元の位置へ戻る
 * - projectConfirming: プロジェクト単位の「確認待ち」判定（分割タイルはいずれか 1 本でも確認待ちなら該当）
 */
import { describe, expect, it } from "vitest";
import { confirmFirstIds, projectConfirming } from "../src/renderer/format";

describe("confirmFirstIds（260922_1: 確認待ちを先頭へ）", () => {
  it("確認待ちのプロジェクトを先頭へ移し、それ以外は後ろへ。それぞれの相対順は保つ", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const confirming = { a: false, b: true, c: false, d: true, e: false };
    expect(confirmFirstIds(ids, confirming)).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("確認待ちが無ければ順序は変わらない", () => {
    expect(confirmFirstIds(["a", "b", "c"], { a: false, b: false, c: false })).toEqual(["a", "b", "c"]);
    expect(confirmFirstIds(["a", "b", "c"], {})).toEqual(["a", "b", "c"]);
  });

  it("判定が無い id（undefined）は確認待ちではない扱い（autoArrangeIds とは逆で、明示的な true だけを前へ出す）", () => {
    expect(confirmFirstIds(["a", "b", "c"], { c: true })).toEqual(["c", "a", "b"]);
  });

  it("すでに先頭にある確認待ちはそのまま（無駄な入れ替えをしない）", () => {
    expect(confirmFirstIds(["a", "b", "c"], { a: true })).toEqual(["a", "b", "c"]);
  });

  it("空配列は空配列を返し、元配列は変更しない", () => {
    expect(confirmFirstIds([], {})).toEqual([]);
    const ids = ["a", "b"];
    confirmFirstIds(ids, { b: true });
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("projectConfirming（260922_1: プロジェクト単位の確認待ち判定）", () => {
  it("単独タイルは state が confirm のときだけ該当", () => {
    expect(projectConfirming(["confirm"])).toBe(true);
    expect(projectConfirming(["running"])).toBe(false);
    expect(projectConfirming(["done"])).toBe(false);
    expect(projectConfirming(["error"])).toBe(false);
    expect(projectConfirming(["disconnected"])).toBe(false);
  });

  it("分割タイルはいずれか 1 本でも確認待ちなら該当", () => {
    expect(projectConfirming(["running", "confirm"])).toBe(true);
    expect(projectConfirming(["running", "done"])).toBe(false);
  });

  it("待機タイル（セッション無し = undefined）や空配列は該当しない", () => {
    expect(projectConfirming([undefined])).toBe(false);
    expect(projectConfirming([])).toBe(false);
  });
});
