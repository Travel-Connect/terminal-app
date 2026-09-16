import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeHooks, settingsPathFor } from "../src/main/hooks-manager";
import { ProjectStore } from "../src/main/project-store";
import { resolveProjectLocations } from "../src/main/project-workspace";
import { matchProjectByCwd } from "../src/main/state-store";
import { computeWindowPresence } from "../src/main/window-presence";

let root: string;
let workspace: string;
let project: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-workspace-"));
  project = path.join(root, "projects", "日本語 app");
  workspace = path.join(root, "saved", "Team.code-workspace");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeWorkspace(folders: unknown[]): void {
  fs.writeFileSync(workspace, JSON.stringify({ folders }));
}

describe("Cursor workspace registration", () => {
  it("JSONC の相対フォルダ・URI・絶対パスを解決し重複を除く", () => {
    const second = path.join(root, "second");
    fs.mkdirSync(second);
    fs.writeFileSync(workspace, '\uFEFF{\n// workspace\n"folders": [\n' +
      '{"path":"../projects/日本語 app","name":"Alias, } // quoted"},\n' +
      JSON.stringify({ uri: pathToFileURL(second).href }) + ',\n' +
      JSON.stringify({ path: project }) + ',\n], /* settings */ "settings": {},\n}');
    expect(resolveProjectLocations(workspace)).toEqual([
      { path: project, workspacePath: workspace },
      { path: second, workspacePath: workspace },
    ]);
  });

  it("元のプロジェクト設定を保持し、workspace 保存先に hooks を書かず、再読込後も検出できる", () => {
    writeWorkspace([{ path: "../projects/日本語 app" }]);
    fs.mkdirSync(path.join(project, ".claude"));
    fs.writeFileSync(settingsPathFor(project), JSON.stringify({ model: "test-model", permissions: { allow: ["Read"] } }));
    const store = new ProjectStore(path.join(root, "data"));
    for (const location of resolveProjectLocations(workspace)) {
      expect(mergeHooks(location.path, 41321).ok).toBe(true);
      expect(store.addProject(location.path, "cursor", location.workspacePath).ok).toBe(true);
    }
    expect(fs.existsSync(path.join(root, "saved", ".claude"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPathFor(project), "utf8"))).toMatchObject({
      model: "test-model", permissions: { allow: ["Read"] }, hooks: expect.any(Object),
    });
    const reloaded = new ProjectStore(path.join(root, "data"));
    reloaded.load();
    const tile = reloaded.projects[0];
    expect(tile.workspacePath).toBe(workspace);
    expect(matchProjectByCwd(path.join(project, "src"), reloaded.projects)?.id).toBe(tile.id);
    expect(computeWindowPresence(reloaded.projects, [{ title: "Team (Workspace) - Cursor", exe: "Cursor.exe" }])).toEqual({ [tile.id]: true });
  });

  it("既存タイルに workspace を関連付けてもプロジェクト設定を失わない", () => {
    const store = new ProjectStore(path.join(root, "data"));
    const { project: tile } = store.addProject(project, "terminal");
    store.renameProject(tile!.id, "Custom name");
    store.setWorkspacePath(tile!.id, workspace);
    const reloaded = new ProjectStore(path.join(root, "data"));
    reloaded.load();
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0]).toMatchObject({ id: tile!.id, name: "Custom name", clickTarget: "terminal", path: project, workspacePath: workspace });
  });

  it.each([null, 42, "", "relative.code-workspace"])("保存済み workspacePath が不正でも存在判定を停止しない: %s", (workspacePath) => {
    const store = new ProjectStore(path.join(root, "data"));
    store.addProject(project);
    fs.writeFileSync(store.projectsFile, JSON.stringify({ projects: [{ ...store.projects[0], workspacePath }] }));
    store.load();
    expect(store.projects[0].workspacePath).toBeUndefined();
    expect(() => computeWindowPresence(store.projects, [{ title: "test - Cursor", exe: "cursor.exe" }])).not.toThrow();
  });

  it.each([
    '{"folders": [}',
    '{"folders": []}',
    '{"folders": [{"uri": "vscode-remote://ssh-remote/test"}]}',
    '{"folders": [{"path": "../projects/日本語 app"}, {"path": "missing"}]}',
    '{"folders": [{}]}',
    '{"folders": [{"path": ""}]}',
  ])("不正・リモート・不存在 workspace は保存先の親へフォールバックしない: %s", (text) => {
    fs.writeFileSync(workspace, text);
    expect(() => resolveProjectLocations(workspace)).toThrow();
    expect(fs.existsSync(path.join(root, "saved", ".claude"))).toBe(false);
  });

  it("明示フォルダは親の .claude に吸われず、通常ファイルは従来のルート解決を使う", () => {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.mkdirSync(path.join(project, ".git"));
    const subdir = path.join(project, "src");
    fs.mkdirSync(subdir);
    const file = path.join(subdir, "main.ts");
    fs.writeFileSync(file, "");
    expect(resolveProjectLocations(subdir)).toEqual([{ path: subdir }]);
    expect(resolveProjectLocations(file)).toEqual([{ path: project }]);
  });
});
