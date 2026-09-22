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
 * - 登録簿 status が busy のセッションは切断しない（260907_1 R4。同期 fork・codex 待ちで本体 transcript が
 *   長く止まっても Claude Code 自身は「作業中」と申告している）。
 */

export interface SweepTarget {
  sessionId: string;
  projectId: string;
  transcriptPath?: string;
}

export interface SweepDeps {
  now(): number;
  /** transcript の最終活動時刻（epoch ms）。取得不可（不存在・権限）は null。呼び出し側は subagent 記録も含めた値を渡す（260907_1） */
  mtimeMs(path: string): number | null;
  /** プロジェクトのウィンドウが存在するか。null = 判定不能（koffi 未ロード等） */
  windowPresent(projectId: string): boolean | null;
  /** Claude Code の登録簿 status（busy / waiting / idle）。省略・undefined なら従来どおり transcript のみで判定（260907_1 R4） */
  registryStatus?(sessionId: string): string | undefined;
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
/**
 * 完了・切断からの復帰（260907_1 R1）: Stop（最終イベント）からこの時間未満は登録簿 busy を信じない。
 * 登録簿は Stop と同じ秒に idle へ切り替わる（2026-09-07 実測）ため、この猶予を過ぎても busy なら
 * 「Stop hook が block して続行中」か「別の作業が続いている」。既定 3 秒
 */
export const STOPPED_RESUME_MIN_AGE_MS = envMs("TERMINAL_APP_STOPPED_RESUME_MIN_AGE_MS", 3_000);
/**
 * block 痕跡の許容ずれ（260907_1 R2）: stop_hook_summary の timestamp は hook 完了後に書かれるため本来は
 * Stop 受信より新しいが、時計・書き込み順のずれに備えて最終イベントよりこの時間だけ前まで許容する
 */
export const BLOCKED_STOP_MARGIN_MS = 2_000;

/**
 * サブエージェント（バックグラウンドエージェント）待ちと判定する余裕（260922_8）。
 * Stop の直前に終わった subagent の書き込みを「まだ動いている」と誤認しないための下駄
 */
export const SUBAGENT_RESUME_MARGIN_MS = 3_000;

/**
 * subagent 記録がこの時間内に更新されていれば「バックグラウンドのエージェントが作業中」とみなす（260922_8）。
 * 終了検知（findConcluded）の対象から外す判断に使う — 外さないと
 * 「完了へ降格 → サブエージェント待ちで実行中へ復帰」を掃引のたびに繰り返す
 */
export const SUBAGENT_ACTIVE_WINDOW_MS = 60_000;

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

/** block された Stop の痕跡（session-scan.findBlockedStop の戻り値。260907_1 R2） */
export interface BlockedStop {
  /** stop_hook_summary の timestamp（epoch ms） */
  at: number;
  /** block 理由（hook の reason。空のこともある） */
  reason: string;
}

export interface StoppedTarget extends SweepTarget {
  state: "done" | "disconnected";
  /** 完了（Stop 受信）または切断判定の時刻（epoch ms） */
  lastEventAt: number;
}

export interface StoppedResumeDeps {
  now(): number;
  /** Claude Code の登録簿 status（busy / waiting / idle）。無ければ undefined */
  registryStatus(sessionId: string): string | undefined;
  /** transcript 終端の分類（session-scan.turnEndOf を注入） */
  turnEnd(path: string): "concluded" | "open" | "unknown";
  /** sinceMs 以降の block 痕跡（session-scan.blockedStopOf を注入） */
  blockedStop(path: string, sinceMs: number): BlockedStop | null;
  /** 本体 transcript と subagent 記録の新しい方の mtime（session-scan.activityMtimeMs を注入）。取得不可は null */
  activityMtimeMs(path: string): number | null;
  /**
   * subagent 記録だけの mtime（session-scan.subagentMtimeMs を注入。260922_8）。
   * 省略時は常に null = サブエージェント待ちの判定をしない（既存呼び出しとの互換）
   */
  subagentMtimeMs?(path: string): number | null;
}

export interface StoppedResumeHit {
  target: StoppedTarget;
  /** 何を根拠に復帰させたか（ログ用）: 登録簿が busy / Stop hook が続行を指示 / 切断後に transcript 更新 / サブエージェントが作業中 */
  reason: "registry" | "blocked-stop" | "transcript" | "subagent";
  /** reason=blocked-stop のとき: block 理由（作業テキストのラベルに使う） */
  blockReason?: string;
}

/**
 * 完了・切断 → 実行中の復帰検知（260907_1 R1〜R3）。
 *
 * 背景: 品質ループ（eval-loop）中に (a) 司令塔が途中で応答を終える → eval-loop の Stop hook が block して続行、
 * でも本アプリの Stop hook は同時に「完了」を送る、(b) 同期 fork や codex 待ちで本体 transcript が止まり
 * 「切断」になる、の 2 経路で「まだ作業中なのに完了・切断のまま」になっていた（2026-09-07 実測）。
 * 完了・切断から実行中へ戻す経路は次のプロンプト（UserPromptSubmit）しか無かった。
 *
 * 根拠は 3 系統（上から順に評価し、最初に成立したものを理由にする）:
 * - R1 登録簿 status が busy、かつ transcript 終端が concluded でない（busy が古いまま残る事故への保険。
 *   transcript 不明・unknown は busy を信じる）。最終イベントから STOPPED_RESUME_MIN_AGE_MS 未満は判定しない
 * - R2 transcript に最終イベント−BLOCKED_STOP_MARGIN_MS 以降の block 痕跡（preventedContinuation=true）がある。
 *   登録簿 status の無い Cursor 起動でも使える
 * - R3 切断中のセッションで、本体または subagent 記録が切断判定より後に更新された。
 *   完了（done）には適用しない — Stop の後にも stop_hook_summary / turn_duration / メタが書かれるため
 */
export function findResumedFromStopped(targets: readonly StoppedTarget[], deps: StoppedResumeDeps): StoppedResumeHit[] {
  const out: StoppedResumeHit[] = [];
  const now = deps.now();
  for (const t of targets) {
    if (now - t.lastEventAt < STOPPED_RESUME_MIN_AGE_MS) continue;
    if (deps.registryStatus(t.sessionId) === "busy") {
      if (t.transcriptPath === undefined || deps.turnEnd(t.transcriptPath) !== "concluded") {
        out.push({ target: t, reason: "registry" });
        continue;
      }
    }
    if (t.transcriptPath === undefined) continue;
    const blocked = deps.blockedStop(t.transcriptPath, t.lastEventAt - BLOCKED_STOP_MARGIN_MS);
    if (blocked !== null) {
      out.push({ target: t, reason: "blocked-stop", blockReason: blocked.reason });
      continue;
    }
    // R5 サブエージェント待ち（260922_8）: 本体が終わっていても subagent 記録が Stop・切断より後に
    // 更新されていれば、バックグラウンドエージェントが作業中 = まだ「実行中」。
    // 本体 transcript は見ない（Stop 直後の後片付けを拾ってしまうため）
    const sub = deps.subagentMtimeMs?.(t.transcriptPath) ?? null;
    if (sub !== null && sub > t.lastEventAt + SUBAGENT_RESUME_MARGIN_MS) {
      out.push({ target: t, reason: "subagent" });
      continue;
    }
    if (t.state === "disconnected") {
      const m = deps.activityMtimeMs(t.transcriptPath);
      if (m !== null && m > t.lastEventAt) out.push({ target: t, reason: "transcript" });
    }
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
    if (deps.registryStatus?.(t.sessionId) === "busy") continue; // 登録簿が作業中と申告している間は切断しない（260907_1 R4）
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

/* ---------------- 返答待ちからの復帰（260922_4） ---------------- */

/** 「返答待ち」にしてから復帰判定を始めるまでの猶予（Stop 直後の後片付けと判定処理の重なりを避ける） */
export const QUESTION_RESUME_MIN_AGE_MS = envMs("TERMINAL_APP_QUESTION_RESUME_MIN_AGE_MS", 3_000);

export interface QuestionTarget extends SweepTarget {
  /** Stop を受けた（または終了検知した）時刻。block 痕跡の探索起点・タイルの「返答待ち・N分前」の起点 */
  stoppedAt: number;
  /** 「返答待ち」にした時刻。活動の比較基準（Stop 直後に書かれる後片付けレコードを再開と誤認しないため） */
  pendingSince: number;
}

export interface QuestionResumeDeps {
  now(): number;
  /** subagent 記録だけの mtime（260922_8）。省略時は判定しない */
  subagentMtimeMs?(path: string): number | null;
  /** Claude Code の登録簿 status（busy / waiting / idle）。無ければ undefined */
  registryStatus(sessionId: string): string | undefined;
  /** transcript 終端の分類（session-scan.turnEndOf を注入） */
  turnEnd(path: string): "concluded" | "open" | "unknown";
  /** sinceMs 以降の block 痕跡（session-scan.blockedStopOf を注入） */
  blockedStop(path: string, sinceMs: number): BlockedStop | null;
}

export interface QuestionResumeHit {
  target: QuestionTarget;
  /** 何を根拠に戻したか: 登録簿が busy / Stop hook が続行を指示 / ターンが再開 / サブエージェントが作業中 */
  reason: "registry" | "blocked-stop" | "turn-open" | "subagent";
  blockReason?: string;
}

/**
 * 返答待ち → 実行中の復帰検知（260922_4）。
 *
 * 背景: 「返答待ち」（Jev 判定）は実質「完了」の言い換えなので、完了・切断と同じ復帰経路が要る。
 * 導入直後の実ログ（2026-09-22 01:23:42 → 01:24:36）で、返答待ちにした直後に作業が進んでいるのに
 * 確認待ち用の復帰規則（transcript の mtime のみ）しか効かず、タイルが取り残されるケースが出た。
 *
 * 根拠は 3 系統（上から順に評価し、最初に成立したものを理由にする）:
 * - 登録簿 status が busy、かつ transcript 終端が concluded でない（busy の残骸への保険）
 * - transcript に block 痕跡（preventedContinuation=true）がある。Stop hook が遅れて書かれた場合も拾う
 * - transcript 終端が open = ターンが再開している（ユーザーが返答した／Claude が続行した）。
 *   mtime ではなく終端分類で見るため、後片付けの書き込みでは戻らない
 */
export function findResumedFromQuestion(targets: readonly QuestionTarget[], deps: QuestionResumeDeps): QuestionResumeHit[] {
  const out: QuestionResumeHit[] = [];
  const now = deps.now();
  for (const t of targets) {
    if (now - t.pendingSince < QUESTION_RESUME_MIN_AGE_MS) continue;
    const turn = t.transcriptPath === undefined ? "unknown" : deps.turnEnd(t.transcriptPath);
    if (deps.registryStatus(t.sessionId) === "busy" && turn !== "concluded") {
      out.push({ target: t, reason: "registry" });
      continue;
    }
    if (t.transcriptPath === undefined) continue;
    const blocked = deps.blockedStop(t.transcriptPath, t.stoppedAt - BLOCKED_STOP_MARGIN_MS);
    if (blocked !== null) {
      out.push({ target: t, reason: "blocked-stop", blockReason: blocked.reason });
      continue;
    }
    if (turn === "open") {
      out.push({ target: t, reason: "turn-open" });
      continue;
    }
    // サブエージェント待ち（260922_8）: 返答を待っているように見えても、裏でエージェントが動いていれば作業中
    const sub = deps.subagentMtimeMs?.(t.transcriptPath) ?? null;
    if (sub !== null && sub > t.stoppedAt + SUBAGENT_RESUME_MARGIN_MS) out.push({ target: t, reason: "subagent" });
  }
  return out;
}
