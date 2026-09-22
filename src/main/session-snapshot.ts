/**
 * セッション表示の保存・復元（260922_7）。
 *
 * セッション状態はもともと揮発仕様（再起動で全タイル「待機」）だったが、実運用では
 * 「どのタイルが自分の返答を待っているか」を再起動後も続けて見たい（2026-09-22 の依頼）。
 * 起動時復元（260922_3）は transcript と登録簿から作り直すため、
 * hook でしか分からない状態（権限確認の「確認待ち」）と Jev の判定結果（返答待ち・危険度・停滞・名前の印）が失われる。
 *
 * そこで「アプリが見ていた状態」をファイルに残し、起動時に**実データと突き合わせてから**取り込む:
 * - プロジェクトが消えていたら捨てる
 * - Claude Code の登録簿でプロセスが居なければ捨てる（閉じたターミナルの残骸を復活させない）
 * - 保存時より transcript が進んでいたら、状態は終端分類で作り直す（古い「確認待ち」を貼り付けない）
 * - transcript が動いていなければ、保存した状態をそのまま使う（= 続きから見える）
 *
 * ファイルは <dataDir>/sessions.json。壊れていれば黙って無視する（表示は従来どおり作り直される）。
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./hooks-manager";
import type { PersistedSession } from "./state-store";

export const SESSION_SNAPSHOT_VERSION = 1;
/** 保存から時間が経ちすぎた記録は使わない（長期間閉じていた場合は作り直す方が正しい） */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

/** 保存する 1 件（セッション記録 ＋ 保存時点の transcript 更新時刻） */
export interface SnapshotEntry extends PersistedSession {
  /** 保存時の transcript mtime（epoch ms）。取得不可なら未設定 */
  transcriptMtimeMs?: number;
}

export interface SnapshotFile {
  version: number;
  savedAt: number;
  sessions: SnapshotEntry[];
}

export function snapshotPath(dataDir: string): string {
  return path.join(dataDir, "sessions.json");
}

/** 保存（原子的）。呼び出し側で間引く */
export function saveSessionSnapshot(dataDir: string, sessions: readonly SnapshotEntry[], now: number): void {
  const body: SnapshotFile = { version: SESSION_SNAPSHOT_VERSION, savedAt: now, sessions: [...sessions] };
  writeFileAtomic(snapshotPath(dataDir), `${JSON.stringify(body, null, 2)}\n`);
}

/** 読み込み。無い・壊れている・版が違う・古すぎるは null（従来どおり作り直す） */
export function loadSessionSnapshot(dataDir: string, now: number, maxAgeMs: number = SNAPSHOT_MAX_AGE_MS): SnapshotFile | null {
  let text: string;
  try {
    text = fs.readFileSync(snapshotPath(dataDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const file = parsed as Partial<SnapshotFile>;
  if (file.version !== SESSION_SNAPSHOT_VERSION || typeof file.savedAt !== "number" || !Array.isArray(file.sessions)) return null;
  if (now - file.savedAt > maxAgeMs) return null;
  const sessions = file.sessions.filter(
    (s): s is SnapshotEntry =>
      s !== null && typeof s === "object" && typeof s.sessionId === "string" && typeof s.projectId === "string" && typeof s.state === "string"
  );
  return { version: file.version, savedAt: file.savedAt, sessions };
}

export interface ReconcileDeps {
  now(): number;
  /** プロジェクトがまだ登録されているか */
  projectExists(projectId: string): boolean;
  /** Claude Code の登録簿による生死（session-registry.classifyLiveness を注入） */
  liveness(sessionId: string): "alive" | "dead" | "unknown";
  /** transcript の mtime（epoch ms）。取得不可は null */
  mtimeMs(path: string): number | null;
  /** transcript 終端の分類（session-scan.turnEndOf を注入） */
  turnEnd(path: string): "concluded" | "open" | "unknown";
}

export interface ReconcileResult {
  /** 取り込むセッション（状態は突き合わせ済み） */
  keep: PersistedSession[];
  /** 捨てた件数の内訳（ログ用） */
  dropped: { project: number; dead: number };
  /** transcript が進んでいたため状態を作り直した件数（ログ用） */
  refreshed: number;
}

/**
 * 保存した記録を実データと突き合わせる（純関数）。
 * transcript が進んでいた場合は、その場の終端分類で「実行中／完了」に作り直し、
 * Jev 由来の印（返答待ち・危険度・停滞）は落とす — 古い判定を貼り付けないため。
 */
export function reconcileSnapshot(entries: readonly SnapshotEntry[], deps: ReconcileDeps): ReconcileResult {
  const keep: PersistedSession[] = [];
  const dropped = { project: 0, dead: 0 };
  let refreshed = 0;
  const now = deps.now();
  for (const entry of entries) {
    if (!deps.projectExists(entry.projectId)) {
      dropped.project += 1;
      continue;
    }
    if (deps.liveness(entry.sessionId) === "dead") {
      dropped.dead += 1;
      continue;
    }
    const { transcriptMtimeMs, ...rec } = entry;
    if (rec.transcriptPath === undefined) {
      keep.push(rec);
      continue;
    }
    const mtime = deps.mtimeMs(rec.transcriptPath);
    if (mtime === null || transcriptMtimeMs === undefined || mtime <= transcriptMtimeMs) {
      keep.push(rec); // 動いていない = 保存時のまま（確認待ち・返答待ち・印がそのまま残る）
      continue;
    }
    // 保存後に作業が進んだ → その場の終端で作り直す
    refreshed += 1;
    const turn = deps.turnEnd(rec.transcriptPath);
    const next: PersistedSession = {
      sessionId: rec.sessionId,
      projectId: rec.projectId,
      state: turn === "concluded" ? "done" : "running",
      lastEventAt: Math.max(rec.lastEventAt, mtime),
      firstSeenAt: rec.firstSeenAt,
    };
    if (turn !== "concluded") next.runningSince = now;
    if (rec.workText !== undefined) next.workText = rec.workText;
    if (rec.transcriptPath !== undefined) next.transcriptPath = rec.transcriptPath;
    if (rec.nameHint !== undefined) next.nameHint = rec.nameHint; // 名前の印は状態に依存しないので残す
    keep.push(next);
  }
  return { keep, dropped, refreshed };
}
