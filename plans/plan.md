# 260906_1 実装計画（画面メモ #1〜#2 ＋ 自動整列）

依頼: 2026-09-06 スクリーンショット注釈 #1（整列ボタンを追加）・#2（ドラッグドロップでカードを並べ替え）＋
テキスト「整列の機能で自動整列の機能を追加して、接続中のアプリを左上に持ってきてほしい」。
自律実行（確認不可）のため、解釈の分かれる点は仮定（※）として明示し、完了報告にも載せる。

| # | 仕様（※ = 仮定） |
|---|---------|
| #1 | タイトルバー右のボタン群（フォルダ登録の右隣）に「自動整列」ボタン。押すと接続中（既存の未接続判定 isUnlinked でない）プロジェクトを先頭＝左上へ、未接続を後ろへ寄せる。※各グループ内の相対順（D&D で決めた順）は維持する。※ボタン押下時の 1 回だけ実行し、5 秒ごとのウィンドウ判定に追従して勝手に並び替えない |
| #2 | タイルを HTML5 D&D で並べ替え。ドロップ先タイルの左半分＝手前、右半分＝直後（アクセント色の縦線で挿入位置を示す）。分割タイル ①② はプロジェクト単位で一緒に動く。内部ドラッグは専用 MIME で識別し、フォルダ登録の D&D（オーバーレイ）と混ざらない |
| 保存 | 並び順 = projects.json の配列順そのもの（新しいキーは持たない）。D&D・自動整列とも `reorderProjects(ids)` 1 本で保存し、順序が同じなら保存も配信もしない |

## モジュール

1. `src/shared/types.d.ts` — `reorderProjects(ids)` API
2. `src/renderer/format.ts` — `projectLinked` / `autoArrangeIds` / `moveProjectId`（DOM 非依存の純関数。単体テスト対象）
3. `src/main/project-store.ts` — `reorderProjects(ids)`（未知 id 無視・欠落は末尾に元順・重複は初出のみ・無変化は false）
4. `src/main/index.ts` — IPC `reorder-projects`（引数検証・ログ・broadcast）
5. `src/preload/index.ts` — ブリッジ
6. `src/renderer/index.html` / `styles.css` / `renderer.ts` — 整列ボタン・タイル D&D（dragstart/dragover/drop/dragend）・挿入位置の目印・window 側の登録 D&D との切り分け
7. `scripts/verify-arrange-e2e.mjs`（新規）— CDP ＋ 合成 DragEvent で証跡採取 → `docs/evidence/20260906-arrange/`

## 検証

- `npm run typecheck` / `npm run lint` / `npm test`（新規テスト 2 ファイル 19 件: `tests/format-arrange.test.ts`・`tests/project-store-reorder.test.ts`）
- E2E（デモ 12 件）: 自動整列で接続中 10 件が先頭・未接続 2 件が末尾、再押下は「整列済み」、D&D 手前／直後、永続化、登録 D&D の回帰
- 稼働アプリを再起動して新ビルドを反映、実ログで「並び順変更」を確認
- 完了報告 HTML（completion-dashboard.html）
