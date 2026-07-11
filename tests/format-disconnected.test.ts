/**
 * 260712_2: ステータスバー表記への「切断」追加分のテスト（既存 format.test.ts は無改変のため別ファイル）。
 * disconnected はオプショナルキー — 未設定（旧呼び出し）は 0 扱いで従来表記と完全互換。
 */
import { describe, expect, it } from "vitest";
import { fmtStatusCounts } from "../src/renderer/format";

describe("fmtStatusCounts の切断表記（260712_2）", () => {
  it("切断 1 件以上で「N切断」を追加する", () => {
    expect(fmtStatusCounts({ running: 2, done: 1, confirm: 0, error: 0, disconnected: 1, total: 4 })).toBe(
      "2実行中 1完了 1切断 / 4セッション"
    );
  });

  it("切断のみのときも件数と総数を表示する", () => {
    expect(fmtStatusCounts({ running: 0, done: 0, confirm: 0, error: 0, disconnected: 2, total: 2 })).toBe(
      "2切断 / 2セッション"
    );
  });

  it("disconnected 未設定（旧呼び出し）と 0 は従来表記のまま", () => {
    expect(fmtStatusCounts({ running: 1, done: 0, confirm: 0, error: 0, total: 1 })).toBe("1実行中 / 1セッション");
    expect(fmtStatusCounts({ running: 1, done: 0, confirm: 0, error: 0, disconnected: 0, total: 1 })).toBe(
      "1実行中 / 1セッション"
    );
  });
});
