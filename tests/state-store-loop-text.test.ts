/**
 * 260907_2: ループ進捗バッジの文字列（loopText）を StateStore に載せる applyLoopText。
 * statusLine 転送（applyStatusStats）と同じく状態遷移には触れず、値が変わったときだけ changed を発火する。
 * 消す（undefined）こともできる点が applyStatusStats と異なる（ループ終了から 30 分で消えるため）。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-07T00:00:00Z" }];
const evt = (name: HookEvent["hook_event_name"], sessionId: string): HookEvent => ({ hook_event_name: name, session_id: sessionId, cwd: "C:/dev/app" });

describe("applyLoopText", () => {
  it("値を載せると view に loopText が出る。状態・時刻・経過起点は変わらない", () => {
    const store = new StateStore(() => 1_000_000);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.applyLoopText("s1", "ループ 1/4・実装中")).toBe(true);
    const v = store.displaySessions(projects)["p1"];
    expect(v.loopText).toBe("ループ 1/4・実装中");
    expect(v.state).toBe("running");
    expect(v.lastEventAt).toBe(1_000_000);
    expect(v.runningSince).toBe(1_000_000);
    expect(fired).toBe(1);
  });

  it("同じ値は無変化（false・changed なし）。違う値で更新。undefined で消える", () => {
    const store = new StateStore(() => 1_000_000);
    store.applyEvent(evt("Stop", "s1"), projects);
    store.applyLoopText("s1", "ループ 1/4・実装中");
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.applyLoopText("s1", "ループ 1/4・実装中")).toBe(false);
    expect(fired).toBe(0);
    expect(store.applyLoopText("s1", "ループ終了・合格 92点")).toBe(true);
    expect(store.displaySessions(projects)["p1"].loopText).toBe("ループ終了・合格 92点");
    expect(store.applyLoopText("s1", undefined)).toBe(true);
    expect(store.displaySessions(projects)["p1"].loopText).toBeUndefined();
    expect(store.applyLoopText("s1", undefined)).toBe(false);
    expect(fired).toBe(2);
  });

  it("未知のセッションは破棄（false）。分割タイル（splitSessions）の各 view にも載る", () => {
    const store = new StateStore(() => 1_000_000);
    expect(store.applyLoopText("zzz", "x")).toBe(false);
    store.applyEvent(evt("UserPromptSubmit", "a"), projects);
    store.applyEvent(evt("UserPromptSubmit", "b"), projects);
    store.applyLoopText("b", "ループ 2/4・採点中");
    const split = store.splitSessions(projects)["p1"];
    expect(split.map((v) => v.loopText)).toEqual([undefined, "ループ 2/4・採点中"]);
  });
});
