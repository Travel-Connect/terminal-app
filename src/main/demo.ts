/**
 * デモモード（--demo）: UI 検証・スクリーンショット証跡用のシードデータ。
 * - モック面 1b 相当の 12 プロジェクト（8実行中 2完了 1確認待ち 1エラー / 12セッション）
 * - --demo-count=16 で NFR-05（16 タイル非破綻）の確認用に 16 件へ拡張
 * - hooks 追記・実ディレクトリ検証は一切行わない（addProjectDirect / seedSession のみ）
 * - main 側でデータディレクトリを一時フォルダへ差し替えて実行する（実 %APPDATA% を汚さない）
 */
import type { Project, SessionState } from "../shared/types";
import type { ProjectStore } from "./project-store";
import type { StateStore } from "./state-store";

interface DemoSeed {
  name: string;
  state: SessionState | "waiting-none";
  /** running: 経過秒 / done・confirm・error: 最終イベントからの経過秒 */
  ago: number;
  /** 現在の作業テキスト（260712 課題B の表示確認用。実運用では UserPromptSubmit の prompt 由来） */
  work?: string;
}

/** モック面 1b の 12 タイル構成（context-design-mock.md） */
const MOCK_1B: DemoSeed[] = [
  { name: "在庫管理-app", state: "done", ago: 120, work: "棚卸し差分のレポートを作成して" }, // 完了・2分前
  { name: "商品登録-app", state: "running", ago: 48 * 60 + 12, work: "Yahooカテゴリ反映ボタンを追加して" }, // 0:48:12
  { name: "メルマガ作成-app", state: "confirm", ago: 60, work: "7月セールの下書きを作って" }, // 確認待ち・1分前
  { name: "商品ページ作成-app", state: "done", ago: 10 }, // 完了・たった今
  { name: "受注管理-app", state: "running", ago: 15 * 60 + 4 },
  { name: "顧客分析-app", state: "running", ago: 7 * 60 + 41 },
  { name: "売上レポート-app", state: "error", ago: 8 * 60 }, // エラー・8分前
  { name: "発注最適化-app", state: "running", ago: 32 * 60 + 55 },
  { name: "レビュー返信-app", state: "running", ago: 3 * 60 + 2 },
  { name: "配送追跡-app", state: "running", ago: 51 * 60 + 30 },
  { name: "問い合わせbot", state: "running", ago: 60 * 60 + 5 },
  { name: "棚卸し-app", state: "running", ago: 2 * 60 * 60 + 15 * 60 + 9 }, // 2:15:09
];

const EXTRA_16: DemoSeed[] = [
  { name: "需要予測-app", state: "done", ago: 300 },
  { name: "棚割り-app", state: "confirm", ago: 30 },
  { name: "画像生成-app", state: "error", ago: 600 },
  { name: "監査ログ-app", state: "waiting-none", ago: 0 }, // 待機（イベント未受信）タイルの確認用
];

export function seedDemo(projectStore: ProjectStore, stateStore: StateStore, count: 12 | 16 = 12): void {
  const seeds = count === 16 ? [...MOCK_1B, ...EXTRA_16] : MOCK_1B;
  const now = Date.now();
  seeds.forEach((seed, i) => {
    const id = `demo-${String(i + 1).padStart(2, "0")}`;
    const project: Project = {
      id,
      name: seed.name,
      path: `C:\\dev\\demo\\${seed.name}`,
      clickTarget: i % 2 === 0 ? "cursor" : "terminal",
      registeredAt: new Date(now - 86400000).toISOString(),
    };
    projectStore.addProjectDirect(project);
    if (seed.state === "waiting-none") return; // タイルは「待機」表示（セッションなし）
    stateStore.seedSession({
      sessionId: `s-${id}`,
      projectId: id,
      state: seed.state,
      lastEventAt: now - seed.ago * 1000,
      runningSince: seed.state === "running" ? now - seed.ago * 1000 : undefined,
      lastMessage: seed.state === "confirm" ? "Claude needs your permission to use Bash" : undefined,
      workText: seed.work,
    });
  });
}
