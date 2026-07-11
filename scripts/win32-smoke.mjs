// window-control（koffi / user32）のスモーク検証。
// ビルド済み dist/main/window-control.js を素の Node から呼び、
// FFI ロードとトップレベルウィンドウ列挙が動くことを確認する（V-09 の前提部分の証跡）。
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wc = require(join(root, "dist", "main", "window-control.js"));

console.log(`win32 API 利用可否: ${wc.isAvailable()}`);
const windows = wc.listTopLevelWindows();
console.log(`可視トップレベルウィンドウ数: ${windows.length}`);
for (const w of windows.slice(0, 10)) {
  console.log(`- [${w.exe || "?"}] ${w.title.slice(0, 70)}`);
}
// 存在しないプロジェクト名での前面化は「見つからない」を返すこと（例外にならない）
const outcome = wc.focusProjectWindow("cursor", "__no_such_project__");
console.log(`存在しない対象の前面化: ok=${outcome.ok} message=${outcome.message}`);
if (wc.isAvailable() && windows.length > 0 && outcome.ok === false) {
  console.log("smoke: OK");
} else {
  console.log("smoke: NG");
  process.exitCode = 1;
}
