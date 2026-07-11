/**
 * 260712_4: reviveSession の終端分類（turnEnd）対応のテスト。
 *
 * 背景バグ（実測 2026-07-11T21:57:19）: Stop → done 済みのセッションでも transcript の mtime は
 * Stop イベント時刻より新しいため、従来ガード（lastEventAt 比較）をすり抜けて「実行中」で復元され、
 * 完了済みタイルがスピナーに戻っていた。加えて割り込み（Esc）では Stop が発火せず、
 * 「実行中」のまま取り残されたタイルを再接続でも直せなかった。
 *
 * 新仕様:
 * - turnEnd=concluded → 「完了」で復元（実行中スタックのヒール。終了系状態は動かさない）
 * - turnEnd=open / 未指定 → 従来どおり「実行中」で復元（切断からの復帰・再起動後の復元）
 * - 実行中 + open は現状維持（runningSince を transcript mtime で巻き戻さない）
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-12T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\terminal-app")];

function evt(name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:\\dev\\terminal-app", ...extra };
}

function storeAt(): { store: StateStore; tick: (ms: number) => void; now: () => number } {
  let t = 1_000_000;
  const store = new StateStore(() => t);
  return { store, tick: (ms) => (t += ms), now: () => t };
}

function revive(
  store: StateStore,
  info: { lastEventAt: number; turnEnd?: "concluded" | "open" | "unknown"; workText?: string }
): boolean {
  return store.reviveSession({
    sessionId: "s1",
    projectId: "p1",
    transcriptPath: "C:\\t\\s1.jsonl",
    ...info,
  });
}

describe("reviveSession × turnEnd=concluded（ターン終了済みの復元）", () => {
  it("未知のセッションは「完了」で復元する（アプリ再起動後、終了済みをスピナーに戻さない）", () => {
    const { store } = storeAt();
    const ok = revive(store, { lastEventAt: 900_000, turnEnd: "concluded", workText: "コミットしてね。" });
    expect(ok).toBe(true);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("done");
    expect(view.runningSince).toBeUndefined();
    expect(view.workText).toBe("コミットしてね。");
  });

  it("実行中スタック（Stop 欠落）を「完了」へヒールする — 再接続で直せなかった本体バグ", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(60_000); // 割り込みで Stop が来ないまま 60 秒
    const ok = revive(store, { lastEventAt: now() - 5_000, turnEnd: "concluded" });
    expect(ok).toBe(true);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("done");
    expect(view.runningSince).toBeUndefined();
  });

  it("done 済みセッションは transcript が新しくても動かさない（21:57:19 の再現ケース）", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    tick(4 * 60_000); // Stop の 4 分後に再接続。transcript mtime は Stop 直後 = イベントより新しい
    const ok = revive(store, { lastEventAt: now() - 3 * 60_000, turnEnd: "concluded" });
    expect(ok).toBe(false);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("done");
    expect(view.state).not.toBe("running"); // スピナーに戻らないこと
  });

  it("切断セッションも終了済みなら「完了」で復元する（「切断」より正確な表示）", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { transcript_path: "C:\\t\\s1.jsonl" }), projects);
    tick(300_000);
    store.markDisconnected("s1");
    tick(10_000);
    const ok = revive(store, { lastEventAt: now() - 5_000, turnEnd: "concluded" });
    expect(ok).toBe(true);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
  });
});

describe("reviveSession × turnEnd=open / unknown（進行中・判定不能）", () => {
  it("実行中 + open は現状維持（runningSince を transcript mtime で動かさない）", () => {
    const { store, tick, now } = storeAt();
    const startedAt = now();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(120_000);
    const ok = revive(store, { lastEventAt: now() - 1_000, turnEnd: "open" });
    expect(ok).toBe(false);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.runningSince).toBe(startedAt); // 経過時間の起点が巻き戻らない
  });

  it("実行中 + unknown も現状維持（判定材料なしで状態を変えない）", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(60_000);
    expect(revive(store, { lastEventAt: now(), turnEnd: "unknown" })).toBe(false);
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
  });

  it("done + open + transcript が新しい → 従来どおり「実行中」へ（ターン開始イベント欠落の復帰）", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    tick(60_000);
    const ok = revive(store, { lastEventAt: now() - 1_000, turnEnd: "open" });
    expect(ok).toBe(true);
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
  });
});
