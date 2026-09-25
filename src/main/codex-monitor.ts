import * as os from "node:os";
import * as path from "node:path";
import type { Project, SessionView, Snapshot } from "../shared/types";
import { readCodexSessions, type CodexReadResult } from "./codex-session-reader";
import { matchProjectByCwd } from "./state-store";

export function codexHome(): string {
  return process.env.TERMINAL_APP_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** 別 dataDir の検証では、明示的な Codex fixture がない限り実履歴を読まない。 */
export function codexMonitoringEnabled(enabled: boolean | undefined): boolean {
  return enabled !== false && (!process.env.TERMINAL_APP_DATA_DIR || !!process.env.TERMINAL_APP_CODEX_HOME);
}

type Reader = () => CodexReadResult;

/** Codex は Windows の拡張パス（\\\\?\\C:\\...）を保存する。登録パスとの比較前に通常形へ戻す。 */
export function normalizeCodexCwd(cwd: string): string {
  const win = cwd.replace(/\//g, "\\");
  if (win.toLowerCase().startsWith("\\\\?\\unc\\")) return "\\\\" + win.slice(8);
  return win.startsWith("\\\\?\\") ? win.slice(4) : win;
}

/** Claude の登録簿・Jev 判定に Codex の会話を流さず、表示時にだけ合流させる。 */
export class CodexMonitor {
  private views: SessionView[] = [];
  private hidden = new Map<string, { at: number; projectId: string }>();
  private lastSuccessAt = 0;
  available = false;

  constructor(
    private readonly read: Reader = () => readCodexSessions({ codexHome: codexHome() }),
    private readonly now: () => number = Date.now,
  ) {}

  get sessions(): readonly SessionView[] { return this.views; }

  refresh(projects: readonly Project[]): boolean {
    const result = this.read();
    this.available = result.available;
    if (!result.available) {
      // 一時的な DB ロックは次回再試行。取得不能が続くときは実行中と断言しない。
      if (this.now() - this.lastSuccessAt < 30_000) return false;
      const next = this.views.filter((s) => projects.some((p) => p.id === s.projectId)).map((s): SessionView =>
        s.state === "running" || s.state === "confirm"
          ? { ...s, state: "disconnected", runningSince: undefined, confirmKind: undefined }
          : s,
      );
      return this.replace(next);
    }
    this.lastSuccessAt = this.now();
    const liveIds = new Set<string>();
    const grouped = new Map<string, SessionView[]>();
    for (const record of result.sessions) {
      const project = matchProjectByCwd(normalizeCodexCwd(record.cwd), projects);
      if (project === null) continue;
      const sessionId = `codex:${record.sessionId}`;
      liveIds.add(sessionId);
      const hiddenAt = this.hidden.get(sessionId);
      if (hiddenAt !== undefined && record.lastEventAt > hiddenAt.at) this.hidden.delete(sessionId);
      const view: SessionView = {
        sessionId, projectId: project.id, provider: "codex", state: record.state,
        lastEventAt: record.lastEventAt, firstSeenAt: record.firstSeenAt,
        runningSince: record.runningSince, taskTitle: record.taskTitle,
        workText: record.workText, confirmKind: record.confirmKind,
      };
      const list = grouped.get(project.id) ?? [];
      list.push(view);
      grouped.set(project.id, list);
    }
    for (const id of this.hidden.keys()) if (!liveIds.has(id)) this.hidden.delete(id);
    const next: SessionView[] = [];
    for (const list of grouped.values()) {
      const active = list.filter((s) => s.state === "running" || s.state === "confirm");
      // 履歴の会話すべてをタイル化しない。作業中は全件、終了済みは直近の 1 件だけ。
      const latestFinished = list.filter((s) => s.state !== "running" && s.state !== "confirm")
        .sort((a, b) => b.lastEventAt - a.lastEventAt || a.sessionId.localeCompare(b.sessionId))[0];
      next.push(...active);
      if (latestFinished !== undefined) next.push(latestFinished);
    }
    // 表示候補を先に選ぶ。隠した最新完了を古い完了で埋め直すと「表示クリア」が効かなくなる。
    const visible = next.filter((s) => !this.hidden.has(s.sessionId));
    visible.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    return this.replace(visible);
  }

  hide(sessionId: string): boolean {
    const session = this.views.find((s) => s.sessionId === sessionId);
    if (session === undefined) return false;
    this.hidden.set(sessionId, { at: session.lastEventAt, projectId: session.projectId });
    return this.replace(this.views.filter((s) => s.sessionId !== sessionId));
  }

  reconnect(projectId: string): void {
    // 再接続は明示的な再表示要求。隠した履歴も次の取得で再評価する。
    for (const [id, entry] of this.hidden) if (entry.projectId === projectId) this.hidden.delete(id);
  }

  private replace(next: SessionView[]): boolean {
    if (JSON.stringify(this.views) === JSON.stringify(next)) return false;
    this.views = next;
    return true;
  }
}

/** 既存の表示規則を保ち、同じプロジェクトの Claude / Codex を分割タイルで並べる。 */
export function mergeCodexViews(
  projects: readonly Project[],
  claude: Pick<Snapshot, "sessions" | "splitSessions">,
  codex: readonly SessionView[],
): Pick<Snapshot, "sessions" | "splitSessions"> {
  const sessions = { ...claude.sessions };
  const splitSessions = { ...claude.splitSessions };
  for (const project of projects) {
    const additions = codex.filter((s) => s.projectId === project.id);
    if (additions.length === 0) continue;
    const primary = sessions[project.id];
    const existing = splitSessions[project.id] ?? (primary === undefined ? [] : [primary]);
    const list = [...existing, ...additions].sort((a, b) =>
      (a.firstSeenAt ?? a.lastEventAt) - (b.firstSeenAt ?? b.lastEventAt) || a.sessionId.localeCompare(b.sessionId),
    );
    sessions[project.id] = [...list].sort((a, b) =>
      Number(b.state === "running") - Number(a.state === "running") || b.lastEventAt - a.lastEventAt,
    )[0];
    if (list.length > 1) splitSessions[project.id] = list;
    else delete splitSessions[project.id];
  }
  return { sessions, splitSessions };
}
