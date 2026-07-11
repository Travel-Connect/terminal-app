/**
 * project-store の単体テスト（projects.json / config.json 永続化。
 * verification.md V-01 の「再起動後も登録が保持」の永続化部分, REQ-01 / REQ-06 / design.md 9 章）。
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

describe("ProjectStore（design.md 9 章）", () => {
  it("登録すると projects.json に永続化され、別インスタンスの load で復元される（AC-01 の保持部分）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    const result = store.addProject(projectDir);
    expect(result.ok).toBe(true);
    expect(result.project?.name).toBe(path.basename(projectDir)); // basename が既定名
    expect(result.project?.clickTarget).toBe("cursor"); // 既定 cursor（design.md 9 章）

    const reloaded = new ProjectStore(dataDir);
    reloaded.load();
    expect(reloaded.projects).toHaveLength(1);
    expect(reloaded.projects[0].path).toBe(projectDir);
    expect(reloaded.projects[0].id).toBe(result.project?.id);
  });

  it("projects.json のフォーマットが design.md 9 章に従う（version / projects 配列）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    store.addProject(projectDir);
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8"));
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.projects)).toBe(true);
    const p = raw.projects[0];
    expect(p).toHaveProperty("id");
    expect(p).toHaveProperty("name");
    expect(p).toHaveProperty("path");
    expect(p).toHaveProperty("clickTarget");
    expect(p).toHaveProperty("registeredAt");
  });

  it("重複登録を拒否する（大文字小文字・区切りの違いも同一視。design.md 3.2(a) パス検証）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    expect(store.addProject(projectDir).ok).toBe(true);
    expect(store.addProject(projectDir).ok).toBe(false);
    expect(store.addProject(projectDir.toUpperCase()).ok).toBe(false);
    expect(store.addProject(projectDir.replace(/\\/g, "/")).ok).toBe(false);
    expect(store.projects).toHaveLength(1);
  });

  it("存在しないパス・ファイル（非ディレクトリ）は登録できない", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    expect(store.addProject(path.join(projectDir, "no-such-dir")).ok).toBe(false);
    const file = path.join(projectDir, "file.txt");
    fs.writeFileSync(file, "x");
    expect(store.addProject(file).ok).toBe(false);
  });

  it("clickTarget の変更が永続化される（AC-10 のデータ部分 / REQ-06）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    const { project } = store.addProject(projectDir);
    expect(store.setClickTarget(project!.id, "terminal")).toBe(true);
    const reloaded = new ProjectStore(dataDir);
    reloaded.load();
    expect(reloaded.projects[0].clickTarget).toBe("terminal");
  });

  it("登録解除が永続化される（REQ-11）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    const { project } = store.addProject(projectDir);
    expect(store.removeProject(project!.id)?.id).toBe(project!.id);
    const reloaded = new ProjectStore(dataDir);
    reloaded.load();
    expect(reloaded.projects).toHaveLength(0);
  });

  it("config 既定値: port=41321 / theme=auto / 常に手前 OFF / 通知音は常に無効（design.md 9 章）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    expect(store.config.port).toBe(41321);
    expect(store.config.theme).toBe("auto");
    expect(store.config.alwaysOnTopDefault).toBe(false);
    expect(store.config.notifySound.enabled).toBe(false);
  });

  it("config.json で notifySound.enabled=true とされていても MVP では強制 false（AC-18 / REQ-12）", () => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ version: 1, port: 41321, theme: "dark", alwaysOnTopDefault: true, notifySound: { enabled: true } })
    );
    const store = new ProjectStore(dataDir);
    store.load();
    expect(store.config.notifySound.enabled).toBe(false); // 音は鳴らさない（設定 UI も無効）
    expect(store.config.theme).toBe("dark");
    expect(store.config.alwaysOnTopDefault).toBe(true);
  });

  it("theme / alwaysOnTopDefault の設定変更が config.json に永続化される（REQ-13 / REQ-07）", () => {
    const store = new ProjectStore(dataDir);
    store.load();
    store.setTheme("light");
    store.setAlwaysOnTopDefault(true);
    const reloaded = new ProjectStore(dataDir);
    reloaded.load();
    expect(reloaded.config.theme).toBe("light");
    expect(reloaded.config.alwaysOnTopDefault).toBe(true);
  });

  it("壊れた projects.json でも例外にせず空で継続する（起動を止めない）", () => {
    fs.writeFileSync(path.join(dataDir, "projects.json"), "{ broken");
    const store = new ProjectStore(dataDir);
    expect(() => store.load()).not.toThrow();
    expect(store.projects).toHaveLength(0);
  });
});
