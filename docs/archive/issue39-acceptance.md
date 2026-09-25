# Issue #39 / #38 検証記録

基点: `08e98c8d369217a569e8f8d0aaa90fc63c1d817f` (`origin/main`、2026-09-08取得)。
作業ブランチ: `codex/issue39-history-issue38`。旧dev/PR #37のbaselineは使わない。

## 現在の確認結果（2026-09-08）

以下の時系列記録には過去時点の「回答待ち」「未実装」が含まれる。この表を現在の受け入れ判定とする。

| 要件 | 現在の証拠と判定 |
| --- | --- |
| 版の記録・再開 | GUI記録、専用アプリ再起動後の一覧再表示、永続化テストで確認。名称・日時の表示整理は6 Proの再レビューを受領し実装。最新画面・操作を専用Electronで確認済み。 |
| 現在／2版の比較 | GUIで両方を確認しMonaco差分を撮影。画像比較も実走。比較だけで容量が増える不具合を修正し、満杯の履歴でも比較できるテスト成功。 |
| 複数ファイルの復元と取り消し | tex/bib/PNG/追加削除改名のGUI往復とSHA-256照合済み。確認画面の対象・件数・除外一覧も撮影。 |
| 中断・復旧・遅延保存 | 実子プロセス終了を含む故障注入、外部競合、stale保存、binary buffer同期をNodeで確認。実journalを残した子プロセス終了→Controller起動復旧→全ファイル回復→writer解除の統合テストも成功。 |
| Git共存・秘密情報・容量 | .git/.env/入力PDF/生成物除外/容量超過のテスト成功。GitをPATH上で利用不可（exit 127）にした専用Electronで、記録→名前変更→比較→復元→通常ビルド→復元前へ戻すGUI往復を完走。Git自体をアンインストールした環境ではない。 |
| Axiom | 実AgentServiceのundo境界永続化をテスト。実AgentServiceとControllerの双方向排他、誤ack後の拒否・正ack後の再開を統合テストで確認。 |
| TDOM・組版 | 復元後の通常ビルドとPDFを実走。TDOMの停止後に遅延起動が生き残る競合を再現し世代管理で修正。実HTTPを含む3回帰テスト成功。rendererも履歴保護中の旧pushを失効。専用Electronのアプリ内PDFでライブBを表示したままAへ復元し、エンジン再開後のライブAを実画像・AXで確認。数式の精度・速度の変更は行っていない。 |
| スニペット | GUI作成・保存・prefix補完・直接挿入・Tab移動・保存ボタン切替、ストアCRUD/stale更新テスト。追加GUIで検索・Tab→Shift+Tab→再編集→最終Tabを確認。日本語IMEの実変換操作は未検証。 |
| 別ターミナル | GUI cd/pwd/タブ/分割/終了後再開/非表示保持、所有権・root変更・crashテスト。最新メニュー再起動も実走。 |
| 視覚レビュー | 上流設計と複数回の画像レビューを6 Proから受領・反映済み。最新の情報密度／文字と色の再レビュー（10分57秒）は全文読了し実装へ反映。変更後の通常状態の画像レビュー（4分1秒）も全文読了。「十分改善済み、情報密度調整は止めてよい」。記録ボタン文字色と操作メニュー矢印の軽微な2点を反映。 |
| 最新main | 2026-09-08再fetch、HEADとorigin/mainは共に08e98c8d369217a569e8f8d0aaa90fc63c1d817f。 |

全体の `node --test tests/*.test.cjs` は**124件成功**。renderer tscと`git diff --check`も成功。上記の未確認項目まで保証するものではない。Git連携の現在の実装・実GUI・保護・runtimeの検証範囲は [git-integration-acceptance.md](git-integration-acceptance.md) に記載。

### 情報密度の再設計（実装・実機レビュー済み）

6 Proの最新回答は `/tmp/tex64-issue39-evidence/gpt6-density-review.txt`。見出し14/20/600、本文・操作13/20/400、補助12/18/400へ統一し、既存テーマのtext/text-soft/accentを使う。版名の再掲、保存済み、一覧の変更件数、常時の容量・説明文を撤去。日時を日付グループと各行の時刻へ集約し、無名版は「名前なし」。表示される全履歴の同分衝突では秒、同秒衝突では短い一意IDで区別する（隠れた保護記録は通常一覧の衝突に数えない）。正確な日時・保護版・保存方針は詳細と復元確認から参照できる。

比較を「比較元→選択した版」に揃え、一覧の追加削除・Monaco・画像・容量差の向きを一緒に反転する。ストア内部のread-only比較snapshot方向とstale検出は維持。変更ゼロでもビルド対象差の確認を省略しないため、復元ボタンの自動無効化は採っていない。

リアルタイムプレビューの変更は、履歴保護中に遅延start/pushが旧状態を再表示する競合の修正のみ。速度・軽量化・組版基本機構は変更していない。高速化案を扱う場合は先に6 Proと精度の影響を検討する。


## 設計レビュー

ChromeのChatGPT **6 Pro**へ、Issue要件と既存の保存・排他・Axiom undo・Monaco差分・ターミナルIPCのコードを提供して上流設計を依頼した。
会話: https://chatgpt.com/c/6a9ef2a8-d684-83e8-8460-9f54e6ead816

設計回答を全文確認済み（表示上の思考時間19分28秒）。保存エンジンはGitに依存しない内容アドレス型スナップショットを採用する。
通常保存では版を増やさず、手動記録と復元だけを通常一覧に出す。復元直前の保護記録は復元行から参照する。
履歴はプロジェクト外のアプリ専用領域へ保存し、既存Gitの内部・設定には触れない。

回答のうち、内蔵ターミナルを全面的に別ウィンドウへ移す案と既存複数ファイル差分の表示変更は採らない。
現在の内蔵ターミナルとファイルごとのMonaco差分を維持し、必要な入口と補助ウィンドウを追加する。
配布AIモードは再公開せず、Code/Axiomと保持中AIのワークスペース整合性を維持する。

## 実装状況（未完了）

- `history-files.cjs`: パス・通常ファイル検証、秘密/Git/生成物の除外、ハッシュ、永続ファイル書込み。
- `history-store.cjs`: 通常ファイルのバイト列を重複排除し、manifest→版記録の順で公開。二度の走査で通常の外部変更を検知。版名のrevision管理、プロジェクト単位の容量制限。
- `history-transaction.cjs`: main内の計画を前提とした復元、保護版、退避、no-clobber設置、journal、rollback/recovery。復元版の公開がコミット点。
- `tests/history-safety.test.cjs`: 18件成功。子プロセスの実終了を含む故障注入、再オープン、バイナリ、外部競合、対象外、容量、破損を確認。

IPC・writer受付制御・起動時復旧・renderer同期と履歴UIを接続済み。ただし統合全体の安全検証は未完了。
復元後は明示的な同期ackまでwriterを止める。通常releaseではsyncing状態を解除できず、古いbufferのackも拒否する。
容量上限設定はアプリ専用領域のsettings.jsonに永続化する。
未保存buffer比較は実装済みで実機検証待ち。スニペット、ターミナル別ウィンドウ、Axiom/TDOM連携の仕上げと6 Pro実機レビューは未完了。

2026-09-08 実機の途中検証:
- 専用Electron・専用profile・/tmpの検証文書で、GUIから版を記録。
- 外部からmain.texのタイトルを変更し、現在bufferへの反映と版比較の変更一覧を確認。
- Monaco差分モーダルの起動をAXで確認。差分画像の証拠は未取得。
- 復元確認→復元→「復元前へ戻す」をGUIで実行。最初の復元ではディスク上のタイトルが旧値へ戻ったことも確認。
- 画像: `/tmp/tex64-issue39-evidence/history-restore-preview.png`、`history-restored.png`。
- 画面に古い比較結果が残る問題を修正、無名版の日付重複表示を修正（変更後の再描画確認はこれから）。
- node:test 21件成功、renderer tsc成功。テストはIssue #39の明示的な回帰テスト要件に従って追加。
- これらは限定的な途中検証であり、全完了条件の達成を意味しない。

次の実装時に必要な検討:
- writer lockはowner付きcandidateディレクトリをrenameで公開する方式へ変更済み。公開前の実プロセス終了テスト成功。
- rootFileの保存/復旧を既存設定へ接続する。
- storeの上限設定・対象外一覧・復旧待ちの操作導線をGUIへ出す。
- 未完了journalがあれば編集・保存・組版・AIを許可しない。同期ackまで旧model保存を防ぐ。

NodeのパスAPIだけでは悪意ある同一権限プロセスのTOCTOUを完全には排除できず、二度の走査も厳密な同時刻スナップショットではない。
復元は複数ファイルのOS原子的置換ではなく、事前保護・検証・journal・回復によって中間状態を通常編集へ公開しない方式。

## 完了条件

- [ ] 日時・任意の版名・変更内容で目的の版を探せる。自動記録で一覧を埋めない。
- [ ] 通常保存と区別して、短い操作で版を記録できる。
- [ ] 版と現在、任意の2版を比較できる。追加・削除・複数ファイル・画像を把握できる。
- [ ] テキスト比較に既存Monaco差分表示を使う。
- [ ] 復元対象と影響を事前に確認でき、復元前の状態と復元後の状態を履歴に残す。
- [ ] 復元を取り消し、復元前の状態へ戻せる。
- [ ] Git未導入・未設定・アカウント無しでGUIの全操作を完走できる。
- [ ] アプリ再起動・プロジェクト再オープンで履歴が残る。
- [ ] tex/bib/画像等を一貫した版として記録する。
- [ ] 未保存編集・外部変更・AI編集中・追加削除改名を保護する。
- [ ] 復元失敗・中断後の復旧を故障注入で確認する。
- [ ] 既存Gitの履歴・ブランチ・設定・indexを変更しない。
- [ ] 秘密情報・生成物・大容量・容量上限の方針を明示し、隠れて外部送信しない。
- [ ] Code/Axiom/保持中AIの同一ワークスペースと整合し、既存undoの安全ガードを維持する。
- [ ] スニペットを作成・編集・削除・検索・挿入でき、prefix補完とタブストップを使える。
- [ ] ターミナルの別ウィンドウを使える。タブ・分割・終了後再開とウィンドウ間所有権を検証する。
- [ ] Electronで主要操作を実行し、実機画像を6 Proへ渡してレビューし、指摘を解消する。
- [ ] 保存・組版・TDOM・数式入力・既存UIに退行がない。
- [ ] 提出前にorigin/mainを再取得して基点差分を再確認する。

## 検証環境

- 実装前の `tsc -p web-src/tsconfig.json --noEmit`: 成功。
- 開発版Electronを専用プロファイルで起動し、複数ファイル文書の編集画面を確認。
- インストール済みアプリや利用者のプロジェクトは検証に使わない。

GitHubログイン・PR/Issue操作・remote同期・上級Git操作は#39で対象外と定義されている。


## 2026-09-08 追加実装・実機確認

- スニペット: mainのrevision付き永続ストア、編集メニュー・Monacoコンテキストメニューから管理画面、名前/prefix/本文編集、検索、作成削除、prefix providerと直接挿入adapterを追加。
- 実機でEquation / eqnを作成・保存。エディタでeqn候補→Enter→第1placeholderをa、第2をTabでbへ→保存。ディスク上もequation環境のa = bとなり、生のplaceholderが残らないことを確認。
- スニペット直接挿入・編集削除・IME・undo・検索の実機確認は残る。ストアCRUD・重複prefix・stale revision・再オープンテスト成功。
- ターミナル: 内蔵版を残し、terminal専用preloadを持つ補助windowへ同じterminal-uiを接続。各windowのTerminalServiceを分離し、top-level sender以外を拒否。非表示でPTY維持、main終了/別root/renderer crashで終了。
- 別windowでpwd→cd chapters→pwd、分割、Ctrl+T、exit→Enter再開を実走。閉じる→再表示で2タブ・分割状態が残ることを確認。
- 初回の透明表示を実画像で発見。共通themeのbody.is-readyを付けて修正し、画像を再採取。
- 専用window所有者/子frame拒否、非表示寿命、root変更、renderer crashのテスト成功。ただし実PTYの不正IPC送信テストは未実施。
- watcherは履歴操作中にbaselineを進めない方式へ変更。解除後の外部変更再調停テスト成功。世代更新時も同rootのtracked baselineを保持。
- 復元成功時にworkspaceGenerationを進め、通常保存はrenderer待ち行列へ入る時点のidentityを保持。mainの保存最終queueでidentityを再検査。変更後の実機復元・遅延保存テストは残る。
- 画像: snippets-library.png / snippets-tabstops.png / terminal-window-split.png / terminal-window-restart.png（いずれも /tmp/tex64-issue39-evidence/）。

### 第一回画像レビュー（回答待ち）
同じChromeの**6 Pro**を明示選択し、履歴確認/復元後、スニペット管理/挿入後、別ターミナル分割の5枚を添付。各添付名がcomposerに存在することを確認して送信（画面表示03:22）。
未完了の安全性項目を明記し、画像で確認できる問題とコード未読の推測を区別する厳密なレビューを依頼。
会話URLは上記と同じ。送信後「画像を分析しています」、続いて「操作導線を整えた」と回答停止ボタンを確認しており生成中。回答はまだ受領・評価していない。

### First GPT 6 Pro visual review collected (2026-09-08)

The five-image review completed after 11m36s in the same Chrome conversation. Read the full review. Its highest-priority UX findings: identify the selected restore and its exact safety version; show project scope/exclusion details in restore confirmation; distinguish saved files from recorded versions; clarify snippet Save versus Insert; reduce sidebar action density; identify terminal pane/action scope. Safety advice is advisory, not code verification. It calls for delayed writer, watcher, owner-lock, renderer-resync, mixed-file, capacity and real build evidence. Windows remains unverified.

Implemented the snippet Save/Insert clarification: a dirty definition shows Unsaved and Save & insert; save succeeds before insertion, revision failures retain draft; destination model is revalidated after save; saving disables definition inputs; ordinary Save is disabled when unchanged; Delete is separated. Search now includes body text.

Actual Electron validation after renderer reload: selected persisted Equation, renamed draft to Equation test; Unsaved and Save & insert appeared. Save & insert persisted the name and selected first placeholder in the editor. One Cmd+Z followed by ordinary Save restored main.tex to SHA-256 `f00d7a81b69f2fe788a839c21fbecdc529e0e0324d041217d27fb8543591cf5d`, equal to the prior fixture baseline. tsc and snippets.test.cjs passed. Images: `/tmp/tex64-issue39-evidence/snippets-unsaved-reviewed.png` and `snippets-direct-placeholder.png`. These new images have not yet been submitted for the next Pro review.

Remaining live fixture: Figures baseline is selected; external changes remain in chapters/introduction.tex, blue images/figure.png, notes.tex, sources.bib (renamed references.bib). The new direct-insert test was undone completely. Continue multi-file restore/return verification and remaining review fixes; do not treat this subsection as full acceptance.

### Mixed-file GUI restore round trip (2026-09-08 03:43–03:44)

Opened notes.tex before restoring Figures baseline. Confirmation listed two replacements (chapter and PNG), deletion of notes.tex and sources.bib, recreation of references.bib. GUI Restore completed, notes.tex tab closed, all baseline SHA-256 values matched and notes/sources were absent. GUI Return to before restore completed and all pre-restore hashes matched, including the blue PNG, external chapter edit, added notes and renamed bibliography. The fake .env fixture hash remained unchanged throughout. Evidence: figures-pre-restore-hashes.json, figures-restore-result.json and figures-return-result.json under /tmp/tex64-issue39-evidence. Restore record times 03:43:44 and 03:44:03.

Then implemented first-review target clarity: restore rows identify target names; return operations have distinct labels; selected restore details show the exact safety timestamp alongside its return button. Comparison selector/button share one row. Restore confirmation names project-recorded scope, counts replace/recreate/delete and expands excluded paths/reasons. Compiled with tsc and inspected actual Electron rendering; screenshot history-multifile-confirm-reviewed.png shows 2/1/2 changes and excluded .env/.tex64. Cancelled this second confirmation, so the live fixture remains the pre-restore external revision. Sidebar still grows vertically; remaining density/current-record status work is not complete. New screenshots await the next Pro review.

### Binary model synchronization and explicit build (2026-09-08 03:48)

Fixed a gap where binary targets were omitted from restored editor synchronization. Every changed path now participates: a binary/deleted target sends content:null to close a text model, and ack rejects any remaining buffer for that path. Retry reconstruction and recovery use the same conversion. Added a controller regression with actual binary disk restore, stale-buffer rejection and retry before release. All six current test files passed together: 27 tests, including history crash safety, watcher, Axiom boundary, snippet storage and helper terminal ownership. This latest main-process change is tested in Node but the existing GUI instance has not yet been restarted to load it.

Reduced sidebar density: version naming is available through Rename after recording; the version list scrolls within 30vh so selected version operations and capacity stay visible. Restoring confirmation starts with Cancel focused. tsc succeeded; inspected actual Electron screen and captured history-sidebar-reviewed.png.

GUI restored Figures baseline again at 03:48:01, then clicked the Build button. Existing PDF viewer opened the result, showing restored introduction and equations. main.log reports `Output written on main.pdf (1 page, 38382 bytes).` The PDF is /tmp/tex64-issue39-document/main.pdf; image history-restored-build-pdf.png records rendering. All baseline source/image/.env hashes remained equal after building. This proves an ordinary post-restore build, not TDOM-in-flight or late-output safety. Current fixture is baseline with build outputs; PDF window is open. Further review and incomplete acceptance items remain.

### Second Pro review dispatched; delayed-save path verified

Opened the same saved Chrome conversation after the old tab had closed; replacement tab ID 798161991. Explicitly selected latest model and Pro power; composer showed 6 Pro. Uploaded and verified five attachment groups: history-sidebar-reviewed.png, history-multifile-confirm-reviewed.png, snippets-unsaved-reviewed.png, snippets-direct-placeholder.png, history-restored-build-pdf.png. Sent second review prompt with implemented changes, actual round-trip/build evidence and explicit remaining limitations. Last live DOM poll showed Answer stop / 回答を停止 and status 整合性を確認した: review still running, not collected. Tab marked for handoff. Do not resubmit/restart merely because it takes time.

Added tests/history-delayed-save.test.cjs using the real WorkspaceManager.withFileMutation queue and real createWorkspaceFileHandlers.handleSaveFile. A blocker delays the save, then the test advances the generation as a restore boundary or simulates A→B→A. Content remains equal to expectedContent, so byte CAS alone would accept: both old requests correctly return stale without changing disk. New-generation save succeeds and subsequent incorrect expectedContent still fails. Both tests passed. This directly verifies queue admission/epoch handling; the boundary update in this test is simulated, not a full Electron restore interleaving. Existing controller tests separately verify restore advances generation.

### Second review integrated; terminal and inline selection checks

Second Pro image review completed after 7m47s; read full response. It confirms target/confirmation/snippet improvements, requests five small follow-ups: use Before this action/Restore this state for recursive undo meaning, add selected/target timestamps, shorten Current work selector, move snippet state upward and emphasize Insert, suppress automatic Ask Axiom during snippet placeholders, and distinguish PDF load/built/source state (last one still pending). Implemented first four display points and selection suppression using the actual vendored snippetController2.isInSnippet() API; selection callback is queued to let the controller update mode first. Actual direct insertion screenshot snippets-placeholder-no-overlay.png confirms placeholder selected without Ask Axiom overlap. Normal explicit Axiom action remains in place.

Terminal helper now initializes i18n, uses New tab / Restart active shell, shows project name in window title (page title cannot override it), numbers panes, and labels pane versus whole-tab close distinctly. tsc and helper ownership/lifetime test passed. Restarted only dedicated validation app; current exec session 62162 loads latest main including binary sync fix. Actual GUI: opened fixture, integrated terminal cwd is correct; opened helper, pwd correct, split shows 1/2 zsh and focus border; screenshot terminal-pane-identifiers.png. Hid helper; after closing integrated session, restore still rejected due to hidden helper. Reopening preserved both panes. Closed helper tab (both panes) and hid empty window. Later GUI restore succeeded, confirming no remaining managed sessions block it.

Found current file-save status stale until pointer-enter. Added dirty-state notification in buffer-ops and a narrow history status update (no list rerender). Actual typing showed Current work · 1 unsaved / Save and keep a version without hovering the sidebar; image history-dirty-state-live.png. Test typing arrived in multiple undo chunks, so cleaned it by an explicit GUI restore to 03:48:01 version rather than claiming two undos reverted all typing. This created restore at 17:02:29 and removed generated main.bbl per the recorded file set. main.tex baseline hash was rechecked. Latest fixture is baseline, no live terminal sessions, main history screen visible. PDF/TDOM-state work and broader acceptance remain incomplete.


## UI簡素化（2026-09-08）

GPT 6 Pro の独立レビュー（https://chatgpt.com/c/6a9fc2d3-b410-83e9-9ee5-f1f46cca775e）を受け、ユーザー承認後に実装。

- 履歴の更新・改名を「操作」へ集約。版／比較先の選択で自動比較し、世代番号で遅い旧結果を破棄する。比較はその時点のスナップショットとして表示し、復元計画の変更件数とは分離。復元直前へ戻す確認画面には対象と日時を残す。
- スニペットの削除・再読込を「操作」へ集約。保存済み時は保存ボタンを隠し、変更時は「保存」「保存して挿入」を表示。呼び出し文字と使用範囲を短い説明で表示。
- 別ターミナルは新規タブ・分割の2ボタン。シェル再起動はネイティブメニューへ移し、別ターミナルが選択中のときだけ有効。確認に端末番号とシェル、実行中コマンドが終了することを表示。分割ペインには「選択中」を明示。
- 比較・設定等を除く常設アクションは、レビュー添付と同じ保存済み状態で15個から10個（新設の操作メニューを含む）。

確認：tsc成功、git diff --check成功、history-controller／snippets／terminal-windowの既存テスト計5件成功。実アプリで現在との自動比較、過去2版の自動比較からMonaco差分表示、スニペット変更→保存→保存済み表示、メニュー開閉、別ターミナルの分割→メニューから端末2再起動→pwd、日本語の履歴・スニペット・復元確認を確認した。

実画面は `/tmp/tex64-issue39-evidence/ui-simplified-*.png`（comparison、snippets-saved、snippets-dirty、snippets-ja、history-ja、restore-confirm-ja、terminal）。検証用プロフィールのみ使用。今回 /Applications への配備・コミット・push は行っていない。


## 情報密度レビューと比較ストレージ監査（2026-09-08）

ユーザーの17:35画像で日時の重複・説明過多・文字階層と色の不統一を確認。UIの再設計について、前回のProチャットへ当該画像と現行CSSを用意して再レビュー中。画像アップロードが完了せず送信ボタンがdisabledのため、同一画像をASCIIファイル名へ複製して1回再添付している。回答受領はまだ。

origin/mainを再取得し、HEADとともに08e98c8d369217a569e8f8d0aaa90fc63c1d817fであることを確認。

比較のみを5回行うと、記録数1のまま永続blob容量が5→55 bytesに増えることを再現。HistoryStore.captureにpersist:falseを追加し、比較時には整合性を2回走査して確認するがblob/treeを永続保存しない。保存済みの比較対象は差分を開く際にhashを検査し、外部変更後ならCOMPARISON_STALEで再比較を求める。未保存内容は比較時の内容を保持する。10MiB超はhash・サイズの比較のみ。旧比較は次の比較時に破棄する。

回帰テストでは12回の変更・比較後も永続容量／tree数／記録数が不変、変更後のlive preview拒否、未保存snapshot保持、旧比較の失効を確認。controller＋history safetyの24件成功。最新main変更は検証アプリの再起動待ち。

情報密度レビューの画像は再添付後にアップロード完了。6 Proへ実送信済みで「回答を停止」を確認。Chromeタブ798162005、同じUXレビュー提案チャット。

比較に加え、キャンセルした復元プレビューでもcaptureの永続保存を行わないよう変更。実行時に改めてcaptureしpreviewのhashと照合してから保護版を公開する既存順序は維持。プレビュー計画は最新1件のみ保持。controller＋history safetyの25件成功（キャンセル3回で容量／tree数不変の回帰を含む）。このplan修正は実アプリ再起動待ち。

2026-09-08 情報密度の変更後レビュー：
- 6 Pro回答全文 `/tmp/tex64-issue39-evidence/gpt6-density-after-review.txt`。評価対象は通常の変更なし画面1枚で、機能全体の保証ではない。
- 実機 `history-density-normal.png`、`history-density-changes.png`、`history-density-image-direction.png` を取得。現在の赤い画像→選択版の青い画像、追加2/削除1/変更2が正しい方向で表示された。
- 詳細ダイアログを実機確認し、内部保護名Before restoreの日本語化と、選択版の記録時除外を取り出す専用read-only inspectを追加。後者は回帰テスト成功。最新mainプロセスへの再起動反映はPDF状態の修正後にまとめて行う。

## 2026-09-08 18:40 追加確認

- Git利用不可の専用PATHでGUIから「提出前」を記録。現在B→選択版AのMonaco差分を確認し、復元でディスクA、保護記録から戻してディスクBを確認。
- 別PDFウィンドウは復元後も古いPDFを表示するため「再ビルドが必要」を保持。PDF再読み込みでも解除されず、ビルド成功後にAのPDFと「PDF読込済み」へ切り替わることを実機確認。状態の再起動永続化・PDF単位の解除・同名別プロジェクト・埋め込みビューアは回帰テストで確認。
- 差分を閉じた後にhidden dialogへフォーカスが残る不具合を修正。inertとフォーカス復帰を設定し、実アプリでも閉後のAXからdialogが消えることを確認。通常・閲覧専用・複数ファイルは実Chromium回帰テストで確認。
- 最新の履歴画面では復元成功の説明段落も常設しない。PDFの状態はPDFビューアで示す。
- 証拠: `/tmp/tex64-issue39-evidence/history-density-final-changes.png`、`gitless-monaco.png`、`gitless-pdf-built-b.png`、`gitless-pdf-stale-after-restore.png`、`gitless-pdf-rebuilt-a.png`。

- TDOM実機連携: アプリ内PDFのライブB→履歴から提出前Aへ復元→再開したライブAを確認。証拠 `tdom-before-restore-b.png` / `tdom-after-restore-a.png`。通常別PDFウィンドウは従来どおり静的PDFであり、ライブ対象は既存アプリ内ビューア。

## 追加目標: GitHub連携（2026-09-08）

ユーザーがGitHubリポジトリのURLからの紐付け、ブランチ変更、push、マージ、タグ付与の分かりやすいUIを追加依頼。従来の「GitHub/remote操作は対象外」はこの追加目標で更新する。ローカル履歴はGit/GitHubなしでも使えるまま維持し、履歴操作が既存Gitを破壊しない要件も維持する。

Chromeの新規会話でGPT 6 Proを明示選択し、URL接続/clone/commit/push/fetch/pull/branch/merge conflict/abort/tag、認証、writer排他、最小UIについて上流設計を依頼済み。HistoryControllerのidentity/token/barrier、IPC owner検査、mainのquiesce/ack構造のコード抜粋を提供。回答は17分56秒で完成・全文読了し、Git基盤を実装中。

- 2026-09-08 再起動実機確認: 専用Electronを終了・再起動し、最近のプロジェクトから再オープン。静的なアプリ内PDFにも「再ビルドが必要」が残ることをAX・実画像で確認（`pdf-stale-after-restart.png`）。

Git上流設計の新規会話: https://chatgpt.com/c/6a9fd9ab-86f4-83e8-9ce8-38c17d61133d （6 Pro、回答完成・全文読了済み）。

接続箇所の事前調査: main.cjsのwriter gate・workspace mutation FIFO・Axiom双方向gate・watcher pause・TDOM停止・renderer freeze/model同期/ackが履歴専用状態に依存している。Gitには同一rootでのgeneration更新と、Axiom undo境界更新、PDF/画像の同期が必要。HistoryStoreの除外対象（.git/.env/.tex64/生成物）はGit退避の全保証にならず、HistoryTransactionのjournalもGit競合index/merge状態には適用できない。設計回答を踏まえ統合方法を決める。
