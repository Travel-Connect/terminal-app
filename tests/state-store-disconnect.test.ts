/**
 * 260712_2: 切断ステータスの状態遷移テスト。
 * - markDisconnected は「実行中」だけを「切断」へ遷移させる（イベント由来の確定状態を上書きしない）
 * - 切断後にイベントが届けば通常の遷移で自己回復する（誤検知のセルフヒール）
 * - reviveSession（再接続）は hook の方が新しい記録を上書きしない
 * - counts の disconnected キーは 1 件以上のときだけ付く（既存期待値との互換）
 *
 * 対応する認識合わせ（2026-07-12 ユーザー回答）: 切断 = transcript 途絶＋ウィンドウ消失の併用判定、
 * 再接続 = 右クリックの手動操作で transcript 走査により復元。
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

function storeAt(): { store: StateStore; tick: (ms: number) => void; now: () => number } {
  let t = 1_000_000;
  const store = new StateStore(() => t);
  return { store, tick: (ms) => (t += ms), now: () => t };
}

describe("markDisconnected（切断への遷移）", () => {
  it("実行中セッションを「切断」へ遷移させ、lastEventAt を検知時刻に更新する", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    tick(300_000);
    expect(store.markDisconnected("s1")).toBe(true);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("disconnected");
    expect(view.lastEventAt).toBe(now()); // 「切断・N分前」の起点 = 検知時点
    expect(view.runningSince).toBeUndefined();
  });

  it("実行中以外（完了等）や未知セッションは遷移させない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.markDisconnected("s1")).toBe(false); // done を上書きしない
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
    expect(store.markDisconnected("no-such-session")).toBe(false);
  });

  it("切断後にイベントが届けば通常遷移で自己回復する（誤検知のセルフヒール）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.markDisconnected("s1");
    tick(1_000);
    // 長時間ツールの完了後に Stop が届いたケース: 切断（誤検知）→ 完了へ
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
    // 新しいプロンプト送信で実行中にも戻れる
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
  });

  it("切断セッションは実行中セッションを覆い隠さない（実行中優先の維持）", () => {
    const { store, tick } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s-live"), projects);
    tick(1_000);
    store.applyEvent(evt("UserPromptSubmit", "s-dead"), projects);
    tick(1_000);
    store.markDisconnected("s-dead"); // lastEventAt は s-live より新しくなる
    const view = store.displaySessions(projects)["p1"];
    expect(view.sessionId).toBe("s-live");
    expect(view.state).toBe("running");
  });
});

describe("runningSessions（切断検知の掃引対象）と transcriptPath の保持", () => {
  it("実行中セッションだけを transcriptPath 付きで列挙する", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { transcript_path: "C:\\t\\s1.jsonl" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s2"), projects); // transcript_path 無し
    store.applyEvent(evt("UserPromptSubmit", "s3", { transcript_path: "C:\\t\\s3.jsonl" }), projects);
    store.applyEvent(evt("Stop", "s3"), projects); // done は対象外
    const targets = store.runningSessions();
    expect(targets.map((t) => t.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(targets.find((t) => t.sessionId === "s1")?.transcriptPath).toBe("C:\\t\\s1.jsonl");
    expect(targets.find((t) => t.sessionId === "s2")?.transcriptPath).toBeUndefined();
  });

  it("後続イベントの transcript_path で保持値が更新される", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { transcript_path: "C:\\t\\old.jsonl" }), projects);
    store.applyEvent(evt("UserPromptSubmit", "s1", { transcript_path: "C:\\t\\new.jsonl" }), projects);
    expect(store.runningSessions()[0].transcriptPath).toBe("C:\\t\\new.jsonl");
  });
});

describe("reviveSession（再接続による復元）", () => {
  it("未知のセッションを「実行中」として復元する（経過時間の起点 = transcript の最終更新）", () => {
    const { store } = storeAt();
    const ok = store.reviveSession({
      sessionId: "s-revived",
      projectId: "p1",
      lastEventAt: 900_000,
      transcriptPath: "C:\\t\\s-revived.jsonl",
      workText: "続きの実装をして",
    });
    expect(ok).toBe(true);
    const view = store.displaySessions(projects)["p1"];
    expect(view.state).toBe("running");
    expect(view.runningSince).toBe(900_000);
    expect(view.workText).toBe("続きの実装をして");
    expect(store.runningSessions()[0].transcriptPath).toBe("C:\\t\\s-revived.jsonl");
  });

  it("hook イベントの方が新しい記録は上書きしない（イベント由来の状態が優先）", () => {
    const { store, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.applyEvent(evt("Stop", "s1"), projects); // now() 時点の done
    const ok = store.reviveSession({
      sessionId: "s1",
      projectId: "p1",
      lastEventAt: now() - 60_000, // transcript の mtime はイベントより古い
      transcriptPath: "C:\\t\\s1.jsonl",
    });
    expect(ok).toBe(false);
    expect(store.displaySessions(projects)["p1"].state).toBe("done");
  });

  it("切断状態のセッションは transcript が新しければ復元される（切断からの手動復帰）", () => {
    const { store, tick, now } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1", { transcript_path: "C:\\t\\s1.jsonl" }), projects);
    tick(300_000);
    store.markDisconnected("s1");
    tick(10_000);
    const ok = store.reviveSession({
      sessionId: "s1",
      projectId: "p1",
      lastEventAt: now() - 5_000, // 検知後も transcript が更新されていた（誤検知）
      transcriptPath: "C:\\t\\s1.jsonl",
    });
    expect(ok).toBe(true);
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
  });
});

describe("counts の disconnected キー（既存期待値との互換）", () => {
  it("切断 0 件のとき disconnected キーを付けない（従来の counts と同形）", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    expect(store.counts(projects)).toEqual({ running: 1, done: 0, confirm: 0, error: 0, total: 1 });
    expect("disconnected" in store.counts(projects)).toBe(false);
  });

  it("切断 1 件以上で disconnected キーが付き、running には数えない", () => {
    const { store } = storeAt();
    store.applyEvent(evt("UserPromptSubmit", "s1"), projects);
    store.markDisconnected("s1");
    expect(store.counts(projects)).toEqual({ running: 0, done: 0, confirm: 0, error: 0, disconnected: 1, total: 1 });
  });
});
