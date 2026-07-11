/**
 * main / preload / renderer で共有する型定義（型のみ。実行時コードなし）。
 * 対応設計: design.md 9 章（データ設計）・5 章（状態管理）
 */

export type ClickTarget = "cursor" | "terminal";

/** 内部状態 = 待機（補助状態）＋確定 4 状態（design.md 5.1） */
export type SessionState = "waiting" | "running" | "done" | "confirm" | "error";

export type ThemeSetting = "light" | "dark" | "auto";

/** projects.json の 1 エントリ（design.md 9 章） */
export interface Project {
  id: string;
  name: string;
  path: string;
  clickTarget: ClickTarget;
  registeredAt: string;
}

/** config.json（design.md 9 章） */
export interface AppConfig {
  version: number;
  port: number;
  theme: ThemeSetting;
  alwaysOnTopDefault: boolean;
  /** REQ-12（次期）用の予約キー。MVP では常に false・UI から変更不可 */
  notifySound: { enabled: boolean };
}

/** セッション状態（メモリのみ・揮発。design.md 9 章） */
export interface SessionView {
  sessionId: string;
  projectId: string;
  state: SessionState;
  /** 最終イベント時刻（epoch ms）。相対時刻表示の起点 */
  lastEventAt: number;
  /** 「実行中」へ遷移した時刻（epoch ms）。経過時間表示の起点（design.md 5.1） */
  runningSince?: number;
  lastMessage?: string;
}

/** ステータスバー件数（REQ-10 / design.md 5.2） */
export interface StatusCounts {
  running: number;
  done: number;
  confirm: number;
  error: number;
  /** 表示中セッション数（プロジェクトごとに 1 つ。待機タイルは数えない） */
  total: number;
}

/** main → renderer へ配信する全量スナップショット */
export interface Snapshot {
  revision: number;
  projects: Project[];
  /** key = projectId。プロジェクトの表示セッション（直近イベント優先。design.md 5.2） */
  sessions: Record<string, SessionView>;
  /** ステータスバー件数（REQ-10）。StateStore.counts を正とし renderer は表示整形のみ行う */
  counts: StatusCounts;
  config: AppConfig;
  pinned: boolean;
  statusMessage: string;
}

export interface RegisterResult {
  ok: boolean;
  path: string;
  projectId?: string;
  error?: string;
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

export interface FocusResult {
  ok: boolean;
  message?: string;
}

/** preload が window.terminalApp として公開する API */
export interface TerminalAppApi {
  getSnapshot(): Promise<Snapshot>;
  registerProjects(paths: string[]): Promise<RegisterResult[]>;
  unregisterProject(id: string): Promise<OpResult>;
  setClickTarget(id: string, target: ClickTarget): Promise<void>;
  setTheme(theme: ThemeSetting): Promise<void>;
  setAlwaysOnTopDefault(value: boolean): Promise<void>;
  setPinned(value: boolean): Promise<void>;
  focusProject(id: string): Promise<FocusResult>;
  windowAction(action: "minimize" | "maximize" | "close"): void;
  /** NFR-01 計測用: スナップショット描画完了を main へ通知（受信→描画のログ差分計測） */
  notifyRendered(revision: number): void;
  onSnapshot(cb: (snap: Snapshot) => void): void;
  /** Electron 32+ で File.path が廃止されたため webUtils 経由でパスを得る */
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    terminalApp: TerminalAppApi;
  }
}
