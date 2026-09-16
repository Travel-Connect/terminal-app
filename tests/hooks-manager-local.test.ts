/**
 * 260916_4: 書き込み先を共有 settings.json から settings.local.json へ変更し、旧書き込み分を移行する。
 * - 既定の書き込み先は .claude/settings.local.json（Claude Code が git 除外する project-local settings）
 * - migrateLegacyHooks は共有 settings.json から自アプリ分（マーカー付き hooks・自アプリの statusLine）だけを取り除く
 * - 共有側にユーザー自身の statusLine があれば local には書かない（local が優先されて上書きになるため）
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_HOOK_EVENTS,
  backupPathFor,
  buildHookCommand,
  buildStatusLineCommand,
  legacySettingsPathFor,
  LOCAL_SETTINGS_FILE,
  mergeHooks,
  mergeStatusLine,
  migrateLegacyHooks,
  removeHooks,
  SETTINGS_FILE,
  settingsPathFor,
} from "../src/main/hooks-manager";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ta-local-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (p: string): Record<string, unknown> => JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
const ourEntry = (port = 41321) => ({ hooks: [{ type: "command", command: buildHookCommand(port), timeout: 5 }] });
const userHook = { matcher: "", hooks: [{ type: "command", command: "node scripts/my-notify.js" }] };

describe("パス", () => {
  it("既定は settings.local.json。legacy は settings.json。バックアップはそれぞれの隣", () => {
    expect(settingsPathFor(dir)).toBe(path.join(dir, ".claude", "settings.local.json"));
    expect(settingsPathFor(dir, SETTINGS_FILE)).toBe(path.join(dir, ".claude", "settings.json"));
    expect(legacySettingsPathFor(dir)).toBe(settingsPathFor(dir, SETTINGS_FILE));
    expect(backupPathFor(dir)).toBe(settingsPathFor(dir, LOCAL_SETTINGS_FILE) + ".terminal-app.bak");
    expect(backupPathFor(dir, SETTINGS_FILE)).toBe(legacySettingsPathFor(dir) + ".terminal-app.bak");
  });

  it("mergeHooks / mergeStatusLine は settings.local.json に書き、settings.json には触れない", () => {
    const shared = { permissions: { allow: ["Read"] } };
    fs.writeFileSync(legacySettingsPathFor(dir), JSON.stringify(shared));
    expect(mergeHooks(dir, 41321, ALL_HOOK_EVENTS).changed).toBe(true);
    expect(mergeStatusLine(dir, 41321).changed).toBe(true);
    expect(read(legacySettingsPathFor(dir))).toEqual(shared);
    const local = read(settingsPathFor(dir));
    expect(Object.keys(local.hooks as object).sort()).toEqual([...ALL_HOOK_EVENTS].sort());
    expect((local.statusLine as { command: string }).command).toBe(buildStatusLineCommand(41321));
  });
});

describe("migrateLegacyHooks", () => {
  it("共有 settings.json から自アプリ分だけを取り除き、ユーザーの hook・他キーは残す。空になった hooks 配列・キーは消す", () => {
    const legacy = {
      permissions: { allow: ["Read"] },
      statusLine: { type: "command", command: buildStatusLineCommand(41321) },
      hooks: {
        Stop: [userHook, ourEntry()],
        Notification: [ourEntry()],
        UserPromptSubmit: [ourEntry()],
        TaskCreated: [ourEntry()],
        SessionStart: [ourEntry()],
      },
    };
    fs.writeFileSync(legacySettingsPathFor(dir), JSON.stringify(legacy, null, 2));
    // 先に local へ追記（index.ts の順序）
    expect(mergeHooks(dir, 41321, ALL_HOOK_EVENTS).ok).toBe(true);
    expect(mergeStatusLine(dir, 41321).ok).toBe(true);
    const r = migrateLegacyHooks(dir, ALL_HOOK_EVENTS);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(read(legacySettingsPathFor(dir))).toEqual({ permissions: { allow: ["Read"] }, hooks: { Stop: [userHook] } });
    expect(fs.existsSync(backupPathFor(dir, SETTINGS_FILE))).toBe(true); // 共有側のバックアップ
    const local = read(settingsPathFor(dir));
    expect(Object.keys(local.hooks as object).sort()).toEqual([...ALL_HOOK_EVENTS].sort());
    expect((local.statusLine as { command: string }).command).toBe(buildStatusLineCommand(41321));
    // 冪等
    expect(migrateLegacyHooks(dir, ALL_HOOK_EVENTS)).toMatchObject({ ok: true, changed: false });
  });

  it("共有 settings.json が無い・自アプリ分が無いなら何もしない（changed=false）", () => {
    expect(migrateLegacyHooks(dir)).toEqual({ ok: true, changed: false });
    fs.writeFileSync(legacySettingsPathFor(dir), JSON.stringify({ hooks: { Stop: [userHook] } }));
    const before = fs.readFileSync(legacySettingsPathFor(dir), "utf8");
    expect(migrateLegacyHooks(dir)).toMatchObject({ ok: true, changed: false });
    expect(fs.readFileSync(legacySettingsPathFor(dir), "utf8")).toBe(before);
  });

  it("共有 settings.json が壊れていれば何も書かず error（1 バイトも変えない）", () => {
    const broken = "{ not json";
    fs.writeFileSync(legacySettingsPathFor(dir), broken);
    const r = migrateLegacyHooks(dir);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("settings.json");
    expect(fs.readFileSync(legacySettingsPathFor(dir), "utf8")).toBe(broken);
  });
});

describe("statusLine の優先関係", () => {
  it("共有 settings.json にユーザー自身の statusLine があれば local には書かない（skipped）", () => {
    fs.writeFileSync(legacySettingsPathFor(dir), JSON.stringify({ statusLine: { type: "command", command: "~/.claude/statusline.sh" } }));
    expect(mergeStatusLine(dir, 41321)).toEqual({ ok: true, changed: false, skipped: true });
    expect(fs.existsSync(settingsPathFor(dir))).toBe(false);
  });

  it("共有側の statusLine が自アプリ分なら local へ書ける（移行で共有側から消える）", () => {
    fs.writeFileSync(legacySettingsPathFor(dir), JSON.stringify({ statusLine: { type: "command", command: buildStatusLineCommand(40000) } }));
    expect(mergeStatusLine(dir, 41321).changed).toBe(true);
    expect(migrateLegacyHooks(dir).changed).toBe(true);
    expect(read(legacySettingsPathFor(dir))).toEqual({});
  });
});

describe("removeHooks の file 指定", () => {
  it("SETTINGS_FILE を渡すと共有 settings.json 側から除去する", () => {
    fs.writeFileSync(legacySettingsPathFor(dir), JSON.stringify({ hooks: { Stop: [ourEntry(), userHook] } }));
    expect(removeHooks(dir, ALL_HOOK_EVENTS).changed).toBe(false); // local には無い
    expect(removeHooks(dir, ALL_HOOK_EVENTS, SETTINGS_FILE).changed).toBe(true);
    expect(read(legacySettingsPathFor(dir))).toEqual({ hooks: { Stop: [userHook] } });
  });
});
