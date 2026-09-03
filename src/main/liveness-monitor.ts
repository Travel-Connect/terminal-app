/**
 * 切断検知（260712_2）: 「実行中」セッションの生死を transcript の更新時刻とウィンドウ存在で判定する。
 *
 * 背景: claude が異常終了・ターミナルごと閉じられた場合、SessionEnd hook は届かず
 * タイルが「実行中」のまま残り続ける（260712 課題A で確認済みの既知の限界）。
 * hook イベントの途絶は判定に使わない — 実行中は hook が来ないのが正常であるため。
 *
 * 判定規則（両シグナルの併用。ユーザー合意 2026-07-12）:
 * - transcript 無更新が TRANSCRIPT_STALE_MS 以上 かつ プロジェクトのウィンドウが見つからない → 切断
 * - transcript 無更新が TRANSCRIPT_STALE_HARD_MS 以上 → ウィンドウが残っていても切断
 *   （claude だけ落ちてシェルのウィンドウが残るケース。ウィンドウ存在は生存の証明にならない）
 * - transcript パス不明・mtime 取得不可・ウィンドウ判定不能（koffi なし）は安全側 = 切断にしない。
 *   ウィンドウ判定はタイトル一致のヒューリスティックで偽陰性がある（タブ切替等）ため、
 *   短い閾値側は「両方成立」を要求して誤検知を抑える。
 */

export interface SweepTarget {
  sessionId: string;
  projectId: string;
  transcriptPath?: string;
}

export interface SweepDeps {
  now(): number;
  /** transcript ファイルの mtime（epoch ms）。取得不可（不存在・権限）は null */
  mtimeMs(path: string): number | null;
  /** プロジェクトのウィンドウが存在するか。null = 判定不能（koffi 未ロード等） */
  windowPresent(projectId: string): boolean | null;
}

/** 検証用の env 上書き（--demo / TERMINAL_APP_DATA_DIR と同系の検証フラグ。実運用では未設定 = 既定値） */
function envMs(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 掃引間隔（既定 15 秒。260904_1 #2 で 30 秒から短縮 — 終了検知・切断検知・確認待ちからの復帰を早める）。
 * index.ts の setInterval で使用
 */
export const DISCONNECT_CHECK_INTERVAL_MS = envMs("TERMINAL_APP_LIVENESS_INTERVAL_MS", 15_000);
/** transcript 無更新がこの時間を超え、かつウィンドウ消失で「切断」（応答生成中は transcript が更新され続ける前提。既定 3 分） */
export const TRANSCRIPT_STALE_MS = envMs("TERMINAL_APP_TRANSCRIPT_STALE_MS", 180_000);
/** transcript 無更新がこの時間を超えたら、ウィンドウが残っていても「切断」（長時間ツール実行の誤検知を避ける余裕。既定 15 分） */
export const TRANSCRIPT_STALE_HARD_MS = envMs("TERMINAL_APP_TRANSCRIPT_STALE_HARD_MS", 15 * 60_000);
/** 終了検知（260712_4）: transcript 無更新がこの時間以上のものだけ終端分類する（ターン境界・Stop 配送中との競合回避。既定 10 秒） */
export const CONCLUDED_MIN_AGE_MS = envMs("TERMINAL_APP_CONCLUDED_MIN_AGE_MS", 10_000);
/**
 * 確認待ちからの復帰（260904_1 #2）: 確認待ちイベントからこの時間以上経った transcript 更新だけを
 * 「許可後の作業再開」とみなす（通知直後に transcript が書き終わる競合を除外。既定 3 秒）
 */
export const CONFIRM_RESUME_MARGIN_MS = envMs("TERMINAL_APP_CONFIRM_RESUME_MARGIN_MS", 3_000);
/** 確認待ちからの復帰: 確認待ちになってからこの時間未満は判定しない（登録簿 status の更新競合を避ける。既定 5 秒） */
export const CONFIRM_RESUME_MIN_AGE_MS = envMs("TERMINAL_APP_CONFIRM_RESUME_MIN_AGE_MS", 5_000);

export interface ConfirmTarget extends SweepTarget {
  /** 確認待ちへ遷移したイベントの時刻（epoch ms） */
  lastEventAt: number;
}

export interface ConfirmResumeDeps {
  now(): number;
  /** transcript ファイルの mtime（epoch ms）。取得不可は null */
  mtimeMs(path: string): number | null;
  /** Claude Code の登録簿 status（busy / waiting / idle）。無ければ undefined（session-registry.registryStatusOf を注入） */
  registryStatus(sessionId: string): string | undefined;
}

export interface ConfirmResumeHit {
  target: ConfirmTarget;
  /** 何を根拠に復帰させたか（ログ用）: 登録簿が busy / transcript が通知後に更新 */
  reason: "registry" | "transcript";
}

/**
 * 確認待ち → 実行中の復帰検知（260904_1 #2）。
 *
 * 背景: 権限確認（Notification）→ ユーザーが許可 → Claude が作業再開、の「許可」には hook が無く、
 * 次の Stop / Notification が来るまでタイルが「確認待ち」のまま残っていた
 * （実ログ 2026-09-03 20:27〜20:41 UTC: 商品登録アプリで permission → confirm が 4 回続き、間に running なし）。
 * 根拠は 2 系統（どちらかで復帰）:
 * - 登録簿 status が busy（Claude Code 自身の申告。cli 起動のみ載る）
 * - transcript の mtime が確認待ちイベント時刻 ＋ 余裕（CONFIRM_RESUME_MARGIN_MS）以降
 *   （許可後のツール実行結果が書き込まれる。アイドル通知（入力待ち）では transcript は動かない）
 * 確認待ちになった直後（CONFIRM_RESUME_MIN_AGE_MS 未満）は判定しない。
 */
export function findResumedFromConfirm(targets: readonly ConfirmTarget[], deps: ConfirmResumeDeps): ConfirmResumeHit[] {
  const out: ConfirmResumeHit[] = [];
  const now = deps.now();
  for (const t of targets) {
    if (now - t.lastEventAt < CONFIRM_RESUME_MIN_AGE_MS) continue;
    if (deps.registryStatus(t.sessionId) === "busy") {
      out.push({ target: t, reason: "registry" });
      continue;
    }
    if (t.transcriptPath === undefined) continue;
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue;
    if (mtime >= t.lastEventAt + CONFIRM_RESUME_MARGIN_MS) out.push({ target: t, reason: "transcript" });
  }
  return out;
}

export interface ConcludedSweepDeps {
  now(): number;
  /** transcript ファイルの mtime（epoch ms）。取得不可（不存在・権限）は null */
  mtimeMs(path: string): number | null;
  /** transcript 終端の分類（session-scan.turnEndOf を注入。concluded 以外は対象外） */
  turnEnd(path: string): "concluded" | "open" | "unknown";
}

/**
 * 終了検知（260712_4）: 「実行中」のうち、transcript 終端がターン完了を示すものを返す。
 *
 * 背景: 割り込み（Esc）では Stop hook が発火しない（2026-07-11 実測 — transcript に
 * stop_hook_summary が無く "[Request interrupted by user for tool use]" のみ残る）。
 * その場合「実行中」から抜ける経路が無く、ウィンドウが生きている限り
 * 切断検知（HARD 15 分）までスピナーが回り続けた。呼び出し側はヒットを「完了」へ遷移させる。
 * 切断判定より先に適用する — 終了済みセッションを「切断」と誤表示しないため。
 */
export function findConcluded(targets: readonly SweepTarget[], deps: ConcludedSweepDeps): SweepTarget[] {
  const out: SweepTarget[] = [];
  for (const t of targets) {
    if (t.transcriptPath === undefined) continue; // 実データが無ければ判定しない（安全側）
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue;
    if (deps.now() - mtime < CONCLUDED_MIN_AGE_MS) continue; // 直後は Stop が配送中かもしれない
    if (deps.turnEnd(t.transcriptPath) === "concluded") out.push(t);
  }
  return out;
}

/**
 * 1 回の掃引: 対象（実行中セッション）のうち切断と判定されたものを返す。
 * 純関数（依存は deps で注入）— 単体テスト対象。
 */
export function findDisconnected(targets: readonly SweepTarget[], deps: SweepDeps): SweepTarget[] {
  const out: SweepTarget[] = [];
  for (const t of targets) {
    if (t.transcriptPath === undefined) continue; // 実データが無ければ判定しない（安全側）
    const mtime = deps.mtimeMs(t.transcriptPath);
    if (mtime === null) continue; // stat 失敗（消失・権限）も安全側 — 一時的な失敗で切断を誤宣言しない
    const age = deps.now() - mtime;
    if (age >= TRANSCRIPT_STALE_HARD_MS) {
      out.push(t);
    } else if (age >= TRANSCRIPT_STALE_MS && deps.windowPresent(t.projectId) === false) {
      out.push(t);
    }
  }
  return out;
}
