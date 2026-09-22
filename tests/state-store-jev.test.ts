/**
 * 260922_2: Jev 判定の反映（StateStore）のテスト。
 * - markQuestionPending: 完了 → 返答待ち（confirm / confirmKind=question）。その後イベントが来ていたら適用しない
 * - applyDangerText / applyStallText: 状態に合うときだけ付き、値が変わったときだけ changed
 * - 状態遷移（イベント・復帰・切断・終了検知）で印が落ちる（clearJudgeMarks）
 * - setWorkText / workTextOf / snapshotOf: 上書き防止の後追い確定
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-22T00:00:00Z" }];
const evt = (name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: name,
  session_id: sessionId,
  cwd: "C:/dev/app",
  transcript_path: "C:/t/s.jsonl",
  ...extra,
});

function storeAt(t: { v: number }): StateStore {
  return new StateStore(() => t.v);
}

describe("markQuestionPending（完了 → 返答待ち）", () => {
  it("完了のセッションを返答待ち（confirm / question）にし、lastMessage を付け、件数は確認待ちに数える", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Stop", "s1"), projects);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.markQuestionPending("s1", 1000)).toBe(true);
    const v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("confirm");
    expect(v.confirmKind).toBe("question");
    expect(v.lastMessage).toBe("Claude が返答を待っています");
    expect(v.lastEventAt).toBe(1000); // 時刻は Stop のまま（「返答待ち・N分前」の起点 = 止まった時刻）
    expect(fired).toBe(1);
    expect(store.confirmSessions().map((c) => c.sessionId)).toEqual(["s1"]); // 確認待ちからの復帰検知の対象になる
  });

  it("その後にイベントが来ていた（lastEventAt が進んだ）・完了でない・未知は適用しない", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Stop", "s1"), projects);
    t.v = 2000;
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "次" }), projects);
    expect(store.markQuestionPending("s1", 1000)).toBe(false);
    expect(store.displaySessions(projects)["p1"].state).toBe("running");
    expect(store.markQuestionPending("s1", 2000)).toBe(false); // running
    expect(store.markQuestionPending("nope", 2000)).toBe(false);
  });

  it("返答待ちは UserPromptSubmit で実行中へ戻り、種別は消える。resumeFromConfirm でも同様", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Stop", "s1"), projects);
    store.markQuestionPending("s1", 1000);
    t.v = 3000;
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "A" }), projects);
    let v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("running");
    expect(v.confirmKind).toBeUndefined();

    const store2 = storeAt(t);
    store2.applyEvent(evt("Stop", "s2"), projects);
    store2.markQuestionPending("s2", 3000);
    expect(store2.resumeFromConfirm("s2")).toBe(true);
    v = store2.displaySessions(projects)["p1"];
    expect(v.state).toBe("running");
    expect(v.confirmKind).toBeUndefined();
  });
});

describe("confirmKind（Notification は permission）", () => {
  it("Notification 由来の確認待ちは confirmKind=permission。Stop で完了になると消える", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Notification", "s1", { message: "Claude needs your permission to use Bash" }), projects);
    expect(store.displaySessions(projects)["p1"].confirmKind).toBe("permission");
    t.v = 2000;
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].confirmKind).toBeUndefined();
  });
});

describe("applyDangerText（確認待ちの危険度）", () => {
  it("確認待ちにだけ付く。同じ値は無変化。undefined で消える。復帰で落ちる", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Notification", "s1", { message: "perm" }), projects);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.applyDangerText("s1", "取り消せない操作")).toBe(true);
    expect(store.displaySessions(projects)["p1"].dangerText).toBe("取り消せない操作");
    expect(store.applyDangerText("s1", "取り消せない操作")).toBe(false);
    expect(fired).toBe(1);
    expect(store.applyDangerText("s1", undefined)).toBe(true);
    expect(store.displaySessions(projects)["p1"].dangerText).toBeUndefined();
    store.applyDangerText("s1", "外部へ送る操作");
    expect(store.resumeFromConfirm("s1")).toBe(true);
    expect(store.displaySessions(projects)["p1"].dangerText).toBeUndefined();
  });

  it("実行中・完了・未知には付かない", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    expect(store.applyDangerText("s1", "x")).toBe(false);
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.applyDangerText("s1", "x")).toBe(false);
    expect(store.applyDangerText("nope", "x")).toBe(false);
  });
});

describe("applyStallText（停滞の疑い）", () => {
  it("実行中にだけ付く。Stop・切断・終了検知で落ちる", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    expect(store.applyStallText("s1", "停滞の疑い・進展なし")).toBe(true);
    expect(store.displaySessions(projects)["p1"].stallText).toBe("停滞の疑い・進展なし");
    expect(store.applyStallText("s1", "停滞の疑い・進展なし")).toBe(false);
    t.v = 2000;
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.displaySessions(projects)["p1"].stallText).toBeUndefined();
    expect(store.applyStallText("s1", "x")).toBe(false); // 完了には付かない

    const s2 = storeAt(t);
    s2.applyEvent(evt("UserPromptSubmit", "s2", { prompt: "x" }), projects);
    s2.applyStallText("s2", "停滞");
    expect(s2.markDisconnected("s2")).toBe(true);
    expect(s2.displaySessions(projects)["p1"].stallText).toBeUndefined();

    const s3 = storeAt(t);
    s3.applyEvent(evt("UserPromptSubmit", "s3", { prompt: "x" }), projects);
    s3.applyStallText("s3", "停滞");
    expect(s3.markConcluded("s3")).toBe(true);
    expect(s3.displaySessions(projects)["p1"].stallText).toBeUndefined();
  });
});

describe("setWorkText / workTextOf / snapshotOf（作業テキストの後追い確定）", () => {
  it("prompt を伏せて遷移させても前の作業テキストが残り、setWorkText で後から置き換えられる", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "在庫の発注点を再計算して" }), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    expect(store.workTextOf("s1")).toBe("在庫の発注点を再計算して");
    t.v = 2000;
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: undefined }), projects);
    expect(store.displaySessions(projects)["p1"].workText).toBe("在庫の発注点を再計算して");
    expect(store.snapshotOf("s1")).toEqual({ state: "running", lastEventAt: 2000, transcriptPath: "C:/t/s.jsonl", lastMessage: undefined });
    expect(store.setWorkText("s1", "はい")).toBe(true);
    expect(store.displaySessions(projects)["p1"].workText).toBe("はい");
    expect(store.setWorkText("s1", "はい")).toBe(false);
    expect(store.setWorkText("s1", "   ")).toBe(false); // 空は無変化
    expect(store.setWorkText("nope", "x")).toBe(false);
    expect(store.workTextOf("nope")).toBeUndefined();
    expect(store.snapshotOf("nope")).toBeUndefined();
  });
});

describe("questionPendingSessions（260922_4: 返答待ちの復帰判定の対象）", () => {
  it("返答待ち（question）だけを返し、Stop の時刻と返答待ちにした時刻を別々に持つ", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Stop", "s1"), projects);
    store.applyEvent(evt("Notification", "s2", { message: "perm" }), projects); // 権限確認は対象外
    t.v = 5000; // Stop から 4 秒後に返答待ちへ（Jev 判定の待ち時間）
    expect(store.markQuestionPending("s1", 1000)).toBe(true);
    expect(store.questionPendingSessions()).toEqual([
      { sessionId: "s1", projectId: "p1", transcriptPath: "C:/t/s.jsonl", stoppedAt: 1000, pendingSince: 5000 },
    ]);
    // 表示の起点（lastEventAt）は Stop のまま = タイルは「返答待ち・止まった時刻から」
    expect(store.displaySessions(projects)["p1"].lastEventAt).toBe(1000);
  });

  it("実行中へ戻ると対象から外れ、基準時刻も消える（次に返答待ちになれば付け直す）", () => {
    const t = { v: 1000 };
    const store = storeAt(t);
    store.applyEvent(evt("Stop", "s1"), projects);
    t.v = 5000;
    store.markQuestionPending("s1", 1000);
    expect(store.resumeFromConfirm("s1")).toBe(true);
    expect(store.questionPendingSessions()).toEqual([]);
    t.v = 9000;
    store.applyEvent(evt("Stop", "s1"), projects);
    t.v = 13000;
    expect(store.markQuestionPending("s1", 9000)).toBe(true);
    expect(store.questionPendingSessions()[0]).toEqual({ sessionId: "s1", projectId: "p1", transcriptPath: "C:/t/s.jsonl", stoppedAt: 9000, pendingSince: 13000 });
  });
});
