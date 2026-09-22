/**
 * 260922_10: タスク名（taskTitle）の反映と、自動リネーム・タスク名読み取りの対象取り出し。
 * タスク名は状態に依存しない（実行中でも完了でも残る）。保存・復元でも往復する。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-22T00:00:00Z" }];
const evt = (name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: name,
  session_id: sessionId,
  cwd: "C:/dev/app",
  transcript_path: `C:/t/${sessionId}.jsonl`,
  ...extra,
});

describe("applyTaskTitle", () => {
  it("付けると view に出る。同じ値は無変化。undefined で消える", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.applyTaskTitle("s1", "確認待ち左上配置")).toBe(true);
    expect(store.displaySessions(projects)["p1"].taskTitle).toBe("確認待ち左上配置");
    expect(store.applyTaskTitle("s1", "確認待ち左上配置")).toBe(false);
    expect(fired).toBe(1);
    expect(store.applyTaskTitle("s1", undefined)).toBe(true);
    expect(store.displaySessions(projects)["p1"].taskTitle).toBeUndefined();
    expect(store.applyTaskTitle("nope", "x")).toBe(false);
  });

  it("状態が変わっても残る（タスク名は状態と無関係）", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    store.applyTaskTitle("s1", "月次レポート作成");
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].taskTitle).toBe("月次レポート作成");
    expect(store.markDisconnected("s1")).toBe(false); // 完了には効かない（既存仕様の確認）
  });

  it("保存 → 取り込みで往復する", () => {
    const a = new StateStore(() => 1000);
    a.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    a.applyTaskTitle("s1", "タスク名");
    const b = new StateStore(() => 2000);
    b.importSessions(a.exportSessions());
    expect(b.displaySessions(projects)["p1"].taskTitle).toBe("タスク名");
  });
});

describe("transcriptSessions / taskTitles", () => {
  it("transcript を持つ生存セッションを返す（終了済みは除く）", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s2", { prompt: "y" }), projects);
    expect(store.transcriptSessions().map((r) => r.sessionId)).toEqual(["s1", "s2"]);
    store.setDead("s2", true);
    expect(store.transcriptSessions().map((r) => r.sessionId)).toEqual(["s1"]);
  });

  it("タスク名を持つセッションだけを返す（自動リネームの材料）", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s2", { prompt: "y" }), projects);
    store.applyTaskTitle("s1", "在庫の棚卸し");
    expect(store.taskTitles()).toEqual([{ sessionId: "s1", projectId: "p1", taskTitle: "在庫の棚卸し" }]);
  });
});
