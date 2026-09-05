/**
 * タイルの並び順の永続化（260906_1）。並び順 = projects.json の配列順そのもの（新しいキーは持たない）。
 * D&D 並べ替え・自動整列のどちらも reorderProjects(ids) 1 本で保存する。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/project-store";

let dataDir: string;
let projectDirs: string[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-data-"));
  projectDirs = [1, 2, 3, 4].map((i) => fs.mkdtempSync(path.join(os.tmpdir(), `ta-proj${i}-`)));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const d of projectDirs) fs.rmSync(d, { recursive: true, force: true });
});

function newStore(): ProjectStore {
  const store = new ProjectStore(dataDir);
  store.load();
  return store;
}

/** 4 件登録して id 配列を返す（登録順 = 初期の並び順） */
function seed(store: ProjectStore): string[] {
  return projectDirs.map((d) => {
    const r = store.addProject(d);
    if (!r.ok || r.project === undefined) throw new Error(r.error);
    return r.project.id;
  });
}

describe("reorderProjects（260906_1）", () => {
  it("指定した順に並べ替わり、projects.json に永続化され、再ロードで復元される", () => {
    const store = newStore();
    const [a, b, c, d] = seed(store);
    expect(store.reorderProjects([c, a, d, b])).toBe(true);
    expect(store.projects.map((p) => p.id)).toEqual([c, a, d, b]);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8")) as { projects: { id: string }[] };
    expect(saved.projects.map((p) => p.id)).toEqual([c, a, d, b]);
    expect(newStore().projects.map((p) => p.id)).toEqual([c, a, d, b]);
  });

  it("未知の id は無視し、指定に無い既存プロジェクトは元の相対順のまま末尾に残す", () => {
    const store = newStore();
    const [a, b, c, d] = seed(store);
    expect(store.reorderProjects(["zzz", d, b])).toBe(true);
    expect(store.projects.map((p) => p.id)).toEqual([d, b, a, c]);
  });

  it("重複した id は最初の出現だけを採用する（プロジェクトが増減しない）", () => {
    const store = newStore();
    const [a, b, c, d] = seed(store);
    expect(store.reorderProjects([b, a, b, b])).toBe(true);
    expect(store.projects.map((p) => p.id)).toEqual([b, a, c, d]);
    expect(store.projects).toHaveLength(4);
  });

  it("順序が変わらないときは false を返し、projects.json を書き換えない", () => {
    const store = newStore();
    const ids = seed(store);
    const file = path.join(dataDir, "projects.json");
    const before = fs.readFileSync(file, "utf8");
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(store.reorderProjects(ids)).toBe(false);
    expect(store.reorderProjects([])).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(0);
  });

  it("並べ替えてもプロジェクトの中身（名前・パス・設定）は変わらない", () => {
    const store = newStore();
    const [a, b] = seed(store);
    store.renameProject(a, "別名");
    store.setClickTarget(b, "terminal");
    store.reorderProjects([b, a]);
    const reloaded = newStore();
    expect(reloaded.projects[0]).toMatchObject({ id: b, clickTarget: "terminal", path: projectDirs[1] });
    expect(reloaded.projects[1]).toMatchObject({ id: a, name: "別名", path: projectDirs[0] });
  });
});
