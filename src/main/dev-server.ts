/**
 * 開発サーバー起動・管理（260722_1: タイル右クリック →「ブラウザで開く」）。
 * - スクリプト検出: package.json の scripts を dev → serve → start の順で採用。
 *   コマンドに electron を含むものは除外（terminal-app 自身のようなデスクトップアプリの誤起動防止）
 * - 出力読み取り: Windows の npm 系は日本語を CP932 で出すことがあるため、
 *   行単位で UTF-8（厳格）→ 失敗時 shift_jis（CP932 相当）の順にデコードする。
 *   行分割（0x0A）は UTF-8 / CP932 とも多バイト文字の途中に現れないため安全
 * - URL 検出: 起動ログの http://localhost:port を拾い、HTTP 応答を確認できてから
 *   呼び出し側へ通知する（開けない URL を案内しない。二重起動拒否等でログに URL を
 *   出した直後に終了するサーバーの「死んだ URL」をブラウザで開かないため — 実機検証で確認済み）。
 *   タイムアウト時は依存パッケージからフレームワーク既定ポートを推測し、同じく応答確認後に通知する
 * - 停止: taskkill /T /F でプロセスツリーごと止める（npm → node の子プロセス連鎖のため）
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
// TextDecoder は実行時はグローバルにもあるが、DOM lib 無しの tsconfig でも型が通るよう util から取る
import { TextDecoder } from "util";

/* ---------------- スクリプト検出 ---------------- */

export interface DetectedScript {
  /** scripts のキー名（npm run <name> に使う） */
  name: string;
  /** scripts の中身（表示・除外判定用） */
  command: string;
}

/** 検出順（dev 優先。start は本番サーバー用のことが多いため最後） */
const SCRIPT_ORDER = ["dev", "serve", "start"] as const;

/**
 * プロジェクトの package.json から起動対象スクリプトを検出する。
 * 見つからない・読めない・electron 系しか無い場合は null（メニュー無効表示の判定に使う）
 */
export function detectDevScript(projectPath: string): DetectedScript | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectPath, "package.json"), "utf8");
  } catch {
    return null;
  }
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return null;
  }
  for (const name of SCRIPT_ORDER) {
    const command = scripts[name];
    if (typeof command !== "string" || command.trim() === "") continue;
    // デスクトップアプリ起動スクリプト（electron .）はブラウザ対象にならないため除外
    if (/\belectron\b/i.test(command)) continue;
    return { name, command };
  }
  return null;
}

/* ---------------- 出力デコード（CP932 / UTF-8 自動判別） ---------------- */

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
let sjisDecoder: TextDecoder | null | undefined;

function getSjisDecoder(): TextDecoder | null {
  if (sjisDecoder === undefined) {
    try {
      sjisDecoder = new TextDecoder("shift_jis");
    } catch {
      // ICU 無し環境（通常の Node / Electron では起こらない）でも本体を落とさない
      sjisDecoder = null;
    }
  }
  return sjisDecoder;
}

/** 1 行分のバイト列を UTF-8（厳格）→ shift_jis の順でデコードする */
export function decodeLine(bytes: Buffer): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    const sjis = getSjisDecoder();
    if (sjis !== null) return sjis.decode(bytes);
    return bytes.toString("latin1");
  }
}

/**
 * ストリームのチャンクを行単位に組み立ててデコードする。
 * チャンク境界で多バイト文字が割れても、行が完成してからデコードするため文字化けしない
 */
export class StreamLineDecoder {
  private pending: Buffer = Buffer.alloc(0);

  /** チャンクを追加し、完成した行（改行を除去済み）を返す */
  push(chunk: Buffer): string[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i] === 0x0a) {
        let end = i;
        if (end > start && this.pending[end - 1] === 0x0d) end -= 1; // CRLF の CR を除去
        lines.push(decodeLine(this.pending.subarray(start, end)));
        start = i + 1;
      }
    }
    this.pending = this.pending.subarray(start);
    return lines;
  }

  /** ストリーム終端で未改行の残りを取り出す */
  flush(): string | null {
    if (this.pending.length === 0) return null;
    const rest = decodeLine(this.pending);
    this.pending = Buffer.alloc(0);
    return rest;
  }
}

/* ---------------- URL 検出 ---------------- */

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** ANSI エスケープ（色付け等）を除去する。Vite 等は色付きで URL を出力するため */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// ホスト直後の境界チェック（レビュー指摘: localhost.example.com 等の前方一致誤マッチ防止）
const URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?![\w.-])(?::\d+)?(?:\/[^\s"'>)\]]*)?/i;

/**
 * 出力 1 行からローカルサーバーの URL を検出する。
 * 0.0.0.0 / [::] などの待受表記はブラウザで開ける localhost に正規化する
 */
export function findLocalUrl(line: string): string | null {
  const m = stripAnsi(line).match(URL_PATTERN);
  if (m === null) return null;
  try {
    const url = new URL(m[0]);
    url.hostname = "localhost";
    return url.toString();
  } catch {
    return null;
  }
}

/* ---------------- フレームワーク既定ポートの推測（URL 未検出時のフォールバック） ---------------- */

/** 依存パッケージ名 → 既定ポート（検出順に評価） */
const FRAMEWORK_DEFAULT_PORTS: ReadonlyArray<readonly [string, number]> = [
  ["next", 3000],
  ["vite", 5173],
  ["react-scripts", 3000],
  ["astro", 4321],
];

/** package.json の dependencies / devDependencies からフレームワーク既定ポートを推測する */
export function guessDefaultPort(projectPath: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(projectPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const [name, port] of FRAMEWORK_DEFAULT_PORTS) {
      if (name in deps) return port;
    }
  } catch {
    /* 読めなければ推測しない */
  }
  return null;
}

/** URL に HTTP 応答があるか（ステータスは問わない。接続できれば生きている扱い） */
export function probeUrl(url: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/* ---------------- 起動・停止の管理 ---------------- */

export interface DevServerView {
  projectId: string;
  scriptName: string;
  /** 検出済み URL（未検出は undefined） */
  url?: string;
  pid?: number;
  startedAt: number;
}

export interface DevServerEvents {
  /** URL を検出した（呼び出し側でブラウザを開く） */
  onUrl: (projectId: string, url: string) => void;
  /** タイムアウトまでに URL を検出できなかった（サーバー自体は起動継続） */
  onUrlTimeout: (projectId: string) => void;
  /** プロセスが終了した（手動停止 stop() 経由の終了では呼ばない） */
  onExit: (projectId: string, code: number | null) => void;
  /** 出力行（デコード済み）。ログ記録用 */
  onLine: (projectId: string, line: string, stream: "stdout" | "stderr") => void;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  scriptName?: string;
}

interface ManagedServer {
  view: DevServerView;
  child: ChildProcess;
  urlTimer: NodeJS.Timeout | null;
  stdoutDecoder: StreamLineDecoder;
  stderrDecoder: StreamLineDecoder;
  /** stop() による意図的な停止（onExit を発火させない） */
  stopping: boolean;
  /** 起動直後のログ抑制用: URL 検出後は stderr のみ記録する */
  urlFound: boolean;
}

export const URL_DETECT_TIMEOUT_MS = 60_000;
/** 検出した URL の応答確認: この間隔で再試行し、予算内に応答が無ければ onUrlTimeout に切り替える */
export const URL_PROBE_INTERVAL_MS = 500;
export const URL_PROBE_BUDGET_MS = 20_000;

export class DevServerManager {
  private servers = new Map<string, ManagedServer>();
  /** stopAll 開始後は新規起動を受け付けない（アプリ終了・再起動との競合防止。レビュー指摘） */
  private shuttingDown = false;

  constructor(private events: DevServerEvents) {}

  isRunning(projectId: string): boolean {
    return this.servers.has(projectId);
  }

  get(projectId: string): DevServerView | null {
    return this.servers.get(projectId)?.view ?? null;
  }

  /**
   * 開発サーバーを起動する。多重起動は拒否（1 プロジェクト 1 サーバー）。
   * spawn は cmd.exe 経由（npm.cmd を直接 spawn できない Windows 事情）で、コンソール窓は出さない
   */
  start(project: { id: string; path: string }): StartResult {
    if (this.shuttingDown) {
      return { ok: false, error: "アプリ終了処理中のため起動できません" };
    }
    if (this.servers.has(project.id)) {
      return { ok: false, error: "開発サーバーは既に起動中です" };
    }
    const script = detectDevScript(project.path);
    if (script === null) {
      return { ok: false, error: "起動できるスクリプト（dev / serve / start）が見つかりません" };
    }
    let child: ChildProcess;
    try {
      // cmd.exe は絶対パスで指定する（ベア名だと cwd（プロジェクト側）が先に探索される
      // Windows の仕様があり、プロジェクト内の同名ファイルを拾う余地を残さない。レビュー指摘）
      const cmdExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
      child =
        process.platform === "win32"
          ? spawn(cmdExe, ["/d", "/s", "/c", `npm run ${script.name}`], {
              cwd: project.path,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
              // 色付け出力を抑えて URL 検出を安定させる（ANSI 除去も併用する二重防御）
              env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
            })
          : spawn("npm", ["run", script.name], {
              cwd: project.path,
              stdio: ["ignore", "pipe", "pipe"],
              env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
            });
    } catch (e) {
      return { ok: false, error: `起動に失敗しました: ${String(e)}` };
    }

    const managed: ManagedServer = {
      view: {
        projectId: project.id,
        scriptName: script.name,
        pid: child.pid,
        startedAt: Date.now(),
      },
      child,
      urlTimer: null,
      stdoutDecoder: new StreamLineDecoder(),
      stderrDecoder: new StreamLineDecoder(),
      stopping: false,
      urlFound: false,
    };
    this.servers.set(project.id, managed);

    const handleLine = (line: string, stream: "stdout" | "stderr"): void => {
      // 起動フェーズは全行、URL 検出後はエラー系（stderr）のみ通知（HMR 等のノイズ抑制）
      if (!managed.urlFound || stream === "stderr") {
        this.events.onLine(project.id, line, stream);
      }
      if (!managed.urlFound) {
        const url = findLocalUrl(line);
        if (url !== null) {
          managed.urlFound = true; // 検出は最初の 1 回だけ採用
          this.clearUrlTimer(managed);
          void this.confirmAndAnnounceUrl(project.id, managed, url);
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of managed.stdoutDecoder.push(chunk)) handleLine(line, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of managed.stderrDecoder.push(chunk)) handleLine(line, "stderr");
    });

    // 終了処理は exit / error で共通化する（spawn 失敗（ENOENT 等）では exit が発火しないため。
    // レビュー指摘: error 放置は「既に起動中」のまま残る幽霊エントリになる）。
    // Map からの削除は「現在のエントリが自分」のときだけ行う（stop タイムアウト後に
    // 起動し直した新サーバーを、旧プロセスの遅れた exit が消さないため。レビュー指摘）
    let finalized = false;
    const finalize = (code: number | null): void => {
      if (finalized) return;
      finalized = true;
      const rest = managed.stdoutDecoder.flush();
      if (rest !== null) handleLine(rest, "stdout");
      const restErr = managed.stderrDecoder.flush();
      if (restErr !== null) handleLine(restErr, "stderr");
      this.clearUrlTimer(managed);
      if (this.servers.get(project.id) === managed) {
        this.servers.delete(project.id);
        if (!managed.stopping) this.events.onExit(project.id, code);
      }
    };
    child.on("exit", (code) => finalize(code));
    child.on("error", () => finalize(null));

    // URL 検出タイムアウト → フレームワーク既定ポートを HTTP 応答確認付きで試す
    managed.urlTimer = setTimeout(() => {
      void (async () => {
        if (managed.urlFound || this.servers.get(project.id) !== managed) return;
        const port = guessDefaultPort(project.path);
        if (port !== null) {
          const candidate = `http://localhost:${port}/`;
          const alive = await probeUrl(candidate);
          // await 中にサーバーが終了・停止・入れ替わっていたら何も通知しない（レビュー指摘）
          if (managed.urlFound || this.servers.get(project.id) !== managed) return;
          if (alive) {
            managed.urlFound = true;
            managed.view.url = candidate;
            this.events.onUrl(project.id, candidate);
            return;
          }
        }
        if (this.servers.get(project.id) === managed) this.events.onUrlTimeout(project.id);
      })();
    }, URL_DETECT_TIMEOUT_MS);

    return { ok: true, scriptName: script.name };
  }

  /**
   * 検出した URL の HTTP 応答を確認できてから onUrl を発火する（260722_1 実機検証の知見）。
   * 「URL をログに出した直後に終了する」ケース（例: Next.js の二重起動拒否）で
   * 死んだ URL をブラウザで開かないための関門。確認中にサーバーが終了したら黙って打ち切る
   * （終了自体は onExit がユーザーへ通知する）
   */
  private async confirmAndAnnounceUrl(projectId: string, managed: ManagedServer, url: string): Promise<void> {
    const deadline = Date.now() + URL_PROBE_BUDGET_MS;
    while (Date.now() < deadline) {
      if (this.servers.get(projectId) !== managed) return; // 停止・終了済み
      if (await probeUrl(url, 1500)) {
        if (this.servers.get(projectId) !== managed) return;
        managed.view.url = url;
        this.events.onUrl(projectId, url);
        return;
      }
      await new Promise((r) => setTimeout(r, URL_PROBE_INTERVAL_MS));
    }
    if (this.servers.get(projectId) === managed) this.events.onUrlTimeout(projectId);
  }

  /** 停止（プロセスツリーごと）。exit イベントの発火（= servers からの削除）まで待つ */
  stop(projectId: string): Promise<{ ok: boolean; error?: string }> {
    const managed = this.servers.get(projectId);
    if (managed === undefined) {
      return Promise.resolve({ ok: false, error: "開発サーバーは起動していません" });
    }
    managed.stopping = true;
    this.clearUrlTimer(managed);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // exit が来ない場合も管理から外す（プロセスは残る可能性をエラーで伝える）
        this.servers.delete(projectId);
        resolve({ ok: false, error: "停止の確認がタイムアウトしました（プロセスが残っている可能性があります）" });
      }, 5000);
      managed.child.once("exit", () => {
        clearTimeout(timeout);
        resolve({ ok: true });
      });
      this.killTree(managed);
    });
  }

  /** アプリ終了・再起動時の一括停止（結果は待つが失敗しても続行）。以後の新規起動は拒否する */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const ids = [...this.servers.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private clearUrlTimer(managed: ManagedServer): void {
    if (managed.urlTimer !== null) {
      clearTimeout(managed.urlTimer);
      managed.urlTimer = null;
    }
  }

  private killTree(managed: ManagedServer): void {
    const pid = managed.child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      // npm → node の子プロセス連鎖ごと止める。結果は exit イベントで観測する
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {
        managed.child.kill();
      });
    } else {
      managed.child.kill("SIGTERM");
    }
  }
}
