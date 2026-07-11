/**
 * ② 状態ストア（design.md 5 章 / REQ-03, REQ-04, REQ-08, REQ-10）。
 * - イベント受信スキーマ検証（design.md 4.8）
 * - イベント → 4 状態マッピング（design.md 4.3 / 4.8）
 * - 状態遷移（design.md 5.1）・複数セッションの直近イベント優先（design.md 5.2）
 * - cwd → プロジェクト対応付け: 最長一致プレフィックス（design.md 4.7）
 * - セッション状態は揮発（アプリ再起動で全タイル「待機」へ。design.md 5.1）
 */
import { EventEmitter } from "events";
import type { Project, SessionState, SessionView, StatusCounts } from "../shared/types";

/** 受理するイベント名（design.md 4.8）。UserPromptSubmit は自動追記対象（OPEN-04 案 A 採用）、SessionEnd は受信側のみ対応（OPEN-03） */
export const ACCEPTED_EVENT_NAMES = ["Stop", "Notification", "UserPromptSubmit", "SessionEnd"] as const;
export type HookEventName = (typeof ACCEPTED_EVENT_NAMES)[number];

export interface HookEvent {
  hook_event_name: HookEventName;
  session_id: string;
  cwd: string;
  message?: string;
  reason?: string;
  transcript_path?: string;
}

/** SessionEnd の正常終了 reason（design.md 4.8。これ以外・欠落は「エラー相当」と判定する） */
export const NORMAL_END_REASONS = new Set(["clear", "logout", "prompt_input_exit", "exit"]);

export type ValidationResult = { ok: true; event: HookEvent } | { ok: false; error: string };

/**
 * 受信ペイロードの検証（design.md 4.8: 必須 = hook_event_name / session_id / cwd がいずれも非空文字列。
 * 未知の hook_event_name は「未知イベント」として不正扱い → 呼び出し側で破棄＋ログ）
 */
export function validateEvent(payload: unknown): ValidationResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "payload はオブジェクトである必要があります" };
  }
  const p = payload as Record<string, unknown>;
  for (const field of ["hook_event_name", "session_id", "cwd"] as const) {
    if (typeof p[field] !== "string" || (p[field] as string).trim() === "") {
      return { ok: false, error: `必須フィールド ${field} が欠落または不正です` };
    }
  }
  const name = p.hook_event_name as string;
  if (!(ACCEPTED_EVENT_NAMES as readonly string[]).includes(name)) {
    return { ok: false, error: `未知の hook_event_name: ${name}` };
  }
  const event: HookEvent = {
    hook_event_name: name as HookEventName,
    session_id: p.session_id as string,
    cwd: p.cwd as string,
  };
  if (typeof p.message === "string") event.message = p.message;
  if (typeof p.reason === "string") event.reason = p.reason;
  if (typeof p.transcript_path === "string") event.transcript_path = p.transcript_path;
  return { ok: true, event };
}

/**
 * Notification message の種別分類（design.md 4.3）。
 * いずれの種別でも遷移先は「確認待ち」（安全側）。分類はログ・将来の出し分け用。
 */
export function classifyNotification(message: string | undefined): "permission" | "idle" | "other" {
  if (!message) return "other";
  const m = message.toLowerCase();
  if (m.includes("permission") || m.includes("許可")) return "permission";
  if (m.includes("waiting for") || m.includes("idle") || m.includes("入力待ち")) return "idle";
  return "other";
}

/**
 * イベント → 遷移先状態（design.md 4.3 / 4.8）。
 * - Stop → 完了（無条件）
 * - Notification → 確認待ち（message 種別によらず安全側に倒す）
 * - UserPromptSubmit → 実行中（OPEN-04 案 A 採用 — 2026-07-11。hooks へ自動追記される。design.md 4.1 / 4.5）
 * - SessionEnd → 正常終了 reason なら null（状態を変えず破棄・ログのみ）、それ以外は「エラー」（OPEN-03 の検知できた範囲）
 */
export function mapEventToState(evt: HookEvent): SessionState | null {
  switch (evt.hook_event_name) {
    case "Stop":
      return "done";
    case "Notification":
      return "confirm";
    case "UserPromptSubmit":
      return "running";
    case "SessionEnd":
      return evt.reason !== undefined && NORMAL_END_REASONS.has(evt.reason) ? null : "error";
  }
}

/** パス正規化（design.md 4.7: 大文字小文字非区別・区切り正規化） */
export function normalizePath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * cwd → プロジェクトの対応付け（design.md 4.7: 最長一致プレフィックス）。
 * サブディレクトリ起動は親プロジェクトに割り当てる。一致しなければ null（呼び出し側で破棄＋ログ）。
 */
export function matchProjectByCwd(cwd: string, projects: readonly Project[]): Project | null {
  const cwdN = normalizePath(cwd);
  let best: Project | null = null;
  let bestLen = -1;
  for (const p of projects) {
    const pN = normalizePath(p.path);
    if (cwdN === pN || cwdN.startsWith(pN + "\\")) {
      if (pN.length > bestLen) {
        best = p;
        bestLen = pN.length;
      }
    }
  }
  return best;
}

interface SessionRec {
  sessionId: string;
  projectId: string;
  state: SessionState;
  lastEventAt: number;
  runningSince?: number;
  lastMessage?: string;
}

export interface ApplyResult {
  projectId: string;
  sessionId: string;
  state: SessionState;
}

/**
 * セッション状態ストア本体。EventEmitter("changed") で UI 更新をトリガする。
 * now はテストから時刻を注入できるようにしてある。
 */
export class StateStore extends EventEmitter {
  private sessions = new Map<string, SessionRec>();

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }

  /**
   * 検証済みイベントを適用する（design.md 5.1 の遷移表）。
   * 戻り値 null = 破棄（未登録 cwd / 正常 SessionEnd）。
   */
  applyEvent(evt: HookEvent, projects: readonly Project[]): ApplyResult | null {
    const project = matchProjectByCwd(evt.cwd, projects);
    if (project === null) return null; // 破棄してログのみ（design.md 10 章）

    const mapped = mapEventToState(evt);
    if (mapped === null) return null; // 正常 SessionEnd: 状態を変えない

    const t = this.now();
    const existing = this.sessions.get(evt.session_id);
    const rec: SessionRec = existing ?? {
      sessionId: evt.session_id,
      projectId: project.id,
      state: "waiting",
      lastEventAt: t,
    };

    if (mapped === "running") {
      // 実行中への遷移: 経過時間の起点を記録（既に実行中なら継続 = 起点維持。design.md 5.1）
      if (rec.state !== "running" || rec.runningSince === undefined) rec.runningSince = t;
    } else {
      rec.runningSince = undefined;
    }
    rec.state = mapped;
    rec.lastEventAt = t;
    rec.projectId = project.id;
    if (evt.hook_event_name === "Notification") rec.lastMessage = evt.message;

    this.sessions.set(evt.session_id, rec);
    this.emit("changed");
    return { projectId: project.id, sessionId: evt.session_id, state: mapped };
  }

  /**
   * プロジェクトごとの表示セッション（design.md 5.2: 最終イベント時刻が最新のセッション）。
   * イベント未受信のプロジェクトは含まれない（= UI 側で「待機」タイル表示）。
   */
  displaySessions(projects: readonly Project[]): Record<string, SessionView> {
    const result: Record<string, SessionView> = {};
    for (const rec of this.sessions.values()) {
      const cur = result[rec.projectId];
      if (cur === undefined || rec.lastEventAt >= cur.lastEventAt) {
        result[rec.projectId] = { ...rec };
      }
    }
    // 登録解除済みプロジェクトのセッションは表示対象から外す
    const ids = new Set(projects.map((p) => p.id));
    for (const pid of Object.keys(result)) {
      if (!ids.has(pid)) delete result[pid];
    }
    return result;
  }

  /** ステータスバー件数（design.md 5.2: 表示中セッションを数える。待機タイルは数えない） */
  counts(projects: readonly Project[]): StatusCounts {
    const c: StatusCounts = { running: 0, done: 0, confirm: 0, error: 0, total: 0 };
    const views = this.displaySessions(projects);
    for (const v of Object.values(views)) {
      c.total += 1;
      if (v.state !== "waiting") c[v.state] += 1; // 表示セッションはイベント由来のため waiting は来ない
    }
    return c;
  }

  /**
   * 指定プロジェクトのセッションを破棄する（登録解除時のメモリ整理）。
   * displaySessions は登録済みプロジェクトのみ返すため表示には影響しないが、
   * 内部 Map に残り続けると長期稼働でメモリが単調増加するため明示的に消す。
   */
  removeProjectSessions(projectId: string): void {
    let removed = false;
    for (const [sid, rec] of this.sessions) {
      if (rec.projectId === projectId) {
        this.sessions.delete(sid);
        removed = true;
      }
    }
    if (removed) this.emit("changed");
  }

  /** デモ用シード（--demo 実行時のみ使用。hooks 追記・永続化は一切行わない） */
  seedSession(rec: SessionView): void {
    this.sessions.set(rec.sessionId, { ...rec });
    this.emit("changed");
  }

  /** 全消去（揮発仕様の明示。T-10: 再起動で全タイル「待機」へ） */
  resetAll(): void {
    this.sessions.clear();
    this.emit("changed");
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
