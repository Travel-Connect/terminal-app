import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexMonitor, codexMonitoringEnabled, mergeCodexViews, normalizeCodexCwd } from "../src/main/codex-monitor";
import type { CodexReadResult, CodexSessionRecord } from "../src/main/codex-session-reader";
import type { Project, SessionView } from "../src/shared/types";

const projects: Project[] = [
  { id: "parent", path: "C:/dev", name: "dev", clickTarget: "cursor", registeredAt: "" },
  { id: "app", path: "C:/dev/app", name: "app", clickTarget: "cursor", registeredAt: "" },
];
const record = (sessionId: string, state: CodexSessionRecord["state"] = "running", time = 100): CodexSessionRecord => ({
  sessionId, cwd: "C:/dev/app/src", state, lastEventAt: time, firstSeenAt: time,
});
afterEach(() => vi.unstubAllEnvs());

describe("Codex の独立した監視", () => {
  it("Codex が実際に保存する Windows 拡張パスも登録済みフォルダに一致する", () => {
    const monitor = new CodexMonitor(() => ({ available: true, sessions: [{ ...record("extended"), cwd: "\\\\?\\C:\\dev\\app\\src" }] }));
    monitor.refresh(projects);
    expect(monitor.sessions[0].projectId).toBe("app");
    expect(normalizeCodexCwd("\\\\?\\UNC\\server\\share\\app")).toBe("\\\\server\\share\\app");
  });

  it("登録した最長一致の cwd に割り当て、全実行中と直近完了 1 件だけを表示する", () => {
    const monitor = new CodexMonitor(() => ({ available: true, sessions: [
      record("first"), record("second", "confirm"), record("old", "done", 90), record("latest", "done", 110),
      { ...record("unregistered"), cwd: "D:/unregistered" },
    ] }));
    expect(monitor.refresh(projects)).toBe(true);
    expect(monitor.sessions.map((s) => s.sessionId)).toEqual(["codex:first", "codex:latest", "codex:second"]);
    expect(monitor.sessions.every((s) => s.projectId === "app" && s.provider === "codex")).toBe(true);
    expect(monitor.refresh(projects)).toBe(false);
  });

  it("表示を隠したセッションは変化するまで戻さず、再接続で復元できる", () => {
    let result: CodexReadResult = { available: true, sessions: [record("one")] };
    const monitor = new CodexMonitor(() => result);
    monitor.refresh(projects);
    expect(monitor.hide("codex:one")).toBe(true);
    monitor.refresh(projects);
    expect(monitor.sessions).toEqual([]);
    result = { available: true, sessions: [record("one", "done", 200)] };
    monitor.refresh(projects);
    expect(monitor.sessions[0].state).toBe("done");
    monitor.hide("codex:one");
    monitor.reconnect("parent");
    monitor.refresh(projects);
    expect(monitor.sessions).toEqual([]);
    monitor.reconnect("app");
    monitor.refresh(projects);
    expect(monitor.sessions).toHaveLength(1);
  });

  it("最新の完了を隠しても過去の完了を代わりに表示しない", () => {
    const monitor = new CodexMonitor(() => ({ available: true, sessions: [record("older", "done", 100), record("newer", "done", 200)] }));
    monitor.refresh(projects);
    expect(monitor.sessions[0].sessionId).toBe("codex:newer");
    monitor.hide("codex:newer");
    monitor.refresh(projects);
    expect(monitor.sessions).toEqual([]);
  });

  it("一時的な読み取り失敗を許容し、長い取得不能では実行中を固定しない", () => {
    let now = 100_000;
    let result: CodexReadResult = { available: true, sessions: [record("one")] };
    const monitor = new CodexMonitor(() => result, () => now);
    monitor.refresh(projects);
    result = { available: false, sessions: [] };
    now += 5_000;
    expect(monitor.refresh(projects)).toBe(false);
    expect(monitor.sessions[0].state).toBe("running");
    now += 30_000;
    expect(monitor.refresh(projects)).toBe(true);
    expect(monitor.sessions[0].state).toBe("disconnected");
    result = { available: true, sessions: [] };
    monitor.refresh(projects);
    expect(monitor.sessions).toEqual([]);
  });

  it("検証用 dataDir だけを指定しても実際の Codex 履歴へ接続しない", () => {
    vi.stubEnv("TERMINAL_APP_DATA_DIR", "C:/test-data");
    vi.stubEnv("TERMINAL_APP_CODEX_HOME", "");
    expect(codexMonitoringEnabled(true)).toBe(false);
    vi.stubEnv("TERMINAL_APP_CODEX_HOME", "C:/test-codex");
    expect(codexMonitoringEnabled(true)).toBe(true);
    expect(codexMonitoringEnabled(false)).toBe(false);
  });
});

describe("Claude と Codex のタイル統合", () => {
  it("同じプロジェクトの両方の状態を保持し、別プロジェクトの既存表示を変えない", () => {
    const claude: SessionView = { sessionId: "same-id", projectId: "app", state: "done", lastEventAt: 100, firstSeenAt: 50 };
    const other: SessionView = { ...claude, sessionId: "other", projectId: "parent" };
    const codex: SessionView = { ...claude, sessionId: "codex:same-id", provider: "codex", state: "running", firstSeenAt: 80 };
    const original = { sessions: { app: claude, parent: other }, splitSessions: {} };
    const merged = mergeCodexViews(projects, original, [codex]);
    expect(merged.splitSessions.app.map((s) => s.sessionId)).toEqual(["same-id", "codex:same-id"]);
    expect(merged.sessions.app).toBe(codex);
    expect(merged.sessions.parent).toBe(other);
    expect(original.splitSessions).toEqual({});
    expect(mergeCodexViews(projects, original, [])).toEqual(original);
  });
});
