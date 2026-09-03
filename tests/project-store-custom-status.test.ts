/**
 * project-store の手動ステータス（260727_1）の単体テスト。
 * 認識合わせ: ステータスは自動検知の SessionState と別レイヤーの手動ラベルで、
 * 選択肢は config.json（customStatuses）、割り当ては projects.json（customStatus）に永続化する。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/project-store";

let dataDir: string;
let projectDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-data-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-proj-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function newStore(): ProjectStore {
  const store = new ProjectStore(dataDir);
  store.load();
  return store;
}

describe("手動ステータス（260727_1）", () => {
  it("config 既定値に初期選択肢（作業中／レビュー待ち／保留）が入る", () => {
    const store = newStore();
    expect(store.config.customStatuses).toEqual(["作業中", "レビュー待ち", "保留"]);
  });

  it("旧バージョンの config.json（customStatuses 欠落）は既定の選択肢で補完される", () => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ version: 1, port: 41321, theme: "dark", alwaysOnTopDefault: false, notifySound: { enabled: false } })
    );
    const store = newStore();
    expect(store.config.customStatuses).toEqual(["作業中", "レビュー待ち", "保留"]);
    expect(store.config.theme).toBe("dark"); // 既存設定は保持
  });

  it("割り当てが projects.json に永続化され、再ロードで復元される", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    expect(store.setCustomStatus(project!.id, "レビュー待ち")).toBe(true);
    const reloaded = newStore();
    expect(reloaded.projects[0].customStatus).toBe("レビュー待ち");
  });

  it("null で解除でき、選択肢に無いステータスの割り当ては拒否される", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    store.setCustomStatus(project!.id, "保留");
    expect(store.setCustomStatus(project!.id, null)).toBe(true);
    expect(store.projects[0].customStatus).toBeUndefined();
    expect(store.setCustomStatus(project!.id, "存在しない選択肢")).toBe(false);
    expect(store.setCustomStatus("p-none", "保留")).toBe(false); // 不明プロジェクト
  });

  it("選択肢の更新が config.json に永続化される（追加）", () => {
    const store = newStore();
    store.setCustomStatuses([...store.config.customStatuses, "リリース済み"]);
    const reloaded = newStore();
    expect(reloaded.config.customStatuses).toContain("リリース済み");
  });

  it("選択肢の更新で空白のみ・重複が除去される", () => {
    const store = newStore();
    store.setCustomStatuses(["  ", "A", "A", " B ", ""]);
    expect(store.config.customStatuses).toEqual(["A", "B"]);
  });

  it("選択肢から削除すると、使用中プロジェクトの割り当ても解除される（再選択できないラベルを残さない）", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    store.setCustomStatus(project!.id, "保留");
    store.setCustomStatuses(["作業中", "レビュー待ち"]); // 「保留」を削除
    expect(store.projects[0].customStatus).toBeUndefined();
    const reloaded = newStore();
    expect(reloaded.projects[0].customStatus).toBeUndefined(); // 解除が永続化されている
  });

  it("残っている選択肢の割り当ては選択肢更新後も維持される", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    store.setCustomStatus(project!.id, "作業中");
    store.setCustomStatuses(["作業中", "レビュー待ち", "保留", "新規"]);
    expect(store.projects[0].customStatus).toBe("作業中");
  });
});
