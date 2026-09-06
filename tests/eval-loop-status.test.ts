/**
 * 260907_2: eval-loop（品質ループ）の進捗バッジ。
 * ~/.claude/eval-loop/registry/{sessions,agents}/<id> に書かれた state.json の絶対パスをたどり、
 * state（schema_version 3。2026-09-07 実測）と codex ジョブ（jobs/iter-NNN-<role>/）から
 * 「ループ 2/4・codex 実装中 1分・最高 78点」のような 1 行を作る。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENDED_SHOW_MS,
  describeLoop,
  evalLoopDir,
  loopTextForSessions,
  parseLoopState,
  readRunningJob,
  type LoopState,
} from "../src/main/eval-loop-status";

const NOW = Date.parse("2026-09-07T04:30:00.000Z");
const NOW_S = Math.floor(NOW / 1000);

/** 実測の state.json（Monthly-report 2026-09-07。長いフィールドは省略） */
const REAL_STATE = {
  schema_version: 3,
  loop_type: "eval",
  active: true,
  iteration: 0,
  max_iterations: 4,
  threshold: 90,
  started_at: 1788718215,
  ended_reason: null,
  session_id: "9b6dc513-88c5-46c0-a49e-6d396fb496c7",
  agent_id: null,
  jobs_dir: "C:/Users/hppym/dev/Monthly-report/.mso/sessions/9b6dc513/jobs",
  latest_score: null,
  best_score: null,
  phase: "generator",
  generator_skill: "assign-eval-loop-generator",
  evaluator_skill: "assign-eval-loop-evaluator",
};

function state(over: Partial<LoopState> = {}): LoopState {
  return { active: true, iteration: 0, maxIterations: 4, ...over };
}

describe("parseLoopState", () => {
  it("実測フォーマットから表示に要る項目を取り出す", () => {
    expect(parseLoopState(JSON.stringify(REAL_STATE))).toEqual({
      active: true,
      iteration: 0,
      maxIterations: 4,
      phase: "generator",
      threshold: 90,
      sessionId: "9b6dc513-88c5-46c0-a49e-6d396fb496c7",
      jobsDir: "C:/Users/hppym/dev/Monthly-report/.mso/sessions/9b6dc513/jobs",
    });
  });

  it("終了した state（active=false・ended_reason・ended_at・score）も読める。agent_id があれば載る", () => {
    const s = parseLoopState(
      JSON.stringify({ ...REAL_STATE, active: false, ended_reason: "threshold_met", ended_at: 1788719308, latest_score: 100, best_score: 100, agent_id: "a6be3bf9a9c1e87d1", session_id: "cf955ad8" })
    );
    expect(s).toMatchObject({ active: false, endedReason: "threshold_met", endedAt: 1788719308, latestScore: 100, bestScore: 100, agentId: "a6be3bf9a9c1e87d1", sessionId: "cf955ad8" });
  });

  it("壊れた JSON・オブジェクトでない・active が boolean でない は null。iteration/max の欠落は 0 / 12（loop-control の既定）", () => {
    expect(parseLoopState("{")).toBe(null);
    expect(parseLoopState("[1]")).toBe(null);
    expect(parseLoopState(JSON.stringify({ iteration: 1 }))).toBe(null);
    expect(parseLoopState(JSON.stringify({ active: true }))).toEqual({ active: true, iteration: 0, maxIterations: 12 });
  });
});

describe("describeLoop（表示文字列）", () => {
  it("進行中: ループ N/M（N は 1 始まり）・phase の日本語", () => {
    expect(describeLoop(state({ phase: "plan" }), null, NOW)).toBe("ループ 1/4・計画中");
    expect(describeLoop(state({ phase: "generator" }), null, NOW)).toBe("ループ 1/4・実装中");
    expect(describeLoop(state({ phase: "evaluator", iteration: 2 }), null, NOW)).toBe("ループ 3/4・採点中");
    expect(describeLoop(state({ phase: "eval" }), null, NOW)).toBe("ループ 1/4・判定中");
    expect(describeLoop(state({ phase: undefined }), null, NOW)).toBe("ループ 1/4・進行中");
    expect(describeLoop(state({ phase: "something-new" }), null, NOW)).toBe("ループ 1/4・進行中");
  });

  it("codex ジョブが走っていれば phase より優先して「codex 実装中／採点中 + 経過」を出す", () => {
    expect(describeLoop(state({ phase: "generator" }), { role: "generator", elapsedMs: 65_000 }, NOW)).toBe("ループ 1/4・codex 実装中 1分");
    expect(describeLoop(state({ phase: "evaluator" }), { role: "evaluator", elapsedMs: 20_000 }, NOW)).toBe("ループ 1/4・codex 採点中 0分");
    expect(describeLoop(state({ phase: "evaluator" }), { role: "debate", elapsedMs: 3_700_000 }, NOW)).toBe("ループ 1/4・codex 採点中 61分");
  });

  it("2 周目以降で最高点があれば末尾に付ける（1 周目は付けない）", () => {
    expect(describeLoop(state({ iteration: 1, phase: "generator", bestScore: 78 }), null, NOW)).toBe("ループ 2/4・実装中・最高 78点");
    expect(describeLoop(state({ iteration: 0, phase: "generator", bestScore: 78 }), null, NOW)).toBe("ループ 1/4・実装中");
    expect(describeLoop(state({ iteration: 1, phase: "generator" }), null, NOW)).toBe("ループ 2/4・実装中");
  });

  it("終了: 理由の日本語 + 点数（latest → best の順）。終了から 30 分を過ぎたら出さない", () => {
    const ended = (reason: string, over: Partial<LoopState> = {}) => state({ active: false, endedReason: reason, endedAt: NOW_S - 60, ...over });
    expect(describeLoop(ended("threshold_met", { latestScore: 92, bestScore: 80 }), null, NOW)).toBe("ループ終了・合格 92点");
    expect(describeLoop(ended("max_iterations", { bestScore: 78 }), null, NOW)).toBe("ループ終了・上限到達 78点");
    expect(describeLoop(ended("cancelled"), null, NOW)).toBe("ループ終了・停止");
    expect(describeLoop(ended("wall_clock_exceeded", { latestScore: 70 }), null, NOW)).toBe("ループ終了・時間切れ 70点");
    expect(describeLoop(ended("stalled:WAIT_GENERATOR"), null, NOW)).toBe("ループ終了・停滞で停止");
    expect(describeLoop(ended("invalid_eval_output"), null, NOW)).toBe("ループ終了・採点不能");
    expect(describeLoop(ended("mystery"), null, NOW)).toBe("ループ終了");
    expect(describeLoop(ended("threshold_met", { endedAt: NOW_S - ENDED_SHOW_MS / 1000 - 1 }), null, NOW)).toBeUndefined();
    expect(describeLoop(ended("threshold_met", { endedAt: NOW_S - ENDED_SHOW_MS / 1000 }), null, NOW)).toBe("ループ終了・合格");
  });

  it("never_started（task 未設定のまま掃除された state）と ended_at の無い終了は出さない", () => {
    expect(describeLoop(state({ active: false, endedReason: "never_started", endedAt: NOW_S }), null, NOW)).toBeUndefined();
    expect(describeLoop(state({ active: false, endedReason: "threshold_met" }), null, NOW)).toBeUndefined();
  });
});

describe("readRunningJob / loopTextForSessions（ファイル）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-evalloop-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function job(jobsDir: string, name: string, files: Record<string, string>, heartbeatAgeMs?: number): string {
    const d = path.join(jobsDir, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, content] of Object.entries(files)) fs.writeFileSync(path.join(d, f), content);
    if (heartbeatAgeMs !== undefined) {
      const hb = path.join(d, "heartbeat");
      fs.writeFileSync(hb, "");
      const t = new Date(NOW - heartbeatAgeMs);
      fs.utimesSync(hb, t, t);
    }
    return d;
  }

  it("readRunningJob: 現在イテレーションの exit_code 無し＋heartbeat が 30 秒以内 → running（経過は started_at から）", () => {
    const jobs = path.join(dir, "jobs");
    job(jobs, "iter-001-generator", { started_at: String(NOW_S - 65) }, 5_000);
    expect(readRunningJob(jobs, 1, NOW)).toEqual({ role: "generator", elapsedMs: 65_000 });
  });

  it("readRunningJob: exit_code があれば終了扱い／heartbeat が古く started_at も 20 秒超なら running ではない／別イテレーションは見ない", () => {
    const jobs = path.join(dir, "jobs");
    job(jobs, "iter-001-generator", { started_at: String(NOW_S - 65), exit_code: "0" }, 1_000);
    expect(readRunningJob(jobs, 1, NOW)).toBe(null);
    job(jobs, "iter-002-evaluator", { started_at: String(NOW_S - 300) }, 120_000);
    expect(readRunningJob(jobs, 2, NOW)).toBe(null);
    job(jobs, "iter-003-generator", { started_at: String(NOW_S - 10) });
    expect(readRunningJob(jobs, 3, NOW)).toEqual({ role: "generator", elapsedMs: 10_000 }); // 起動直後の猶予
    expect(readRunningJob(jobs, 4, NOW)).toBe(null);
    expect(readRunningJob(undefined, 1, NOW)).toBe(null);
    expect(readRunningJob(path.join(dir, "nope"), 1, NOW)).toBe(null);
  });

  it("readRunningJob: generator → evaluator → debate の順に最初の running を返す", () => {
    const jobs = path.join(dir, "jobs");
    job(jobs, "iter-000-evaluator", { started_at: String(NOW_S - 30) }, 2_000);
    job(jobs, "iter-000-debate", { started_at: String(NOW_S - 40) }, 2_000);
    expect(readRunningJob(jobs, 0, NOW)).toEqual({ role: "evaluator", elapsedMs: 30_000 });
  });

  function registerLoop(kind: "sessions" | "agents", id: string, stateObj: Record<string, unknown>, stateDirName = id): string {
    const stateDir = path.join(dir, "states", stateDirName);
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "state.json");
    fs.writeFileSync(stateFile, JSON.stringify({ ...stateObj, jobs_dir: path.join(stateDir, "jobs").replace(/\\/g, "/") }));
    fs.mkdirSync(path.join(dir, "registry", kind), { recursive: true });
    fs.writeFileSync(path.join(dir, "registry", kind, id), stateFile.replace(/\\/g, "/") + "\n"); // 実物は末尾改行付きの絶対パス 1 行
    return stateDir;
  }

  it("loopTextForSessions: registry/sessions/<sessionId> からたどって表示文字列を返す（codex ジョブ込み）", () => {
    const stateDir = registerLoop("sessions", "s1", { ...REAL_STATE, session_id: "s1", iteration: 1, best_score: 78, phase: "generator" });
    job(path.join(stateDir, "jobs"), "iter-001-generator", { started_at: String(NOW_S - 125) }, 3_000);
    const m = loopTextForSessions(["s1", "s2"], { evalLoopDir: dir, now: NOW });
    expect(m.get("s1")).toBe("ループ 2/4・codex 実装中 2分・最高 78点");
    expect(m.has("s2")).toBe(false);
  });

  it("loopTextForSessions: fork ループ（registry/agents/<agentId>。state の session_id で対応付け）も拾う", () => {
    registerLoop("agents", "a6be3bf9a9c1e87d1", { ...REAL_STATE, session_id: "s9", agent_id: "a6be3bf9a9c1e87d1", iteration: 0, phase: "evaluator" });
    const m = loopTextForSessions(["s9"], { evalLoopDir: dir, now: NOW });
    expect(m.get("s9")).toBe("ループ 1/4・採点中");
  });

  it("loopTextForSessions: 同じセッションに複数ループ → 進行中を優先し「（他 N 本）」を添える。終了のみなら終了表示", () => {
    registerLoop("sessions", "s1", { ...REAL_STATE, session_id: "s1", active: false, ended_reason: "threshold_met", ended_at: NOW_S - 10, latest_score: 95 });
    registerLoop("agents", "agent-a", { ...REAL_STATE, session_id: "s1", agent_id: "agent-a", iteration: 2, phase: "plan" }, "agent-a");
    registerLoop("agents", "agent-b", { ...REAL_STATE, session_id: "s1", agent_id: "agent-b", iteration: 0, phase: "generator" }, "agent-b");
    const m = loopTextForSessions(["s1"], { evalLoopDir: dir, now: NOW });
    expect(m.get("s1")).toMatch(/^ループ [13]\/4・(計画中|実装中)（他 1 本）$/);
    fs.rmSync(path.join(dir, "registry", "agents"), { recursive: true, force: true });
    expect(loopTextForSessions(["s1"], { evalLoopDir: dir, now: NOW }).get("s1")).toBe("ループ終了・合格 95点");
  });

  it("loopTextForSessions: registry の中身が無効・state が無い・壊れている・registry 自体が無い → そのセッションは無し（例外を出さない）", () => {
    fs.mkdirSync(path.join(dir, "registry", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "registry", "sessions", "s1"), path.join(dir, "missing", "state.json") + "\n");
    fs.writeFileSync(path.join(dir, "registry", "sessions", "s2"), "");
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{not json");
    fs.writeFileSync(path.join(dir, "registry", "sessions", "s3"), broken + "\n");
    const m = loopTextForSessions(["s1", "s2", "s3"], { evalLoopDir: dir, now: NOW });
    expect(m.size).toBe(0);
    expect(loopTextForSessions(["s1"], { evalLoopDir: path.join(dir, "nowhere"), now: NOW }).size).toBe(0);
  });
});

describe("evalLoopDir", () => {
  const saved = process.env.TERMINAL_APP_EVAL_LOOP_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.TERMINAL_APP_EVAL_LOOP_DIR;
    else process.env.TERMINAL_APP_EVAL_LOOP_DIR = saved;
  });

  it("既定は <home>/.claude/eval-loop。env TERMINAL_APP_EVAL_LOOP_DIR で差し替え（空白のみは未設定扱い）", () => {
    delete process.env.TERMINAL_APP_EVAL_LOOP_DIR;
    expect(evalLoopDir("C:/Users/x")).toBe(path.join("C:/Users/x", ".claude", "eval-loop"));
    process.env.TERMINAL_APP_EVAL_LOOP_DIR = "C:/tmp/el";
    expect(evalLoopDir("C:/Users/x")).toBe("C:/tmp/el");
    process.env.TERMINAL_APP_EVAL_LOOP_DIR = "  ";
    expect(evalLoopDir("C:/Users/x")).toBe(path.join("C:/Users/x", ".claude", "eval-loop"));
  });
});
