/**
 * state-store の単体テスト。
 * - 受信スキーマ検証（design.md 4.8 / 持ち越し課題1）
 * - イベント → 状態マッピング（design.md 4.3。spec.md AC-04 / AC-05 / AC-16）
 * - 状態遷移表（design.md 5.1。verification.md 4 章 T-1〜T-7, T-10）
 * - cwd → プロジェクト最長一致（design.md 4.7）
 * - ステータスバー件数（REQ-10 / V-13 のロジック部分）
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import {
  classifyNotification,
  mapEventToState,
  matchProjectByCwd,
  StateStore,
  validateEvent,
  type HookEvent,
} from "../src/main/state-store";

function project(id: string, p: string): Project {
  return { id, name: p.split("\\").pop() ?? p, path: p, clickTarget: "cursor", registeredAt: "2026-07-11T00:00:00Z" };
}

const projects = [
  project("p1", "C:\\dev\\zaiko-app"),
  project("p2", "C:\\dev\\zaiko-app\\sub-module"),
  project("p3", "C:\\dev\\other"),
];

function evt(
  name: HookEvent["hook_event_name"],
  sessionId = "s1",
  cwd = "C:\\dev\\other",
  extra: Partial<HookEvent> = {}
): HookEvent {
  return { hook_event_name: name, session_id: sessionId, cwd, ...extra };
}

describe("validateEvent（design.md 4.8: 必須フィールドと不正 JSON の判定条件）", () => {
  it("必須フィールドが揃っていれば受理する", () => {
    const r = validateEvent({ hook_event_name: "Stop", session_id: "s1", cwd: "C:\\dev\\x" });
    expect(r.ok).toBe(true);
  });

  it.each(["hook_event_name", "session_id", "cwd"])("必須フィールド %s の欠落は不正", (field) => {
    const payload: Record<string, unknown> = { hook_event_name: "Stop", session_id: "s1", cwd: "C:\\dev\\x" };
    delete payload[field];
    expect(validateEvent(payload).ok).toBe(false);
  });

  it("未知の hook_event_name は不正（破棄対象）", () => {
    expect(validateEvent({ hook_event_name: "Unknown", session_id: "s", cwd: "c" }).ok).toBe(false);
  });

  it("オブジェクト以外・空文字は不正", () => {
    expect(validateEvent(null).ok).toBe(false);
    expect(validateEvent([1, 2]).ok).toBe(false);
    expect(validateEvent("Stop").ok).toBe(false);
    expect(validateEvent({ hook_event_name: "Stop", session_id: "", cwd: "c" }).ok).toBe(false);
  });
});

describe("mapEventToState（design.md 4.3 / 4.8 の表どおり）", () => {
  it("Stop → 完了（無条件。AC-04）", () => {
    expect(mapEventToState(evt("Stop"))).toBe("done");
  });

  it("Notification → 確認待ち（許可要求・入力待ち・その他いずれも。AC-05 / 安全側）", () => {
    expect(mapEventToState(evt("Notification", "s", "c", { message: "Claude needs your permission to use Bash" }))).toBe("confirm");
    expect(mapEventToState(evt("Notification", "s", "c", { message: "Claude is waiting for your input" }))).toBe("confirm");
    expect(mapEventToState(evt("Notification", "s", "c", { message: "something else" }))).toBe("confirm");
    expect(mapEventToState(evt("Notification"))).toBe("confirm");
  });

  it("UserPromptSubmit → 実行中（OPEN-04 案 A の受信側対応）", () => {
    expect(mapEventToState(evt("UserPromptSubmit"))).toBe("running");
  });

  it("SessionEnd: 正常終了 reason は破棄（null）・それ以外はエラー相当（design.md 4.8 / V-16 / AC-16）", () => {
    expect(mapEventToState(evt("SessionEnd", "s", "c", { reason: "clear" }))).toBe(null);
    expect(mapEventToState(evt("SessionEnd", "s", "c", { reason: "logout" }))).toBe(null);
    expect(mapEventToState(evt("SessionEnd", "s", "c", { reason: "prompt_input_exit" }))).toBe(null);
    expect(mapEventToState(evt("SessionEnd", "s", "c", { reason: "other" }))).toBe("error");
    expect(mapEventToState(evt("SessionEnd"))).toBe("error"); // reason 欠落も安全側でエラー扱い
  });

  it("classifyNotification はログ用の種別分類を返す（遷移はいずれも確認待ち）", () => {
    expect(classifyNotification("Claude needs your permission to use Bash")).toBe("permission");
    expect(classifyNotification("Claude is waiting for your input")).toBe("idle");
    expect(classifyNotification("hello")).toBe("other");
    expect(classifyNotification(undefined)).toBe("other");
  });
});

describe("matchProjectByCwd（design.md 4.7: 最長一致プレフィックス）", () => {
  it("完全一致・サブディレクトリ一致（親プロジェクトへ割り当て）", () => {
    expect(matchProjectByCwd("C:\\dev\\zaiko-app", projects)?.id).toBe("p1");
    expect(matchProjectByCwd("C:\\dev\\zaiko-app\\src\\deep", projects)?.id).toBe("p1");
  });

  it("ネストしたプロジェクトは最長一致を優先する", () => {
    expect(matchProjectByCwd("C:\\dev\\zaiko-app\\sub-module\\x", projects)?.id).toBe("p2");
  });

  it("大文字小文字非区別・スラッシュ区切りも一致する", () => {
    expect(matchProjectByCwd("c:\\DEV\\ZAIKO-APP", projects)?.id).toBe("p1");
    expect(matchProjectByCwd("C:/dev/zaiko-app/src", projects)?.id).toBe("p1");
  });

  it("前方一致でもディレクトリ境界が違えば一致しない（zaiko-app-2 と zaiko-app は別）", () => {
    expect(matchProjectByCwd("C:\\dev\\zaiko-app-2", projects)).toBe(null);
  });

  it("どのプロジェクトにも一致しない cwd は null（破棄対象。design.md 10 章）", () => {
    expect(matchProjectByCwd("D:\\somewhere\\else", projects)).toBe(null);
  });
});

describe("StateStore 状態遷移（design.md 5.1 / verification.md 4 章）", () => {
  function storeAt(): { store: StateStore; tick: (ms: number) => void } {
    let t = 1_000_000;
    const store = new StateStore(() => t);
    return {
      store,
      tick: (ms) => {
        t += ms;
      },
    };
  }

  it("T-1: 待機 → Stop = 完了", () => {
    const { store } = storeAt();
    const r = store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    expect(r?.state).toBe("done");
    expect(r?.projectId).toBe("p3");
  });

  it("T-2: 待機 → Notification = 確認待ち", () => {
    const { store } = storeAt();
    expect(store.applyEvent(evt("Notification", "s1", "C:\\dev\\other"), projects)?.state).toBe("confirm");
  });

  it("T-3: 完了 → Notification = 確認待ちへ上書き（緑→アンバー）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    tick(1000);
    expect(store.applyEvent(evt("Notification", "s1", "C:\\dev\\other"), projects)?.state).toBe("confirm");
  });

  it("T-4: 確認待ち → Stop = 完了（許可後に完走）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Notification", "s1", "C:\\dev\\other"), projects);
    tick(1000);
    expect(store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects)?.state).toBe("done");
  });

  it("T-5: 完了 → Stop 再発火 = 状態維持で時刻のみ更新", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    const t1 = store.displaySessions(projects)["p3"].lastEventAt;
    tick(5000);
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    const view = store.displaySessions(projects)["p3"];
    expect(view.state).toBe("done");
    expect(view.lastEventAt).toBe(t1 + 5000);
  });

  it("T-6: エラー → Stop = 完了へ復帰する", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("SessionEnd", "s1", "C:\\dev\\other", { reason: "other" }), projects);
    expect(store.displaySessions(projects)["p3"].state).toBe("error");
    tick(1000);
    expect(store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects)?.state).toBe("done");
  });

  it("実行中への遷移で経過時間の起点を記録し、継続では起点を維持する（design.md 5.1）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:\\dev\\other"), projects);
    const since1 = store.displaySessions(projects)["p3"].runningSince;
    expect(since1).toBeDefined();
    tick(3000);
    store.applyEvent(evt("UserPromptSubmit", "s1", "C:\\dev\\other"), projects); // 実行中（継続）
    expect(store.displaySessions(projects)["p3"].runningSince).toBe(since1);
    tick(1000);
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    expect(store.displaySessions(projects)["p3"].runningSince).toBeUndefined();
  });

  it("T-7: 同一プロジェクト 2 セッションは最終イベントが新しい方を表示（design.md 5.2 / spec.md 5.4）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    tick(1000);
    store.applyEvent(evt("Notification", "s2", "C:\\dev\\other"), projects);
    expect(store.displaySessions(projects)["p3"].state).toBe("confirm");
    expect(store.displaySessions(projects)["p3"].sessionId).toBe("s2");
  });

  it("未登録 cwd のイベントは破棄される（null を返し状態を作らない）", () => {
    const { store } = storeAt();
    expect(store.applyEvent(evt("Stop", "s1", "D:\\unknown"), projects)).toBe(null);
    expect(store.sessionCount).toBe(0);
  });

  it("正常 SessionEnd は状態を変えない（破棄・ログのみ）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    tick(1000);
    expect(store.applyEvent(evt("SessionEnd", "s1", "C:\\dev\\other", { reason: "clear" }), projects)).toBe(null);
    expect(store.displaySessions(projects)["p3"].state).toBe("done");
  });

  it("ステータスバー件数: 状態別件数と総数（REQ-10 / V-13 のロジック）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "sA", "C:\\dev\\zaiko-app"), projects); // p1: running
    tick(10);
    store.applyEvent(evt("Stop", "sB", "C:\\dev\\zaiko-app\\sub-module"), projects); // p2: done
    tick(10);
    store.applyEvent(evt("Notification", "sC", "C:\\dev\\other"), projects); // p3: confirm
    expect(store.counts(projects)).toEqual({ running: 1, done: 1, confirm: 1, error: 0, total: 3 });
  });

  it("T-10: resetAll で全セッションが消える（揮発仕様 = 再起動後は全タイル待機）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    store.resetAll();
    expect(store.sessionCount).toBe(0);
    expect(store.displaySessions(projects)).toEqual({});
  });

  it("登録解除済みプロジェクトのセッションは表示から外れる", () => {
    const { store } = storeAt();
    store.applyEvent(evt("Stop", "s1", "C:\\dev\\other"), projects);
    const withoutP3 = projects.filter((p) => p.id !== "p3");
    expect(store.displaySessions(withoutP3)).toEqual({});
    expect(store.counts(withoutP3).total).toBe(0);
  });
});
