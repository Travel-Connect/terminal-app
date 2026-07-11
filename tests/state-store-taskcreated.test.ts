/**
 * 260712_3: TaskCreated hook → task_subject をタイルの作業テキストに出す機能のテスト。
 *
 * payload 形は 2026-07-12 に実 claude 2.1.207 の hook stdin ダンプで実測確認:
 *   { session_id, transcript_path, cwd, prompt_id, hook_event_name: "TaskCreated",
 *     task_id, task_subject, task_description }
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { mapEventToState, StateStore, validateEvent, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-12T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\terminal-app")];

function evt(name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:\\dev\\terminal-app", ...extra };
}

function storeAt(): { store: StateStore; tick: (ms: number) => void } {
  let t = 1_000_000;
  const store = new StateStore(() => t);
  return { store, tick: (ms) => (t += ms) };
}

describe("validateEvent: TaskCreated の受理", () => {
  it("実測 payload 形の TaskCreated を受理し task_subject を保持する", () => {
    const result = validateEvent({
      session_id: "4b446a25-edb9-48ed-979b-78cb88255f79",
      transcript_path: "C:\\Users\\x\\.claude\\projects\\C--dev-terminal-app\\4b446a25.jsonl",
      cwd: "C:\\dev\\terminal-app",
      prompt_id: "039cc74d",
      hook_event_name: "TaskCreated",
      task_id: "1",
      task_subject: "フォーマット紐付けを実装",
      task_description: "フォーマット紐付け機能を実装する",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.hook_event_name).toBe("TaskCreated");
      expect(result.event.task_subject).toBe("フォーマット紐付けを実装");
    }
  });

  it("task_subject が文字列でない場合はフィールドを落として受理する（イベント自体は有効）", () => {
    const result = validateEvent({ hook_event_name: "TaskCreated", session_id: "s", cwd: "C:\\dev", task_subject: 123 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.task_subject).toBeUndefined();
  });
});

describe("mapEventToState: TaskCreated → 実行中", () => {
  it("タスク作成は作業中にしか起きないため実行中へマップする", () => {
    expect(mapEventToState(evt("TaskCreated", "s1", { task_subject: "x" }))).toBe("running");
  });
});

describe("applyEvent: TaskCreated による作業テキスト更新", () => {
  it("task_subject がタイルの workText に反映される", () => {
    const { store } = storeAt();
    store.applyEvent(evt("TaskCreated", "s1", { task_subject: "フォーマット紐付けを実装" }), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.workText).toBe("フォーマット紐付けを実装");
  });

  it("実行中セッションに TaskCreated が来ても経過時間の起点（runningSince）は維持される", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "作業して" }), projects);
    const before = store.displaySessions(projects)["p1"].runningSince;
    tick(60_000);
    store.applyEvent(evt("TaskCreated", "s1", { task_subject: "サブタスク A" }), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.runningSince).toBe(before); // 実行継続 = 起点維持（design.md 5.1）
    expect(view.workText).toBe("サブタスク A"); // prompt より新しいタスク件名で上書き
  });

  it("task_subject が空・空白のみなら既存の workText を維持する", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "元の依頼" }), projects);
    store.applyEvent(evt("TaskCreated", "s1", { task_subject: "   " }), projects);
    expect(store.displaySessions(projects)["p1"].workText).toBe("元の依頼");
  });

  it("完了後に TaskCreated が来たら実行中へ戻る（作業再開の検知）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    tick(1_000);
    store.applyEvent(evt("TaskCreated", "s1", { task_subject: "次のタスク" }), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.workText).toBe("次のタスク");
  });

  it("未登録プロジェクトの TaskCreated は破棄される（既存イベントと同じ規則）", () => {
    const { store } = storeAt();
    const result = store.applyEvent(
      { hook_event_name: "TaskCreated", session_id: "s1", cwd: "C:\\dev\\unregistered", task_subject: "x" },
      projects
    );
    expect(result).toBeNull();
  });

  it("80 文字を超える task_subject は既存の整形規則（省略）が適用される", () => {
    const { store } = storeAt();
    store.applyEvent(evt("TaskCreated", "s1", { task_subject: "あ".repeat(100) }), projects);
    const work = store.displaySessions(projects)["p1"].workText ?? "";
    expect(work.length).toBe(81); // 80 文字 + 省略記号
    expect(work.endsWith("…")).toBe(true);
  });
});
