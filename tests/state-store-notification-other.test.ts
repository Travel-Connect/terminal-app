/**
 * 260916_2: 公式 notification_type が permission / idle 以外（auth_success / agent_completed / quota_* 等）の
 * Notification は人の応答を要しないので「確認待ち」にしない。
 * 2026-09-14 実測: auth_success で 5.5 分「確認待ち」のまま＋トースト。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { isIgnorableNotification, StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:\\dev\\app", clickTarget: "cursor", registeredAt: "2026-09-16T00:00:00Z" }];

function notification(sessionId: string, extra: Partial<HookEvent>): HookEvent {
  return { hook_event_name: "Notification", session_id: sessionId, cwd: "C:\\dev\\app", ...extra };
}

describe("isIgnorableNotification", () => {
  it("notification_type が other 系なら true、permission / idle なら false、無ければ false（従来の文言推定）", () => {
    expect(isIgnorableNotification(notification("s", { notification_type: "auth_success", message: "Logged in" }))).toBe(true);
    expect(isIgnorableNotification(notification("s", { notification_type: "agent_completed" }))).toBe(true);
    expect(isIgnorableNotification(notification("s", { notification_type: "quota_auto_resume_scheduled" }))).toBe(true);
    expect(isIgnorableNotification(notification("s", { notification_type: "permission_prompt" }))).toBe(false);
    expect(isIgnorableNotification(notification("s", { notification_type: "idle_prompt" }))).toBe(false);
    expect(isIgnorableNotification(notification("s", { notification_type: "" , message: "something" }))).toBe(false);
    expect(isIgnorableNotification(notification("s", { message: "something unknown" }))).toBe(false);
    expect(isIgnorableNotification({ hook_event_name: "Stop", session_id: "s", cwd: "C:\\dev\\app" })).toBe(false);
  });
});

describe("applyEvent: 状態を変えない Notification", () => {
  it("実行中は実行中のまま（時刻・作業テキストも据え置き）。結果は ignored=true", () => {
    let t = 1_000;
    const store = new StateStore(() => t);
    store.applyEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "C:\\dev\\app", prompt: "作業" }, projects);
    t = 5_000;
    const r = store.applyEvent(notification("s1", { notification_type: "auth_success", message: "Logged in" }), projects);
    expect(r).toEqual({ projectId: "p1", sessionId: "s1", state: "running", ignored: true });
    expect(store.displaySessions(projects).p1).toMatchObject({ sessionId: "s1", state: "running", workText: "作業", lastEventAt: 1_000 });
  });

  it("完了は完了のまま。未知のセッションは記録を作らない", () => {
    const store = new StateStore(() => 1_000);
    store.applyEvent({ hook_event_name: "Stop", session_id: "s1", cwd: "C:\\dev\\app" }, projects);
    expect(store.applyEvent(notification("s1", { notification_type: "agent_completed" }), projects)).toMatchObject({ state: "done", ignored: true });
    expect(store.displaySessions(projects).p1.state).toBe("done");
    expect(store.applyEvent(notification("new", { notification_type: "auth_success" }), projects)).toEqual({ projectId: "p1", sessionId: "new", state: "waiting", ignored: true });
    expect(store.sessionIds()).toEqual(["s1"]);
  });

  it("permission_prompt / idle_prompt、および notification_type 無しの未知文言は従来どおり確認待ち", () => {
    const store = new StateStore(() => 1_000);
    expect(store.applyEvent(notification("a", { notification_type: "permission_prompt" }), projects)?.state).toBe("confirm");
    expect(store.applyEvent(notification("b", { notification_type: "idle_prompt" }), projects)?.state).toBe("confirm");
    expect(store.applyEvent(notification("c", { message: "何かの通知" }), projects)?.state).toBe("confirm");
  });

  it("未登録 cwd は従来どおり null", () => {
    const store = new StateStore(() => 1_000);
    expect(store.applyEvent(notification("s", { notification_type: "auth_success", cwd: "C:\\elsewhere" }), projects)).toBe(null);
  });
});
