/**
 * 表示名の変更（260903_2）: タイルに出る name はフォルダ名が既定だが、ユーザーが自由に変えられる。
 * 空にするとフォルダ名へ戻す。前面化・切断検知はフォルダ名（path の basename）を使うため
 * 表示名の変更で動作は変わらない（このテストでは path が不変であることを確認する）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECT_NAME_MAX, ProjectStore } from "../src/main/project-store";

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

describe("renameProject（260903_2）", () => {
  it("表示名が projects.json に永続化され、再ロードで復元される（path は不変）", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    expect(store.renameProject(project!.id, "Shopify カレンダー")).toEqual({ ok: true, name: "Shopify カレンダー" });
    const reloaded = newStore();
    expect(reloaded.projects[0].name).toBe("Shopify カレンダー");
    expect(reloaded.projects[0].path).toBe(projectDir);
  });

  it("前後の空白は取り除く", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    store.renameProject(project!.id, "  月次レポート  ");
    expect(store.projects[0].name).toBe("月次レポート");
  });

  it("空・空白のみはフォルダ名へ戻す", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    store.renameProject(project!.id, "別名");
    expect(store.renameProject(project!.id, "   ")).toEqual({ ok: true, name: path.basename(projectDir) });
    expect(store.projects[0].name).toBe(path.basename(projectDir));
  });

  it("上限文字数を超える表示名は拒否し、元の名前を保つ", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    const tooLong = "あ".repeat(PROJECT_NAME_MAX + 1);
    const result = store.renameProject(project!.id, tooLong);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(PROJECT_NAME_MAX));
    expect(store.projects[0].name).toBe(path.basename(projectDir));
    // 上限ちょうどは受理
    expect(store.renameProject(project!.id, "い".repeat(PROJECT_NAME_MAX)).ok).toBe(true);
  });

  it("存在しない id はエラー", () => {
    const store = newStore();
    const result = store.renameProject("p-nope", "x");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
