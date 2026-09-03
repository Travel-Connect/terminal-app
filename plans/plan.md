# 260904_1 実装計画（画面メモ #1〜#3）

依頼: 2026-09-04 スクリーンショット注釈 #1〜#3。確認済み仕様（AskUserQuestion 2 ラウンド）:

| # | 確定仕様 |
|---|---------|
| #1 | 手動ステータスのバッジを表示名の下の行へ（名前は 1 行いっぱい） |
| #2 | 完了・切断の掃引 30 秒 → 15 秒。同周期で「確認待ち」中に transcript が更新（または登録簿 status=busy）なら「実行中」へ自動復帰。確認待ちは青（--accent）で 1 秒周期の点滅 |
| #3 分割 | 同じフォルダで生きている claude が 2 本以上のときだけタイルを自動分割（「名前 ①②」起動順）。生死は `~/.claude/sessions/<pid>.json`（Claude Code 自身の登録簿）＋ PID 存在で判定。分割タイル右クリック「この枠を消す」。件数は表示タイル基準 |
| #3 位置 | タイル右クリック「ウィンドウ位置を記憶／戻す／記憶を消す」、設定画面に全プロジェクト一括の記憶／復元。「立ち上げる」後は記憶位置へ自動適用。projects.json に保存（最大化保持・画面外は復元しない） |

## モジュール

1. `src/shared/types.d.ts` — WindowBounds / Project.windowBounds / SessionView.firstSeenAt / Snapshot.splitSessions / API 追加
2. `src/main/session-registry.ts`（新規）— 登録簿の読み取り・生死分類（純関数 + fs）
3. `src/main/state-store.ts` — dead フラグ・firstSeenAt・splitSessions・countTiles・resumeFromConfirm・removeSession・pruneDeadSessions
4. `src/main/liveness-monitor.ts` — 15 秒・findResumedFromConfirm
5. `src/main/window-bounds.ts`（新規）— WindowBounds の検証・整形（純関数）
6. `src/main/window-control.ts` — GetWindowPlacement / SetWindowPlacement / MonitorFromRect
7. `src/main/project-store.ts` — setWindowBounds・load 時の検証
8. `src/main/index.ts` — 掃引の拡張・スナップショット・メニュー・IPC・立ち上げ後の位置復元
9. `src/preload/index.ts` / `src/renderer/*` — 分割タイル・バッジ配置・青点滅・設定画面ボタン
10. `src/main/demo.ts` — 分割タイルのシード（証跡用）
11. `scripts/verify-split-blink-e2e.mjs`（新規）— CDP で証跡採取 → `docs/evidence/20260904-split-blink/`

## 検証

- `npm run typecheck` / `npm run lint` / `npm test`（新規テスト 6 本）
- E2E（デモ）スクリーンショット、稼働アプリ再起動後の実ログ（掃引・登録簿・復帰）
- 完了報告 HTML（completion-dashboard.html）
