# terminal-app 検証実行記録（verification-results）

| 項目 | 内容 |
|------|------|
| 実施日 | 2026-07-11（初回）／同日 追記: OPEN-04 採用ループ（6 章） |
| 実施者 | Claude Code（eval-loop turn-000 実装フェーズ） |
| 対象 | Electron MVP 実装（`C:/Users/hppym/dev/terminal-app/`、Electron 37.10.3 / Node 22.18.0 / Windows 11） |
| 上位文書 | `verification.md`（V-xx の手順正本）／`spec.md`（AC-xx）／`design.md` |
| 証跡の場所 | 初回分: `.loop/archive-loop-20260711-162831/turns/turn-000-evidence/`（アーカイブ済み）。OPEN-04 採用ループ分（6 章）: `.loop/current/turns/turn-000-evidence/`（以下「evidence/」と表記） |

判定の凡例:

- **成功** — 自動テストまたは実行証跡で合否基準を満たした
- **部分実施** — ローカルで実行可能な範囲は実施して合格。残りは実 Claude Code セッション・実ウィンドウ・目視が必要（未実施範囲と手動手順を明記）
- **未実施** — 今回は実行していない（理由と手動手順を明記）

本記録は verification.md 7 章の実施記録（`verification-log.md` 相当）の初回版に当たる。
**手動 E2E チェックリスト（verification.md 6 章）を通しで実施していないため、本記録では「MVP 完了」とは判定しない。**

## 1. 結果サマリ（V-01〜V-20）

| 検証項目 | 結果 | 実施内容と証跡 | 未実施範囲（手動手順） |
|----------|------|----------------|------------------------|
| V-01 D&D 登録と再起動後の保持 | 部分実施 | 永続化と復元は単体テストで成功（`tests/project-store.test.ts`、evidence/test.log）。登録済みプロジェクトが起動時にタイル表示されることを実アプリで確認（evidence/app-real-project.png） | 実マウス操作での D&D は 6 章 #2・#12 の手動枠 |
| V-02 hooks 追記と既存設定の保全 | 成功 | 単体テスト（.claude なし／既存 hooks あり／不正 JSON／冪等・`tests/hooks-manager.test.ts`）全 green。さらに実アプリ起動経由でサンドボックスの settings.json へマージし、既存 hooks 保全・バックアップ生成・2 回目起動での無書き込みを確認（evidence/sandbox-settings-before.json → after-merge.json、idempotency-check.log） | D&D 起点での一連操作は 6 章 #3 の手動枠 |
| V-03 登録解除で自アプリ分のみ除去 | 成功 | 単体テストで自アプリ分のみ除去・deep equal 一致・空キー削除・不正 JSON 中断を確認（`tests/hooks-manager.test.ts`、evidence/test.log） | 設定画面からの解除操作は 6 章 #16 の手動枠 |
| V-04 Stop 発火 → 1 秒以内に「完了」 | 部分実施 | 擬似注入（curl 実 POST）で Stop → 完了遷移を確認。受信→描画のログ差分 `ui-latency` = **11〜18ms ≤ 1000ms**（evidence/injection-results.log。計測方式は 2026-07-11 変更後の verification.md 3.2 手順 4） | 実 Claude Code セッションでの Stop 発火は 3.2 の手動枠 |
| V-05 Notification 発火 → 「確認待ち」 | 部分実施 | 擬似注入（message = permission 系）で確認待ち遷移・種別分類ログを確認（evidence/injection-results.log、app-demo-injected.png の配送追跡-app） | 実セッションでの許可要求・60 秒放置は 3.3 の手動枠 |
| V-06 呼吸発光（緑/アンバー）と静的な赤 | 部分実施 | CSS 実装は `breath 2.4s ease-in-out infinite`（完了・確認待ちのみ）、エラーは `animation: none`。スクリーンショットで緑/アンバーの発光とエラーの赤を確認（evidence/app-demo-dark.png ほか） | 「約 2.4 秒周期の呼吸」の動的な見え方は 6 章 #6 の目視枠 |
| V-07 実行中表示（スピナー・無発光） | 成功 | 実行中タイルがニュートラル＋スピナー＋経過時間（0:48:14 等）・発光なしで表示（evidence/app-demo-dark.png） | — |
| V-08 タイル表示要素の網羅 | 成功 | プロジェクト名／状態アイコン（✓ ? ⚠ スピナー）／状態ラベル＋相対時刻（完了・2分前）／経過時間（実行中）を確認（evidence/app-demo-dark.png、app-demo-16tiles.png） | — |
| V-09 クリックで前面化（最小化復元含む） | 部分実施 | koffi/user32 FFI のロード・可視トップレベルウィンドウ 38 件の列挙（実 Cursor ウィンドウ含む）・対象不一致時の「ウィンドウが見つかりません」応答を確認（evidence/win32-smoke.log） | 実 Cursor/ターミナルの前面化・最小化復元は 6 章 #8・#9 の手動枠（OS フォーカス依存のため自動化対象外 — verification.md 5 章） |
| V-10 Cursor/ターミナル切替の反映 | 部分実施 | 設定 UI の 2 択トグル実装（evidence/app-settings-dark.png）と clickTarget 永続化の単体テスト成功 | 切替後クリックの実機反映は 6 章 #10 の手動枠 |
| V-11 常に手前の ON/OFF | 部分実施 | `setAlwaysOnTop` ON/OFF の API 反映をログで確認（evidence/run-real-project.log の pin-check 行）。ピン留めボタン・起動時既定値の実装済み | 他ウィンドウとの重なり目視は 6 章 #11 の手動枠 |
| V-12 空状態表示 | 成功 | 登録 0 件で D&D 誘導文言＋「0 セッション」を表示（evidence/app-empty-dark.png） | — |
| V-13 ステータスバー件数の追随 | 成功 | 擬似注入の前後で「8実行中 2完了 1確認待ち 1エラー / 12セッション」→「5実行中 3完了 2確認待ち 2エラー / 12セッション」へ追随（evidence/app-demo-dark.png → app-demo-injected.png）。件数ロジックの単体テストも green | — |
| V-14 アプリ未起動でも Claude Code が完走 | 部分実施 | 停止状態で design.md 4.1 と同一の hook コマンドを実行: exit 28（exit 2 ではない = 非ブロック）・所要 約 2 秒（アーカイブ evidence/hook-noapp.log）。**実測所見: 本マシンでは接続拒否の即時失敗ではなく `-m 2` 上限のタイムアウト失敗**。**追記（2026-07-11 OPEN-04 採用ループ）**: `--connect-timeout 1` で約 1.0 秒／`--connect-timeout 0.5` で約 0.52 秒に短縮できることを実測（各 3 回・いずれも exit 28。evidence/hook-noapp-timeout.log）。採否は design.md 4.6 に記録（今回は未採用・短縮候補として記録） | 実セッションの完走・体感遅延は 3.6 の手動枠 |
| V-15 16 タイルでレイアウト非破綻 | 成功 | 16 タイル（待機タイル含む）で折返し表示・全タイル視認可能（evidence/app-demo-16tiles.png） | クリック可能性の実操作確認は目視枠 |
| V-16 エラーイベントで静的赤表示 | 成功 | design.md 4.8 で形式を確定後、`SessionEnd + reason:"other"` の擬似注入でエラータイル（静的赤・⚠）を確認（evidence/app-demo-injected.png の問い合わせbot、injection-results.log）。マッピングの単体テストも green。検知の網羅範囲は OPEN-03 のまま（9 章） | — |
| V-17 テーマ切替（should） | 成功 | ダーク/ライトのトークン切替を実装。ライト版メイン・設定のスクリーンショット（evidence/app-demo-light.png、app-settings-light.png）。自動はメディアクエリ追従 | モック 1e・1f との詳細比較は目視枠 |
| V-18 MVP で通知音が無効・無音 | 成功 | 通知音トグルが操作不可＋「次期対応」注記で表示（evidence/app-settings-dark.png）。コードベースに音声再生処理は存在せず、config の `notifySound.enabled` は読み込み時に強制 false（単体テストあり） | — |
| V-19 受信サーバが 127.0.0.1 のみバインド | 成功 | `netstat -ano` で `127.0.0.1:41321 LISTENING` のみ・`0.0.0.0` なし（evidence/injection-results.log）。テストでも bind アドレスを assert | — |
| V-20 アイドル時 CPU 負荷 | 成功（短縮版） | **実測（2026-07-11 OPEN-04 採用ループ）**: 「完了」タイル 1 枚（呼吸発光アニメーションあり・スピナーなし）の状態で 60 秒間（2 秒×30 サンプル、`Get-Counter \Process(electron*)\% Processor Time` を論理プロセッサ数 28 で正規化）: **平均 0.03% / 最大 0.359% < 1%**（NFR-07 合格。evidence/idle-cpu.log、計測スクリプト evidence/v20-idle-cpu.ps1） | 3.8 の原手順（5 分放置・タスクマネージャー目視）はさらに長時間の確認をする場合の手動枠 |

## 2. 擬似イベント注入の詳細（verification.md 3.4 / 3.7 の実行結果）

`node scripts/verify-injection.mjs <出力先>` で再実行可能。今回の結果（evidence/injection-results.log）:

| 注入 | 期待 | 結果 |
|------|------|------|
| Stop（棚卸し-app） | 204・実行中→完了 | 204・完了へ遷移（ui-latency 11ms） |
| Notification permission（配送追跡-app のサブディレクトリ cwd） | 204・→確認待ち（親プロジェクトへ対応付け） | 204・確認待ちへ遷移（種別=permission） |
| SessionEnd reason=other（問い合わせbot） | 204・→エラー | 204・エラーへ遷移 |
| 不正 JSON | 400・状態不変 | 400・破棄 |
| 未登録 cwd | 204 受理・破棄ログのみ | 204・「event 破棄」ログ |
| 未知イベント名 | 400 | 400 |
| 別パス /other | 404 | 404 |
| GET | 405 | 405 |

## 3. 自動テスト（verification.md 5 章の単体・統合枠）

- `npm test`（Vitest）: **4 ファイル 57 テスト全件 green**（evidence/test.log）
  - `tests/hooks-manager.test.ts` — settings.json マージ/除去（V-02 / V-03 / NFR-03）
  - `tests/state-store.test.ts` — スキーマ検証・状態遷移 T-1〜T-7・T-10・cwd 最長一致（design.md 4.3〜4.8 / 5 章）
  - `tests/event-server.test.ts` — HTTP 受信・不正入力破棄・バインド（3.4 / NFR-04）
  - `tests/project-store.test.ts` — projects.json / config.json 永続化（V-01 / design.md 9 章）
- `npm run build` / `npm run typecheck` / `npm run lint`: いずれも exit 0（evidence/build.log / typecheck.log / lint.log）

## 4. 未確定事項の技術検証タスク（verification.md 9 章）の状況

| ID | 状況 |
|----|------|
| OPEN-01 | **完了**: Electron で確定（2026-07-11 ユーザー選択）。PoC 比較は不要になった |
| OPEN-03 | 未実施（実 claude プロセスの強制終了実測が必要）。受信側の形式は design.md 4.8 で暫定確定済みのため、検証で SessionEnd hook 追記を採用する場合の受け口は実装済み |
| OPEN-04 | **完了（2026-07-11 案 A 採用・解消）**: ユーザー実測フィードバック（返信＝Stop では変わるが、プロンプト送信では何も変わらない）を受けて案 A を採用。hooks 断片へ UserPromptSubmit を追加し、既存登録へは起動時追補で適用（design.md 4.1 / 4.2 / 4.5）。擬似注入・追補の実測は 6 章。実 Claude Code セッションでの発火タイミング実測は手動枠として残る。T-9 は検証対象になった |

## 5. 次回（手動検証）に残る項目

verification.md 6 章のチェックリストを通しで実施する（特に #2, #4, #5, #8〜#12, #15, #16）。
上表の「部分実施」の未実施範囲はすべて 6 章の該当番号に対応付けてある。

## 6. 追記: OPEN-04 採用ループの実測（2026-07-11。証跡 = `.loop/current/turns/turn-000-evidence/`）

対象変更: hooks 断片の 3 イベント化（UserPromptSubmit 追加）／起動時追補／マーカー厳格化
（command の `/terminal-app/event` 一致）／counts の Snapshot 一本化／表示純関数の切り出し。

### 6.1 UserPromptSubmit → 「実行中」の擬似注入（`node scripts/verify-injection.mjs`）

- デモ 12 タイルへ curl 実 POST（stdin 転送）。`UserPromptSubmit`（在庫管理-app: 完了→実行中）は
  **204 受理 → running 遷移 → ui-latency 9ms**（evidence/injection-results.log）。
- スクリーンショット: 在庫管理-app がニュートラル＋スピナー＋経過時間 `0:00:06` の実行中表示
  （evidence/app-demo-injected.png。ダーク）。ライトテーマの実行中表示は
  evidence/app-demo-light-running.png（棚卸し-app `2:15:11` ほか）。
- 既存注入（Stop 204 / Notification 204 / SessionEnd=error 204 / 不正 JSON 400 / 未登録 cwd 204 破棄 /
  未知イベント 400 / 別パス 404 / GET 405）はすべて前回と同結果（リグレッションなし）。
- V-19 再確認: `netstat` で LISTEN は `127.0.0.1:41321` のみ（同ログ）。

### 6.2 起動時追補（旧 2 イベント → 3 イベント）の before/after（`node scripts/verify-upgrade.mjs`）

旧 2 イベント構成＋他者 hook（command に `terminal-app` をパスとして含む）＋他キー
（permissions / model）を持つサンドボックス settings.json に対し、実モード起動（一時データ
ディレクトリ使用・実 %APPDATA% 非接触）の起動時追補を実測（evidence/upgrade-results.log、
before/after 原本 = evidence/upgrade-before.settings.json / upgrade-after.settings.json）:

- Stop 既設エントリ（他者 hook 含む）無変更: **true** ／ Notification 既設エントリ無変更: **true**
- 他キー（permissions / model）無変更: **true**
- UserPromptSubmit が 1 件だけ追記（マーカー = `/terminal-app/event`）: **true**
- 追補後に UserPromptSubmit を注入: 204 → running（ui-latency 3ms）。タイルが「実行中」
  （スピナー＋経過時間 0:00:06）になったスクリーンショット = evidence/app-upgrade-running.png

### 6.3 V-20 アイドル CPU（短縮版）／ V-14 --connect-timeout

- V-20: 「完了」タイル 1 枚（呼吸発光のみ）で 60 秒サンプリング → **平均 0.03% / 最大 0.359% < 1%**
  （evidence/idle-cpu.log。1 章の V-20 行参照）
- V-14: baseline 約 2.0 秒 / `--connect-timeout 1` 約 1.0 秒 / `--connect-timeout 0.5` 約 0.52 秒
  （いずれも exit 28 ≠ 2 = 非ブロック。evidence/hook-noapp-timeout.log。採否は design.md 4.6）

### 6.4 自動テスト（今回追加分を含む全件）

- `npm test`: **7 ファイル 89 テスト全件 green**（evidence/test.log）。追加分:
  `tests/hooks-manager-open04.test.ts`（3 イベントのマージ/除去・旧 2 イベントからの追補・
  マーカー厳格化での他者エントリ非破壊）／`tests/state-store-open04.test.ts`
  （UserPromptSubmit→実行中を全 5 状態から検証＋HTTP 擬似注入統合）／`tests/format.test.ts`
  （fmtElapsed・fmtRelative・fmtStatusCounts の境界値）
- `npm run build` / `npm run typecheck` / `npm run lint`: いずれも exit 0
  （evidence/build.log / typecheck.log / lint.log）

### 6.5 実 Claude Code セッションでの残作業（手動枠）

実セッションでプロンプトを送信し、UserPromptSubmit hook の実発火 → タイルが「実行中」へ
変わることを確認する（verification.md 3.2 / 3.3 と同枠。擬似注入では受信経路のみ検証済み）。
