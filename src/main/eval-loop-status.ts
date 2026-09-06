/**
 * eval-loop（品質ループ）の進捗バッジ（260907_2）。
 *
 * 情報源は eval-loop ハーネス v3 がディスクに書く事実だけ:
 * - `~/.claude/eval-loop/registry/{sessions,agents}/<id>` … state.json の絶対パスが 1 行（末尾改行付き）
 * - state.json（schema_version 3。2026-09-07 実測）… active / iteration（0 始まり）/ max_iterations / phase
 *   （plan → generator → evaluator → eval）/ latest_score / best_score / ended_reason / ended_at（epoch 秒）/
 *   session_id / agent_id（fork・parallel ループ）/ jobs_dir
 * - codex ジョブ `jobs/iter-NNN-<role>/` … heartbeat（runner が 5 秒ごと touch、30 秒で stale）/ started_at（epoch 秒）/
 *   exit_code（あれば終了）。ll_job_status と同じ規則（起動 20 秒の猶予）で「走行中」を判定する
 *
 * 表示は 1 行: 「ループ 2/4・codex 実装中 1分・最高 78点」（周回数は 1 始まり）。終了後は ENDED_SHOW_MS の間だけ
 * 「ループ終了・合格 92点」。LLM の自己申告に依存せず、読めない・壊れているものは黙って無視する（バッジ無し）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface LoopState {
  active: boolean;
  /** 0 始まり（state.json のまま。表示時に +1 する） */
  iteration: number;
  maxIterations: number;
  phase?: string;
  threshold?: number;
  latestScore?: number;
  bestScore?: number;
  endedReason?: string;
  /** epoch 秒（loop-lib の ll_now） */
  endedAt?: number;
  sessionId?: string;
  agentId?: string;
  jobsDir?: string;
}

export interface RunningJob {
  role: "generator" | "evaluator" | "debate";
  elapsedMs: number;
}

/** ループ終了後にバッジを出し続ける時間（30 分） */
export const ENDED_SHOW_MS = 30 * 60_000;
/** codex ジョブの heartbeat がこれより古ければ走行中とみなさない（loop-lib.sh LL_HEARTBEAT_STALE=30 秒） */
const HEARTBEAT_STALE_MS = 30_000;
/** 起動直後（heartbeat も pid もまだ無い）の猶予（ll_job_status と同じ 20 秒） */
const STARTUP_GRACE_MS = 20_000;
const JOB_ROLES: ReadonlyArray<RunningJob["role"]> = ["generator", "evaluator", "debate"];
/** registry/agents の走査上限（暴走した登録の掃除は loop-start.sh の 14 日 prune に任せる） */
const MAX_AGENT_ENTRIES = 200;

const PHASE_LABEL: Record<string, string> = { plan: "計画中", generator: "実装中", evaluator: "採点中", eval: "判定中" };
const REASON_LABEL: Record<string, string> = {
  threshold_met: "合格",
  max_iterations: "上限到達",
  cancelled: "停止",
  wall_clock_exceeded: "時間切れ",
  invalid_eval_output: "採点不能",
};

/** eval-loop のホーム（既定 ~/.claude/eval-loop）。env `TERMINAL_APP_EVAL_LOOP_DIR` で差し替え可能（E2E 用） */
export function evalLoopDir(homeDir: string = os.homedir()): string {
  const override = process.env.TERMINAL_APP_EVAL_LOOP_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  return path.join(homeDir, ".claude", "eval-loop");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** state.json の本文 → 表示に要る項目。active が boolean でない・JSON でないものは null */
export function parseLoopState(text: string): LoopState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.active !== "boolean") return null;
  const iteration = num(r.iteration);
  const max = num(r.max_iterations);
  const s: LoopState = {
    active: r.active,
    iteration: iteration !== undefined && iteration >= 0 ? Math.floor(iteration) : 0,
    maxIterations: max !== undefined && max > 0 ? Math.floor(max) : 12, // loop-control.sh の既定
  };
  const phase = str(r.phase);
  if (phase !== undefined) s.phase = phase;
  const threshold = num(r.threshold);
  if (threshold !== undefined) s.threshold = threshold;
  const latest = num(r.latest_score);
  if (latest !== undefined) s.latestScore = latest;
  const best = num(r.best_score);
  if (best !== undefined) s.bestScore = best;
  const reason = str(r.ended_reason);
  if (reason !== undefined) s.endedReason = reason;
  const endedAt = num(r.ended_at);
  if (endedAt !== undefined) s.endedAt = endedAt;
  const sessionId = str(r.session_id);
  if (sessionId !== undefined) s.sessionId = sessionId;
  const agentId = str(r.agent_id);
  if (agentId !== undefined) s.agentId = agentId;
  const jobsDir = str(r.jobs_dir);
  if (jobsDir !== undefined) s.jobsDir = jobsDir;
  return s;
}

function mtimeMs(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
function readEpochSeconds(p: string): number | undefined {
  try {
    const v = Number(fs.readFileSync(p, "utf8").trim());
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 現在イテレーションで走行中の codex ジョブ（generator → evaluator → debate の順で最初のもの）。
 * 走行中 = exit_code が無く、heartbeat が 30 秒以内 または started_at から 20 秒未満（起動直後）。
 * 経過は started_at 起点（無ければ heartbeat 起点）。jobs_dir 不明・無しは null
 */
export function readRunningJob(jobsDir: string | undefined, iteration: number, now: number): RunningJob | null {
  if (jobsDir === undefined) return null;
  const prefix = `iter-${String(iteration).padStart(3, "0")}-`;
  for (const role of JOB_ROLES) {
    const d = path.join(jobsDir, prefix + role);
    let isDir = false;
    try {
      isDir = fs.statSync(d).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    if (fs.existsSync(path.join(d, "exit_code"))) continue;
    const startedAt = readEpochSeconds(path.join(d, "started_at"));
    const hb = mtimeMs(path.join(d, "heartbeat"));
    const heartbeatFresh = hb !== null && now - hb <= HEARTBEAT_STALE_MS;
    const justStarted = startedAt !== undefined && now - startedAt * 1000 < STARTUP_GRACE_MS;
    if (!heartbeatFresh && !justStarted) continue;
    const elapsedMs = startedAt !== undefined ? Math.max(0, now - startedAt * 1000) : hb !== null ? Math.max(0, now - hb) : 0;
    return { role, elapsedMs };
  }
  return null;
}

/**
 * 1 ループの表示文字列。
 * - 進行中: 「ループ N/M・<段階>」（N = iteration+1）。codex ジョブ走行中は段階を「codex 実装中／採点中 <経過分>分」に
 *   置き換える。2 周目以降で best_score があれば「・最高 NN点」
 * - 終了: 「ループ終了・<理由> <点数>点」を ended_at から ENDED_SHOW_MS の間だけ。理由は既知のものだけ日本語化
 *   （stalled:* は「停滞で停止」）。never_started（task 未設定のまま掃除された state）と ended_at 無しは出さない
 */
export function describeLoop(state: LoopState, job: RunningJob | null, now: number): string | undefined {
  if (state.active) {
    const stage =
      job !== null
        ? `codex ${job.role === "generator" ? "実装中" : "採点中"} ${Math.floor(job.elapsedMs / 60_000)}分`
        : (PHASE_LABEL[state.phase ?? ""] ?? "進行中");
    let text = `ループ ${state.iteration + 1}/${state.maxIterations}・${stage}`;
    if (state.iteration > 0 && state.bestScore !== undefined) text += `・最高 ${state.bestScore}点`;
    return text;
  }
  if (state.endedReason === undefined || state.endedReason === "never_started" || state.endedAt === undefined) return undefined;
  if (now - state.endedAt * 1000 > ENDED_SHOW_MS) return undefined;
  const reason = state.endedReason.startsWith("stalled") ? "停滞で停止" : REASON_LABEL[state.endedReason];
  const score = state.latestScore ?? state.bestScore;
  let text = "ループ終了";
  if (reason !== undefined) text += `・${reason}`;
  if (score !== undefined) text += reason !== undefined ? ` ${score}点` : `・${score}点`;
  return text;
}

/** registry の 1 ファイル（state.json への絶対パス 1 行）をたどって state を読む。読めなければ null */
function readStateViaRegistry(registryFile: string): { statePath: string; state: LoopState } | null {
  let statePath: string;
  try {
    statePath = fs.readFileSync(registryFile, "utf8").trim();
  } catch {
    return null;
  }
  if (statePath === "") return null;
  let text: string;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  const state = parseLoopState(text);
  return state === null ? null : { statePath, state };
}

/** 同じセッションに複数ループがあるときの 1 行: 進行中を優先（他があれば件数）、無ければ最も新しく終わったもの */
function describeLoops(loops: readonly LoopState[], now: number): string | undefined {
  const active = loops.filter((s) => s.active);
  if (active.length > 0) {
    const s = active[0];
    const text = describeLoop(s, readRunningJob(s.jobsDir, s.iteration, now), now);
    if (text === undefined) return undefined;
    return active.length > 1 ? `${text}（他 ${active.length - 1} 本）` : text;
  }
  const ended = loops.filter((s) => s.endedAt !== undefined).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const s of ended) {
    const text = describeLoop(s, null, now);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * 指定セッション群のループ進捗バッジ文言。registry/sessions/<sessionId> と registry/agents/*（state の session_id で
 * 対応付け）の両方を見る。読めない・壊れている・対応する state が無いセッションは結果に含めない（例外は投げない）
 */
export function loopTextForSessions(sessionIds: readonly string[], deps: { evalLoopDir: string; now: number }): Map<string, string> {
  const wanted = new Set(sessionIds);
  const loops = new Map<string, LoopState[]>();
  const seenPaths = new Set<string>();
  const add = (sid: string, hit: { statePath: string; state: LoopState }): void => {
    if (seenPaths.has(hit.statePath)) return;
    seenPaths.add(hit.statePath);
    const list = loops.get(sid) ?? [];
    list.push(hit.state);
    loops.set(sid, list);
  };
  for (const sid of wanted) {
    if (!/^[A-Za-z0-9._-]+$/.test(sid)) continue; // registry のファイル名規則（ll_safe_id）外はたどらない
    const hit = readStateViaRegistry(path.join(deps.evalLoopDir, "registry", "sessions", sid));
    if (hit !== null) add(sid, hit);
  }
  const agentsDir = path.join(deps.evalLoopDir, "registry", "agents");
  let names: string[] = [];
  try {
    names = fs.readdirSync(agentsDir);
  } catch {
    names = [];
  }
  for (const name of names.slice(0, MAX_AGENT_ENTRIES)) {
    const hit = readStateViaRegistry(path.join(agentsDir, name));
    if (hit !== null && hit.state.sessionId !== undefined && wanted.has(hit.state.sessionId)) add(hit.state.sessionId, hit);
  }
  const out = new Map<string, string>();
  for (const [sid, list] of loops) {
    const text = describeLoops(list, deps.now);
    if (text !== undefined) out.set(sid, text);
  }
  return out;
}
