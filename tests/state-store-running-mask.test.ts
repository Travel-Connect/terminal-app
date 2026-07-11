/**
 * 260712 課題A の回帰テスト: 「タイルは完了表示なのに実セッションはまだ動いている」バグ。
 *
 * 実ログ（%APPDATA%\terminal-app\logs\app.log 2026-07-11）で確認された再現経路:
 *   14:24:31 UserPromptSubmit → running (project=p-43d5, session=e7707b33…)  ← 長時間セッション
 *   14:26:11 UserPromptSubmit → running (project=p-43d5, session=474e89e3…)  ← 別の短命セッション
 *   14:26:15 Stop → done            (project=p-43d5, session=474e89e3…)
 *   → 旧規則（無条件で最終イベント優先）ではタイルが「完了」になるが、
 *     e7707b33 は 15:09 の Stop まで実行継続中だった（スクリーンショット 20260711233456 の
 *     「完了・8分前」対「Puttering… 35m41s」）。
 *
 * 修正: displaySessions は「実行中」セッションを最優先し、同順位内で最終イベント優先とする。
 * 併せて、正常 SessionEnd で「実行中」のまま終了したセッションの記録は破棄する
 * （破棄しないと実在しない「実行中」が優先表示され続けるため）。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-11T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\terminal-app")];

function evt(
  name: HookEvent["hook_event_name"],
  sessionId: string,
  extra: Partial<HookEvent> = {}
): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd: "C:\\dev\\terminal-app", ...extra };
}

function storeAt(): { store: StateStore; tick: (ms: number) => void } {
  let t = 1_000_000;
  const store = new StateStore(() => t);
  return { store, tick: (ms) => (t += ms) };
}

describe("実行中セッションの優先表示（260712 課題A: 完了なのに実行中バグの回帰）", () => {
  it("再現ケース: 実行中セッションの後に別セッションの Stop が来ても「実行中」を表示し続ける", () => {
    const { store, tick } = storeAt();
    // 長時間セッション（実ログの e7707b33 相当）が実行開始
    store.applyEvent(evt("UserPromptSubmit", "s-long"), projects);
    tick(100_000);
    // 短命セッション（実ログの 474e89e3 相当）が同じプロジェクトで開始 → 4 秒で完了
    store.applyEvent(evt("UserPromptSubmit", "s-short"), projects);
    tick(4_000);
    store.applyEvent(evt("Stop", "s-short"), projects);
    // 旧規則ではここで「完了」（s-short）になっていた。修正後は実行継続中の s-long を表示する
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.sessionId).toBe("s-long");
    expect(store.counts(projects)).toEqual({ running: 1, done: 0, confirm: 0, error: 0, total: 1 });
  });

  it("別セッションの Notification / エラーも実行中セッションを覆い隠さない", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s-long"), projects);
    tick(1_000);
    store.applyEvent(evt("Notification", "s-other", { message: "Claude needs your permission" }), projects);
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s-long");
    tick(1_000);
    store.applyEvent(evt("SessionEnd", "s-other2", { reason: "other" }), projects); // エラー相当
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
  });

  it("実行中セッション同士は最終イベントが新しい方を表示する（同順位内は従来規則）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s-a"), projects);
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit", "s-b"), projects);
    expect(store.displaySessions(projects)["p1"].sessionId).toBe("s-b");
  });

  it("正常な完了遷移は壊れない: 実行中セッション自身の Stop で「完了」になる", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s-long"), projects);
    tick(60_000);
    store.applyEvent(evt("Stop", "s-long"), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("done");
    expect(view.sessionId).toBe("s-long");
  });

  it("実行中でないセッション同士は従来どおり最終イベント優先（T-7 の規則を維持）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s-1"), projects);
    tick(1_000);
    store.applyEvent(evt("Notification", "s-2"), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("confirm");
    expect(view.sessionId).toBe("s-2");
  });

  it("動作再開で実行中へ戻る: 覆い隠しが起きた後でも UserPromptSubmit で実行中表示になる", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s-short"), projects); // 完了表示
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit", "s-long"), projects); // 実セッションの活動
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
  });
});

describe("正常 SessionEnd と実行中記録の整理（幽霊実行中の防止）", () => {
  it("実行中のまま正常終了（Stop なし）したセッションの記録は破棄される", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s-long"), projects);
    tick(1_000);
    const r = store.applyEvent(evt("SessionEnd", "s-long", { reason: "prompt_input_exit" }), projects);
    expect(r?.discardedRunning).toBe(true);
    expect(store.sessionCount).toBe(0);
    expect(store.displaySessions(projects)["p1"]).toBeUndefined(); // タイルは「待機」へ
  });

  it("破棄後は残っている別セッションの状態が表示される（実行中の固定を防ぐ）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s-done"), projects);
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit", "s-run"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
    tick(1_000);
    store.applyEvent(evt("SessionEnd", "s-run", { reason: "exit" }), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("done"); // s-done へフォールバック
  });

  it("完了・確認待ちセッションへの正常 SessionEnd は従来どおり何も変えない（null 破棄）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s-1"), projects);
    tick(1_000);
    expect(store.applyEvent(evt("SessionEnd", "s-1", { reason: "clear" }), projects)).toBe(null);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
  });

  it("未知セッションへの正常 SessionEnd も従来どおり null 破棄", () => {
    const { store } = storeAt();
    expect(store.applyEvent(evt("SessionEnd", "s-unknown", { reason: "exit" }), projects)).toBe(null);
    expect(store.sessionCount).toBe(0);
  });
});
