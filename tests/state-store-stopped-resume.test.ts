/**
 * 260907_1: 完了・切断 → 実行中の復帰（StateStore.stoppedSessions / resumeFromStopped）と
 * block 理由 → 作業テキストの整形（blockReasonToWorkText）。
 * 掃引（liveness-monitor.findResumedFromStopped）のヒットを適用する側の遷移規則を確認する。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, blockReasonToWorkText, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-07T00:00:00Z" }];

function evt(name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:/dev/app", ...extra };
}

function storeAt(start = 1_000_000) {
  let now = start;
  const store = new StateStore(() => now);
  return { store, tick: (ms: number) => { now += ms; } };
}

describe("stoppedSessions", () => {
  it("完了と切断だけを state / transcript パス / 最終イベント時刻付きで返す（確認待ち・実行中・終了済みは除く）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "d1", { transcript_path: "C:/t/d1.jsonl" }), projects);
    tick(10);
    store.applyEvent(evt("UserPromptSubmit", "x1", { transcript_path: "C:/t/x1.jsonl" }), projects);
    tick(10);
    store.markDisconnected("x1");
    store.applyEvent(evt("Notification", "c1"), projects);
    store.applyEvent(evt("UserPromptSubmit", "r1"), projects);
    store.applyEvent(evt("Stop", "dead1"), projects);
    store.setDead("dead1", true);
    const list = store.stoppedSessions().sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
    expect(list).toEqual([
      { sessionId: "d1", projectId: "p1", state: "done", transcriptPath: "C:/t/d1.jsonl", lastEventAt: 1_000_000 },
      { sessionId: "x1", projectId: "p1", state: "disconnected", transcriptPath: "C:/t/x1.jsonl", lastEventAt: 1_000_020 },
    ]);
  });
});

describe("resumeFromStopped", () => {
  it("完了 → 実行中。経過時間の起点と最終イベント時刻は検知時刻。作業テキストは維持", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "月次レポートを作って" }), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    tick(4_000);
    expect(store.resumeFromStopped("s1")).toBe(true);
    const v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("running");
    expect(v.runningSince).toBe(1_004_000);
    expect(v.lastEventAt).toBe(1_004_000);
    expect(v.workText).toBe("月次レポートを作って");
  });

  it("作業テキストを指定すれば置き換える（block 理由のラベル）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "依頼文" }), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.resumeFromStopped("s1", "[Eval-loop iteration 1/4 | RESUME 1/3]")).toBe(true);
    expect(store.displaySessions(projects)["p1"].workText).toBe("[Eval-loop iteration 1/4 | RESUME 1/3]");
  });

  it("切断 → 実行中", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(1_000);
    store.markDisconnected("s1");
    tick(1_000);
    expect(store.resumeFromStopped("s1")).toBe(true);
    const v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("running");
    expect(v.runningSince).toBe(1_002_000);
  });

  it("確認待ち・実行中・エラー・未知セッションには適用しない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Notification", "c1"), projects);
    store.applyEvent(evt("UserPromptSubmit", "r1"), projects);
    store.applyEvent(evt("SessionEnd", "e1", { reason: "crash" }), projects);
    expect(store.resumeFromStopped("c1")).toBe(false);
    expect(store.resumeFromStopped("r1")).toBe(false);
    expect(store.resumeFromStopped("e1")).toBe(false);
    expect(store.resumeFromStopped("zzz")).toBe(false);
  });

  it("復帰後に本当の Stop が来れば完了になり、件数も追随する（通常の遷移が壊れない）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    store.resumeFromStopped("s1");
    expect(store.counts(projects)).toEqual({ running: 1, done: 0, confirm: 0, error: 0, total: 1 });
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
    expect(store.counts(projects)).toEqual({ running: 0, done: 1, confirm: 0, error: 0, total: 1 });
  });

  it("changed を発火する（UI 更新のトリガ）。適用できないときは発火しない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1"), projects);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    store.resumeFromStopped("s1");
    expect(fired).toBe(1);
    store.resumeFromStopped("s1"); // もう実行中
    expect(fired).toBe(1);
  });
});

describe("blockReasonToWorkText", () => {
  it("先頭の [...] ラベルだけを取り出す（eval-loop の block 理由の形式）", () => {
    expect(blockReasonToWorkText("[Eval-loop iteration 1/4 | RESUME 1/3] The loop is mid-iteration and your response ended before the iteration completed. Continue now.\nSTATE_FILE=...")).toBe(
      "[Eval-loop iteration 1/4 | RESUME 1/3]"
    );
    expect(blockReasonToWorkText("  [Eval-loop iteration 2/4 | current score: 70 out of 100] next")).toBe("[Eval-loop iteration 2/4 | current score: 70 out of 100]");
  });

  it("[...] が無ければ 1 行目を 80 文字で省略", () => {
    expect(blockReasonToWorkText("Continue with step 2\nmore details")).toBe("Continue with step 2");
    const long = "a".repeat(100);
    expect(blockReasonToWorkText(long)).toBe("a".repeat(80) + "…");
  });

  it("[...] が長すぎる（78 文字超）ときも 1 行目の省略にフォールバック", () => {
    const label = "[" + "x".repeat(90) + "] tail";
    expect(blockReasonToWorkText(label)).toBe(label.slice(0, 80) + "…");
  });

  it("空・空白のみは undefined", () => {
    expect(blockReasonToWorkText("")).toBeUndefined();
    expect(blockReasonToWorkText("   \n  ")).toBeUndefined();
  });
});
