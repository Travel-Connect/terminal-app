/**
 * OPEN-04 案 A 採用（2026-07-11）: UserPromptSubmit → 「実行中」遷移の追加テスト。
 * 要件対応:
 * - criteria (c) / design.md 5.1 遷移表: 全状態（待機・実行中・確認待ち・完了・エラー）から
 *   実行開始（UserPromptSubmit）で「実行中」へ遷移すること
 * - criteria (d): runningSince（経過時間の起点）が設定され、継続では維持されること
 * - criteria tests_evidence: HTTP 擬似注入（実ソケット POST）で「実行中」へ遷移すること
 *   （task.md「プロンプトを送信しても何も変わらない」の解消を受信経路ごと固める）
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { createEventServer, type EventServer } from "../src/main/event-server";
import { StateStore, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-11T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\zaiko-app")];

function evt(name: HookEvent["hook_event_name"], extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: "s1", cwd: "C:\\dev\\zaiko-app", ...extra };
}

function storeAt(): { store: StateStore; tick: (ms: number) => void; now: () => number } {
  let t = 1_000_000;
  const store = new StateStore(() => t);
  return { store, tick: (ms) => (t += ms), now: () => t };
}

describe("UserPromptSubmit → 実行中（design.md 5.1 遷移表の「実行開始」列を全状態から検証）", () => {
  it("待機（未受信セッション）→ 実行中。runningSince が受信時刻になる", () => {
    const { store, now } = storeAt();
    const r = store.applyEvent(evt("UserPromptSubmit"), projects);
    expect(r?.state).toBe("running");
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.runningSince).toBe(now());
  });

  it("完了 → 実行中（完了後に新しいプロンプトを送信 = task.md の実利用シナリオ）", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("Stop"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
    tick(60_000);
    expect(store.applyEvent(evt("UserPromptSubmit"), projects)?.state).toBe("running");
    const view = store.displaySessions(projects)["p1"];
    expect(view.runningSince).toBe(now()); // 経過時間は新しい実行の開始時刻から
  });

  it("確認待ち → 実行中（許可後の再開。design.md 5.1）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Notification", { message: "Claude needs your permission to use Bash" }), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("confirm");
    tick(1000);
    expect(store.applyEvent(evt("UserPromptSubmit"), projects)?.state).toBe("running");
  });

  it("エラー → 実行中（design.md 5.1）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("SessionEnd", { reason: "other" }), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("error");
    tick(1000);
    expect(store.applyEvent(evt("UserPromptSubmit"), projects)?.state).toBe("running");
  });

  it("実行中 → 実行中（継続）: runningSince（経過時間の起点）を維持する", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit"), projects);
    const since = now();
    tick(90_000);
    store.applyEvent(evt("UserPromptSubmit"), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.runningSince).toBe(since); // 起点維持（1:30 経過として表示され続ける）
  });

  it("実行中になるとステータスバー件数（counts）に running として反映される（REQ-10）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit"), projects);
    expect(store.counts(projects)).toEqual({ running: 1, done: 0, confirm: 0, error: 0, total: 1 });
  });
});

describe("HTTP 擬似注入 → 実行中（統合: event-server → StateStore。criteria tests_evidence）", () => {
  let server: EventServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("POST UserPromptSubmit が 204 で受理され、該当プロジェクトが実行中になる", async () => {
    const { store } = storeAt();
    server = createEventServer({
      port: 0, // 空きポート（テスト安定性）
      onEvent: (e) => store.applyEvent(e, projects),
    });
    const addr = await server.listen();
    const res = await fetch(`http://127.0.0.1:${addr.port}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "s-http-01",
        cwd: "C:\\dev\\zaiko-app\\sub", // サブディレクトリ起動も親プロジェクトへ対応付け（design.md 4.7）
      }),
    });
    expect(res.status).toBe(204);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.runningSince).toBeDefined();
  });
});
