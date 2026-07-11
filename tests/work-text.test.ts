/**
 * 260712 課題B: タイルの「現在の作業テキスト」表示のロジックテスト。
 *
 * データソース調査（2026-07-12 実測）:
 * - UserPromptSubmit hook の stdin JSON に prompt フィールドが実在することを
 *   実 claude セッション（sandbox プロジェクト＋ダンプ hook）で確認済み。
 * - ターミナルのオレンジ表示（スピナー行「✳ …中… (14m 2s · ↓ 37.1k tokens)」）は
 *   TUI 描画のみで hook payload / transcript JSONL のどちらにも存在しない
 *   → 取得可能な最善の実データ = 最新 prompt を表示する。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { createEventServer, type EventServer } from "../src/main/event-server";
import { extractWorkText, StateStore, validateEvent, WORK_TEXT_MAX, type HookEvent } from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-11T00:00:00Z" };
}

const projects = [project("p1", "C:\\dev\\zaiko-app")];

function evt(name: HookEvent["hook_event_name"], extra: Partial<HookEvent> = {}): HookEvent {
  return { hook_event_name: name, session_id: "s1", cwd: "C:\\dev\\zaiko-app", ...extra };
}

describe("extractWorkText（prompt → タイル表示テキストの整形）", () => {
  it("前後空白を除去しそのまま返す", () => {
    expect(extractWorkText("  Yahooカテゴリ反映ボタンを追加して  ")).toBe("Yahooカテゴリ反映ボタンを追加して");
  });

  it("改行・タブ・連続空白は単一スペースへ畳む（タイルは 1 行表示のため）", () => {
    expect(extractWorkText("フォーマット紐付けを実装して。\n\n仕様は docs\t参照")).toBe(
      "フォーマット紐付けを実装して。 仕様は docs 参照"
    );
  });

  it(`長文は ${WORK_TEXT_MAX} 文字で打ち切り「…」を付ける`, () => {
    const long = "あ".repeat(WORK_TEXT_MAX + 50);
    const result = extractWorkText(long);
    expect(result).toBe("あ".repeat(WORK_TEXT_MAX) + "…");
  });

  it(`ちょうど ${WORK_TEXT_MAX} 文字は省略しない（境界値）`, () => {
    const exact = "い".repeat(WORK_TEXT_MAX);
    expect(extractWorkText(exact)).toBe(exact);
  });

  it("空・空白のみ・undefined は undefined（UI は非表示フォールバック）", () => {
    expect(extractWorkText("")).toBeUndefined();
    expect(extractWorkText("   \n\t ")).toBeUndefined();
    expect(extractWorkText(undefined)).toBeUndefined();
  });
});

describe("validateEvent が prompt フィールドを受理・保持する", () => {
  it("prompt が文字列なら event に取り込む", () => {
    const r = validateEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      cwd: "C:\\dev\\x",
      prompt: "テスト用のプロンプト",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.prompt).toBe("テスト用のプロンプト");
  });

  it("prompt が非文字列でも他が正しければ受理し、prompt は無視する", () => {
    const r = validateEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "C:\\dev\\x", prompt: 123 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.prompt).toBeUndefined();
  });
});

describe("StateStore への配線（UserPromptSubmit の prompt → SessionView.workText）", () => {
  function storeAt(): { store: StateStore; tick: (ms: number) => void } {
    let t = 1_000_000;
    const store = new StateStore(() => t);
    return { store, tick: (ms) => (t += ms) };
  }

  it("UserPromptSubmit の prompt が workText として表示セッションに載る", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", { prompt: "Yahooカテゴリ反映ボタンを追加して" }), projects);
    expect(store.displaySessions(projects)["p1"].workText).toBe("Yahooカテゴリ反映ボタンを追加して");
  });

  it("Stop（完了）後も直前の作業テキストを保持する", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", { prompt: "リファクタして" }), projects);
    tick(1_000);
    store.applyEvent(evt("Stop"), projects);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("done");
    expect(view.workText).toBe("リファクタして");
  });

  it("prompt の無い UserPromptSubmit は既存の workText を維持する（消さない）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", { prompt: "作業A" }), projects);
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit"), projects); // prompt 欠落（古い hook 形式等）
    expect(store.displaySessions(projects)["p1"].workText).toBe("作業A");
  });

  it("prompt を一度も受けていないセッションの workText は undefined（UI 非表示フォールバック）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop"), projects);
    expect(store.displaySessions(projects)["p1"].workText).toBeUndefined();
  });

  it("新しいプロンプトで workText が置き換わる", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", { prompt: "作業A" }), projects);
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit", { prompt: "作業B" }), projects);
    expect(store.displaySessions(projects)["p1"].workText).toBe("作業B");
  });
});

describe("HTTP 統合（event-server → StateStore → workText。hooks と同一経路の実データ配線）", () => {
  let server: EventServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("POST UserPromptSubmit（日本語 prompt）が workText として表示に反映される", async () => {
    let t = 1_000_000;
    const store = new StateStore(() => t++);
    server = createEventServer({
      port: 0,
      onEvent: (e) => store.applyEvent(e, projects),
    });
    const addr = await server.listen();
    const res = await fetch(`http://127.0.0.1:${addr.port}/terminal-app/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "s-http-work",
        cwd: "C:\\dev\\zaiko-app",
        prompt: "フォーマット紐付けを実装して",
      }),
    });
    expect(res.status).toBe(204);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.workText).toBe("フォーマット紐付けを実装して");
  });
});
