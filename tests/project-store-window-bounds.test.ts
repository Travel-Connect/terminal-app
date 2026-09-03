/**
 * ウィンドウ位置の記憶（260904_1 #3）: projects.json への永続化・消去・壊れた保存値の無視。
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

const bounds = { x: 1920, y: 0, width: 1280, height: 1040, maximized: false, savedAt: "2026-09-04T00:00:00.000Z" };

describe("setWindowBounds", () => {
  it("記憶した位置が projects.json に保存され、再ロードで復元される", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    expect(store.setWindowBounds(project!.id, bounds)).toBe(true);
    expect(newStore().projects[0].windowBounds).toEqual(bounds);
  });

  it("null で記憶を消す。未知 ID・不正値は false で何も変えない", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    store.setWindowBounds(project!.id, bounds);
    expect(store.setWindowBounds(project!.id, { ...bounds, width: 10 })).toBe(false);
    expect(store.projects[0].windowBounds).toEqual(bounds);
    expect(store.setWindowBounds("p-none", bounds)).toBe(false);
    expect(store.setWindowBounds(project!.id, null)).toBe(true);
    expect(newStore().projects[0].windowBounds).toBeUndefined();
  });

  it("projects.json 上の壊れた windowBounds はロード時に捨て、他の項目は保持する", () => {
    const store = newStore();
    const { project } = store.addProject(projectDir);
    const file = path.join(dataDir, "projects.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Array<Record<string, unknown>> };
    json.projects[0].windowBounds = { x: "a" };
    fs.writeFileSync(file, JSON.stringify(json));
    const reloaded = newStore();
    expect(reloaded.projects[0].id).toBe(project!.id);
    expect(reloaded.projects[0].windowBounds).toBeUndefined();
  });
});
