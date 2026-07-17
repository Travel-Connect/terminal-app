/**
 * Windows で `tsc.cmd` 経由のビルドが黒いコンソールをフラッシュしないよう、
 * node から typescript を直接起動する（windowsHide: true）。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

function runTsc(config) {
  const result = spawnSync(process.execPath, [tsc, "-p", config], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runTsc("tsconfig.main.json");
runTsc("tsconfig.renderer.json");

const srcDir = join(root, "src", "renderer");
const outDir = join(root, "dist", "renderer");
mkdirSync(outDir, { recursive: true });
for (const f of ["index.html", "styles.css"]) {
  copyFileSync(join(srcDir, f), join(outDir, f));
}
console.log(`copy-assets: index.html, styles.css -> ${outDir}`);
