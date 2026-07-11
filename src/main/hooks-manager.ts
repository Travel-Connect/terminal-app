/**
 * ④ hooks 設定マネージャ（design.md 4.1〜4.2 / REQ-02, REQ-11, NFR-03）。
 *
 * 方針（design.md 4.2）:
 * - `.claude/settings.json` が無ければ `{}` から開始（`.claude/` は作成する）
 * - パース失敗時は何も書かずに中断（壊れたファイルを上書きしない）
 * - 書き込み前に `settings.json.terminal-app.bak` へバックアップ（操作ごとに上書き）
 * - マーカー（command に URL パス `/terminal-app/event` を含む）が無い場合のみ append（冪等）。
 *   既存エントリは順序含め変更しない
 * - 一時ファイル → rename のアトミック書き込み
 * - 除去は自アプリのマーカー付きエントリのみ。空になった配列・hooks キーは削除
 * - 起動時追補（design.md 4.2）: 登録済みプロジェクトにも本マージを冪等適用し、
 *   不足イベント（旧 2 イベント構成 → UserPromptSubmit）だけを再登録なしで append する
 */
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_PORT, EVENT_PATH, HOOK_MARKER } from "./constants";

/**
 * 追記対象イベント。Stop / Notification に加え UserPromptSubmit を追記する
 * （OPEN-04 案 A 採用 — 2026-07-11 ユーザー実測により確定。design.md 4.1 / 4.5）。
 * UserPromptSubmit がプロンプト送信＝実行開始の検知経路になり、タイルを「実行中」へ遷移させる。
 */
export const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit"] as const;

export interface HookOpResult {
  ok: boolean;
  /** 実際にファイルへ書き込んだか（冪等 no-op のとき false） */
  changed: boolean;
  error?: string;
  backupPath?: string;
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookEntry {
  hooks?: HookCommand[];
  [k: string]: unknown;
}

type SettingsObject = Record<string, unknown>;

/** design.md 4.1 の hook コマンド文字列を組み立てる */
export function buildHookCommand(port: number = DEFAULT_PORT): string {
  return (
    `curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:${port}${EVENT_PATH}` +
    ` -H "Content-Type: application/json" --data-binary @-`
  );
}

function buildHookEntry(port: number): HookEntry {
  return {
    hooks: [{ type: "command", command: buildHookCommand(port), timeout: 5 }],
  };
}

export function settingsPathFor(projectPath: string): string {
  return path.join(projectPath, ".claude", "settings.json");
}

export function backupPathFor(projectPath: string): string {
  return settingsPathFor(projectPath) + ".terminal-app.bak";
}

/**
 * エントリが自アプリのもの（command に URL パス `/terminal-app/event` を含む）か判定（design.md 4.1）。
 * 2026-07-11 厳格化: 旧 `terminal-app` 部分一致だと、ユーザー自身の hook コマンドが
 * terminal-app をパスに含むだけで誤って自アプリ扱い（除去・置換）されるため。
 */
export function entryHasMarker(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const hooks = (entry as HookEntry).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h !== null &&
      typeof h === "object" &&
      typeof (h as HookCommand).command === "string" &&
      (h as HookCommand).command.includes(HOOK_MARKER)
  );
}

/** マーカー付きエントリの command が現在の設定（ポート）と一致するか */
function entryMatchesCommand(entry: unknown, command: string): boolean {
  if (!entryHasMarker(entry)) return false;
  const hooks = (entry as HookEntry).hooks as HookCommand[];
  return hooks.some((h) => h.command === command);
}

interface LoadResult {
  ok: boolean;
  settings?: SettingsObject;
  raw?: string;
  exists: boolean;
  error?: string;
}

function loadSettings(settingsPath: string): LoadResult {
  if (!fs.existsSync(settingsPath)) return { ok: true, settings: {}, exists: false };
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch (e) {
    return { ok: false, exists: true, error: `settings.json を読み込めません: ${String(e)}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, exists: true, raw, error: "settings.json のルートがオブジェクトではありません" };
    }
    return { ok: true, settings: parsed as SettingsObject, raw, exists: true };
  } catch {
    // design.md 4.2: パース失敗時は何も書かずに中断（壊れたファイルを上書きしない）
    return { ok: false, exists: true, raw, error: "settings.json の JSON パースに失敗しました（手動確認が必要です）" };
  }
}

/** 一時ファイル → rename のアトミック書き込み（design.md 4.2 / NFR-03） */
export function writeFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  try {
    fs.renameSync(tmp, filePath); // Windows でも既存ファイルを置換する
  } catch (e) {
    // rename に失敗した一時ファイルを残さない（ゴミファイル堆積の防止）
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 掃除失敗は無視（本来のエラーを優先して伝える） */
    }
    throw e;
  }
}

function backupIfExists(projectPath: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined; // 元ファイルが無い場合はバックアップ不要
  const bak = backupPathFor(projectPath);
  fs.writeFileSync(bak, raw, "utf8");
  return bak;
}

/**
 * バックアップ → アトミック書き込みの共通処理（design.md 4.2 手順 5〜6）。
 * mergeHooks / removeHooks の書き込み末尾を一本化する。
 */
function backupAndWrite(projectPath: string, settingsPath: string, raw: string | undefined, settings: SettingsObject): HookOpResult {
  let backupPath: string | undefined;
  try {
    backupPath = backupIfExists(projectPath, raw);
    writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return { ok: true, changed: true, backupPath };
  } catch (e) {
    return { ok: false, changed: false, error: `settings.json の書き込みに失敗しました: ${String(e)}`, backupPath };
  }
}

/**
 * 登録時のマージ（design.md 4.2 マージ手順）。
 * 冪等: マーカー付きエントリが現在のコマンドと一致して存在する場合は何も書かない。
 * ポート変更時（design.md 3.3）: 旧ポートのマーカー付きエントリを現在のコマンドへ置き換える。
 */
export function mergeHooks(projectPath: string, port: number = DEFAULT_PORT): HookOpResult {
  const settingsPath = settingsPathFor(projectPath);
  const loaded = loadSettings(settingsPath);
  if (!loaded.ok || loaded.settings === undefined) {
    return { ok: false, changed: false, error: loaded.error };
  }
  const settings = loaded.settings;
  const command = buildHookCommand(port);

  // hooks コンテナの検証（想定外の型なら壊さず中断）
  if ("hooks" in settings && (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    return { ok: false, changed: false, error: "settings.json の hooks キーがオブジェクトではありません" };
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const evt of HOOK_EVENTS) {
    if (evt in hooks && !Array.isArray(hooks[evt])) {
      return { ok: false, changed: false, error: `settings.json の hooks.${evt} が配列ではありません` };
    }
  }

  // 変更が必要か判定（冪等性: design.md 4.2 手順 4）
  let changed = false;
  const nextHooks: Record<string, unknown> = { ...hooks };
  for (const evt of HOOK_EVENTS) {
    const arr = Array.isArray(nextHooks[evt]) ? ([...(nextHooks[evt] as unknown[])] as unknown[]) : [];
    const markerEntries = arr.filter((e) => entryHasMarker(e));
    const upToDate = markerEntries.length === 1 && entryMatchesCommand(markerEntries[0], command);
    if (!upToDate) {
      // 自アプリ分（旧ポート・重複含む）を除去し、現在のエントリを末尾へ append。
      // 既存（他者）のエントリは順序含めそのまま維持する。
      const others = arr.filter((e) => !entryHasMarker(e));
      others.push(buildHookEntry(port));
      nextHooks[evt] = others;
      changed = true;
    }
  }

  if (!changed && loaded.exists) {
    return { ok: true, changed: false };
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  } catch (e) {
    return { ok: false, changed: false, error: `.claude ディレクトリを作成できません: ${String(e)}` };
  }
  settings.hooks = nextHooks;
  return backupAndWrite(projectPath, settingsPath, loaded.raw, settings);
}

/**
 * 登録解除時の除去（design.md 4.2 除去手順）。
 * 自アプリのマーカー付きエントリのみを取り除き、空になった配列・空になった hooks キーは削除する。
 */
export function removeHooks(projectPath: string): HookOpResult {
  const settingsPath = settingsPathFor(projectPath);
  if (!fs.existsSync(settingsPath)) {
    return { ok: true, changed: false }; // 元々何もない → 除去不要
  }
  const loaded = loadSettings(settingsPath);
  if (!loaded.ok || loaded.settings === undefined) {
    return { ok: false, changed: false, error: loaded.error };
  }
  const settings = loaded.settings;
  if (settings.hooks === undefined || settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    return { ok: true, changed: false }; // hooks が無い/想定外 → 触らない
  }
  const hooks = settings.hooks as Record<string, unknown>;

  let changed = false;
  for (const evt of HOOK_EVENTS) {
    const arr = hooks[evt];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((e) => !entryHasMarker(e));
    if (filtered.length !== arr.length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooks[evt]; // 空になった配列は削除（痕跡を残さない）
      } else {
        hooks[evt] = filtered;
      }
    }
  }
  if (!changed) return { ok: true, changed: false };

  if (Object.keys(hooks).length === 0) {
    delete settings.hooks; // 空になった hooks キーも削除
  }

  return backupAndWrite(projectPath, settingsPath, loaded.raw, settings);
}
