/**
 * project-root の単体テスト（260727_1 / 260729 改定: D&D のプロジェクトルート解決）。
 * 認識合わせ（260729 改定）: ディレクトリのドロップ・フォルダ選択はユーザーが対象を明示して
 * いるため、そのディレクトリ自体を登録する（祖先探索しない）。祖先探索すると、複数プロジェクトを
 * 束ねる親フォルダ（例: 開発案件/ の .claude）に吸われて親が登録される実障害が起きた。
 * ファイルのドロップのみ .claude / .git を目印に祖先へ遡ってルートに読み替える。
 * 探索は stopDir（実運用ではホームディレクトリ）で打ち切る — ~/.claude を誤検知して
 * ホームをプロジェクト登録しないため。テストでは stopDir に一時ディレクトリを渡して決定化する。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectRoot } from "../src/main/project-root";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-root-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** root 配下に相対パスでディレクトリ／ファイルを作るヘルパ */
function mkdir(rel: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function mkfile(rel: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  return p;
}

/** stopDir を一時ディレクトリに固定して呼ぶ（実行環境のホーム階層に依存させない） */
function resolve(p: string): string | null {
  return resolveProjectRoot(p, { stopDir: root });
}

describe("resolveProjectRoot（260727_1 / D&D ルート解決）", () => {
  it("ファイルのドロップ: 祖先の .git を持つディレクトリをルートとして返す", () => {
    const project = mkdir("proj");
    mkdir("proj/.git");
    const file = mkfile("proj/src/deep/util.py");
    expect(resolve(file)).toBe(project);
  });

  it("ディレクトリのドロップ: 祖先に目印があってもそのディレクトリ自体を返す（260729 改定）", () => {
    mkdir("proj");
    mkdir("proj/.claude");
    const sub = mkdir("proj/docs/images");
    expect(resolve(sub)).toBe(sub);
  });

  it("回帰: 親フォルダに .claude がある目印なしプロジェクトのドロップで親を登録しない（260729 実障害）", () => {
    // 実例: 開発案件/.claude がある状態で 開発案件/shopifyカレンダー作成 をドロップ →
    // 親の 開発案件 ではなく、ドロップしたフォルダ自体が登録されること
    mkdir(".claude"); // stopDir（擬似ホーム）直下ではなく親フォルダ側に置く構図を作る
    mkdir("kaihatsu/.claude");
    const dropped = mkdir("kaihatsu/shopify-calendar");
    expect(resolve(dropped)).toBe(dropped);
  });

  it("プロジェクトルート自体のドロップ: そのまま返す（既存挙動の維持）", () => {
    const project = mkdir("proj");
    mkdir("proj/.git");
    expect(resolve(project)).toBe(project);
  });

  it("目印が複数階層にある場合は最も近い祖先を返す（ネストしたリポジトリ）", () => {
    mkdir("outer/.git");
    const inner = mkdir("outer/packages/inner");
    mkdir("outer/packages/inner/.claude");
    const file = mkfile("outer/packages/inner/src/a.ts");
    expect(resolve(file)).toBe(inner);
  });

  it("目印なしのディレクトリ: ドロップされたディレクトリ自体を返す（従来のフォルダ D&D と同じ）", () => {
    const plain = mkdir("plain-folder");
    expect(resolve(plain)).toBe(plain);
  });

  it("目印なしのファイル: 親ディレクトリを返す", () => {
    const file = mkfile("plain/note.md");
    expect(resolve(file)).toBe(path.join(root, "plain"));
  });

  it("存在しないパスは null（呼び出し側で登録エラーに落とす）", () => {
    expect(resolve(path.join(root, "no-such-path"))).toBeNull();
  });

  it(".git がファイルでも目印になる（git worktree / submodule では .git はファイル）", () => {
    const project = mkdir("wt");
    mkfile("wt/.git");
    const file = mkfile("wt/src/a.ts");
    expect(resolve(file)).toBe(project);
  });

  it("stopDir 自身の目印は判定しない（実運用: ~/.claude を誤検知してホームを登録しない）", () => {
    // root を擬似ホームに見立てる: root/.claude があっても、root 配下の目印なしフォルダは
    // root まで遡らず、そのフォルダ自体が返る
    mkdir(".claude");
    const plain = mkdir("Downloads/stuff");
    expect(resolve(plain)).toBe(plain);
  });

  it("stopDir の外のパスはドライブルートまで通常どおり探索する", () => {
    // stopDir を無関係な階層にして、探索が stopDir に一切触れないケース
    const project = mkdir("elsewhere/proj");
    mkdir("elsewhere/proj/.git");
    const file = mkfile("elsewhere/proj/src/a.ts");
    expect(resolveProjectRoot(file, { stopDir: path.join(root, "unrelated") })).toBe(project);
  });
});
