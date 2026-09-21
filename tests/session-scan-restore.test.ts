/**
 * 260922_3: 起動時復元・再接続の対象選定 selectRestorable のテスト。
 * 登録簿で生きている（alive）セッションは transcript が古くても復元し、dead は復元せず、
 * 登録簿が読めない（unknown）ときだけ従来の更新窓（fallbackActiveMs）で決める。
 */
import { describe, expect, it } from "vitest";
import { RECONNECT_ACTIVE_MS, selectRestorable } from "../src/main/session-scan";

const now = 10_000_000;
const found = [
  { sessionId: "old-alive", mtimeMs: now - 5 * 60 * 60_000 }, // 5 時間前だが生きている（質問して止まったまま）
  { sessionId: "fresh-dead", mtimeMs: now - 1_000 }, // 直前に更新されたが登録簿に無い（閉じたターミナル）
  { sessionId: "fresh-unknown", mtimeMs: now - 1_000 },
  { sessionId: "old-unknown", mtimeMs: now - RECONNECT_ACTIVE_MS - 1 },
];

describe("selectRestorable", () => {
  it("alive は更新が古くても復元、dead は復元しない、unknown は更新窓で決める", () => {
    const liveness = (sid: string): "alive" | "dead" | "unknown" => (sid.endsWith("alive") ? "alive" : sid.endsWith("dead") ? "dead" : "unknown");
    expect(selectRestorable(found, liveness, now).map((s) => s.sessionId)).toEqual(["old-alive", "fresh-unknown"]);
  });

  it("登録簿が丸ごと読めない（全部 unknown）ときは従来どおり更新窓だけで決める", () => {
    expect(selectRestorable(found, () => "unknown", now).map((s) => s.sessionId)).toEqual(["fresh-dead", "fresh-unknown"]);
    expect(selectRestorable(found, () => "unknown", now, 10 * 60 * 60_000).map((s) => s.sessionId)).toEqual(found.map((s) => s.sessionId));
  });

  it("空配列は空配列。元配列は変更しない", () => {
    expect(selectRestorable([], () => "alive", now)).toEqual([]);
    const copy = [...found];
    selectRestorable(found, () => "dead", now);
    expect(found).toEqual(copy);
  });
});
