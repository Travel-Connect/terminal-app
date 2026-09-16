/**
 * 260916_3: セッション記録の上限。session_id は送信側が自由に決められるため、上限が無いと偽イベントで
 * Map が単調増加し、掃引（メインスレッドの同期 I/O）が線形に重くなる。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { MAX_SESSIONS_PER_PROJECT, MAX_SESSIONS_TOTAL, StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [
  { id: "p1", name: "a", path: "C:\\dev\\a", clickTarget: "cursor", registeredAt: "2026-09-16T00:00:00Z" },
  { id: "p2", name: "b", path: "C:\\dev\\b", clickTarget: "cursor", registeredAt: "2026-09-16T00:00:00Z" },
];

function stop(sessionId: string, cwd = "C:\\dev\\a"): HookEvent {
  return { hook_event_name: "Stop", session_id: sessionId, cwd };
}

describe("セッション記録の上限", () => {
  it("プロジェクトあたり MAX_SESSIONS_PER_PROJECT を超えると、実行中でない最も古い記録から捨てる", () => {
    let t = 0;
    const store = new StateStore(() => (t += 1));
    store.applyEvent({ hook_event_name: "UserPromptSubmit", session_id: "running-old", cwd: "C:\\dev\\a", prompt: "x" }, projects);
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT - 1; i += 1) store.applyEvent(stop(`s${i}`), projects);
    expect(store.sessionIds()).toHaveLength(MAX_SESSIONS_PER_PROJECT);
    store.applyEvent(stop("newest"), projects);
    expect(store.sessionIds()).toHaveLength(MAX_SESSIONS_PER_PROJECT);
    expect(store.sessionIds()).toContain("running-old"); // 実行中は最古でも守る
    expect(store.sessionIds()).not.toContain("s0"); // 実行中でない最古が捨てられる
    expect(store.sessionIds()).toContain("newest");
  });

  it("既存セッションの更新は上限に達していても捨てない", () => {
    let t = 0;
    const store = new StateStore(() => (t += 1));
    for (let i = 0; i < MAX_SESSIONS_PER_PROJECT; i += 1) store.applyEvent(stop(`s${i}`), projects);
    store.applyEvent(stop("s0"), projects);
    expect(store.sessionIds()).toHaveLength(MAX_SESSIONS_PER_PROJECT);
    expect(store.sessionIds()).toContain("s1");
  });

  it("全体で MAX_SESSIONS_TOTAL を超えると他プロジェクト分も含めて最古から捨てる", () => {
    let t = 0;
    const store = new StateStore(() => (t += 1));
    const perProject = MAX_SESSIONS_PER_PROJECT;
    const many: Project[] = [];
    for (let p = 0; p < Math.ceil(MAX_SESSIONS_TOTAL / perProject) + 1; p += 1) {
      many.push({ id: `q${p}`, name: `q${p}`, path: `C:\\dev\\q${p}`, clickTarget: "cursor", registeredAt: "2026-09-16T00:00:00Z" });
    }
    let n = 0;
    for (const proj of many) {
      for (let i = 0; i < perProject; i += 1) {
        store.applyEvent(stop(`x${n}`, proj.path), many);
        n += 1;
      }
    }
    expect(store.sessionIds().length).toBeLessThanOrEqual(MAX_SESSIONS_TOTAL);
    expect(store.sessionIds()).not.toContain("x0");
    expect(store.sessionIds()).toContain(`x${n - 1}`);
  });
});
