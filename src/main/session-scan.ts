/**
 * 再接続（260712_2）: プロジェクトの Claude Code transcript ディレクトリを走査し、
 * 「直近まで動いていた」セッションを見つけて復元候補として返す。
 *
 * transcript の場所: %USERPROFILE%\.claude\projects\<munge(プロジェクトパス)>\<sessionId>.jsonl
 * munge 規則 = 英数字以外を "-" へ置換（実ディレクトリ 2026-07-12 実測:
 * C:\Users\hppym\dev\terminal-app → C--Users-hppym-dev-terminal-app）。
 * munge は情報を落とす（日本語名は全て "-" になる）ため、JSONL 内の cwd フィールドで
 * 「本当にこのプロジェクトのセッションか」を必ず裏取りする。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractWorkText, normalizePath } from "./state-store";

/** transcript がこの時間以内に更新されていれば「動作中」として復元対象にする（切断判定の TRANSCRIPT_STALE_MS と対称） */
export const RECONNECT_ACTIVE_MS = 180_000;

/** transcript 末尾の走査量。直近のレコードから cwd 検証と workText 抽出ができれば足りる */
const TAIL_BYTES = 256 * 1024;

export interface LiveSessionInfo {
  sessionId: string;
  transcriptPath: string;
  mtimeMs: number;
  workText?: string;
}

export function mungeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptDirFor(projectPath: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".claude", "projects", mungeProjectPath(projectPath));
}

/** cwd がプロジェクト配下か（サブディレクトリ起動も同一プロジェクト扱い。matchProjectByCwd と同じ規則） */
function cwdBelongsTo(cwd: string, projectPath: string): boolean {
  const cwdN = normalizePath(cwd);
  const projN = normalizePath(projectPath);
  return cwdN === projN || cwdN.startsWith(projN + "\\");
}

/** JSONL 末尾チャンクを行単位でパースし、新しい順に返す（先頭行はチャンク境界で欠けうるため parse 失敗は捨てる） */
function tailRecords(filePath: string): Array<Record<string, unknown>> {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readLen = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    const lines = buf.toString("utf8").split("\n");
    const records: Array<Record<string, unknown>> = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>);
        }
      } catch {
        /* チャンク境界の欠け行・破損行はスキップ */
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

/** user レコードから表示用テキストを取り出す（tool_result・メタ・コマンド枠 <...> は対象外） */
function userTextOf(rec: Record<string, unknown>): string | undefined {
  if (rec.type !== "user" || rec.isMeta === true) return undefined;
  const message = rec.message as Record<string, unknown> | undefined;
  if (message === undefined || message === null || typeof message !== "object") return undefined;
  const content = message.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const block = content.find(
      (b: unknown): b is { type: string; text: string } =>
        b !== null && typeof b === "object" && (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    );
    text = block?.text;
  }
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  // <command-name> 等のシステム枠・キャベット文はユーザーの依頼文ではないため除外
  if (trimmed === "" || trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return undefined;
  return trimmed;
}

/**
 * プロジェクトの transcript ディレクトリから「直近 activeMs 以内に更新された」セッションを列挙する。
 * - agent-*.jsonl（サブエージェント記録）とサブディレクトリは対象外
 * - JSONL 内の cwd がプロジェクト配下であることを検証できたものだけ返す（munge の衝突対策）
 * - 更新が新しい順に返す
 */
export function scanLiveSessions(
  projectPath: string,
  opts?: { homeDir?: string; now?: number; activeMs?: number }
): LiveSessionInfo[] {
  const dir = transcriptDirFor(projectPath, opts?.homeDir);
  const now = opts?.now ?? Date.now();
  const activeMs = opts?.activeMs ?? RECONNECT_ACTIVE_MS;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // ディレクトリ無し = このプロジェクトの transcript がまだ無い
  }

  const found: LiveSessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.startsWith("agent-")) continue;
    const filePath = path.join(dir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > activeMs) continue; // 更新が止まって久しい = 動作中とみなさない

    const records = tailRecords(filePath);
    // cwd の裏取り: 末尾側の直近レコードに cwd があり、プロジェクト配下であること
    const cwdRec = records.find((r) => typeof r.cwd === "string");
    if (cwdRec === undefined || !cwdBelongsTo(cwdRec.cwd as string, projectPath)) continue;

    let workText: string | undefined;
    for (const rec of records) {
      const text = userTextOf(rec);
      if (text !== undefined) {
        workText = extractWorkText(text);
        break;
      }
    }
    found.push({ sessionId: entry.name.slice(0, -".jsonl".length), transcriptPath: filePath, mtimeMs, workText });
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
