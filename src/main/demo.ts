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
  /** 手動ステータス（260727_1 のバッジ表示確認用。実運用ではタイル右クリックで割り当て） */
  status?: string;
  /** 未接続（260903_1 の灰色表示確認用。実運用では対象アプリのウィンドウ有無を EnumWindows で判定） */
  unlinked?: boolean;
  /**
   * 同じプロジェクトの 2 本目以降のセッション（260904_1 #3 の分割タイル確認用）。
   * 実運用では同じフォルダで複数の claude が動いていると自動で分かれる
   */
  extra?: Array<{ state: SessionState; ago: number; work?: string }>;
  /** 260922_2: 危険度の印（confirm のみ。Jev 判定の表示確認用） */
  danger?: string;
  /** 260922_2: 停滞の疑いの印（running のみ。Jev 判定の表示確認用） */
  stall?: string;
  /** 260922_2: 確認待ちの種別（既定 permission。question = 返答待ち） */
  confirmKind?: "permission" | "question";
}

/** モック面 1b の 12 タイル構成（context-design-mock.md） */
const MOCK_1B: DemoSeed[] = [
  { name: "在庫管理-app", state: "done", ago: 120, work: "棚卸し差分のレポートを作成して", status: "レビュー待ち" }, // 完了・2分前
  { name: "商品登録-app", state: "running", ago: 48 * 60 + 12, work: "Yahooカテゴリ反映ボタンを追加して", status: "作業中" }, // 0:48:12
  { name: "メルマガ作成-app", state: "confirm", ago: 60, work: "7月セールの下書きを作って", danger: "取り消せない操作・外部へ送る操作" }, // 確認待ち・1分前（260922_2: 危険度の印）
  { name: "商品ページ作成-app", state: "done", ago: 10, unlinked: true }, // 完了・たった今（Cursor は閉じている = 未接続）
  { name: "受注管理-app", state: "confirm", ago: 15 * 60 + 4, work: "注文CSVの取込を直して", confirmKind: "question" }, // 260922_2: 返答待ち（Jev 判定）
  { name: "顧客分析-app", state: "running", ago: 7 * 60 + 41 },
  { name: "売上レポート-app", state: "error", ago: 8 * 60, status: "保留", unlinked: true }, // エラー・8分前（未接続）
  { name: "発注最適化-app", state: "running", ago: 32 * 60 + 55, work: "在庫の発注点を再計算して", stall: "停滞の疑い・同じ失敗を繰り返し" }, // 260922_2: 停滞の印
  { name: "レビュー返信-app", state: "running", ago: 3 * 60 + 2 },
  { name: "配送追跡-app", state: "running", ago: 51 * 60 + 30 },
  { name: "問い合わせbot", state: "running", ago: 60 * 60 + 5, unlinked: true }, // 実行中はウィンドウ無しでも灰色にしない（isUnlinked の除外規則の確認用）
  { name: "棚卸し-app", state: "running", ago: 2 * 60 * 60 + 15 * 60 + 9 }, // 2:15:09
];

const EXTRA_16: DemoSeed[] = [
  { name: "需要予測-app", state: "done", ago: 300 },
  // 分割タイル（260904_1 #3）: 1 つの Cursor で 2 本の claude（① 確認待ち / ② 実行中）
  { name: "棚割り-app", state: "confirm", ago: 30, work: "棚割り表の再計算をして", status: "作業中", extra: [{ state: "running", ago: 3 * 60 + 20, work: "テストを全部通して" }] },
  { name: "画像生成-app", state: "error", ago: 600 },
  { name: "監査ログ-app", state: "waiting-none", ago: 0, unlinked: true }, // 待機（イベント未受信）タイルの確認用（未接続）
];

/**
 * シード投入。戻り値は 260903_1 のウィンドウ有無マップ（実運用では index.ts の pollWindowPresence が
 * EnumWindows で作る値。デモではシードの unlinked から固定値を作り、キャプチャで灰色表示を確認できるようにする）
 */
export function seedDemo(projectStore: ProjectStore, stateStore: StateStore, count: 12 | 16 = 12): Record<string, boolean> {
  const seeds = count === 16 ? [...MOCK_1B, ...EXTRA_16] : MOCK_1B;
  const now = Date.now();
  const presence: Record<string, boolean> = {};
  seeds.forEach((seed, i) => {
    const id = `demo-${String(i + 1).padStart(2, "0")}`;
    const project: Project = {
      id,
      name: seed.name,
      path: `C:\\dev\\demo\\${seed.name}`,
      clickTarget: i % 2 === 0 ? "cursor" : "terminal",
      registeredAt: new Date(now - 86400000).toISOString(),
      customStatus: seed.status,
    };
    projectStore.addProjectDirect(project);
    presence[id] = seed.unlinked !== true;
    if (seed.state === "waiting-none") return; // タイルは「待機」表示（セッションなし）
    stateStore.seedSession({
      sessionId: `s-${id}`,
      projectId: id,
      state: seed.state,
      lastEventAt: now - seed.ago * 1000,
      runningSince: seed.state === "running" ? now - seed.ago * 1000 : undefined,
      lastMessage: seed.state === "confirm" ? (seed.confirmKind === "question" ? "Claude が返答を待っています" : "Claude needs your permission to use Bash") : undefined,
      workText: seed.work,
      firstSeenAt: now - 3600_000, // 1 本目が先に起動した想定（分割時の並び順）
      confirmKind: seed.state === "confirm" ? (seed.confirmKind ?? "permission") : undefined,
      dangerText: seed.state === "confirm" ? seed.danger : undefined,
      stallText: seed.state === "running" ? seed.stall : undefined,
    });
    (seed.extra ?? []).forEach((ex, j) => {
      stateStore.seedSession({
        sessionId: `s-${id}-${j + 2}`,
        projectId: id,
        state: ex.state,
        lastEventAt: now - ex.ago * 1000,
        runningSince: ex.state === "running" ? now - ex.ago * 1000 : undefined,
        workText: ex.work,
        firstSeenAt: now - 3600_000 + (j + 1) * 60_000,
      });
    });
  });
  return presence;
}
