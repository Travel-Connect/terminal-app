# 260907_1 実装計画（ループ・codex 作業中を「実行中」として扱う）

> 実装は Claude Code が直接行う（TDD: 新規テストを先に書いて RED → 実装 → GREEN）。

依頼: 「ループ skill の発動中に codex などのジョブが入ったり一度止まると、タイルが完了のまま止まって見える。
codex 側が作業中でもターミナル（terminal-app）の方は完了になっている。まだ作業中という扱いにしたい」
→ 提案 A（terminal-app が Claude Code の登録簿 status を実行中判定の正にする）で承認済み（2026-09-07）。

**Goal:** Stop が block されて続行した／同期 fork や codex wait で本体 transcript が止まった、のどちらでも
タイルを「実行中」に保つ（戻す）。eval-loop 側は変更しない。

**Architecture:** 既存の 15 秒掃引（sweepLiveness）に「完了・切断 → 実行中」の復帰判定を足し、
Stop 受信時は 3.5 秒後に同じ判定を 1 回前倒しで走らせて完了トーストをその後に出す。
根拠は 3 系統: 登録簿 `status=busy`（cli 起動）／transcript の `stop_hook_summary.preventedContinuation=true`
（block の痕跡。Cursor 起動でも使える）／切断中の transcript・subagent 記録の更新。
切断判定は登録簿 busy の間は行わず、更新時刻は subagent 記録（`<sessionId>/subagents/agent-*.jsonl`）も含める。

**根拠（2026-09-07 実測）:** 登録簿 status は Stop と同じ秒に idle、Esc でも idle、ターン中（同期 fork 含む）は busy 継続。
Monthly-report は 03:12 の fork 開始で本体 transcript が止まり 03:27 に「切断」誤判定（登録簿は busy、subagent 記録は更新継続）。
block された Stop は対話 transcript に `preventedContinuation:true` として残る（現状 classifyTurnEnd は無条件に concluded 扱い）。

| # | 仕様（※ = 仮定） |
|---|---------|
| R1 | 完了・切断（終了済みでない）のセッションで、最終イベントから 3 秒以上経過し登録簿 status が busy、かつ transcript 終端が concluded でなければ「実行中」へ戻す（※ busy が古いまま残る事故への保険として終端を併用） |
| R2 | 完了・切断のセッションで、transcript に最終イベント時刻−2 秒以降の `stop_hook_summary.preventedContinuation=true` があれば「実行中」へ戻す。作業テキストは stopReason の先頭 `[...]`（無ければ 1 行目 80 文字） |
| R3 | 切断のセッションで、本体 transcript または subagent 記録が切断判定より後に更新されていれば「実行中」へ戻す |
| R4 | 切断判定（transcript 無更新）は登録簿 status=busy のセッションには適用しない。無更新の判定には subagent 記録の更新時刻も含める |
| R5 | `classifyTurnEnd` は `preventedContinuation=true` の stop_hook_summary を open（ターン継続）と分類する。turn_duration 単独は従来どおり concluded |
| R6 | Stop 受信で「完了」にした 3.5 秒後に R1/R2 を 1 回前倒し判定。戻したときは完了トーストを出さず、戻さなければそこで出す（※ 完了トーストは最大 3.5 秒遅れる）。同じセッションの次のイベントで保留は取り消す |
| R7 | 登録簿ディレクトリは env `TERMINAL_APP_SESSIONS_DIR` で差し替え可能（E2E 用。未設定なら従来どおり `~/.claude/sessions`） |

## モジュール（変更ファイル）

1. `src/main/session-scan.ts` — `classifyTurnEnd` の R5、`findBlockedStop` / `blockedStopOf`（R2 の痕跡検出）、`activityMtimeMs`（本体＋subagent の最新 mtime）
2. `src/main/liveness-monitor.ts` — `findResumedFromStopped`（R1〜R3 の純関数）、`findDisconnected` の busy 除外（R4）、定数 `STOPPED_RESUME_MIN_AGE_MS` / `BLOCKED_STOP_MARGIN_MS`
3. `src/main/state-store.ts` — `stoppedSessions()` / `resumeFromStopped()` / `blockReasonToWorkText()`
4. `src/main/session-registry.ts` — `registryDir` の env 上書き（R7）
5. `src/main/index.ts` — 掃引への組み込み、Stop 後の前倒し判定とトースト保留（R6）、ログ文言
6. `scripts/verify-loop-running-e2e.mjs`（新規）— 専用インスタンス＋擬似登録簿で R1〜R4・R6 を実測 → `docs/evidence/20260907-loop-running/`
7. docs: `docs/spec.md`（REQ-17 / AC-21）・`docs/design.md`（5.1 注記・5.2 追記）・`docs/verification.md`（V-22）・`docs/verification-results.md`・`README.md`

## タスク（TDD。各タスクで RED → GREEN → `npx vitest run <file>`）

### Task 1: 終端分類と block の痕跡（session-scan）
- Test（新規）: `tests/session-scan-blocked-stop.test.ts`
  - classifyTurnEnd: `stop_hook_summary{preventedContinuation:true}` が終端 → open／false・欠落 → concluded／`[turnDuration, stopHookSummary(true)]` → open／turn_duration 単独 → concluded
  - findBlockedStop: 新しい順の配列で、since 以降の block → `{at, reason}`／古い block → null／最新 summary が非 block → null（さらに古い block は見ない）／timestamp 欠落 → null
  - blockedStopOf: 一時ファイルで同上
  - activityMtimeMs: 本体のみ／subagents に新しい記録あり → その mtime／本体無し → null
- 実装: 上記関数を追加（tailRecords を再利用）

### Task 2: 復帰判定の純関数（liveness-monitor）
- Test（新規）: `tests/liveness-monitor-stopped-resume.test.ts`
  - findResumedFromStopped: busy＋終端 open → registry／busy＋終端 concluded → 無し／busy＋transcript 不明 → registry／blocked-stop → reason 付き／MIN_AGE 未満 → 無し／切断＋更新あり → transcript／完了＋更新のみ → 無し／idle・waiting は根拠にしない
  - findDisconnected: registryStatus busy は HARD 超過でも切断しない／registryStatus 未指定は従来どおり
- 実装: 型・定数・関数追加。`SweepDeps.registryStatus?` を任意で追加

### Task 3: 状態ストアの遷移（state-store）
- Test（新規）: `tests/state-store-stopped-resume.test.ts`
  - stoppedSessions: 完了・切断だけ（終了済み・確認待ち・実行中は除く）を state/transcriptPath/lastEventAt 付きで返す
  - resumeFromStopped: 完了 → 実行中（runningSince = lastEventAt = 今）／切断 → 実行中／確認待ち・実行中・未知 → false／workText 指定で更新・未指定で維持
  - blockReasonToWorkText: `[Eval-loop iteration 1/4 | RESUME 1/3] The loop ...` → `[Eval-loop iteration 1/4 | RESUME 1/3]`／括弧無し → 1 行目 80 文字／空 → undefined
- 実装: 3 関数追加

### Task 4: 登録簿ディレクトリの env 上書き（session-registry）
- Test（新規）: `tests/session-registry-env.test.ts` — env 設定時はそのパス、未設定時は `~/.claude/sessions`
- 実装: `registryDir` で `process.env.TERMINAL_APP_SESSIONS_DIR` を優先

### Task 5: 配線（index.ts）
- 掃引: 確認待ち復帰の直後に `findResumedFromStopped(stateStore.stoppedSessions(), deps)` → `resumeFromStopped` → ログ「完了／切断から復帰: <name> — 登録簿 status=busy｜Stop hook が続行を指示｜切断後に transcript 更新」
- 切断判定: `mtimeMs: activityMtimeMs`、`registryStatus` を渡す
- Stop 受信: `pendingStopChecks` に 3.5 秒タイマー。発火時に登録簿を読み直して同じ判定 → 戻す（トースト無し）／戻さない → 完了トースト。次のイベント受信・cleanup・will-quit で取り消し
- `npm run typecheck` / `npm run lint` / `npm test`（既存テスト無改変）

### Task 6: E2E（scripts/verify-loop-running-e2e.mjs）
- 専用ポート・一時 dataDir・一時登録簿（`TERMINAL_APP_SESSIONS_DIR`。pid は自プロセス）・掃引 2 秒・HARD 4 秒
- (a) cli 相当（status busy）: Stop → 完了 → 3.5 秒後に実行中へ（ログ確認）。status idle にして Stop → 完了のまま
- (b) Cursor 相当（status 無し）: Stop → 完了 → transcript に block 痕跡を追記 → 実行中＋作業テキスト `[Eval-loop iteration 1/4 | RESUME 1/3]`。正常終端を追記して Stop → 完了のまま
- (c) 本体 transcript を古くしても busy なら切断しない／status 無しでも subagent 記録が新しければ切断しない／両方古いと切断 → subagent 追記で実行中へ復帰
- スクリーンショットと app.log を `docs/evidence/20260907-loop-running/` に保存。`npm run build` 後に実行

### Task 7: 稼働アプリへの反映と実環境確認
- 旧プロセス（PID 89908）を `taskkill //PID` で終了 → `start-app.bat` で起動 → app.log に起動と掃引ログ
- 実ループ（Monthly-report 等）の Stop/復帰がログに出れば記録（時間依存のため出なければその旨を報告）

### Task 8: ドキュメントと完了報告
- spec REQ-17 / AC-21、design 5.1 注記・5.2 追記、verification V-22、verification-results 追記、README 追記
- `completion-dashboard.html`（completion-dashboard skill）
- コミット: feat（実装＋テスト＋E2E＋docs）→ docs（ダッシュボード）の 2 本（従来どおり）

## 検証コマンド

- `npx vitest run tests/session-scan-blocked-stop.test.ts tests/liveness-monitor-stopped-resume.test.ts tests/state-store-stopped-resume.test.ts tests/session-registry-env.test.ts`
- `npm run typecheck && npm run lint && npm test && npm run build`
- `node scripts/verify-loop-running-e2e.mjs docs/evidence/20260907-loop-running`

## 追加: 260907_2 ループ進捗バッジ（提案時の案 C。2026-09-07 ユーザー指示「ループ進捗バッジを追加して」）

| # | 仕様 |
|---|------|
| B1 | タイル名の下（手動バッジと同じ行）に「ループ N/M・<段階>」を出す。N は iteration+1、段階は phase（計画中／実装中／採点中／判定中）。codex ジョブ走行中は「codex 実装中／採点中 <経過分>分」に置き換える。2 周目以降で best_score があれば「・最高 NN点」 |
| B2 | 終了後は ended_at から 30 分だけ「ループ終了・<理由> <点数>点」。理由の日本語化は既知のものだけ。never_started は出さない |
| B3 | 情報源は `registry/sessions/<sessionId>` と `registry/agents/*`（state の session_id で対応付け）。同じセッションに進行中が複数なら先頭＋「（他 N 本）」 |
| B4 | 15 秒の掃引で更新（`StateStore.applyLoopText`。状態遷移に触れない）。env `TERMINAL_APP_EVAL_LOOP_DIR` で参照先を差し替え可能 |

### Task 9: eval-loop-status（純関数＋ファイル読取）
- Test（新規）: `tests/eval-loop-status.test.ts` — parseLoopState / describeLoop / readRunningJob / loopTextForSessions / evalLoopDir
- 実装: `src/main/eval-loop-status.ts`

### Task 10: StateStore.applyLoopText と view
- Test（新規）: `tests/state-store-loop-text.test.ts`
- 実装: `src/main/state-store.ts`（loopText）、`src/shared/types.d.ts`

### Task 11: 配線と描画
- `src/main/index.ts`（掃引で loopTextForSessions → applyLoopText。表示の出現・消滅をログ）
- `src/renderer/renderer.ts` / `styles.css`（`.tile-badge-row` に手動バッジと `.tile-loop` を並べる。両方無ければ行ごと非表示）

### Task 12: E2E とドキュメント
- `scripts/verify-loop-badge-e2e.mjs` → `docs/evidence/20260907-loop-badge/`（擬似 eval-loop ディレクトリ・codex ジョブ・fork ループ・終了表示・期限切れ）
- spec（REQ-18 / AC-22）・design（5.2, 6.2）・verification（V-23）・verification-results（8.6）・README・完了報告・コミット・push
