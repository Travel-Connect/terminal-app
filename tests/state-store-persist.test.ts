/**
 * 260922_7: セッション記録の書き出し・取り込み（再起動をまたぐ保存用）。
 * 表示に出ない内部項目（transcriptPath・questionSince）も往復し、終了済みは保存しない。
 * 取り込みは「まだ知らないセッションだけ」— 起動後にイベントで確立した記録を古い保存で上書きしない。
 */
import { describe, expect, it } from "vitest";
import type { Project } from "../src/shared/types";
import { StateStore, type HookEvent, type PersistedSession } from "../src/main/state-store";

const projects: Project[] = [{ id: "p1", name: "app", path: "C:/dev/app", clickTarget: "cursor", registeredAt: "2026-09-22T00:00:00Z" }];
const evt = (name: HookEvent["hook_event_name"], sessionId: string, extra: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: name,
  session_id: sessionId,
  cwd: "C:/dev/app",
  transcript_path: "C:/t/s.jsonl",
  ...extra,
});

describe("exportSessions", () => {
  it("表示に必要な値と内部項目（transcriptPath・questionSince）を書き出す", () => {
    const t = { v: 1000 };
    const store = new StateStore(() => t.v);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "在庫を数えて" }), projects);
    store.applyEvent(evt("Stop", "s1"), projects);
    t.v = 5000;
    store.markQuestionPending("s1", 1000);
    store.applyNameHint("s1", "名前が作業を表していません");
    const [rec] = store.exportSessions();
    expect(rec).toEqual({
      sessionId: "s1",
      projectId: "p1",
      state: "confirm",
      lastEventAt: 1000,
      firstSeenAt: 1000,
      lastMessage: "Claude が返答を待っています",
      workText: "在庫を数えて",
      transcriptPath: "C:/t/s.jsonl",
      confirmKind: "question",
      nameHint: "名前が作業を表していません",
      questionSince: 5000,
    });
  });

  it("終了済み（dead）は書き出さない", () => {
    const store = new StateStore(() => 1000);
    store.applyEvent(evt("Stop", "s1"), projects);
    store.applyEvent(evt("Stop", "s2"), projects);
    store.setDead("s2", true);
    expect(store.exportSessions().map((r) => r.sessionId)).toEqual(["s1"]);
  });

  it("実行中の経過起点（runningSince）も持ち越す", () => {
    const store = new StateStore(() => 7000);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "x" }), projects);
    expect(store.exportSessions()[0].runningSince).toBe(7000);
  });
});

describe("importSessions", () => {
  const saved: PersistedSession[] = [
    {
      sessionId: "s1",
      projectId: "p1",
      state: "confirm",
      lastEventAt: 1000,
      firstSeenAt: 500,
      confirmKind: "permission",
      dangerText: "外部へ送る操作",
      workText: "デプロイして",
      transcriptPath: "C:/t/s.jsonl",
    },
  ];

  it("取り込んだ記録がそのまま表示に出る（確認待ち・危険度・作業テキスト）", () => {
    const store = new StateStore(() => 9000);
    expect(store.importSessions(saved)).toBe(1);
    const v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("confirm");
    expect(v.confirmKind).toBe("permission");
    expect(v.dangerText).toBe("外部へ送る操作");
    expect(v.workText).toBe("デプロイして");
    expect(v.lastEventAt).toBe(1000);
    expect(store.counts(projects).confirm).toBe(1);
  });

  it("既に知っているセッションは上書きしない（実データが優先）", () => {
    const store = new StateStore(() => 9000);
    store.applyEvent(evt("UserPromptSubmit", "s1", { prompt: "新しい依頼" }), projects);
    expect(store.importSessions(saved)).toBe(0);
    const v = store.displaySessions(projects)["p1"];
    expect(v.state).toBe("running");
    expect(v.workText).toBe("新しい依頼");
  });

  it("書き出し → 取り込みで往復できる（別インスタンスでも同じ表示）", () => {
    const a = new StateStore(() => 1000);
    a.applyEvent(evt("Notification", "s1", { message: "perm" }), projects);
    a.applyDangerText("s1", "取り消せない操作");
    const b = new StateStore(() => 9000);
    b.importSessions(a.exportSessions());
    expect(b.displaySessions(projects)["p1"]).toEqual(a.displaySessions(projects)["p1"]);
  });

  it("空配列は 0 件（changed も起きない）", () => {
    const store = new StateStore(() => 1000);
    let fired = 0;
    store.on("changed", () => { fired += 1; });
    expect(store.importSessions([])).toBe(0);
    expect(fired).toBe(0);
  });
});
