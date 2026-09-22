/**
 * 260922_7: セッション表示の保存・復元（再起動後に続きから確認できるようにする）。
 * - save/load: 版・保存時刻・壊れたファイル・古すぎる記録の扱い
 * - reconcileSnapshot: 実データ（登録・登録簿・transcript）と突き合わせてから取り込む
 *   進んでいたセッションは終端分類で作り直し、古い判定（返答待ち・危険度・停滞）は貼り付けない
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_SNAPSHOT_VERSION,
  SNAPSHOT_MAX_AGE_MS,
  loadSessionSnapshot,
  reconcileSnapshot,
  saveSessionSnapshot,
  snapshotPath,
  type ReconcileDeps,
  type SnapshotEntry,
} from "../src/main/session-snapshot";

const NOW = 1_700_000_000_000;

const entry = (over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  sessionId: "s1",
  projectId: "p1",
  state: "confirm",
  lastEventAt: NOW - 60_000,
  firstSeenAt: NOW - 600_000,
  transcriptPath: "C:/t/s1.jsonl",
  transcriptMtimeMs: NOW - 60_000,
  confirmKind: "permission",
  lastMessage: "Claude needs your permission to use Bash",
  dangerText: "取り消せない操作",
  workText: "dist を作り直して",
  nameHint: "名前が作業を表していません",
  ...over,
});

const deps = (over: Partial<ReconcileDeps> = {}): ReconcileDeps => ({
  now: () => NOW,
  projectExists: () => true,
  liveness: () => "alive",
  mtimeMs: () => NOW - 60_000,
  turnEnd: () => "concluded",
  ...over,
});

describe("save / load", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-app-snap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("保存した記録をそのまま読み戻せる", () => {
    saveSessionSnapshot(dir, [entry()], NOW);
    const file = loadSessionSnapshot(dir, NOW);
    expect(file?.version).toBe(SESSION_SNAPSHOT_VERSION);
    expect(file?.savedAt).toBe(NOW);
    expect(file?.sessions).toEqual([entry()]);
  });

  it("ファイルが無い・壊れている・版が違うときは null（従来どおり作り直す）", () => {
    expect(loadSessionSnapshot(dir, NOW)).toBeNull();
    fs.writeFileSync(snapshotPath(dir), "{壊れた", "utf8");
    expect(loadSessionSnapshot(dir, NOW)).toBeNull();
    fs.writeFileSync(snapshotPath(dir), JSON.stringify({ version: 999, savedAt: NOW, sessions: [] }), "utf8");
    expect(loadSessionSnapshot(dir, NOW)).toBeNull();
  });

  it("保存から時間が経ちすぎた記録は使わない", () => {
    saveSessionSnapshot(dir, [entry()], NOW);
    expect(loadSessionSnapshot(dir, NOW + SNAPSHOT_MAX_AGE_MS)).not.toBeNull();
    expect(loadSessionSnapshot(dir, NOW + SNAPSHOT_MAX_AGE_MS + 1)).toBeNull();
  });

  it("形の壊れた要素は落として読み込む", () => {
    fs.writeFileSync(
      snapshotPath(dir),
      JSON.stringify({ version: SESSION_SNAPSHOT_VERSION, savedAt: NOW, sessions: [entry(), null, { sessionId: 1 }, {}] }),
      "utf8"
    );
    expect(loadSessionSnapshot(dir, NOW)?.sessions).toEqual([entry()]);
  });
});

describe("reconcileSnapshot", () => {
  it("transcript が動いていなければ保存時のまま取り込む（確認待ち・危険度・名前の印が残る）", () => {
    const r = reconcileSnapshot([entry()], deps());
    expect(r.keep).toHaveLength(1);
    expect(r.keep[0].state).toBe("confirm");
    expect(r.keep[0].confirmKind).toBe("permission");
    expect(r.keep[0].dangerText).toBe("取り消せない操作");
    expect(r.refreshed).toBe(0);
    expect(r.keep[0]).not.toHaveProperty("transcriptMtimeMs"); // 保存専用の項目は取り込まない
  });

  it("登録が消えたプロジェクト・終了済みのセッションは捨てる", () => {
    expect(reconcileSnapshot([entry()], deps({ projectExists: () => false }))).toMatchObject({ keep: [], dropped: { project: 1, dead: 0 } });
    expect(reconcileSnapshot([entry()], deps({ liveness: () => "dead" }))).toMatchObject({ keep: [], dropped: { project: 0, dead: 1 } });
  });

  it("登録簿が読めない（unknown）ときは捨てずに残す", () => {
    expect(reconcileSnapshot([entry()], deps({ liveness: () => "unknown" })).keep).toHaveLength(1);
  });

  it("保存後に transcript が進んでいたら終端分類で作り直し、古い判定は落とす", () => {
    const moved = deps({ mtimeMs: () => NOW - 1_000, turnEnd: () => "open" });
    const r = reconcileSnapshot([entry({ state: "confirm", confirmKind: "question", stallText: "停滞の疑い・進展なし" })], moved);
    expect(r.refreshed).toBe(1);
    expect(r.keep[0].state).toBe("running");
    expect(r.keep[0].runningSince).toBe(NOW);
    expect(r.keep[0].confirmKind).toBeUndefined();
    expect(r.keep[0].dangerText).toBeUndefined();
    expect(r.keep[0].stallText).toBeUndefined();
    expect(r.keep[0].lastEventAt).toBe(NOW - 1_000);
    expect(r.keep[0].workText).toBe("dist を作り直して"); // 作業テキストと名前の印は残す
    expect(r.keep[0].nameHint).toBe("名前が作業を表していません");
  });

  it("進んでいてターンが終わっていれば「完了」にする", () => {
    const r = reconcileSnapshot([entry()], deps({ mtimeMs: () => NOW - 1_000, turnEnd: () => "concluded" }));
    expect(r.keep[0].state).toBe("done");
    expect(r.keep[0].runningSince).toBeUndefined();
  });

  it("transcript のパスが無い・mtime が取れない記録はそのまま残す（安全側）", () => {
    expect(reconcileSnapshot([entry({ transcriptPath: undefined })], deps()).keep[0].state).toBe("confirm");
    expect(reconcileSnapshot([entry()], deps({ mtimeMs: () => null })).keep[0].state).toBe("confirm");
    expect(reconcileSnapshot([entry({ transcriptMtimeMs: undefined })], deps({ mtimeMs: () => NOW })).keep[0].state).toBe("confirm");
  });

  it("空配列は空配列", () => {
    expect(reconcileSnapshot([], deps())).toEqual({ keep: [], dropped: { project: 0, dead: 0 }, refreshed: 0 });
  });
});
