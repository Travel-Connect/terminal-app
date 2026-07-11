/**
 * ② 状態ストアの永続化部分: projects.json / config.json（design.md 9 章 / REQ-01, REQ-06, REQ-13）。
 * 書き込みはすべて一時ファイル → rename のアトミック方式（NFR-03 と同方針）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { AppConfig, ClickTarget, Project, ThemeSetting } from "../shared/types";
import { DEFAULT_PORT } from "./constants";
import { writeFileAtomic } from "./hooks-manager";
import type { LoggerLike } from "./logger";
import { nullLogger } from "./logger";
import { normalizePath } from "./state-store";

export interface AddProjectResult {
  ok: boolean;
  project?: Project;
  error?: string;
}

/**
 * 登録対象ディレクトリの検証（design.md 3.2(a) パス検証）。
 * 実在ディレクトリであること・重複登録でないことを確認する。
 * ProjectStore.addProject と main の登録フロー（hooks マージ前の事前検証）で共用し、
 * 検証ロジックの二重実装を防ぐ。
 */
export function validateProjectDir(
  dirPath: string,
  projects: readonly Project[]
): { ok: true } | { ok: false; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    return { ok: false, error: `パスが存在しません: ${dirPath}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `フォルダのみ登録できます: ${dirPath}` };
  }
  const norm = normalizePath(dirPath);
  if (projects.some((p) => normalizePath(p.path) === norm)) {
    return { ok: false, error: `登録済みです: ${path.basename(dirPath)}` };
  }
  return { ok: true };
}

function defaultConfig(): AppConfig {
  return {
    version: 1,
    port: DEFAULT_PORT,
    theme: "auto",
    alwaysOnTopDefault: false,
    notifySound: { enabled: false }, // REQ-12 予約キー。MVP では常に false
  };
}

export class ProjectStore {
  private _projects: Project[] = [];
  private _config: AppConfig = defaultConfig();

  constructor(
    private readonly dataDir: string,
    private readonly logger: LoggerLike = nullLogger
  ) {}

  get projectsFile(): string {
    return path.join(this.dataDir, "projects.json");
  }

  get configFile(): string {
    return path.join(this.dataDir, "config.json");
  }

  get projects(): readonly Project[] {
    return this._projects;
  }

  get config(): AppConfig {
    return this._config;
  }

  /** 起動時ロード。ファイル欠落は既定値、パース失敗は既定値で継続（既存ファイルは上書きしない） */
  load(): void {
    try {
      if (fs.existsSync(this.projectsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.projectsFile, "utf8")) as {
          projects?: Project[];
        };
        this._projects = Array.isArray(parsed.projects) ? parsed.projects : [];
      }
    } catch (e) {
      this.logger.error(`projects.json の読み込みに失敗（空で継続・次回保存まで既存ファイルは温存）: ${String(e)}`);
      this._projects = [];
    }
    try {
      if (fs.existsSync(this.configFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8")) as Partial<AppConfig>;
        this._config = { ...defaultConfig(), ...parsed };
      }
    } catch (e) {
      this.logger.error(`config.json の読み込みに失敗（既定値で継続）: ${String(e)}`);
      this._config = defaultConfig();
    }
    // MVP では通知音は常に無効（REQ-12 / spec.md AC-18。UI からも変更不可）
    this._config.notifySound = { enabled: false };
  }

  /**
   * D&D 登録（REQ-01 / design.md 3.2(a)）。
   * 検証は validateProjectDir に集約（実在ディレクトリ・重複なし）。name はフォルダ basename を既定とする。
   */
  addProject(dirPath: string, clickTarget: ClickTarget = "cursor"): AddProjectResult {
    const valid = validateProjectDir(dirPath, this._projects);
    if (!valid.ok) {
      return { ok: false, error: valid.error };
    }
    const project: Project = {
      id: this.newId(),
      name: path.basename(dirPath),
      path: dirPath,
      clickTarget,
      registeredAt: new Date().toISOString(),
    };
    this._projects.push(project);
    this.saveProjects();
    return { ok: true, project };
  }

  /** デモ実行専用: 実在検証をせずに追加する（--demo のみ。通常経路では使わない） */
  addProjectDirect(project: Project): void {
    this._projects.push(project);
    this.saveProjects();
  }

  removeProject(id: string): Project | null {
    const idx = this._projects.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const [removed] = this._projects.splice(idx, 1);
    this.saveProjects();
    return removed;
  }

  getProject(id: string): Project | null {
    return this._projects.find((p) => p.id === id) ?? null;
  }

  setClickTarget(id: string, target: ClickTarget): boolean {
    const p = this._projects.find((x) => x.id === id);
    if (!p) return false;
    p.clickTarget = target;
    this.saveProjects();
    return true;
  }

  setTheme(theme: ThemeSetting): void {
    this._config.theme = theme;
    this.saveConfig();
  }

  setAlwaysOnTopDefault(value: boolean): void {
    this._config.alwaysOnTopDefault = value;
    this.saveConfig();
  }

  private newId(): string {
    for (;;) {
      const id = "p-" + crypto.randomBytes(2).toString("hex");
      if (!this._projects.some((p) => p.id === id)) return id;
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private saveProjects(): void {
    this.ensureDir();
    writeFileAtomic(this.projectsFile, JSON.stringify({ version: 1, projects: this._projects }, null, 2) + "\n");
  }

  private saveConfig(): void {
    this.ensureDir();
    writeFileAtomic(this.configFile, JSON.stringify(this._config, null, 2) + "\n");
  }
}
