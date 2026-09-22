/**
 * 260922_6: タイル名と作業内容の不一致の印（nameHint）と、その判定対象の取り出し（workTextSessions）。
 * 印は状態に依存しない（実行中でも完了でも残る）。表示名を直したら呼び出し側が clearNameHints で消す。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [
  { id: "p1", name: "dev", path: "C:/dev/app1", clickTarget: "cursor", registeredAt: "2026-09-22T00:00:00Z" },
  { id: "p2", name: "別アプリ", path: "C:/dev/app2", clickTarget: "cursor", registeredAt: "2026-09-22T00:00:00Z" },
];
const evt = (name: HookEvent["hook_event_name"], sessionId: string, cwd: string, extra: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: name,
  session_id: sessionId,
  cwd,
  ...extra,
});

describe("workTextSessions", () => {
  it("作業テキストを持つ生存セッションだけを返す", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:/dev/app1", { prompt: "在庫の発注点を再計算して" }), projects);
    store.applyEvent(evt("Stop", "s2", "C:/dev/app2"), projects); // 作業テキスト無し
    expect(store.workTextSessions()).toEqual([{ sessionId: "s1", projectId: "p1", workText: "在庫の発注点を再計算して" }]);
    store.setDead("s1", true);
    expect(store.workTextSessions()).toEqual([]);
  });

  it("完了したセッションも対象（名前の見直しは状態に関係ない）", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:/dev/app1", { prompt: "在庫の発注点を再計算して" }), projects);
    store.applyEvent(evt("Stop", "s1", "C:/dev/app1"), projects);
    expect(store.workTextSessions().map((s) => s.sessionId)).toEqual(["s1"]);
  });
});

describe("applyNameHint / clearNameHints", () => {
  it("印を付けると view に出る。同じ値は無変化。undefined で消える", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:/dev/app1", { prompt: "x" }), projects);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.applyNameHint("s1", "名前が作業を表していません")).toBe(true);
    expect(store.displaySessions(projects)["p1"].nameHint).toBe("名前が作業を表していません");
    expect(store.applyNameHint("s1", "名前が作業を表していません")).toBe(false);
    expect(fired).toBe(1);
    expect(store.applyNameHint("s1", undefined)).toBe(true);
    expect(store.displaySessions(projects)["p1"].nameHint).toBeUndefined();
    expect(store.applyNameHint("nope", "x")).toBe(false);
  });

  it("状態が変わっても残る（実行中 → 完了 → 確認待ち）", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:/dev/app1", { prompt: "x" }), projects);
    store.applyNameHint("s1", "名前と作業が一致しません");
    store.applyEvent(evt("Stop", "s1", "C:/dev/app1"), projects);
    expect(store.displaySessions(projects)["p1"].nameHint).toBe("名前と作業が一致しません");
    store.applyEvent(evt("Notification", "s1", "C:/dev/app1", { message: "perm" }), projects);
    expect(store.displaySessions(projects)["p1"].nameHint).toBe("名前と作業が一致しません");
  });

  it("clearNameHints は指定プロジェクトの全セッションから消す（他プロジェクトは残す）", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:/dev/app1", { prompt: "x" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s2", "C:/dev/app1", { prompt: "y" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s3", "C:/dev/app2", { prompt: "z" }), projects);
    store.applyNameHint("s1", "名前が作業を表していません");
    store.applyNameHint("s2", "名前が作業を表していません");
    store.applyNameHint("s3", "名前が作業を表していません");
    expect(store.clearNameHints("p1")).toBe(true);
    expect(store.clearNameHints("p1")).toBe(false); // 消すものが無ければ false
    const views = store.displaySessions(projects);
    expect(views["p1"].nameHint).toBeUndefined();
    expect(views["p2"].nameHint).toBe("名前が作業を表していません");
  });
});
