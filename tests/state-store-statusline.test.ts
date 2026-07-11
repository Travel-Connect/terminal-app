/**
 * 260712_3 案A: applyStatusStats（statusLine メトリクスの反映）のテスト。
 * statusline はアイドル中にも最大 300ms 間隔で発火するため、
 * (1) 状態遷移・lastEventAt に触れないこと、(2) 値が同じ間は再描画（changed）しないこと、が要点。
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

describe("applyStatusStats", () => {
  it("既知セッションの statsText を更新し、SessionView に載る", () => {
    const store = new StateStore(() => 1_000_000);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.applyStatusStats("s1", "↓ 70.5k tokens · thinking xhigh")).toBe(true);
    expect(store.displaySessions(projects)["p1"].statsText).toBe("↓ 70.5k tokens · thinking xhigh");
  });

  it("状態・lastEventAt は一切変えない（アイドル中の statusline で実行中化しない）", () => {
    let t = 1_000_000;
    const store = new StateStore(() => t);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyEvent(evt("Stop", "s1"), projects); // 完了・入力待ち
    const before = store.displaySessions(projects)["p1"];
    t += 60_000;
    store.applyStatusStats("s1", "↓ 1.2k tokens");
    const after = store.displaySessions(projects)["p1"];
    expect(after.state).toBe("done"); // 実行中に戻さない
    expect(after.lastEventAt).toBe(before.lastEventAt); // 相対時刻の起点も動かさない
  });

  it("同じ値の再送では changed = false（300ms 間隔の再描画抑制）", () => {
    const store = new StateStore(() => 1_000_000);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.applyStatusStats("s1", "↓ 500 tokens")).toBe(true);
    expect(store.applyStatusStats("s1", "↓ 500 tokens")).toBe(false);
    expect(store.applyStatusStats("s1", "↓ 600 tokens")).toBe(true);
  });

  it("未知セッション・undefined は破棄（false）", () => {
    const store = new StateStore(() => 1_000_000);
    expect(store.applyStatusStats("unknown", "↓ 1.0k tokens")).toBe(false);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.applyStatusStats("s1", undefined)).toBe(false);
    expect(store.displaySessions(projects)["p1"].statsText).toBeUndefined();
  });

  it("メトリクスが取れない周回（undefined）でも直前の表示値を維持する", () => {
    const store = new StateStore(() => 1_000_000);
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyStatusStats("s1", "↓ 70.5k tokens");
    store.applyStatusStats("s1", undefined); // /compact 直後など
    expect(store.displaySessions(projects)["p1"].statsText).toBe("↓ 70.5k tokens");
  });
});
