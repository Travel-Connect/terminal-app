/**
 * Jev（TypeSafe AI）実 API の疎通と 4 判定のサンプル確認（260922_2）。
 * ビルド済み dist/main/jev-client.js / jev-judge.js をそのまま使い、代表的な入力に対する確率と
 * 本アプリの解釈（返答待ち／危険度／作業テキスト／停滞）を表示する。
 * API キーは env TYPESAFE_API_KEY か %USERPROFILE%/.typesafe.env から読む（出力には出さない）。
 *
 *   node scripts/probe-jev.mjs [出力先 JSON]
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";

const require = createRequire(import.meta.url);
const client = require("../dist/main/jev-client.js");
const judge = require("../dist/main/jev-judge.js");

const apiKey = client.loadTypesafeApiKey();
if (apiKey === null) {
  console.error("TYPESAFE_API_KEY が見つかりません");
  process.exit(2);
}
const jev = client.createJevClient({ apiKey, logger: { info: console.log, warn: console.warn, error: console.error } });

const cases = [];
async function run(label, kind, state, questions, interpret) {
  const t0 = Date.now();
  const answers = await jev.judge(state, questions);
  const ms = Date.now() - t0;
  const verdict = interpret(answers);
  const brief = answers === null ? null : Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.type === "noul" ? Number(a.noul.toFixed(3)) : a]));
  cases.push({ label, kind, ms, answers: brief, verdict });
  console.log(`\n[${kind}] ${label} (${ms}ms)`);
  console.log("  answers:", JSON.stringify(brief));
  console.log("  verdict:", JSON.stringify(verdict));
}

// 1. 返答待ち
await run("日本語の質問で終わる返答", "pending", judge.pendingQuestionState(
  "確認待ちの並び順は 2 通り考えられます。A = 元の並び順のまま先頭へ、B = 待ち時間が長い順。どちらにしますか？"
), judge.pendingQuestionQuestions(), judge.interpretPendingQuestion);
await run("完了報告（フォローアップ提案付き）", "pending", judge.pendingQuestionState(
  "実装が完了しました。テスト 470 件・型検査・Lint はすべて成功です。変更ファイルは format.ts と renderer.ts です。必要なら次にコミットも行えます。"
), judge.pendingQuestionQuestions(), judge.interpretPendingQuestion);
await run("許可を求める返答", "pending", judge.pendingQuestionState(
  "dist フォルダを削除してから再ビルドする必要があります。削除して進めてよいですか？"
), judge.pendingQuestionQuestions(), judge.interpretPendingQuestion);

// 2. 危険度
await run("rm -rf dist", "danger", judge.dangerState({ name: "Bash", input: JSON.stringify({ command: "rm -rf dist && npm run build" }) }, "Claude needs your permission to use Bash"), judge.dangerQuestions(), judge.interpretDanger);
await run("git push --force", "danger", judge.dangerState({ name: "Bash", input: JSON.stringify({ command: "git push --force origin main" }) }, "Claude needs your permission to use Bash"), judge.dangerQuestions(), judge.interpretDanger);
await run("ファイルを読むだけ", "danger", judge.dangerState({ name: "Read", input: JSON.stringify({ file_path: "C:/dev/app/src/index.ts" }) }, "Claude needs your permission to use Read"), judge.dangerQuestions(), judge.interpretDanger);
await run("npm test", "danger", judge.dangerState({ name: "Bash", input: JSON.stringify({ command: "npm test" }) }, "Claude needs your permission to use Bash"), judge.dangerQuestions(), judge.interpretDanger);

// 3. 作業テキスト
for (const prompt of ["はい", "A", "続けて", "OK。コミットプッシュして。", "在庫の発注点を再計算して"]) {
  await run(`prompt=「${prompt}」`, "workText", prompt, judge.workTextQuestions(), judge.interpretWorkText);
}

// 4. 停滞
const failing = [];
for (let i = 0; i < 4; i++) {
  failing.push({ kind: "tool_use", text: 'Bash {"command":"npx vitest run tests/foo.test.ts"}' });
  failing.push({ kind: "tool_result", text: "FAIL tests/foo.test.ts > adds: expected 3 to be 4", error: true });
}
await run("同じテストを 4 回失敗", "stall", judge.stallState(failing), judge.stallQuestions(), judge.interpretStall);
const progressing = [
  { kind: "tool_use", text: 'Read {"file_path":"src/a.ts"}' },
  { kind: "tool_result", text: "export function a() {...}" },
  { kind: "tool_use", text: 'Edit {"file_path":"src/a.ts","old_string":"x","new_string":"y"}' },
  { kind: "tool_result", text: "The file has been updated" },
  { kind: "tool_use", text: 'Bash {"command":"npx vitest run"}' },
  { kind: "tool_result", text: "Tests 12 passed (12)" },
  { kind: "text", text: "テストが通ったので README を更新します" },
  { kind: "tool_use", text: 'Edit {"file_path":"README.md"}' },
  { kind: "tool_result", text: "The file has been updated" },
];
await run("順調に進む手順", "stall", judge.stallState(progressing), judge.stallQuestions(), judge.interpretStall);

const out = process.argv[2];
if (out) {
  fs.writeFileSync(out, JSON.stringify({ model: jev.model, at: new Date().toISOString(), cases }, null, 2));
  console.log(`\nsaved: ${out}`);
}
