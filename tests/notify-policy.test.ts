/**
 * 260712_5: 通知要否判定（shouldNotify）の単体テスト。
 * 完了（done）・確認待ち（confirm）への遷移でのみ通知し、同一状態への再遷移では
 * 通知しない（過剰通知の抑制）ことを検証する。
 */
import { describe, expect, it } from "vitest";
import { shouldNotify } from "../src/main/notify-policy";

describe("shouldNotify", () => {
  it("初回遷移（prevState=undefined）→ done なら通知する", () => {
    expect(shouldNotify(undefined, "done")).toBe(true);
  });

  it("running → done（実行中から完了への遷移）なら通知する", () => {
    expect(shouldNotify("running", "done")).toBe(true);
  });

  it("done → done（同一状態への再遷移）は通知しない", () => {
    expect(shouldNotify("done", "done")).toBe(false);
  });

  it("done → confirm（完了 → 確認待ちの遷移）は通知する", () => {
    expect(shouldNotify("done", "confirm")).toBe(true);
  });

  it("running → running（対象外状態）は通知しない", () => {
    expect(shouldNotify("running", "running")).toBe(false);
  });

  it("初回遷移でも対象外状態（waiting）は通知しない", () => {
    expect(shouldNotify(undefined, "waiting")).toBe(false);
  });

  it("confirm → confirm（確認待ちの再通知）は抑制する", () => {
    expect(shouldNotify("confirm", "confirm")).toBe(false);
  });
});
