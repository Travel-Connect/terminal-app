/**
 * Claude Code のセッション登録簿（260904_1 #3: 分割タイルの生死判定）。
 *
 * claude 2.1.x は起動時に %USERPROFILE%\.claude\sessions\<pid>.json を書き、終了時に消す
 * （2026-09-04 実測 v2.1.259: {"pid","sessionId","cwd","startedAt","kind":"interactive",
 *   "entrypoint":"cli"|"claude-vscode","status":"busy"|"waiting"|"idle",...}。
 *   status は cli 起動のセッションにのみ載る）。
 *
 * 本アプリはこれを「セッションが今も生きているか」の一次情報に使う:
 * - 登録簿にあり PID が生きている → alive
 * - 登録簿に無い／PID が死んでいる（kill 等でファイルが残った）→ dead
 * - 登録簿ディレクトリ自体が無い・読めない（旧版・別環境）→ unknown（従来どおり hook / transcript で判定）
 *
 * 注意: ファイルは status 変化のたびに書き換わるため、読み取りが書き込み途中に当たると
 * パース失敗 = 「登録簿に無い」に見える。呼び出し側（index.ts の掃引）は dead を
 * 2 回連続で観測してから確定させる（1 回の誤判定でタイルを消さない）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  /** cli 起動のみ: busy / waiting / idle（実測値。将来増える可能性あり） */
  status?: string;
  kind?: string;
  entrypoint?: string;
}

export type Liveness = "alive" | "dead" | "unknown";

/**
 * 登録簿ディレクトリ（既定 ~/.claude/sessions）。
 * env `TERMINAL_APP_SESSIONS_DIR` で差し替え可能（260907_1 R7。E2E が擬似登録簿で busy/idle を再現するため。
 * TERMINAL_APP_DATA_DIR と同系の検証フラグで、実運用では未設定）
 */
export function registryDir(homeDir: string = os.homedir()): string {
  const override = process.env.TERMINAL_APP_SESSIONS_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  return path.join(homeDir, ".claude", "sessions");
}

/** 1 ファイル分の JSON を解釈する。必須は pid（正の整数）と sessionId（非空文字列）。それ以外は任意 */
export function parseRegistryEntry(text: string): RegistryEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.sessionId !== "string" || r.sessionId === "") return null;
  const entry: RegistryEntry = { pid: r.pid, sessionId: r.sessionId };
  if (typeof r.cwd === "string") entry.cwd = r.cwd;
  if (typeof r.status === "string") entry.status = r.status;
  if (typeof r.kind === "string") entry.kind = r.kind;
  if (typeof r.entrypoint === "string") entry.entrypoint = r.entrypoint;
  return entry;
}

/**
 * 登録簿を丸ごと読む。ディレクトリが無い・読めないときは null（判定不能）。
 * 壊れた／書き込み途中のファイルは個別に読み飛ばす（他のセッションの判定を止めない）。
 */
export function readSessionRegistry(dir: string = registryDir()): RegistryEntry[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const out: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = parseRegistryEntry(fs.readFileSync(path.join(dir, name), "utf8"));
      if (entry !== null) out.push(entry);
    } catch {
      /* 個別の読み取り失敗は無視 */
    }
  }
  return out;
}

/**
 * PID が生きているか。process.kill(pid, 0) は Windows でもプロセス存在確認として使える
 * （2026-09-04 実測: 生存 → true / 不存在 → ESRCH / 保護プロセス → EPERM = 存在する）。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * セッションの生死分類（純関数。PID 確認は注入）。
 * 同じ sessionId のエントリが複数ある（--resume で別プロセスが同じ会話を開いた等）ときは
 * どれか 1 つでも生きていれば alive。
 */
export function classifyLiveness(
  entries: readonly RegistryEntry[] | null,
  sessionId: string,
  pidAlive: (pid: number) => boolean = isPidAlive
): Liveness {
  if (entries === null) return "unknown";
  const hits = entries.filter((e) => e.sessionId === sessionId);
  if (hits.length === 0) return "dead";
  return hits.some((e) => pidAlive(e.pid)) ? "alive" : "dead";
}

/** 登録簿の status（busy / waiting / idle）。cli 起動以外や登録簿が無いときは undefined */
export function registryStatusOf(entries: readonly RegistryEntry[] | null, sessionId: string): string | undefined {
  if (entries === null) return undefined;
  return entries.find((e) => e.sessionId === sessionId)?.status;
}
