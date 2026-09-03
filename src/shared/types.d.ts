/**
 * main / preload / renderer で共有する型定義（型のみ。実行時コードなし）。
 * 対応設計: design.md 9 章（データ設計）・5 章（状態管理）
 */

export type ClickTarget = "cursor" | "terminal";

/**
 * 内部状態 = 待機（補助状態）＋確定 4 状態（design.md 5.1）＋切断（260712_2）。
 * 切断 = 「実行中」なのに transcript の更新が途絶し（ウィンドウ消失を併用判定）、
 * SessionEnd も届いていないセッション。liveness-monitor が検知して遷移させる。
 */
export type SessionState = "waiting" | "running" | "done" | "confirm" | "error" | "disconnected";

export type ThemeSetting = "light" | "dark" | "auto";

export type WindowAction = "minimize" | "maximize" | "close" | "restart";

/** projects.json の 1 エントリ（design.md 9 章） */
export interface Project {
  id: string;
  name: string;
  path: string;
  clickTarget: ClickTarget;
  registeredAt: string;
  /**
   * 手動ステータス（260727_1）。自動検知の SessionState とは別レイヤーのユーザー付与ラベル。
   * config.customStatuses の中から右クリックメニューで選択する。未設定 = ラベルなし
   */
  customStatus?: string;
  /**
   * 記憶したウィンドウ位置（260904_1 #3）。タイル右クリック「ウィンドウ位置を記憶」で
   * 対象アプリ（Cursor / ターミナル）のウィンドウ配置を保存し、「立ち上げる」直後や
   * 「記憶した位置へ戻す」で SetWindowPlacement により再現する。未設定 = 記憶なし
   */
  windowBounds?: WindowBounds;
}

/**
 * ウィンドウ配置（260904_1 #3）。GetWindowPlacement の通常時矩形（rcNormalPosition）＋最大化フラグ。
 * 座標は保存・復元とも同じ API を使うため、モニタ構成が同じ限り忠実に再現できる
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  /** 記憶した日時（ISO 8601）。設定画面の表示用 */
  savedAt: string;
}

/** config.json（design.md 9 章） */
export interface AppConfig {
  version: number;
  port: number;
  theme: ThemeSetting;
  alwaysOnTopDefault: boolean;
  /** REQ-12（次期）用の予約キー。MVP では常に false・UI から変更不可 */
  notifySound: { enabled: boolean };
  /** 手動ステータスの選択肢（260727_1）。設定画面で自由に追加・削除できる */
  customStatuses: string[];
  /**
   * 未接続タイル（260903_1: 対象アプリのウィンドウが無いタイル）を表示するか。
   * false = 灰色タイルをグリッドから隠す。ステータスバーのトグルで切り替え、再起動後も保持
   */
  showUnlinked: boolean;
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
  /**
   * 現在の作業テキスト（260712 課題B）。UserPromptSubmit hook の prompt（実データ）を整形した値。
   * ターミナルのオレンジ表示（スピナー行）そのものは hook / transcript に載らないため、
   * 「このセッションに何をやらせているか」を示す最も新しい実データとして prompt を用いる
   * （260712_3: TaskCreated の task_subject でも更新される）。
   */
  workText?: string;
  /**
   * statusLine 転送由来の作業メトリクス（260712_3 案A）。
   * 例「↓ 70.5k tokens · thinking xhigh」。取得不能・未転送時は undefined（非表示）。
   */
  statsText?: string;
  /**
   * このセッションを最初に観測した時刻（epoch ms。260904_1 #3）。
   * 同じプロジェクトで複数セッションが並行するときの分割タイルの並び順（起動順）に使う
   */
  firstSeenAt?: number;
}

/** ステータスバー件数（REQ-10 / design.md 5.2） */
export interface StatusCounts {
  running: number;
  done: number;
  confirm: number;
  error: number;
  /** 切断セッション数（260712_2）。既存テスト・呼び出し側との互換のためオプショナル（未設定 = 0 扱い） */
  disconnected?: number;
  /** 表示中セッション数（表示タイルごとに 1 つ。分割タイルはそれぞれ数える。待機タイルは数えない） */
  total: number;
}

/** main → renderer へ配信する全量スナップショット */
export interface Snapshot {
  revision: number;
  projects: Project[];
  /** key = projectId。プロジェクトの表示セッション（直近イベント優先。design.md 5.2） */
  sessions: Record<string, SessionView>;
  /**
   * 分割タイル（260904_1 #3）。key = projectId、value = そのプロジェクトで生きているセッションが
   * 2 本以上あるときの一覧（起動順）。キーが無いプロジェクトは従来どおり sessions の 1 タイル表示。
   * 生死は Claude Code のセッション登録簿（~/.claude/sessions）と PID 存在で判定する
   */
  splitSessions: Record<string, SessionView[]>;
  /** ステータスバー件数（REQ-10）。main が表示タイル基準で数え、renderer は表示整形のみ行う */
  counts: StatusCounts;
  config: AppConfig;
  pinned: boolean;
  statusMessage: string;
  /**
   * ウィンドウ有無（260903_1）。key = projectId、value = クリックで開く対象アプリ（Cursor / ターミナル）の
   * ウィンドウが見つかったか。main が約 5 秒ごとに判定する。キーが無い = 判定不能（koffi 未ロード等）で、
   * renderer は「接続あり」扱いにする（安全側）。未接続の最終判定は renderer の isUnlinked（format.ts）
   */
  windowPresence: Record<string, boolean>;
}

export interface RegisterResult {
  ok: boolean;
  path: string;
  projectId?: string;
  error?: string;
}

/**
 * D&D ドロップの生ペイロード（260727_1）。
 * Cursor（VS Code 系）からのドラッグは OS の File が付かないため、
 * renderer は DataTransfer の中身を丸ごと main へ渡し、main 側で
 * パス抽出（drop-paths.ts）と診断ログ出力を行う。
 */
export interface DropPayload {
  /** webUtils.getPathForFile で解決できた実ファイルパス（エクスプローラからのドロップ） */
  filePaths: string[];
  /** dataTransfer.types の一覧（診断ログ用） */
  types: string[];
  /** type → getData(type) の値（先頭 8000 文字。フォールバック抽出＋診断ログ用） */
  data: Record<string, string>;
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
  /** D&D ドロップの生ペイロードを渡して登録する（260727_1: パス抽出は main 側で行う） */
  registerDrop(payload: DropPayload): Promise<RegisterResult[]>;
  /**
   * フォルダ選択ダイアログでプロジェクトを登録する（260727_1）。
   * Cursor のツリーからの D&D は OS ドラッグにパス情報が載らず対応不能のため、確実な代替導線
   */
  pickProjects(): Promise<RegisterResult[]>;
  /** D&D 診断ログを main のログファイルへ送る（260727_1。renderer コンソールは非表示運用のため） */
  dndLog(msg: string): void;
  unregisterProject(id: string): Promise<OpResult>;
  setClickTarget(id: string, target: ClickTarget): Promise<void>;
  /** 手動ステータスの割り当て（260727_1）。null = 解除 */
  setProjectStatus(id: string, status: string | null): Promise<void>;
  /** 手動ステータスの選択肢一覧を丸ごと更新（260727_1）。追加・削除とも本 API に集約 */
  setCustomStatuses(list: string[]): Promise<void>;
  /** 表示名の変更（260903_2）。空はフォルダ名へ戻す。上限超過などは ok=false + error */
  setProjectName(id: string, name: string): Promise<OpResult>;
  /** 未接続タイルの表示／非表示（260903_1）。config.json に保持 */
  setShowUnlinked(value: boolean): Promise<void>;
  setTheme(theme: ThemeSetting): Promise<void>;
  setAlwaysOnTopDefault(value: boolean): Promise<void>;
  setPinned(value: boolean): Promise<void>;
  focusProject(id: string): Promise<FocusResult>;
  /**
   * タイルの右クリックメニューを表示（260712_2: 再接続・表示クリア・登録解除）。
   * sessionId は分割タイル（260904_1 #3）のときだけ渡す — 「この枠を消す」の対象になる
   */
  showTileMenu(id: string, sessionId?: string): Promise<void>;
  /** 全プロジェクトのウィンドウ位置を一括で記憶（260904_1 #3）。結果はステータスバーにも出る */
  saveAllWindowBounds(): Promise<OpResult>;
  /** 記憶済みの全プロジェクトのウィンドウを記憶位置へ戻す（260904_1 #3） */
  restoreAllWindowBounds(): Promise<OpResult>;
  /** restart はアプリ自体を再起動する（main 側で確認ダイアログを挟む）。 */
  windowAction(action: WindowAction): void;
  /** NFR-01 計測用: スナップショット描画完了を main へ通知（受信→描画のログ差分計測） */
  notifyRendered(revision: number): void;
  onSnapshot(cb: (snap: Snapshot) => void): void;
  /** タイル右クリック →「表示名を変更…」で main から届く。renderer 側で入力ダイアログを開く（260903_2） */
  onRenameRequest(cb: (projectId: string) => void): void;
  /** Electron 32+ で File.path が廃止されたため webUtils 経由でパスを得る */
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    terminalApp: TerminalAppApi;
  }
}
