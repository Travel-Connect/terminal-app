/**
 * renderer 表示整形 純関数（src/renderer/format.ts）の単体テスト。
 * 要件対応:
 * - 前ループ evaluator 持ち越し指摘 3: fmtRelative / fmtElapsed / ステータスバー 0 件省略が
 *   単体テスト未カバー → 純関数へ切り出してカバーする（criteria tests_evidence / code_quality）
 * - design.md 5.1: 経過時間 h:mm:ss（モック 1a: 1:24:01）・相対時刻（1 分未満は「たった今」）
 * - design.md 6.1 / 面 1b: 件数 0 の状態は省略した表記
 */
import { describe, expect, it } from "vitest";
import { fmtElapsed, fmtRelative, fmtStatusCounts } from "../src/renderer/format";

describe("fmtElapsed（実行中の経過時間 h:mm:ss。design.md 5.1 / 6.2）", () => {
  it("モック 1a の表記例: 1:24:01（在庫管理-app）", () => {
    expect(fmtElapsed((1 * 3600 + 24 * 60 + 1) * 1000)).toBe("1:24:01");
  });

  it("0 ミリ秒 = 0:00:00（実行開始直後）", () => {
    expect(fmtElapsed(0)).toBe("0:00:00");
  });

  it("境界値: 59 秒 / 60 秒 / 3599 秒 / 3600 秒", () => {
    expect(fmtElapsed(59_000)).toBe("0:00:59");
    expect(fmtElapsed(60_000)).toBe("0:01:00");
    expect(fmtElapsed(3_599_000)).toBe("0:59:59");
    expect(fmtElapsed(3_600_000)).toBe("1:00:00");
  });

  it("異常系: 負値（時計ずれ）は 0:00:00 に丸める", () => {
    expect(fmtElapsed(-5000)).toBe("0:00:00");
  });

  it("ミリ秒端数は切り捨てる（999ms は 0 秒扱い）", () => {
    expect(fmtElapsed(999)).toBe("0:00:00");
    expect(fmtElapsed(1000)).toBe("0:00:01");
  });

  it("長時間実行: 10 時間超も h が伸びるだけで破綻しない", () => {
    expect(fmtElapsed(10 * 3600 * 1000 + 5000)).toBe("10:00:05");
  });
});

describe("fmtRelative（相対時刻。design.md 5.1: 1 分未満は「たった今」）", () => {
  it("1 分未満は「たった今」（0 秒・59 秒）", () => {
    expect(fmtRelative(0)).toBe("たった今");
    expect(fmtRelative(59_000)).toBe("たった今");
  });

  it("分表示: 60 秒 = 1分前、3599 秒 = 59分前", () => {
    expect(fmtRelative(60_000)).toBe("1分前");
    expect(fmtRelative(120_000)).toBe("2分前"); // モック 1b「完了・2分前」
    expect(fmtRelative(3_599_000)).toBe("59分前");
  });

  it("時間表示: 3600 秒 = 1時間前、24 時間未満まで", () => {
    expect(fmtRelative(3_600_000)).toBe("1時間前");
    expect(fmtRelative(23 * 3600 * 1000 + 3_599_000)).toBe("23時間前");
  });

  it("日表示: 24 時間以上", () => {
    expect(fmtRelative(24 * 3600 * 1000)).toBe("1日前");
    expect(fmtRelative(72 * 3600 * 1000)).toBe("3日前");
  });

  it("異常系: 負値（時計ずれ）は「たった今」に丸める", () => {
    expect(fmtRelative(-1000)).toBe("たった今");
  });
});

describe("fmtStatusCounts（ステータスバー表記。REQ-10 / design.md 6.1 の 0 件省略）", () => {
  it("面 1b の表記例: 8実行中 2完了 1確認待ち 1エラー / 12セッション", () => {
    expect(fmtStatusCounts({ running: 8, done: 2, confirm: 1, error: 1, total: 12 })).toBe(
      "8実行中 2完了 1確認待ち 1エラー / 12セッション"
    );
  });

  it("件数 0 の状態は省略される（完了・エラーのみ等）", () => {
    expect(fmtStatusCounts({ running: 0, done: 2, confirm: 0, error: 1, total: 3 })).toBe("2完了 1エラー / 3セッション");
    expect(fmtStatusCounts({ running: 12, done: 0, confirm: 0, error: 0, total: 12 })).toBe("12実行中 / 12セッション");
  });

  it("全状態 0 件（登録のみ・イベント未受信 / 0 件）は「{N} セッション」のみ（面 1a / 1c）", () => {
    expect(fmtStatusCounts({ running: 0, done: 0, confirm: 0, error: 0, total: 0 })).toBe("0 セッション");
  });

  it("UserPromptSubmit で実行中 1 件になった直後の表記（task.md シナリオの表示確認）", () => {
    expect(fmtStatusCounts({ running: 1, done: 0, confirm: 0, error: 0, total: 1 })).toBe("1実行中 / 1セッション");
  });
});
