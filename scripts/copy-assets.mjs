// renderer の静的アセット（index.html / styles.css）を dist へコピーする（build の一部）
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src", "renderer");
const outDir = join(root, "dist", "renderer");

mkdirSync(outDir, { recursive: true });
for (const f of ["index.html", "styles.css"]) {
  copyFileSync(join(srcDir, f), join(outDir, f));
}
console.log(`copy-assets: index.html, styles.css -> ${outDir}`);
