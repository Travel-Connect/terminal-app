/**
 * Jev に聞く「小さな判断」の定義と解釈（260922_2）。純関数のみ（I/O は jev-client.ts / index.ts）。
 *
 * 4 つの判定:
 * 1. 返答待ち（pending question）: Stop（作業終了）時、Claude の最後の返答が「ユーザーへの質問・判断依頼で
 *    終わっている」か。yes なら「完了」ではなく「返答待ち」（確認待ちと同じ扱い = 青の点滅・左上）にする
 * 2. 確認待ちの危険度（danger）: 許可待ちのツール呼び出しが「取り消せない操作」「外部へ送る操作」か。
 *    該当すればタイルに赤い印を出す（複数の確認待ちが並んだとき先に見るべきものが分かる）
 * 3. 作業テキストの上書き防止（work text）: 短いプロンプト（「はい」「OK」「続けて」等）が「作業内容を表す文」か。
 *    no なら前の作業テキストを残す
 * 4. 停滞の疑い（stall）: 実行中セッションの直近の手順が「同じ失敗の繰り返し」「進展なし」か。
 *    yes ならタイルに注意印を出す
 *
 * 設計指針（公式 docs「How to build」/ Obsidian ノートの結論に従う）:
 * - 1 問で大きく聞かず、小さな yes/no（noul）に分けてコードで合成する
 * - 閾値は最初は高め。危険度のように「見逃しより誤検知の方が安い」判定だけ低めにする
 * - 「不明」への逃げ道: 判定材料が短すぎる・空のときは Jev に聞かず「判定なし」にする（precheck）
 * - noul と choice で数値が一致しない（jaggedness）ため、型をまたいで閾値を使い回さない
 */
import type { JevAnswers, JevQuestion } from "./jev-client";

/** state に載せる文字数の上限（32k トークン制限とコスト・context rot の両方を避ける） */
export const STATE_MAX_CHARS = 6_000;

/** 末尾優先で切り詰める（結論・最後の質問は文末に来るため） */
export function tailClip(text: string, max: number = STATE_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max + 1)}`;
}

const noul = (instructions: string): JevQuestion => ({ type: "noul", instructions });

/* ---------------- 1. 返答待ち ---------------- */

/** 返答待ちと判定する asks_user の下限。誤って「返答待ち」にすると完了が隠れるため高め */
export const PENDING_QUESTION_THRESHOLD = 0.7;
/** これより短い返答は判定しない（「了解」等の相槌に質問は無い） */
export const PENDING_QUESTION_MIN_CHARS = 12;

export function pendingQuestionQuestions(): Record<string, JevQuestion> {
  return {
    asks_user: noul(
      "The assistant's final message asks the user a question, asks the user to choose between options, " +
        "or asks the user to make a decision or provide information, and the assistant is waiting for the user's reply before it can continue. " +
        "The message may be written in Japanese."
    ),
    is_report: noul(
      "The message is a completion report or summary of finished work that does not require any reply from the user " +
        "(it may offer optional follow-ups, but the work is done)."
    ),
    wants_permission: noul(
      "The message explicitly asks the user for permission or approval to perform a specific action before doing it " +
        "(e.g. 'May I delete...', 'Should I proceed with...', '実行してよいですか')."
    ),
  };
}

export interface PendingQuestionVerdict {
  pending: boolean;
  /** asks_user の確率（ログ用） */
  p: number;
  /** 判定の要約（ログ用） */
  detail: string;
}

/** state 用: 最後の返答本文。短すぎれば null（Jev に聞かない） */
export function pendingQuestionState(lastAssistantText: string | undefined): string | null {
  const text = (lastAssistantText ?? "").trim();
  if (text.length < PENDING_QUESTION_MIN_CHARS) return null;
  return tailClip(text);
}

export function interpretPendingQuestion(answers: JevAnswers | null): PendingQuestionVerdict | null {
  if (answers === null) return null;
  const asks = answers.asks_user?.type === "noul" ? answers.asks_user.noul : undefined;
  if (asks === undefined) return null;
  const report = answers.is_report?.type === "noul" ? answers.is_report.noul : 0;
  const perm = answers.wants_permission?.type === "noul" ? answers.wants_permission.noul : 0;
  // 質問または許可依頼が強く、かつ「完了報告」の方が強くない → 返答待ち
  const signal = Math.max(asks, perm);
  const pending = signal >= PENDING_QUESTION_THRESHOLD && signal > report;
  return { pending, p: signal, detail: `asks_user=${asks.toFixed(2)} wants_permission=${perm.toFixed(2)} is_report=${report.toFixed(2)}` };
}

/* ---------------- 2. 確認待ちの危険度 ---------------- */

/** 危険の印を出す下限。見逃しより誤検知の方が安い（印が付くだけ）ので低め */
export const DANGER_THRESHOLD = 0.6;

export function dangerQuestions(): Record<string, JevQuestion> {
  return {
    irreversible: noul(
      "The requested tool call would delete, overwrite, or irreversibly change files, data, git history, or system state " +
        "(examples: rm / del / Remove-Item, git push --force, git reset --hard, git clean, DROP TABLE, truncating or overwriting files, " +
        "killing processes, uninstalling software, changing system settings)."
    ),
    external: noul(
      "The requested tool call sends data outside the local machine or publishes something " +
        "(examples: git push, deploying, HTTP requests to external services, posting messages, sending email, uploading files)."
    ),
    broad_scope: noul(
      "The requested tool call affects many files or the whole repository/system at once rather than a single small target " +
        "(examples: recursive operations on a directory, wildcard deletes, bulk renames, global installs)."
    ),
  };
}

export interface ToolCallSummary {
  name: string;
  /** JSON 化した input（呼び出し側で切り詰め済み） */
  input: string;
}

/** state 用: 許可待ちのツール呼び出し。無ければ null（Jev に聞かない） */
export function dangerState(call: ToolCallSummary | undefined, notificationMessage: string | undefined): string | null {
  if (call === undefined) return null;
  const lines = [`Tool: ${call.name}`, `Input: ${tailClip(call.input, 3_000)}`];
  if (notificationMessage !== undefined && notificationMessage !== "") lines.push(`Notification: ${notificationMessage}`);
  return lines.join("\n");
}

export interface DangerVerdict {
  /** 表示文言（例「取り消せない操作・外部へ送る操作」）。該当なしは undefined */
  text?: string;
  detail: string;
}

export function interpretDanger(answers: JevAnswers | null): DangerVerdict | null {
  if (answers === null) return null;
  const get = (k: string): number | undefined => (answers[k]?.type === "noul" ? (answers[k] as { noul: number }).noul : undefined);
  const irreversible = get("irreversible");
  const external = get("external");
  const broad = get("broad_scope");
  if (irreversible === undefined && external === undefined && broad === undefined) return null;
  const labels: string[] = [];
  if ((irreversible ?? 0) >= DANGER_THRESHOLD) labels.push("取り消せない操作");
  if ((external ?? 0) >= DANGER_THRESHOLD) labels.push("外部へ送る操作");
  if ((broad ?? 0) >= DANGER_THRESHOLD) labels.push("広範囲に影響");
  const fmt = (v: number | undefined): string => (v === undefined ? "-" : v.toFixed(2));
  return {
    text: labels.length > 0 ? labels.join("・") : undefined,
    detail: `irreversible=${fmt(irreversible)} external=${fmt(external)} broad_scope=${fmt(broad)}`,
  };
}

/* ---------------- 3. 作業テキストの上書き防止 ---------------- */

/** これ以下の長さのプロンプトだけ Jev に聞く（長い文はほぼ作業指示。呼び出し回数の抑制） */
export const WORK_TEXT_SHORT_CHARS = 40;
/** 「作業内容を表す文」とみなす下限 */
export const WORK_TEXT_TASK_THRESHOLD = 0.5;

export function workTextQuestions(): Record<string, JevQuestion> {
  return {
    is_task: noul(
      "The user's message describes a task, instruction, or request that tells the assistant what work to do " +
        "(a new topic or concrete work item), as opposed to a brief acknowledgement, approval, yes/no answer, " +
        "'continue'/'go ahead', a choice like 'A' or 'B', or a one-word reply. The message may be in Japanese."
    ),
  };
}

/**
 * 判定が必要か（precheck）: 前の作業テキストがあり、新しいプロンプトが短いときだけ。
 * それ以外は従来どおり無条件に置き換える
 */
export function shouldJudgeWorkText(prompt: string | undefined, previousWorkText: string | undefined): boolean {
  if (prompt === undefined || previousWorkText === undefined || previousWorkText === "") return false;
  const trimmed = prompt.trim();
  return trimmed !== "" && trimmed.length <= WORK_TEXT_SHORT_CHARS;
}

export interface WorkTextVerdict {
  /** true = 作業指示なので置き換える。false = 相槌・返答なので前の文を残す */
  replace: boolean;
  p: number;
}

export function interpretWorkText(answers: JevAnswers | null): WorkTextVerdict | null {
  if (answers === null || answers.is_task?.type !== "noul") return null;
  const p = answers.is_task.noul;
  return { replace: p >= WORK_TEXT_TASK_THRESHOLD, p };
}

/* ---------------- 4. 停滞の疑い ---------------- */

/** 停滞と判定する下限。誤検知は「注意印が出るだけ」だが実行中のタイルに毎回出ると邪魔なので高め */
export const STALL_THRESHOLD = 0.75;
/** 判定に必要な最小手順数（tool_use + tool_result の対）。これ未満は「まだ分からない」 */
export const STALL_MIN_STEPS = 4;
/** 同じセッションに再度聞くまでの最小間隔（コスト・レート制限の抑制） */
export const STALL_MIN_INTERVAL_MS = 60_000;

export interface StepSummary {
  /** "tool_use" | "tool_result" | "text" */
  kind: "tool_use" | "tool_result" | "text";
  /** tool_use: ツール名＋主要引数 / tool_result: 結果の抜粋 / text: 返答の抜粋 */
  text: string;
  /** tool_result のみ: is_error */
  error?: boolean;
}

export function stallQuestions(): Record<string, JevQuestion> {
  return {
    repeating_failure: noul(
      "The agent is repeating the same or nearly the same action that keeps failing with the same error, " +
        "without materially changing its approach."
    ),
    no_progress: noul(
      "The recent steps show no progress toward completing the task: going in circles, re-reading the same files repeatedly, " +
        "undoing and redoing the same edits, or retrying identical commands."
    ),
    making_progress: noul(
      "The recent steps show the agent making steady progress: each step builds on the previous one, errors are resolved, " +
        "and new files or results appear."
    ),
  };
}

/** state 用: 直近の手順を古い順の箇条書きに。手順が少なければ null（Jev に聞かない） */
export function stallState(stepsOldestFirst: readonly StepSummary[]): string | null {
  const steps = stepsOldestFirst.filter((s) => s.kind !== "text");
  if (steps.length < STALL_MIN_STEPS) return null;
  const lines = stepsOldestFirst.map((s, i) => {
    const tag = s.kind === "tool_use" ? "CALL" : s.kind === "tool_result" ? (s.error === true ? "RESULT(error)" : "RESULT") : "ASSISTANT";
    return `${i + 1}. ${tag}: ${s.text.replace(/\s+/g, " ").slice(0, 400)}`;
  });
  return tailClip(`Recent steps of a coding agent (oldest first):\n${lines.join("\n")}`);
}

export interface StallVerdict {
  /** 表示文言。該当なしは undefined */
  text?: string;
  detail: string;
}

export function interpretStall(answers: JevAnswers | null): StallVerdict | null {
  if (answers === null) return null;
  const get = (k: string): number | undefined => (answers[k]?.type === "noul" ? (answers[k] as { noul: number }).noul : undefined);
  const repeating = get("repeating_failure");
  const noProgress = get("no_progress");
  const progress = get("making_progress");
  if (repeating === undefined && noProgress === undefined) return null;
  const fmt = (v: number | undefined): string => (v === undefined ? "-" : v.toFixed(2));
  const detail = `repeating_failure=${fmt(repeating)} no_progress=${fmt(noProgress)} making_progress=${fmt(progress)}`;
  // 「進展あり」が強ければ停滞にしない（相反する信号の合成）
  const stalled = (progress ?? 0) < STALL_THRESHOLD;
  if (stalled && (repeating ?? 0) >= STALL_THRESHOLD) return { text: "停滞の疑い・同じ失敗を繰り返し", detail };
  if (stalled && (noProgress ?? 0) >= STALL_THRESHOLD) return { text: "停滞の疑い・進展なし", detail };
  return { detail };
}
