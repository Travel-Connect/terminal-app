/**
 * 260712_7: 再接続の「動作中」判定窓（RECONNECT_ACTIVE_MS）が、切断検知の HARD 閾値
 * （liveness-monitor.TRANSCRIPT_STALE_HARD_MS。ウィンドウ有無に関わらず切断とみなす基準）
 * より短いと、「切断」と判定された直後に再接続してもヒットしない（時間軸で必ず手遅れになる）。
 * この矛盾が実際に発生した（product-register, 2026-07-12 08:06 切断 → 08:07 再接続失敗）ため、
 * 「HARD 閾値以上の経過でも動作中とみなす」ことを固定でテストする。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRANSCRIPT_STALE_HARD_MS } from "../src/main/liveness-monitor";
import { RECONNECT_ACTIVE_MS, scanLiveSessions, transcriptDirFor } from "../src/main/session-scan";

const PROJECT = "C:\\dev\\terminal-app";

let home: string;
let dir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ta-scan-reconnect-"));
  dir = transcriptDirFor(PROJECT, home);
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeTranscript(name: string, ageMs: number): string {
  const p = path.join(dir, name);
  const rec = { type: "user", message: { role: "user", content: "依頼" }, cwd: PROJECT };
  fs.writeFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

describe("RECONNECT_ACTIVE_MS と切断検知 HARD 閾値の整合性", () => {
  it("RECONNECT_ACTIVE_MS は切断検知の HARD 閾値（TRANSCRIPT_STALE_HARD_MS）以上である", () => {
    // 「切断」と判定された時点で transcript は最低でも HARD 閾値ぶん無更新のため、
    // 再接続の窓がそれより狭いと理屈上ヒットしなくなる（対称性の担保）。
    expect(RECONNECT_ACTIVE_MS).toBeGreaterThanOrEqual(TRANSCRIPT_STALE_HARD_MS);
  });

  it("transcript 無更新が HARD 閾値ちょうど（切断判定される瞬間）でも「動作中」として拾える", () => {
    writeTranscript("just-disconnected.jsonl", TRANSCRIPT_STALE_HARD_MS);
    const found = scanLiveSessions(PROJECT, { homeDir: home });
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe("just-disconnected");
  });
});
