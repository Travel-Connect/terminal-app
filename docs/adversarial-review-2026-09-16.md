# 敵対的レビュー（2026-09-16）

| 項目 | 内容 |
|------|------|
| 対象 | main `3ae0879`（260916_1 を含む）。src / tests / scripts / docs 全体 |
| 方法 | 5 観点（状態機械・セキュリティ・Win32/起動・テスト/文書・製品 UX）を並列に独立レビュー。指摘は「コードで確認」「実行/PoC/ログで再現」「推定」を区別 |
| 前提 | 個人利用・ローカル専用（spec 2 章）。ただしその前提に甘えた箇所は指摘対象 |
| 修正 | 本レビューでは行っていない（提案のみ） |

## 対応状況（2026-09-16 同日）

| 指摘 | 対応 | コミット |
|------|------|----------|
| 0 章の真因（Cursor Agents 窓）/ H7 | windowsState で検出・前面化、タイトル一致の厳格化。実機で sunrest-rankget-script が接続に変わった | 260916_5 |
| C1 / H1 / H2 / M1 | compact の no-op、未登録簿セッションの実行中保護、agents の mtime 順、other 通知の無視 | 260916_2 |
| H3 / H4 / L7 / #10 再指摘 | Origin / Host / Content-Type 検証、transcript_path 許可リスト、セッション上限、ログの本文除去 | 260916_3 |
| H5 | settings.local.json へ移行（起動時に 14 件移行済み）、ドライブ直下・ホームの登録拒否 | 260916_4 |
| H6 / H8 / M2〜M17 / L1〜L13 | 未対応（H6 は通知設計・トレイ・起動時復元を含むため別途） | — |

`C:\` の登録（「Cドライブ」タイル）は残してある。厳格一致により常時「未接続」になるので、不要なら設定画面から解除する
（解除すると `C:\.claude\settings.local.json` の hooks も除去される。新規のドライブ直下登録は拒否される）。

## 0. 今日の報告症状（IDE で開かない／設定が引き継がれない）の真因

260916_1（Codex 委譲）は `.code-workspace` 対応・親 IDE の env 除去を入れたが、**ユーザーの実データと合わない**。

| 事実 | 根拠 |
|------|------|
| `projects.json` 14 件に `workspacePath` は 0 件。`C:\dev` 配下に `.code-workspace` は無い。Cursor の `windowsState` も 6 窓すべて folder | 実ファイル確認 |
| Cursor 3.15.6 の統合ターミナル環境に `ELECTRON_RUN_AS_NODE` / `VSCODE_CWD` / `VSCODE_IPC_HOOK_CLI` は無い（あるのは `CHROME_CRASHPAD_PIPE_NAME`, `VSCODE_GIT_*`, `VSCODE_INJECTION`, `GIT_ASKPASS`） | 実行確認 |
| Cursor 本体は 2026-08-10 から更新されていない（更新は「ダウンロード済み・未適用」） | `C:\Program Files\cursor` の mtime、Cursor main.log |
| **cursor.exe の可視窓 6 個のうち 1 個のタイトルが固定文字列「Cursor Agents」**（Glass / Agents モード。`resources\app\out\main.js` に `VA="Cursor Agents"`）。フォルダ名を含まないので `matchesProjectWindow` が一致せず、前面化・未接続判定・位置復元がすべて外れる。該当は sunrest-rankget-script | EnumWindows 実測、windowsState の `uiState.glassMode` |
| **新ビルドはまだ一度も動いていない**。稼働中 electron.exe は pid 44380（10:05 起動・旧コード）。12:19 の `npm run start` は single-instance lock で黙って終了し、app.log に起動行は 10:05 の 1 件のみ | プロセス一覧、app.log |

最短の確認手順:
1. 稼働中のアプリを終了 → `start-app.bat` で再起動（app.log に新しい「起動」行が出ることを確認）。
2. sunrest-rankget-script の Cursor 窓を Agents（Glass）表示から通常レイアウトに戻す（またはファイルを 1 つ開く）→ タイトルが `… - sunrest-rankget-script - Cursor` になり、5 秒以内にタイルが接続に変わるか。
3. 逆に接続中の窓を Agents 表示にして未接続になるか。

「設定が引き継がれない」は、`C:\dev` を親フォルダとして登録している（配下すべてに hooks が効くと期待）が、Claude Code の project settings は起動 cwd 直下の `.claude` しか読まないため、未登録サブフォルダのセッションはイベントが届かない、という別経路の可能性がある（推定）。

## 1. Critical / High

### C1. `SessionStart(source=compact)` が実行中の同一セッション記録を消す（状態機械）
- 場所: `src/main/state-store.ts:322-328`、`src/main/index.ts:403-411`
- auto-compact はターン途中で同じ session_id の SessionStart を発火する。実装は `rec.sessionId === evt.session_id` なら生存中でも prune → タイルが待機に落ち、runningSince / workText / backgroundDriven（保持根拠）/ firstSeenAt（①②順）を失う。次の Stop で保持なしの「完了」が作られ誤トースト。design.md 5.2「生存中には触れない」と矛盾。
- 根拠: app.log 2026-09-10 06:39:21 / 2026-09-14 02:07:50 で再現。テスト再現あり。
- 修正案: 同一 session_id の削除は `dead || disconnected` のときだけ。`source === "compact"` は no-op。

### H1. 登録簿に載らない hook 発火セッション（eval-loop の子）が 20 秒で切断→破棄→Stop で復活→完了トースト
- 場所: `src/main/index.ts:607-634`、`src/main/session-registry.ts:112-116`、`src/main/state-store.ts:364`
- 本日 10 セッション（UUIDv7、`UserPromptSubmit → Stop` の 2 イベントのみ、登録簿に一度も載らない）が全件この形。破棄されない経路では hook 受信で strike が戻らず 1 掃引で再 dead。分割タイルが 15〜30 秒だけ出て消えるちらつきも伴う。
- 修正案: hook 受信時に `deadStrikes.delete`、登録簿で一度も alive を観測していないセッションは registry 判定を unknown 扱い、`pruneDeadSessions` は最終イベントから 60 秒以内を対象外。

### H2. `.mso/agents` 走査上限 200 が readdir のアルファベット順先頭なので、進行中ループが見えない
- 場所: `src/main/eval-loop-status.ts:70, 292`
- webdashboard-app は 252 件、Pricefluctuation-app は 226 件。id が後ろに並ぶ active ループは保持・バッジの対象外 → 260908_1 以前の誤トーストに退行。残骸は増える一方。
- 修正案: state.json の mtime 降順で並べてから slice。古い（30 分＋ENDED_SHOW_MS 超）ものは読まない。

### H3. 受信サーバが Origin / Host / Content-Type を検証せず、任意 Web ページから偽イベントを注入できる（セキュリティ）
- 場所: `src/main/event-server.ts:125-161`
- `fetch("http://127.0.0.1:41321/terminal-app/event", {method:"POST", body})`（text/plain = preflight なし）で到達。Host 未検証のため DNS リバインディングで `/statusline` の応答も読める。PoC（隔離ポート 41999）で 204 受理を確認。bug-audit #10 の見送り理由「外部から到達不可」は崩れている。
- 修正案: `Content-Type: application/json` 必須、`Origin` ヘッダ付きは拒否、`Host` を `127.0.0.1:<port>` / `localhost:<port>` に限定。加えて hooks コマンドに共有トークン（`-H X-Terminal-App-Token`）を埋め込み、起動時追補で全登録へ配布。`requestTimeout` / `headersTimeout` も明示。

### H4. `transcript_path` 無検証 → 偽イベントでアプリが任意ローカルファイルを開く。セッション Map は無制限
- 場所: `src/main/state-store.ts:71, 302, 376`、`src/main/session-scan.ts:156-181, 199-230`
- H3 と連鎖。`stop_hook_summary.stopReason` の先頭 `[...]` は作業テキストとして UI に出る。session_id を変えて撃てば Map が単調増加し、掃引（メインスレッド同期 I/O）が線形に重くなる。
- 修正案: `transcript_path` は `~/.claude/projects/**/*.jsonl` のみ許可。プロジェクトあたり／全体のセッション上限。

### H5. hooks と statusLine を共有の `.claude/settings.json` に書く。`C:\` と `C:\dev` が登録済み（運用）
- 場所: `src/main/hooks-manager.ts:80-99`、`src/main/project-store.ts:38-56`
- `C:\.claude\settings.json` と `C:\dev\.claude\settings.json` に本アプリ hooks が各 5 件（実ファイル確認）。`C:\dev\.claude` は ai-environment の runtime copy（audit.ps1 が drift 検出、sync で消えても起動時追補が再注入）。Pricefluctuation-app / webdashboard-app / instagram-app / 料金変動下準備 の `.claude/settings.json` は untracked かつ非 ignore で `git add -A` すると配布され、他環境では各 hook が最大 2 秒待ち・statusLine が空欄化する。ドライブルート登録に上限なし。
- 今日の変更で `path.basename("C:\\")` が `""` になる経路に trim ガードが入り、「Cドライブ」タイルは旧コードでは最前面の Cursor に必ず一致（ログに「前面化 成功: Cドライブ」）、新コードでは永久に未接続、という無言の挙動変化。
- 修正案: 書き込み先を `.claude/settings.local.json` に変更し起動時追補で移行。ドライブルート・ホーム・登録済みの祖先は登録拒否。`C:\` `C:\dev` の登録と hooks を掃除。

### H6. 成功基準 SC-1「視界の隅で気づける」が実運用レイアウトで成立しない（UX）
- 場所: `src/main/index.ts:1456-1474, 521-543`、`src/main/project-store.ts:63`、`src/renderer/index.html:80-92`
- 常に手前は既定 OFF。Cursor 最大化で本アプリは背後にあり発光は見えない。背後での通知は flashFrame / setOverlayIcon / Tray いずれも無し。頼みのトーストは spec/README で「次期」と書きながら常時 ON・OFF 不可・集約なし（Stop 49〜68 件/日、Notification 20〜40 件/日、切断 10〜13 件/日）。14 登録では 4 行目以降がスクロール外。
- 修正案: 通知設定（種別 ON/OFF・同一プロジェクト集約・切断は既定 OFF）、`flashFrame` + オーバーレイ件数、トレイ常駐（閉じる＝格納）、常に手前の既定 ON、高密度モード。

### H7. 前面化失敗の体験とタイトル部分一致の偽陽性（UX / Win32）
- 場所: `src/main/window-control.ts:226-234`、`src/main/index.ts:1396-1404`
- 失敗はステータスバー右端 1 行のみ（9/14: 9 件、9/15: 11 件、9/16: 69 件）。`title.includes(folderName)` は「dev」が `dev-server.ts - 他プロジェクト - Cursor` に一致するなど誤前面化の素地。Cursor Agents 窓（0 章）は検出不能。
- 修正案: Cursor はタイトル依存をやめ `Cursor.exe <folder>` の spawn に一本化（既存窓があれば Cursor 自身が集約・前面化する）。存在判定は `%APPDATA%\Cursor\User\globalStorage\storage.json` の `windowsState` か hooks の cwd。最低限、タイトルを ` - ` で分割して末尾「Cursor」直前セグメントの完全一致にする。失敗時はタイル内に「立ち上げる」導線。

### H8. README の導入 URL が 6 コミット古いリモートを指す。index.ts / renderer.ts はユニットテスト 0（テスト/文書）
- 場所: `README.md:31`、`src/main/index.ts:212-242, 344-377, 521-543, 600-739`
- origin / fork の main は `b70e32d`（9/8）。260908_1〜260916_1 はどのリモートにも無い。トースト判定・`scheduleStopRecheck`・`releasedPendingToast`・`loopHoldReason` の 30 分ガードは自動テストが一切なく（`new Notification` 直呼びで注入点なし）、ユーザーが最も困った誤トーストが検証されていない。
- 修正案: push。onEvent / sweep を `createMainController(deps)` に切り出して notify / now / registry / fs を注入し vitest 化。

## 2. Medium

| # | 観点 | 場所 | 内容 | 修正案 |
|---|------|------|------|--------|
| M1 | 状態機械 | `state-store.ts:162-163`、`index.ts:389-391` | `notification_type` が other（`auth_success` / `agent_completed` / `quota_*`）でも確認待ち＋トースト。ログに `auth_success → confirm` 3 件（最長 5.5 分放置） | other は状態を変えない（ログのみ） |
| M2 | 状態機械 | `index.ts:232-237` | `backgroundDriven` × 登録簿 `shell` の保持に停滞ガードなし。長寿命 background プロセスで「実行中」が人のプロンプトまで解けない | transcript mtime ベースの 15〜30 分ガード |
| M3 | 状態機械 | `session-scan.ts:28, 198-230, 291-292` | 末尾レコード 1 件が 256KB 超（大きな tool_result）だと `tailRecords` が空 → 終端 unknown・block 痕跡なし・再接続対象外 → 15 分後に切断 | 完全行が取れなければ窓を倍々で読み直す（上限 4MB） |
| M4 | Win32 | `window-control.ts:356-374` | `AttachThreadInput` を対象窓のスレッドに繋いでいるが、借りるべきは現在のフォアグラウンド窓のスレッド。通知クリック経由では効かず ALT 単押しフォールバックが飛び、Cursor / Win32 アプリのメニューバーにフォーカスが移る | `GetForegroundWindow()` のスレッドに attach。spawn 方式なら不要 |
| M5 | Win32 | `app-launcher.ts:121-125`、`start-app.bat` | 除去する env 3 キーは実環境に存在しない。実際に継承されるのは `CHROME_CRASHPAD_PIPE_NAME`（子 Electron の crashpad が親に繋がる）、`VSCODE_GIT_*` / `GIT_ASKPASS`（子 Cursor の git 認証が親へ）、`TERM_PROGRAM*` | VS Code の `sanitizeProcessEnvironment` と同じく `/^ELECTRON_/`, `/^VSCODE_/`, `CHROME_CRASHPAD_PIPE_NAME`, `GIT_ASKPASS`, `TERM_PROGRAM*`, `COLORTERM` を正規表現で除去。bat にも `set "ELECTRON_RUN_AS_NODE="` |
| M6 | Win32 | `window-control.ts:53-62`、`app-launcher.ts:82-83` | Windows Terminal のタイトルはタブ名（既定「PowerShell」）で、Claude Code も端末タイトルを書き換えるためターミナル検出はほぼ機能しない（推定） | `wt.exe -w new nt --title "<folder>" --suppressApplicationTitle -d <path>` で起動しタブ名で一致 |
| M7 | UX | `index.ts:853-879`、`session-registry.ts` | 再起動後は全タイル待機。登録簿（cwd / status）と transcript 走査は実装済みなのに起動時に自動復元しない。「再接続」は 4 日間で使用 0 回 | 起動時に登録簿→実行中/待機を復元し、次の掃引で補正 |
| M8 | UX | `index.ts:1498-1536`、`index.html:141-152` | hooks 追補失敗・curl 不在・ポートずれは黙ってタイルが更新されないだけ。監視が効いているかの表示（listen ポート・最終受信時刻）が無い | ステータスバーに「受信 :41321・最終イベント N 分前」、登録時セルフテスト |
| M9 | UX | `liveness-monitor.ts:304-322`、`index.ts:537-543` | 「切断」トーストの本文「再接続で拾い直せます」だが再接続の窓は切断後 5 分。README の「終了済み」「保持」は UI に無く、保持中は通常の実行中と見分けが付かない | 語彙を「応答なし・15 分」等に。保持中の副ラベル |
| M10 | UX | `index.ts:344-377` | Stop で即「完了（緑）」→ 3.5 秒後に「実行中」へ戻るちらつき（1 日 2〜5 回） | 3.5 秒間は発光なしの「完了（確認中）」 |
| M11 | UX | `state-store.ts:380-397, 110-117` | 作業テキストに prompt 先頭 / TaskCreated 件名（無条件上書き）/ block 理由 / 再接続の transcript 末尾が区別なく混在 | 出典 prefix か 2 行化 |
| M12 | UX | `renderer.ts:24, 489-503`、`event-server.ts:57-70` | 設定画面「他 N 件を表示」は 14 登録で常に折り畳み。ポート変更 UI 無し（ダイアログは config.json 手編集を案内）。自動起動・ログを開く・バージョン表示なし。× で即終了（確認なし・トレイなし） | 折り畳み撤廃、ポート欄＋適用、スタートアップ登録、トレイ格納 |
| M13 | テスト | `scripts/verify-injection.mjs:22-23, 77-93`、`scripts/verify-upgrade.mjs:23, 60-81` | 両スクリプトは 41321 固定で**稼働中の実アプリに POST**する（demo は port 0 で listen）。verification-results.md「再実行可能」は虚偽。PASS/FAIL 判定なし | demo の実ポートを拾う／廃止して E2E 系に統合 |
| M14 | 文書 | `docs/spec.md:85, 153-175, 190`、`docs/design.md:338, 405-430`、`docs/verification.md` | AC-22 が参照されるのに定義なし。REQ-17/18 が design 11 章に無い。260712_2〜260916_1 の機能に AC / V が無い。design 7.1「起動代行はしない」vs 立ち上げ実装、REQ-12「トースト次期」vs 実装済み、hooks は 3 イベント記述 vs 実装 5 種、**statusLine 注入は spec/design/README のどこにも無い**、design 9 章スキーマ・5.1 遷移表が 4 状態のまま（実装 6 状態）、「設定でポート変更」だが UI 無し | 現行に改訂 |
| M15 | テスト | `tests/hooks-manager*.test.ts`、`index.ts:786-795, 1503-1510` | hooks テストは既定 3 イベントで検証。本番は 5 種＋statusLine。「本番構成で merge → remove → 原文 deep equal」の合成テストが無い | registerProject 相当の往復テスト |
| M16 | 運用 | `start-app.bat`、`package.json` | BOM 無し日本語 echo（CP932 で文字化け）、`dist` 存在チェックのみで `git pull` 後に旧 dist を起動、`npm run dev` 無し、`engines` 未宣言 | `chcp 65001` or BOM、src より dist が古ければ build、`"dev": "npm run build && electron ."` |
| M17 | 文書 | `README.md:8, 42`、`verification-results.md:249`、`plans/plan.md:103-104` | README の `%USERPROFILE%\.claude\eval-loop\` は `.mso` に変更済み（自己矛盾）。V-01〜V-20（実際 V-24）。`TERMINAL_APP_EVAL_LOOP_DIR` は存在しない。V-20（アイドル CPU）は 7/11 の 1 タイル計測のみで現行構成未計測 | 更新・再計測 |

## 3. Low

| # | 観点 | 場所 | 内容 |
|---|------|------|------|
| L1 | 状態機械 | `index.ts:437-443, 385` | Stop が 3.5 秒以内に 2 回来ると完了トーストが出ない（ログ上は最短 15.1 秒で実害稀） |
| L2 | 状態機械 | `index.ts:605`、`liveness-monitor.ts:254-259` | 掃引コストの支配項は `.mso/agents` 全走査（8〜26 ms/プロジェクト）と done セッション全件の `blockedStop` 読み。NFR-07 内（≈0.5%）だが増加傾向 |
| L3 | 状態機械 | `state-store.ts:233-241, 594` | 非 dead の「切断」が検知時刻で新しくなり、先に終わった本命の「完了」を覆う |
| L4 | 状態機械 | `index.ts:842, 1000-1014, 626-630` | `removeProjectSessions` / `clearProjectDisplay` / `pruneDeadSessions` が index.ts 側の Map（pendingStopChecks / heldSessions / releasedPendingToast / loopStatusCache）を掃除しない。表示クリア後の Stop でトーストが出ない |
| L5 | 状態機械 | `session-scan.ts:186-188, 262-266` | 再接続の走査はプロジェクト直下の transcript ディレクトリだけで、サブフォルダ起動セッションは拾えない |
| L6 | セキュリティ | `index.ts:1467-1473` | `sandbox: false`、`setWindowOpenHandler` / `will-navigate` 未登録。XSS 面は innerHTML 0 件・CSP ありで閉じているが多層防御が無い |
| L7 | セキュリティ | `event-server.ts:88` | 不正 JSON の先頭 200 文字を app.log に書く（prompt に貼った鍵の断片が残りうる） |
| L8 | セキュリティ | `project-workspace.ts:41-57`、`hooks-manager.ts:155-176` | workspace の `folders.path` の `..` / UNC を封じ込めずに hooks 書き込み先を決める。settings.json がシンボリックリンクなら rename で実体化。JSONC は「書けない」だけで案内が弱い |
| L9 | Win32 | `window-control.ts:154-162, 332-341` | `String.fromCharCode(...spread)` 最大 32768 要素。`rcNormalPosition`（ワークスペース座標）を `MonitorFromRect`（スクリーン座標）で判定 |
| L10 | Win32 | `app-launcher.ts:44-57`、`project-store.ts:109-112` | Cursor.exe 解決が `resources\app\bin` で終わる PATH を何でも Cursor 扱い（現環境は正しく解決）。workspacePath の不正値を無言で削除 |
| L11 | テスト | `tests/dev-server-spawn.test.ts` ほか | 実プロセス起動で 4.5 秒（全体の 55%）。suite 全体が Windows 前提で `skipIf` 無し。E2E は固定ポート共有（42197/9335）で並列不可。`toBeDefined()` / `expect.any(Object)` の弱い assert |
| L12 | 運用 | `.gitignore` | `.mso/` `verify-out/` が非 ignore。ダッシュボード HTML がコミット済み。`window-control.ts` は `any` 20 個、coverage 計測なし |
| L13 | UX | `index.ts:1309-1321`、`styles.css` | 右クリックメニュー 8〜9 項目＋内部用語。未接続はグレースケールのみでラベル無し。「エラー」状態は SessionEnd hook 未登録のため到達不能（凡例・件数にだけ存在）。`powerMonitor` 未使用でスリープ復帰直後に一斉「切断」の可能性 |

## 4. 確認して問題なしと判断した主な点

- XSS: `innerHTML` / `insertAdjacentHTML` / `eval` の使用 0 件。描画は `textContent`。CSP `default-src 'self'`。preload は IPC ラッパのみ公開。
- spawn: dev-server は絶対パス cmd.exe＋固定スクリプト名、app-launcher は argv 渡し（`shell:true` なし）。`shell.openExternal` は localhost 系のみ。
- koffi: EnumWindows コールバックは `finally` で unregister、OpenProcess は CloseHandle、200 回連続列挙で例外なし。spawn の Promise は `'spawn'` / `'error'` のどちらかで必ず settle。
- タイマー: pendingStopChecks は新イベント・prune・will-quit で取り消し。掃引と前倒し判定は同期で割り込みなし。魔法数の大小関係（3500 > 3000、margin 2000）は整合。
- cwd 最長一致は区切り付きで `foo` と `foo-bar` を混同しない。JSONL / state.json / 登録簿のパースは行・ファイル単位で例外吸収。transcript 末尾 256KB 読みは 1.1 ms/回。
- 多重起動は `requestSingleInstanceLock`。`TERMINAL_APP_DATA_DIR` 指定時は userData も分離。
- E2E 9 本（taskcreated / statusline / concluded / disconnect / arrange / split-blink / unlinked-rename / loop-running / loop-badge）は現行 dist で PASS。

## 5. 推奨する着手順

1. **再起動して新ビルドを動かし、0 章の手順で Cursor Agents 窓の仮説を確認**（30 分）。結果次第で H7 の方針を決める。
2. **C1 / H1 / H2**（状態機械。各 10〜30 行の差分＋既存テスト形式で再現テスト。半日）。誤トーストの主因。
3. **H3 / H4**（受信サーバの送信元検証＋transcript_path 許可リスト＋セッション上限。半日）。
4. **H5**（settings.local.json 移行＋ドライブルート拒否＋`C:\` `C:\dev` の掃除。半日〜1 日）。
5. **H6 / M7 / M8**（通知設定・flashFrame・トレイ・起動時復元・ヘルス表示。1.5〜2 日）。SC-1 が初めて成立する。
6. **H8 / M13 / M14**（push、index.ts の controller 分離とテスト、壊れた verify の整理、spec/design の現行化。1〜2 日）。
