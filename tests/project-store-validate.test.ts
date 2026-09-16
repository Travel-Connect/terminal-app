/**
 * 260916_4: ドライブ直下・ホームフォルダは登録拒否（実運用で `C:\` と `C:\dev` が登録され、C:\.claude に hooks が書かれていた）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateProjectDir } from "../src/main/project-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-validate-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("validateProjectDir", () => {
  it("通常のフォルダは登録できる", () => {
    expect(validateProjectDir(dir, [])).toEqual({ ok: true });
  });

  it("ドライブ直下（C:\\ / C:/）は拒否", () => {
    const root = path.parse(dir).root; // 例 C:\ （`C:` は path.resolve でカレントディレクトリになるため対象外）
    for (const p of [root, root.replace(/\\/g, "/")]) {
      const r = validateProjectDir(p, []);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("ドライブ直下");
    }
  });

  it("ホームフォルダは拒否", () => {
    const r = validateProjectDir(os.homedir(), []);
    expect(r.ok).toBe(false);
  });

  it("存在しない・ファイル・重複は従来どおり拒否", () => {
    expect(validateProjectDir(path.join(dir, "nope"), []).ok).toBe(false);
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    expect(validateProjectDir(file, []).ok).toBe(false);
    expect(validateProjectDir(dir, [{ id: "p", name: "x", path: dir, clickTarget: "cursor", registeredAt: "" }]).ok).toBe(false);
  });
});
