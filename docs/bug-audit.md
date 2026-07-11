# バグ調査レポート（bug-audit）

| 項目 | 内容 |
|------|------|
| 実施日 | 2026-07-11 |
| 対象 | `src/` 全モジュール（main 10 / preload 1 / renderer 2 / shared 1）＋ `scripts/` |
| 方法 | 全ファイル通読による静的監査（観点別）＋ 既存テスト 89 件・typecheck・lint・build での回帰確認 |
| 結果サマリ | 発見 13 件 → **修正 7 件 / 意図的見送り 6 件**（見送りは全件理由付き） |

修正はすべて既存テスト（tests/ 改変なし）がそのまま通ることを確認済み。
`npm test`（89 passed）/ `npm run typecheck` / `npm run lint` / `npm run build` すべて exit 0。

---

## 1. 調査した観点と結果

| 観点 | 調査内容 | 結果 |
|------|----------|------|
| リソースリーク | Map・リスナー・ファイルハンドル・一時ファイルの解放漏れ | **3 件発見**（#3, #6, #7）→ 3 件修正 |
| エラーハンドリング | 例外の握りつぶし・未処理 'error' イベント・失敗時のロールバック | **2 件発見**（#2, #9）→ 1 件修正・1 件見送り |
| 非同期の競合 | 起動シーケンスの競合・イベント順序・タイマー | **3 件発見**（#4, #10, #11）→ 1 件修正・2 件見送り |
| 境界値・入力検証 | 引数パース・チャンク境界・同時刻タイブレーク・巨大ボディ | **4 件発見**（#1, #5, #8, #13）→ 2 件修正・2 件見送り |
| Windows 固有 | rename の失敗（ロック/EPERM）・SetForegroundWindow 制約・パス正規化 | **1 件発見**（#12）→ 見送り（既知の定石実装。#7 の tmp 残留は Windows で発生しやすいため修正済み） |

補足（問題なしと確認した箇所）:

- `normalizePath` / `matchProjectByCwd` の最長一致プレフィックス — 大文字小文字・区切り混在・末尾区切りを正しく同一視。
- preload の `contextBridge` 公開 API — `contextIsolation: true` / `nodeIntegration: false` で最小面。
- renderer の D&D `dragenter/dragleave` 深度カウンタ・`webUtils.getPathForFile`（Electron 32+ の File.path 廃止対応）— 問題なし。
- hooks の除去がマーカー（URL パス一致）付きエントリのみを対象とし、他者エントリの順序を保全 — テストで担保済み。
- `writeFileAtomic` による projects.json / config.json / settings.json のアトミック書き込み — 中断時に元ファイルが壊れない。

---

## 2. 発見したバグ・リスクと判断（修正 / 見送り）

### 修正した（7 件）

| # | 観点 | 場所 | 内容 | 修正 |
|---|------|------|------|------|
| 1 | 境界値 | `src/main/event-server.ts` | 受信ボディを chunk ごとに `toString("utf8")` で連結していたため、TCP チャンク境界がマルチバイト文字（日本語 message 等）の途中に落ちると文字化け（U+FFFD）する | Buffer のまま蓄積し `end` で `Buffer.concat().toString("utf8")` に変更 |
| 2 | エラーハンドリング | `src/main/event-server.ts` | `listen()` の `once("error", reject)` が成功後も残存。settled 済み Promise への reject は無視され（1 回目のエラーが握りつぶし）、2 回目以降はリスナー不在の 'error' でプロセスがクラッシュしうる | listen 成功時に reject 用リスナーを外し、以降の実行時エラーはログ出力に落とす恒常リスナーへ差し替え |
| 3 | リソースリーク | `src/main/index.ts` | NFR-01 計測用 `pendingRender` Map が、ウィンドウ破棄中など renderer が `notify-rendered` を返せない状況でもエントリを積み続け、単調増加する | スナップショットを配信できる（win が生存している）ときのみ計測開始点を記録 |
| 4 | 非同期競合 | `src/main/index.ts` | 多重起動時に `app.quit()` を呼んでも quit は非同期のため初期化が続行し、2 個目のインスタンスが受信ポートの listen を試みて「ポート使用中」ダイアログを出す競合窓があった | `secondInstance` フラグを導入し `whenReady` 冒頭で初期化を打ち切り |
| 5 | 境界値 | `src/main/index.ts` | `--capture-delay=abc` など非数値を渡すと `Number()` が NaN → `setTimeout(NaN)` は 0ms 扱いとなり、描画完了前に即キャプチャされる | 有限・非負のときのみ採用し、それ以外は既定 1600ms にフォールバック |
| 6 | リソースリーク | `src/main/state-store.ts` / `src/main/index.ts` | プロジェクト登録解除後もそのセッションが内部 Map に残留（表示には出ないが、常駐アプリのため長期稼働でメモリが単調増加） | `StateStore.removeProjectSessions(projectId)` を追加し、`unregister-project` ハンドラから呼び出し |
| 7 | リソースリーク（Windows で顕在化しやすい） | `src/main/hooks-manager.ts` | `writeFileAtomic` の rename 失敗時（Windows のファイルロック・EPERM 等）に `.tmp-<pid>-<ts>` ファイルが残留し堆積する | rename 失敗時に tmp を削除してから元エラーを再 throw |

### 意図的に見送った（6 件・理由付き）

| # | 観点 | 場所 | 内容 | 見送り理由 |
|---|------|------|------|-----------|
| 8 | 境界値 | `src/main/logger.ts` | 日次ローテーションの「日付」が `toISOString()`（UTC）基準のため、JST では朝 9 時にローテーションされる | 実害はローテ境界が 9 時間ずれるだけで、ログ欠損・混入は起きない。ローカル日付化はアーカイブ名の互換確認（既存 `app-YYYYMMDD.log` との連続性）が必要で、リスクに対しリターンが小さい |
| 9 | エラーハンドリング | `src/main/project-store.ts` | `load()` が projects.json 内の各エントリのフィールド型検証をしない（壊れたエントリがそのまま UI に渡る余地） | ファイル全体のパース失敗は既に安全側（空で継続・元ファイル温存）。エントリはアプリ自身のみが書くため発生経路が実質なく、スキーマ厳格化はむしろ有効データを捨てる誤判定リスクの方が大きい |
| 10 | 非同期 | `src/main/event-server.ts` | リクエスト完了までの明示タイムアウトがない（超低速送信でソケットが滞留しうる） | 127.0.0.1 バインドのみで外部から到達不可。ボディ上限 256KB ガードと Node の `server.requestTimeout` 既定（300 秒）があり、個人利用の脅威モデルでは過剰防御と判断 |
| 11 | 非同期 | `src/main/event-server.ts` | 413 応答直後に `req.destroy()` するため、応答本文がクライアントに届く前に切断される可能性 | 送信側（hooks の `curl -m 2`）は応答本文を読まずに捨てる設計のため実害なし。巨大ボディの受信を即中断する現挙動を優先 |
| 12 | Windows 固有 | `src/main/window-control.ts` | フォールバックの `keybd_event`（ALT 送出）はユーザーのキー入力と競合する理論上の窓がある | SetForegroundWindow 制約回避の定石で発生窓が極小。`SendInput` への置換は koffi 構造体定義の追加検証が必要で、動作実績のある現実装を維持 |
| 13 | 境界値 | `src/main/state-store.ts` | `displaySessions` の同時刻（ms 単位で同一 `lastEventAt`）タイブレークが Map 挿入順依存 | ms 精度の完全同時刻は実運用でほぼ発生せず、発生時も「どちらの直近セッションを表示するか」が 1 イベント分ズレるだけで自己修復する。決定的にする価値が薄い |

---

## 3. 回帰確認

| 検証 | コマンド | 結果 |
|------|----------|------|
| 単体・統合テスト | `npm test` | 7 files / **89 passed** (exit 0)・tests/ の既存ファイル改変なし |
| 型検査 | `npm run typecheck`（main / renderer / tests の 3 プロジェクト） | exit 0 |
| 静的解析 | `npm run lint`（eslint: src / tests / scripts） | exit 0 |
| ビルド | `npm run build` | exit 0 |

修正 #1〜#7 は既存テストの通過をもって「挙動非破壊（外部仕様不変）」を確認した。
#1（UTF-8 チャンク境界）と #6（セッション残留）は既存テストでは直接カバーされない内部堅牢性の修正だが、
公開 API・レスポンスコード・表示仕様は一切変えていない。
