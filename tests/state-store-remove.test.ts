/**
 * StateStore.removeProjectSessions の回帰テスト（bug-audit #6 の直接カバー）。
 * 登録解除したプロジェクトのセッションが内部 Map から確実に消え（長期稼働でのメモリ
 * 単調増加の防止）、他プロジェクトのセッション・表示・件数に影響しないことを検証する。
 * （パス区切りはフォワードスラッシュ表記。normalizePath が区切りを同一視するため等価）
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("/").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-11T00:00:00Z" };
}

const projects = [project("p1", "C:/dev/zaiko-app"), project("p2", "C:/dev/other")];

function evt(name: HookEvent["hook_event_name"], sessionId: string, cwd: string): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd };
}

/** p1 に 2 セッション・p2 に 1 セッションを積んだストアを作る */
function seededStore(): StateStore {
  const store = new StateStore();
  store.applyEvent(evt("Stop", "s1", "C:/dev/zaiko-app"), projects);
  store.applyEvent(evt("UserPromptSubmit", "s2", "C:/dev/zaiko-app/sub"), projects);
  store.applyEvent(evt("Notification", "s3", "C:/dev/other"), projects);
  return store;
}

describe("removeProjectSessions（bug-audit #6: 登録解除後のセッション残留防止）", () => {
  it("対象プロジェクトのセッションのみ消え、他プロジェクトは影響を受けない", () => {
    const store = seededStore();
    expect(store.sessionCount).toBe(3);

    store.removeProjectSessions("p1");

    expect(store.sessionCount).toBe(1); // p1 の 2 セッションだけが消えた
    const views = store.displaySessions(projects);
    expect(views["p1"]).toBeUndefined();
    expect(views["p2"]?.sessionId).toBe("s3"); // p2 は状態ごと保持
    expect(views["p2"]?.state).toBe("confirm");
  });

  it("ステータスバー件数が除去後の状態を反映する（V-13 のロジック整合）", () => {
    const store = seededStore();
    expect(store.counts(projects).total).toBe(2); // 表示は最新セッションのみ（p1=s2, p2=s3）

    store.removeProjectSessions("p1");

    const c = store.counts(projects);
    expect(c.total).toBe(1);
    expect(c.confirm).toBe(1);
    expect(c.running).toBe(0);
    expect(c.done).toBe(0);
  });

  it("セッションを消したときは changed を発火し、対象なしのときは発火しない", () => {
    const store = seededStore();
    let changed = 0;
    store.on("changed", () => (changed += 1));

    store.removeProjectSessions("p1");
    expect(changed).toBe(1);

    store.removeProjectSessions("p1"); // 既に空 → 無変化なので通知しない
    store.removeProjectSessions("p-unknown");
    expect(changed).toBe(1);
  });

  it("除去後に同一 session_id のイベントが来れば新規セッションとして再登録できる（再登録シナリオ）", () => {
    const store = seededStore();
    store.removeProjectSessions("p1");

    const result = store.applyEvent(evt("Stop", "s1", "C:/dev/zaiko-app"), projects);
    expect(result).not.toBeNull();
    expect(store.sessionCount).toBe(2);
    expect(store.displaySessions(projects)["p1"]?.state).toBe("done");
  });
});
