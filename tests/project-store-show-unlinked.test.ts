/**
 * 未接続タイルの表示／非表示トグル（260903_1）の永続化。
 * config.json の showUnlinked（既定 true = 従来どおり全タイル表示）。旧 config・壊れた値は true に倒す。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/project-store";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-data-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function newStore(): ProjectStore {
  const store = new ProjectStore(dataDir);
  store.load();
  return store;
}

describe("showUnlinked（260903_1）", () => {
  it("既定は true（未接続タイルも表示 = 従来と同じ見え方）", () => {
    expect(newStore().config.showUnlinked).toBe(true);
  });

  it("false にすると config.json に保存され、再ロードで復元される", () => {
    newStore().setShowUnlinked(false);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) as { showUnlinked?: boolean };
    expect(saved.showUnlinked).toBe(false);
    expect(newStore().config.showUnlinked).toBe(false);
  });

  it("旧バージョンの config.json（キー欠落）と壊れた値は true で補完し、他の設定は保持する", () => {
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({ version: 1, port: 41321, theme: "dark", alwaysOnTopDefault: true, notifySound: { enabled: false } })
    );
    const store = newStore();
    expect(store.config.showUnlinked).toBe(true);
    expect(store.config.theme).toBe("dark");
    expect(store.config.alwaysOnTopDefault).toBe(true);

    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ version: 1, showUnlinked: "no" }));
    expect(newStore().config.showUnlinked).toBe(true);
  });
});
