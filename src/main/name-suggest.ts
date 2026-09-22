/**
 * 表示名の提案（260922_6）: Claude Code CLI（headless `claude -p --model sonnet`）に
 * 「このフォルダで実際にやっている作業に合う短い日本語の表示名」を 1 行で出してもらう。
 *
 * 役割分担: 「名前が作業と合っているか」の判定は Jev（jev-judge.nameMatch*）、
 * 「では何という名前にするか」の生成は Claude。Jev は文章を生成しないため、生成側は別モデルが要る。
 *
 * 安全側の設計:
 * - 生成した名前は**提案止まり**。適用は呼び出し側（main）が確認ダイアログを挟んで行う
 * - CLI が無い・タイムアウト・空出力・長すぎる出力は「提案なし」に倒す（既存の表示名はそのまま）
 * - 送るのはフォルダ名・現在の表示名・直近の作業テキストだけ（transcript 全文は送らない）
 */
import { spawn } from "child_process";
import * as path from "path";

/** 生成を待つ上限（実測: sonnet で 10〜15 秒） */
export const NAME_SUGGEST_TIMEOUT_MS = 90_000;
/** 提案名の上限文字数（projects.json の表示名上限 40 より短く、タイルに収まる長さ） */
export const NAME_SUGGEST_MAX_CHARS = 24;

/**
 * CLI が混ぜてくる案内行（260922_9。実測: 自動更新の失敗・サンドボックス警告・権限ルールの注意）。
 * 名前の候補から除外する
 */
const NOISE_LINE = /^(?:[\u2717\u2718\u00d7\u26a0\u2713\u2714]|Permission deny|Warning|WARN|Error|ERROR|Auto-update|Run claude doctor|Sandbox|Tip:)/i;

export interface NameSuggestInput {
  /** フォルダ名（basename） */
  folderName: string;
  /** 現在の表示名 */
  currentName: string;
  /** 直近の作業テキスト（新しい順。空配列可） */
  works: readonly string[];
}

/**
 * CLI に渡すプロンプト（純関数）。1 行だけ返させるため、条件を箇条書きで固定する
 */
export function buildNamePrompt(input: NameSuggestInput, strict = false): string {
  const works = input.works
    .map((w) => w.replace(/\s+/g, " ").trim())
    .filter((w) => w !== "")
    .slice(0, 5);
  return [
    "次の開発プロジェクトに付ける「タイルの表示名」を 1 つだけ考えてください。",
    "",
    `フォルダ名: ${input.folderName}`,
    `現在の表示名: ${input.currentName}`,
    works.length > 0 ? `直近の作業:\n${works.map((w) => `- ${w}`).join("\n")}` : "直近の作業: （不明）",
    "",
    "条件:",
    `- 日本語で ${NAME_SUGGEST_MAX_CHARS} 文字以内`,
    "- 何のプロジェクトか一目で分かる具体的な名前（「dev」「アプリ」のような汎用語だけにしない）",
    "- 作業内容そのものではなく、プロジェクトの名前にする",
    "- 記号・引用符・太字（**）・説明・前置き・改行を付けず、名前だけを 1 行で出力する",
    ...(strict
      ? [
          "",
          "重要: 出力は名前 1 行だけにしてください。理由・前置き・補足・記号は一切書かないでください。",
          "出力例: 在庫スキャンツール",
        ]
      : []),
  ].join("\n");
}

/**
 * CLI の出力から表示名を取り出す（純関数）。
 * 最初の非空行を採り、引用符・箇条書き記号・末尾の句点を落とす。空・長すぎ・制御文字混入は null
 */
export function parseSuggestedName(stdout: string, maxChars: number = NAME_SUGGEST_MAX_CHARS): string | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "") continue;
    if (NOISE_LINE.test(line)) continue; // CLI の警告・更新通知などは名前の候補にしない
    // 「箇条書き → 引用符 → 句点」は順番が入れ替わることがある（例「- 「名前」。」）ため、
    // 変化しなくなるまで繰り返し落とす
    for (let i = 0; i < 4; i++) {
      const before = line;
      line = line.replace(/^[-*・]\s*/, ""); // 箇条書き
      line = line.replace(/^[「『"'`*_~]+|[」』"'`*_~]+$/g, ""); // 引用符・かぎ括弧・太字などの強調
      line = line.replace(/[。.!?！？]+$/g, "").trim();
      if (line === before) break;
    }
    if (line === "") continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(line)) continue;
    if (line.length > maxChars) continue; // 説明文などは候補にしない（次の行を見る）
    return line;
  }
  return null;
}

export interface NameSuggestResult {
  ok: boolean;
  name?: string;
  error?: string;
}

export interface NameSuggestDeps {
  /** 実行する CLI（既定 claude）。テストで差し替える */
  run(prompt: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; error?: string }>;
  timeoutMs?: number;
  maxChars?: number;
}

/** CLI に渡す環境変数: 色付けと自動更新の案内を止めて、出力を名前 1 行だけにする */
const CLI_ENV = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", DISABLE_AUTOUPDATER: "1" };

/** 既定の実行系: Windows は cmd.exe 経由（claude は .cmd のため直接 spawn できない） */
export function runClaudeCli(prompt: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    // プロンプトは標準入力から渡す（260922_9）。複数行の文字列を cmd.exe の引数に載せると
    // 改行がコマンド区切りとして解釈され、CLI には 1 行目しか届かない（2026-09-22 実測の不具合）
    const args = ["-p", "--model", "sonnet"];
    let child;
    try {
      child =
        process.platform === "win32"
          ? spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", "claude", ...args], {
              cwd,
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
              env: CLI_ENV,
            })
          : spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: CLI_ENV });
    } catch (e) {
      resolve({ ok: false, stdout: "", error: `起動に失敗しました: ${String(e)}` });
      return;
    }
    try {
      child.stdin?.end(prompt, "utf8"); // 標準入力へ渡して閉じる（閉じないと CLI が入力待ちのままになる）
    } catch {
      /* 書き込み失敗は close / error 側で拾う */
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { ok: boolean; stdout: string; error?: string }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, stdout, error: `${Math.round(timeoutMs / 1000)} 秒以内に応答がありませんでした` });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      finish({ ok: false, stdout, error: `claude コマンドを実行できません: ${e.message}` });
    });
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, stdout, error: `claude が異常終了しました (code=${code})${stderr.trim() !== "" ? `: ${stderr.trim().slice(0, 200)}` : ""}` });
    });
  });
}

/** 表示名の提案を 1 件得る。失敗は ok=false + 理由（呼び出し側はステータスバーに出す） */
export async function suggestProjectName(input: NameSuggestInput, cwd: string, deps: NameSuggestDeps): Promise<NameSuggestResult> {
  const timeoutMs = deps.timeoutMs ?? NAME_SUGGEST_TIMEOUT_MS;
  const maxChars = deps.maxChars ?? NAME_SUGGEST_MAX_CHARS;
  const r = await deps.run(buildNamePrompt(input), cwd, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error ?? "提案を取得できませんでした" };
  let name = parseSuggestedName(r.stdout, maxChars);
  if (name === null) {
    // 説明文が混ざったときは 1 回だけ言い直す（260922_9。sonnet は時々理由を添える）
    const retry = await deps.run(buildNamePrompt(input, true), cwd, timeoutMs);
    if (retry.ok) name = parseSuggestedName(retry.stdout, maxChars);
  }
  if (name === null) return { ok: false, error: "提案の形式が想定外でした（名前だけの 1 行が得られませんでした）" };
  if (name === input.currentName) return { ok: false, error: `今の表示名（${name}）のままで良い、という提案でした` };
  return { ok: true, name };
}
