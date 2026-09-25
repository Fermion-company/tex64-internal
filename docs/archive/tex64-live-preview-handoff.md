# TeX64 ライブプレビュー修正・引き継ぎ

作成日: 2026-09-11、更新 2026-09-12。§A が最新のまとめ、§0 はその前日の詳細な経過（Claude Opus 5）。§1 以降は 09-11 前半の設計案で、食い違う箇所は §A・§0 を優先する。

## A. 総仕上げ（2026-09-12、Claude Opus 5）— まずここを読む

### A.1 いま動いているもの
- 316 ページの jlreq/stypattern2 文書（sandbox の複製）で、Build → PDF 163 ページ → ch16:33 の 1 文字入力が、入力から 0.74 秒で同じ位置の Live に出る（r28）。canonical は約 100 秒後に置換し、その間も last-good を保つ。
- 連打と削除（r29）、入力中に古い版の canonical が届く場合（r30b で巻き戻りを発見、r30c〜r30e で修正を確認）、Build の hold 中のエンジン再起動（r31）を実機で確認した。E2E ドライバはアプリの `scripts/e2e/`（README に手順と期待値）。
- ブランチはどちらも `codex/issue52-preview-convergence`。エンジンは `57b31f5`（別セッションの塗り色の証明）の上に `b5049f8`（epoch 属性の割り当て）→ `54a07dd`（`canonicalAnchorRefused`）→ `c27c6ed`（属性が取れなければ fail-closed）→ `e1e37de`（last-good lease）。アプリは `ee4a0f6`（再起動で hold を保つ）・`0735417`（E2E ドライバ）と release.yml の pin 更新。
- issue #52 には 2026-09-12 の状況報告を投稿済み（閉じていない）: https://github.com/Fermion-company/tex64-internal/issues/52#issuecomment-5641579445 。原稿は `testing/live-preview-evidence/issue52-report.md`。
- ローカルに残した退避ブランチ（エンジン）: `claude/mixed-block-anchor-v1`〜`-v3`（rebase 前の履歴。push していない）。worktree `wt-anchor` は `/private/tmp` 配下なので再起動で消える。

### A.2 今回の総仕上げで見つけて直したもの（ChatGPT 監査 5 回、最終 MERGE APPROVE）
- **入力中に古い版の canonical が届くと表示が 2 版前へ巻き戻る**（r30b で実測。X・Y を打ち、X の版の canonical が届いた後に Z を打つと、server の proof lineage は正しく失効して Z は `base-generation` で anchor なし、client は certified overlay を消して base の「iii。」を約 100 秒表示）。→ client に last-good lease: 同じ block で拒否理由が `base-generation`・`canonical-behind` のときは直前の overlay を所有権ごと残し（presentation は pending のまま）、その report の provisional 表示は一切しない。overlay は、覆う canonical の画像を DOM に入れる同じ手順・新しい anchor の atomic commit・reset でだけ外す（retiring は独立状態、retire は pending patch を消さない）。r30c で Z の後も XY を保ち rev5 の canonical で XYZ に収束。
- **エンジン再起動で Build の hold が外れる**（health poll が source 変更と同じ扱い）。→ アプリ `ee4a0f6`。r31 で、kill から復旧まで静的PDFが 163 ページを所有し、復旧後の activation も held、次の打鍵は +0.62 秒で Live。
- **anchor を作らなかった理由が見えない**（capture・plan の約 40 の fail-closed 条件）。→ report の `canonicalAnchorRefused`（client は使わない）。r30b の巻き戻りの原因（`base-generation`）はこれで即座に特定できた。TeX Live の更新で callback の description が変わった場合もこれで分かる。
- epoch 属性を固定番号 8125 から luatexbase の割り当てへ。割り当てに失敗したら stamp せず mixed anchor が拒否する（fail-closed）。
- handoff の fail-open（「12 回で reveal」）は現行コードにはない（token 確認まで再送し続け、静的PDFを外さない）ことを確認。

### A.3 B2（resident 309 対 canonical 316）の正体
- canonical の 300 の明示ページブロックの開始ページを SyncTeX で取り（2 ページにまたがるのは ch15-07 だけ）、エンジン単体で文書全体を開いて rescue まで drain（420 秒）した resident と比べると、**resident 316 ページ、300 ブロックすべて開始ページが一致**。分割（pagebuilder）の不一致ではない。
- 実体: resident は 31 個の multicols ページブロック（各章の「例題」ページ＋1）を state job とし、隔離コンパイルで rescue する。これが終わるまで resident のページ数が足りず（アプリの実走では編集時点で 300・302・309）、アプリはページ数が違う間 canonical を保持するので、anchor 対象外の編集は canonical（約 100 秒）待ちになる。gate を外すのは誤り（未 rescue のページは本当にない）。
- 次の一手（監査と合意した順）: (1) 31 個の rescue の時間を queued → start → TeX 起動・前文 → 本文 → PDF 変換 → adopt に分解して計測、(2) 全体の throughput（起動費が支配的なら fmt、CPU の取り合いなら canonical・Build・rescue の scheduler）、(3) 対象 block より前の non-native block がすべて rescue 済みならその block の物理ページ番地は確定、という prefix certification（中規模の設計、#52 に最も効く）、(4) multicols の resident native 化は最後。

### A.4 残るリスク（重さ順）と引き継ぎ
| 項目 | 重さ | 状態・次の一手 |
|---|---|---|
| B2 rescue の readiness | #52 の最大の残り | A.3 の順で |
| A1 塗り色を証明しない | 安全（速いが誤る） | 別セッションで `57b31f5 fix: prove each canonical glyph's fill color against its witness` として push 済み（本セッションの変更はその上に rebase） |
| A3 mask 内部だけにある canonical 固有の塗り | 安全 | mask の外周 16 点しか見ていない。点を増やしても本質的に閉じない。mask 矩形内の canonical の operator が base 行以外の塗りを持たないことを server 側の paint index で証明する設計が要る |
| A4 block 途中の catcode 変更 | 安全（稀） | tdomActive は block 入口の catcode だけを見る |
| A2・A5 信頼境界・description の偽装 | 契約上の制限 | docs/10 に明記済み |
| B1 warm 前の cold 編集（24 秒） | 性能 | kill 耐性のある breadcrumb checkpoint（engine-v3 の core） |
| lease の残る短い窓 | 表示（稀） | covering canonical の画像 commit 前に届いた、別 base の新しい anchor は、その commit まで base を一瞬見せうる（新 anchor の commit で置換） |
| lease の liveness | 性能（非 blocker） | 複数ページにまたがる anchor が retiring になり、その 1 ページが遠く offscreen で canonical 画像の lazy commit を待つと、preview が退役するまで frozen（provisional 抑止）が全体に残る。誤表示にはならない。retiring の anchor ページは lazy loading を迂回して強制 stage するとよい |
| B4 Build と canonical の二重コンパイル・B5 先読みの main thread・D1 lualatex 総数の上限なし | 信頼性・性能 | backlog。E2E の lualatex は最大 16〜18 |
| CI | 運用 | エンジンの audit.yml は main への push と手動のみ（コメントの「every push」と食い違う）、ci.yml は main と PR。作業ブランチは draft PR を開けば push ごとに ci.yml が走る。方針はメンテナ判断 |
| 実機で未確認 | 検証 | Build 中の入力、hold 中の外部ファイル変更、エンジン障害中の入力、改ページを伴う編集、複数ファイルの行き来（anchor の lineage は意図的に単一 block） |

### A.5 検証の記録
- エンジン: 各コミットで hot-path 59/59、farm 343/343、`npm run test:host` 42/42（最終ツリー）。
- 実機 E2E（アプリの `scripts/e2e/live-preview-e2e.mjs`）: r28・r29・r30b〜r30e・r31。ログ・SSE・スクリーンショットは `testing/live-preview-evidence/<run>/`（プロジェクト複製と profile は除外）、要所の切り抜きは同じ場所の `crop-*.png`、B2 の比較は `b2-canonical.tsv`・`b2-compare.tsv`・`b2-resident.mjs`、issue #52 への報告の原稿は `issue52-report.md`。
- 反映: エンジン `57b31f5..e1e37de` を ff-merge・push、監査 CI run 34654972141。アプリは release.yml の pin を e1e37de にしてコミット・push、`npm run tdom:sync` の後 deploy:local。
- ChatGPT 監査の会話「設計監査と状態遷移」（GPT-5.6 Sol・極高）: 総仕上げ 1 回目（リスク台帳の優先度付け）、2 回目（巻き戻りと修正案 a → 狭い lease A'）、3 回目（lease の 3 競合、B2 の結論と次の順序、issue 報告の必須項目）、4 回目（retiring 中の provisional 公開と、新 anchor の失敗が last-good を消す 2 点）、5 回目（frozen＝leased または retiring、pending だけ捨てる discard で MERGE APPROVE。merge gate は hot-path・farm・host と最終の stale-canonical 実機）。

## 0. 最新状況（2026-09-11 Claude Opus 5）

### 0.1 結論

- 表示側（方針A）は作り直し、316 ページ文書の実機 E2E で確認した。Build 後の最初の編集で PDF が1ページへ戻る不具合は解消した。
- anchor 対象のプレーンな段落では、Build 後の最初の編集が**入力から約 0.7 秒で PDF 上に現れる**ことを確認した（r8・r11、キャレット位置の warm が入力前に完了している場合）。
- ハンドオフの再現箇所 ch16:33 は、当初はエンジンがそのブロックを組版できず（下記 0.4）canonical 全文（約 72 秒）を待っていた。原因（`\deadcycles` の蓄積、§0.10）を直し、混在 block の canonical-anchor（§0.11）を入れて、**入力から 0.74 秒で同じ位置の Live に X が出る**ようになった（r28、エンジン 80af71a・アプリ 61cc0a2、配備済み）。
- 両リポジトリにコミットして push し、`/Applications/TeX64.app` へ 1 回反映した（deploy:local、ad-hoc 署名、`codesign --verify --deep --strict` 通過、同梱エンジン `9a6e9a6`。反映時はアプリを起動していない）。エンジン監査 CI は成功。

### 0.2 コミット（push 済み、ブランチはどちらも `codex/issue52-preview-convergence`）

- アプリ `/Users/majinkuu/Desktop/TeX64-Pro`: `19ce437 fix: hand Build-owned paper back to the same Live frame`（`web-src/app/code-live-preview.ts`、`web-src/app/viewer.ts`、`web-src/app/types.ts`、生成物 `Resources/web/app/{code-live-preview,viewer}.js`、`Resources/web/pdf-viewer.js`、`Resources/web/pdf-viewer.css`、`electron/services/tdom-engine.cjs`、`docs/realtime-preview.md`。前半の Codex 追補（§2 の7ファイル）はこれで置き換えた）、`b03d94e build: bundle the Build-handoff preview engine`（`Resources/tdom-engine` を `9a6e9a6` に同期、release.yml の `TDOM_ENGINE_COMMIT` も同じ）。コミット時は `TEX64_SKIP_LOCAL_DEPLOY=1` で post-commit の自動配備を止め、最後に明示的に 1 回だけ配備した。
- エンジン `/Users/majinkuu/Desktop/tdom-engine`: `f7aa553 fix: keep saved overlay bytes as the child input`（E1・E2）、`42cca6a fix: accept a child anchor whose own autosave landed first`（E3）、`7e59eb7 perf: prefetch canonical anchor proof inputs with the edit`（E4、`canonical-anchor.js` は予算定数の公開のみ）、`9a6e9a6 feat: echo embed viewport tokens and applied source revision`（`web/app.js`、`docs/13-host-integration.md`）。hot-path core（engine-v3.js）は変更していない。
- 確認: アプリ `tsc -p web-src/tsconfig.json`、`node --check`、`git diff --check`。エンジンはコミットごとに hot-path 52/52、farm 15/15（343/343 行）、`npm run test:host` 42/42、`git diff --check`。監査 CI は workflow_dispatch で実行（run 34534382586、成功。この workflow は main への push か手動起動でしか走らない）。

### 0.3 方針A（表示）— 原因、設計、実測

実測で確定した原因（r2）: Build が PDF タブを新しく開くと、viewer の ready 前に `holdLivePreview()` が呼ばれて hold が消える。ready 時に hold のない Live payload が送られて新しい activation ができ、Build の静的PDFではなく Live が表示される。最初の編集で、Build 成功時に進めた `liveGeneration` が配布され、iframe が作り直されて1ページ目になる。前回の実機試験で Build 後に見えていた「PDF 163 ページ」も Live 面だった。

設計:
- hold は Live 状態の一部（`viewer.setLivePreview(url, generation, target, hold, expectedSrcRev)`）。ready・PDF タブの再生成後も同じ状態を再送する。単発の `live-hold` は廃止。
- Build 成功で `liveGeneration` を進めない。pdf-viewer は同じ url と generation なら iframe を作り直さず、`enterLiveHeld()` と `resumeLiveFromHold()` で held と pending を切り替える。
- held 中は静的PDFが上、同じ iframe が下。静的PDFのスクロールを 120ms debounce で `goto-sync` し、snapshot ごとにずれを補正する（`alignHeldFrame`）。Live 表示中に Build したら、Build の PDF を Live のページで開く（`state.pendingPage`）。
- Build 後の変更は編集版数（`sourceEditVersion`）で判定する（未保存バッファの比較では autosave 後の変更を区別できない。r10 で hold が解除されない不具合として実測）。その変更を含む push をエンジンが受理したら、後続の push があっても所有権を戻し、受理した srcRev を期待版として配布する。
- 復帰時は静的PDFの表示中心の紙面位置を token 付き `goto-sync` で渡す。iframe が token を返し、期待版以上の srcRev を適用し、紙面が完成（`ready` または `presentationPending === false`）したら切り替える。確認できない間は再送し、静的PDFを外さない（fail-closed）。pending 中に静的PDFをスクロールしたら新しい位置を渡し直す。token を返さない旧エンジンは先頭ページの許容幅で判定する。
- `presentationPending === false` だけを条件にすると、この文書では anchor 表示後も TDOM が pending（resident のページ数が canonical より少なく、後方ページが確定待ち）のため、切替が canonical 到着（+80 秒）まで遅れた（r9）。そのため `ready` も完成の合図として受け入れる。
- 新しい activation も静的PDFの表示位置から始め、条件は従来どおり `ready`。

実測（Playwright、316 ページ文書の複製）:
| run | 条件 | 結果 |
|---|---|---|
| r2 | 旧 Codex 追補 | Build 後に Live が見え、編集で iframe 再生成（1ページ目の機構を再現） |
| r3/r4 | ch16:33、入力時点で解除（中間設計） | 同じ activation のまま 0.18〜0.27 秒で Live、ページ移動なし |
| r8 | probes 4 行目（p312）、Build 前から Live、warm 完了後 | anchor 成立、+0.73 秒で X |
| r9 | 期待版＋`presentationPending` 必須 | X は +0.59 秒に描けたが隠れたまま、切替 +80 秒 |
| r10 | 未保存バッファ比較での解除判定 | autosave 後の push に解除の印が付かず hold が解けない |
| r11 | 最終設計 | 受理 +0.61 秒で解除、token 確認、+0.70 秒で X 入りの Live |
| r12 | 最終設計、ch16:33、Build が PDF タブを開く | 受理 +0.46 秒、token 確認、+0.49 秒に同じ 162〜164 ページの Live（旧紙面）。canonical +76.7 秒で X、表示位置は不変 |
| r13 | 最終設計、2 ページの小規模文書 | 受理 +0.10 秒、+0.15 秒で Live、+0.28 秒で編集入りの紙面 |
| r7 | 2 ページの小規模文書（中間設計） | +0.3 秒で編集入りの紙面、余計な待機なし |

### 0.4 方針B（エンジン）— 確定した事実

1. ch16:33 のブロック b333 は `\subsection{概念整理…}`＋KKfbox1＋33 行目の段落＋…が空行なしで一続き。resident はこのブロックで `native-error`（`tdomDeferred`、行数 0、rescue 済み）となり組版を保留する。page patch が出ず `dirty-source-without-structured-patch`。canonical-anchor の基準も作れない（`captureCanonicalAnchorBase` の galley 副作用条件）。現行設計では anchor の対象外で、表示は canonical 1 回（約 72 秒）待ち。
2. 旧エンジンでは autosave の fs.watch（ディスク＝overlay）が `terminalAnchorEpoch` と canonical の inputEpoch を進めて再組版し、続く overlay 除去でも srcRev が進んで canonical が 2 回走っていた（最終収束 180 秒）。
3. プレーンな段落では child proof・base・plan が成立する。anchor の成否は resident の編集組版時間で決まる（証明予算は受理から 700ms）。warm 完了後は 0.33〜0.45 秒（11〜15 ブロック）で成立（r8・r11）。warm が入力時点で未完了だと 9.8 秒（91 ブロック）で `PROOF_DEADLINE_EXCEEDED`（r6）。キャレット位置の warm 自体に 2.5〜6 秒以上かかる。
4. `childAnchorEditBeforeOverlay` のディスク不一致（autosave 先行）は今回の実走では起きていない。

### 0.5 方針B（エンジン）— 実施した修正

- E1: live overlay が被さるファイルへのディスク書込は入力変化にしない。`onExternalChange` はロック外とロック内の両方で判定する。
- E2: `removeOverlays` の時点でディスク＝overlay なら overlay ファイルを入力として残す（`savedOverlays`）。実効入力が変わらない `/edit` は直前の report を返し、srcRev・anchor epoch・input epoch を進めない。後で別の内容がディスクに書かれたら overlay を外し、既存の除去と同じく `refresh({ removed })` する。原文表示の補助（`activeSourceLine`・bibliography の位置）も live → saved → disk の順で読む。
- E3: child proof のディスク条件に「readPath＝file かつ ディスク＝今回の要求内容 かつ mtime ≥ `clientEditAtEpochMs`」を追加。第三の内容は従来どおり拒否。
- E4: anchor 証明の SyncTeX 候補と描画索引を、base 捕捉直後から編集組版と並行して先読みする。証明の条件と予算は変えていない。r8 で resident 組版（327ms）は先読みなしの r5（435ms）より遅くなっていない。
- 埋め込み snapshot に `srcRev` と `viewportToken` を追加（`goto-sync` の token を、そのページへスクロールした後に返す）。
- 効果: autosave による無効化と二重 canonical が消え、最終収束は 180 秒から 72 秒（r4）。warm 済みのプレーン段落は anchor が成立する。

### 0.6 ChatGPT（GPT-5.6 Sol・思考量 極高・Chat）での監査

会話「設計監査と状態遷移」https://chatgpt.com/c/6aa2deaa-fd44-83ee-91b2-3fc61ac09c7a
- 1 回目（旧 Codex 追補と設計、28 分）: hold 意図の非永続・4 回試行後の誤位置 reveal・autosave watcher の epoch 破壊を指摘。表示所有権／iframe 寿命／受理入力世代の分離を推奨。
- 2 回目（新実装）: push 受理前の解除、reveal が編集世代を確認していない、topPage 許容幅は位置の証明にならない、先読みの資源競合、savedOverlays を原文表示補助が見ていない、を指摘 → 受理後解除・期待版・token・原文表示補助は採用。`presentationPending` 必須は r9 の実測（anchor が 80 秒隠れる）により `ready` も許容に変更。`onExternalChange` の早期 epoch 更新は、overlay を作る編集自身の anchor 世代が後で採番されるため維持。

### 0.7 次の一手（メンテナ判断が必要）

1. キャレット warm の完了が遅い（2.5〜6 秒以上）。warm 前に打鍵するとコールド編集（r6: 91 ブロック・9.8 秒）になり anchor が間に合わない。warm の優先度・checkpoint 保持（editHold）の見直しは engine-v3 の hot-path core のため承認が要る。ChatGPT 案: caret warm を viewport warm より強い pin にする、anchor 証明材料をキャレット停止時に先読みして edit で再検証する。
2. native-error で保留されるブロック。原因は tcolorbox ではなく `\deadcycles` の蓄積だった（§0.10、修正済み・検証中）。segmenter で「閉じた環境の後の段落」を分離する案は、この修正後も anchor が必要かを実測してから判断する。
3. 証明予算 700ms は既存の設計値で、緩めていない。
4. push→`/edit` の main 側遅延は 0〜161ms とばらつく（Build 直後の混雑）。常時の問題ではない。

### 0.8 最終確認（このセッション末）

- 最終コードで r11（probes 段落、+0.70 秒で X）、r12（ch16:33、+0.49 秒で同位置の Live、+76.7 秒で X）、r13（小規模、+0.28 秒で編集入り）を実走。いずれもページ移動・iframe 再生成なし、同じ activation のまま。
- アプリ: `tsc -p web-src/tsconfig.json`、`node --check Resources/web/pdf-viewer.js electron/services/tdom-engine.cjs`、`git diff --check`。
- エンジン: hot-path 52/52、farm 15 文書すべて一致（343/343 行）、`npm run test:host` 42/42、`git diff --check`。
- 未実施: インストール版を起動しての目視確認、Build 中の追加入力・外部ファイル変更・改ページを伴う編集の実走（§7 の後段の確認項目）。

### 0.9 検証ハーネスと証拠

- `/tmp/tex64-local-latency/claude-20260911/harness/`: `e2e-build-live.mjs`（Playwright Electron。起動→プロジェクトを開く→canonical 収束待ち→Build→静的PDFの位置決め→キャレット→warm 待ち→1 文字入力→100ms 間隔の状態・SSE・スクリーンショット）、`refresh-diag-app.py`（作業ツリーから一時診断ログ入りのアプリ複製を作る。重いディレクトリはシンボリックリンク）、`diag-engine-patch.py`（エンジン複製に棄却理由ログ `TDOM_ANCHOR_DIAG`）。
- 実行時の注意: エンジンは 1 つだけ（`/Applications/TeX64.app` を閉じてから）。`BASE_PROFILE=/tmp/tex64-local-latency/pdf-open-dev-profile` を複製して使う。初回に `#settings-pages` がクリックを遮るので `#settings-close` で閉じる（ドライバが自動処理）。環境変数で対象（`TARGET_FILE`/`TARGET_LINE`/`CARET_AFTER`/`TARGET_PAGE`/`PRE_OPEN_PDF`/`WARM_WAIT_MS`/`SANDBOX`/`MAIN_SHA`/`MIN_PAGES`）を切り替える。
- 実測ログ: `runs/r2`〜（driver/renderer/main/engine の JSONL、SSE、代表スクリーンショット）、まとめ `12-e2e-results.md`。

### 0.10 ch16:33 の native-error の根本原因（engine hot-path 調査、配備後）

- 原因は tcolorbox ではなく、resident の output 吸収が `\deadcycles` を戻せていないこと。`tdom_absorb_output`（daemon.lua）と iso 側の `tdom_iso_absorb`（tex-templates.js）は `tex.deadcycles = 0` で戻すつもりだったが、LuaTeX 1.24 はこの代入（`tex.set('deadcycles', 0)` も）を黙って無視する（最小例: `\deadcycles=7` の後に代入しても TeX 側は 7 のまま）。
- 吸収は出力しないので毎回 dead cycle になる。各ページブロック末尾の `\clearpage` は 2 回吸収するので、fork の系列に沿って `\deadcycles` が 2 ずつ増え続け、約 100 ページ目で `\maxdeadcycles=200` に達する。以降は `\clearpage` を含むすべてのブロックが `Output loop---200 consecutive dead cycles` → TeX の強制 `\shipout` → `\write` の実行による `Forbidden control sequence…\write`、`Use of \endwrite doesn't match its definition`、`Incomplete \iffalse` の連鎖となり、`tdomClosure` → `native-error` → `deferredBlockGalley`（行数 0）になる。
- 実測: r15（`TDOM_TRACE_ERRORS=1` と `status.lasterrorcontext` を足した診断エンジン）で b249〜b629 の奇数ブロック（ch12 以降の各ページ本体）すべてが native error。b333（ch16:33 を含むページ本体）は `\clearpage` 内の `Use of`。偶数ブロックはページ間のコメント行だけのブロック（`% PAGE …` の後に `\subsection` が FORCED_START で区切る）。
- オフライン再現: resident の driver.tex と同じ前処理・shim・dormant 設定に daemon.lua を読み、エンジンと同じ分割（`segmentBody`）と同じ rescue 振り分け（`needsRescue`、multicols は state job 扱いで resident では組版しない）でブロックを順に流す 1 プロセスの lualatex（`scratchpad/repro/`、`mkbody.mjs`）。修正前は `\deadcycles` がブロックごとに 0,2,4,… と増え、block 237（ch11）で最初の Output loop。修正後は 660 ブロック全部で `\deadcycles` が 0 のまま、native error 0。
- 修正（エンジン `4a81bf1 fix: reset dead cycles from the absorbing output routines`、push 済み、監査 CI run 34539477758 全段成功）: 両方の吸収で `tex.sprint('\\deadcycles=0\\relax')` により TeX 自身に戻させる（\output の中で Lua 呼び出しの直後に実行される）。暴走時（resident は 51 回で fork を終了、iso は 51 回目以降を破棄）は従来どおり戻さないので TeX の保護も残る。hot-path 52/52、farm 15/15（343/343）、host 42/42。回帰テストは CI が回す `tests/hot-path.test.js` へ移す（`native-closure.test.js` は `npm test` に含まれず CI でも走らないため。移設は未コミット、修正前 9a6e9a6 で失敗・修正後に成功を確認済み）。
- 実測 r16（修正後、ch16:33、Build なし）: native error 0（r15 は 452 行）。resident のページ数 301（r15 は 123）。編集は `replace-page 163` の structured patch、fallback なし、typeset 304ms。ただし表示は canonical rev 3 到着（+110.7 秒）まで旧紙面のまま: b333 は fidelity `exact-preview-required`（gfx）で、provisional 紙面は exact chunk 待ち（`provPending`）かつ resident と canonical のページ数が違う（299〜301 対 316）ため canonical が保持される。canonical-anchor は capture で拒否（`hasGalleySideEffects`: gfx・toclines 1、かつ見出し box・tcolorbox box が単一行の witness にならない）。
- canonical 到着が遅くなった（r12 75.8 秒、r14 81 秒、r15 85 秒 → r16 110.7 秒）。resident が約 100 ページ目以降も実際に組むようになった負荷と見られる（未計測）。
- warm: 開いた直後の caret warm は checkpoint 234→309 の 76 ブロックを再組版して 16.8 秒（1 ブロック約 220ms、`TDOM_MAX_CHECKPOINTS=8` で checkpoint が疎）。warm 完了前に打鍵するとこの分がそのまま編集遅延になる。

### 0.11 ch16:33 の即時反映（エンジン変更、ChatGPT 監査 5 回目で MERGE 承認）

作業場所: `scratchpad/wt-anchor`（`~/Desktop/tdom-engine` の git worktree、ブランチ `claude/mixed-block-anchor`、4a81bf1 の上）。インストール版は `~/Desktop/tdom-engine` の作業ツリーを使うため、検証が終わるまで本体の作業ツリーには入れていない。
- `d2b293b test: pin the dead-cycle reset in the hot-path suite`（§0.10 の回帰テスト移設）
- `5b73e6b feat: anchor a prose line inside a block with opaque boxes`: 混在 block の canonical-anchor。box ごとの witness、plain 行の glyph run 以外を固定する frame の完全一致、変わった行は plain 行かつ fidelity flag 0、証明は plain 行すべての一意照合。gfx block は表示リストが glyph を出さない（全行 `pendingExact`）ため、変わった行は sourcebox の位置から表示リストと同じ run 描画関数で描く（`sourceBoxLineCommands`）。
- `b8c40fe perf: cache SyncTeX lookups per generation and prefetch caret proofs`: 証明は block の全ソース行に `synctex view` を 1 回ずつ呼び、毎回 316 ページ分を読み直す（19 行で 700ms 超過、r19）。generation 単位の cache と、caret warm が ready になった時点の先読み。
- `4912058 perf: resume a superseded warm from the boundary it reached`: 新しい warm が実行中の warm walk を kill していた（replay は STEP で入力 checkpoint を消費するため進捗が全損）。warm どうしは次の block 境界で止め、到達境界を editHold に固定して再開。編集による割り込みは従来どおり kill（engine-v3 の core のため未変更）。
- 各コミットで hot-path（53→55）・farm 343/343・host 42/42。

実測（`scratchpad/runs/`、解析は `scratchpad/analyze.py <run>`）:
| run | 条件 | 結果 |
|---|---|---|
| r17 | 混在 anchor 初版、warm 未完了で打鍵 | cold 編集 100 block・24 秒、予算超過 |
| r19 | 同、warm 完了後 | 表示リストに glyph なし（plan L200）、SyncTeX 先読みが予算内に終わらず |
| r20 | 3 変更すべて、Build なし | warm は 298→306 と再開して入力 19.5 秒前に完了。候補 761 件と paint index が受理後 81ms、resident 編集 271ms、証明 399ms、**入力から 0.57 秒で 163 ページに X**（スクリーンショット `r20/shots/t00790.png` で位置も確認） |
| r21 | 3 変更すべて、Build → PDF → 最初の編集 | 証明 293ms、+0.47 秒で overlay、+0.49 秒に Build の静的PDFから同じ位置の Live へ切替（srcRev 3・token 一致）。canonical は +78 秒で置換 |

ChatGPT 監査（GPT-5.6 Sol・極高、会話「設計監査と状態遷移」）1 回目: 0001・0002・0004・0005 は支持。混在 anchor（0003）に [高] 2 件。
- [高1] 候補の出所: 候補は block の全ソース行の SyncTeX を平坦化したもので、自分の record が欠け、枠内の同文面・同幅の行だけが残ると誤った位置へ描き得る。→ まず問い合わせ行で本文行に限定したが、実文書で本文 2 行目の SyncTeX（行 box と中の glue/kern すべて）が段落を閉じた行（`\end{KKfbox11}` の 36 行）に付いており、正しい anchor まで拒否した（r22）。サイズで枠の canonical 領域を特定する案も KKfbox12 の寸法不一致で不成立。→ 内容で出所を固める形にした: frame が不透明 box を固定するので canonical 上の枠内の文字列は resident と同じ。不透明 box の glyph 列が plain 行の glyph 列を含むときは拒否（`opaqueTextHoldsWitness`）。
- [高2] frame の完全性: `gfx` は真偽値だけ。→ 収穫で box ごとに描画系 whatsit の種類・mode・順序・文字列 payload を md5 して `fx` に（LuaTeX 1.24 は TeX 由来 literal の token list の中身を Lua に出さない。`n.data` は文字列 "data"、`getdata` は process ごとに変わる参照番号で hash に使えない）。active character（babel shorthand・`\catcode 13`）を持つ block は対象外（`tdomActive`）、rescue galley・非 native closure も対象外。
- 2 回目の監査: BLOCK、merge blocker 2 点（(1) 不透明 box の文字列を canonical の ToUnicode と同じ表現で比べられない場合は拒否、(2) 中身を観測できない描画 whatsit・未知の shipout callback）。→ (1) `opaqueTextComparable`: 不透明 box の文字は native font・remap/math/PUA/U+FFFD なしに限る。(2) token list literal の中身は読めないので拒否ではなく経路を閉じた: literal は生成時に展開、編集は macro を実行しない（TeX 特殊文字拒否・active character 拒否）、callback は resident が `GEO.paintCallbacks` で報告したものがすべて既知（`ltj.*`・`luaotfload.*`・`luacolor.process`・lua-ul の `add underlines to list`）の場合だけ。luacolor は shipout 時に属性の色を書くので resident の run の色に出ない → 黒以外の luacolor 値を持つ glyph・rule の box を `ca` として記録し、変わった行が `ca` なら plain・mixed とも anchor しない。黒の値は luacolor の map が private（`debug.getupvalue` 無効）なので root で `oberdiek.luacolor.getvalue()` に黒の 3 表現を問い合わせる。この文書は luacolor で本文色を全体に設定しており、属性の有無だけで判定すると本文行まで全部 `ca=1` になった（実データで確認後に修正）。
- 2026-09-11 15:55 頃にマシンが再起動し `/tmp` が消えた（E2E ハーネス `e2e-build-live.mjs`・診断用のアプリ/エンジン複製・`runs/r*`・base profile、上の §0.9 の `/tmp/tex64-local-latency` もすべて消失）。コミット済みの履歴はリポジトリに残っていた。worktree を作り直し、未コミットだった 2 回目の修正を再実装した。
- 3 回目の監査: blocker 1（不透明 box の文字の比較可能性）は解消。blocker 2 が残る: (a) 編集していない後続 macro が、編集で変わった TeX の状態を読んで中身の読めない literal を作る経路、(b) callback を `ltj.*`・`luaotfload.*` の接頭辞で許可しており、GEO（前文時点）の registry しか見ていない。
- 4 回目への対応（`c7f7c17`・`1f663c5` に畳み込み）: (b) callback 名 × description の完全一致の集合（実文書で登録される組そのもの）にし、各 galley が GEO 以後の登録を `paintLate` として lineage で累積して報告、plan は GEO と全 block の paintLate を照合（galley のない block があれば拒否）。(a) resident が build_page のたびに `\prevgraf`・`\prevdepth`・`\badness`・ページ累計・最後の node の値などを標本化して block ごとの state trail（md5）を galley に載せ、mixed frame に含める。段落内（水平モード）は標本化されないので、変わった行を含む移し替え（build_page 単位、node に属性 8125 で番号を付けて `epochs` として収穫）に `fx`・`ca`・float・insert があれば拒否。必要性を示すテスト: `\parfillskip` を有限にした段落の直後に `\hbox{\pdfextension literal{\the\badness\space w}}`。1 文字足すと trail を除いた frame は一致、trail は異なる。LuaTeX 1.24 で読めないのは TeX が作った pdf_literal の token list だけ（colorstack・special・late_lua は文字列で読める）。
- 4 回目の監査: 2b は承認（残り: 前文で元の add_to_callback を保存した package の同一 block 内の登録→削除）。2a は「後続の Lua が既に組まれた node list（page_head）を読んで literal を変える」経路が残るとして BLOCK、segmenter で段落を独立 block にする案を推奨。
- 5 回目（反論）: その反例は承認済みの plain anchor にも block 境界越しにそのまま当てはまり（後続 block の galley は stateVec が同じなら再利用）、segmenter 分割でも閉じない。canonical だけが走る実際の `\output`・shipout hook も両方に共通。LuaTeX 1.24 では一般的な gate が作れない（literal の中身は読めない、`\directlua` の hook も `debug.getinfo` もない。luatexja 自身が `\ltj@@getparam@one{direction}` から `tex.nest` を読むので「list を読むコードがあれば拒否」は全 luatexja 文書を拒否）。→ 監査は「信頼境界を plain・mixed 共通の契約前提として docs に明記するなら APPROVE / MERGE 可」と判定。明記した（`80af71a`）。2b の残りも driver の最初の行で add_to_callback を包む形で閉じた（`585b506`）。
- 最終履歴（ブランチ `claude/mixed-block-anchor`、4a81bf1 の上。旧版 `-v1`・`-v2` は退避）: `d2b293b` test: dead-cycle 回帰テスト → `c7f7c17` feat: 収穫側（fx・tdomActive・ca・paintCallbacks・paintLate・state trail・epochs）→ `1f663c5` feat: 混在 block の anchor → `dbd2b5e` perf: SyncTeX cache と caret 先読み → `76c9ed3` perf: warm の再開 → `585b506` fix: callback 登録を driver の最初の行から記録 → `80af71a` docs: 信頼境界。各コミットで hot-path（56→58→58→58→59→59）・farm 343/343・host 42/42。実データ（sandbox 前文 + ch16 の 2 ページ）で trail 一致・paintLate なし・galley 欠落なし・plan 成立（変わった行 3）。
- 見つけたが今回は直していない穴（別作業）: canonical の行の証明（pdf.js paint index）は glyph の文字と位置だけを照合し、塗り色を照合しない。resident は縦モード（top-level や入れ子の vlist 直下）の colorstack push を run の色に反映しない（`walk_v` と top-level の whatsit 分岐は `note_fx` だけ）。luacolor を使わない xcolor 文書で、段落の前に縦モードで `\color` があると、canonical の赤い行を黒で描き直し得る（plain・mixed 共通）。対策案: paint index で glyph ごとの fill color を記録し、witness の run 色と一致しない行は証明しない。

反映（2026-09-11 22:40〜23:30 頃）: エンジン `codex/issue52-preview-convergence` を `4a81bf1..80af71a` に ff-merge・push（本体作業ツリーの未コミットのテスト 2 件は d2b293b と同一だったので破棄）、監査 CI run 34606292841 成功。アプリ `61cc0a2 build: bundle the mixed-block anchor engine`（release.yml の TDOM_ENGINE_COMMIT を 80af71a に）を push。deploy:local は gitignore された同梱コピー `Resources/tdom-engine` を詰めるため、1 回目は 9a6e9a6 のままだった。`npm run tdom:sync` で 80af71a にしてから再度 deploy:local（/Applications/TeX64.app の VENDOR.json が 80af71a）。

アプリ E2E（`scratchpad/runs/r24`〜`r28`、APP_DIR はリポジトリそのもの、TDOM_ENGINE_DIR は `~/Desktop/tdom-engine`=80af71a）:
- 新しい profile では、起動直後に Settings（runtime onboarding）と更新告知 modal が Build ボタンを覆う（r24・r25 は Build のクリックで timeout）。ハーネスは `#settings-close` と `#announcement-modal-close` を押す。
- 新しい profile の初回 Build は PDF を開かなかった（r26・r27）。ファイルツリーから開くと編集中と同じ group に入り、ch16 を開くと PDF が隠れる（r27）。ハーネスは renderer が要求していない `openFile`（`tex64Bridge.postMessage({type:'openFile', path:'main.pdf'})`）を送る。host が PDF を押し込む経路なので、アプリが split を有効にして secondary group に出す。
- r27（PDF 非表示だが engine は動作）: 入力 +0.63 秒で resident 更新（typeset 266ms）と b333 の canonical-anchor ready（proof 415ms、163 ページ）。
- **r28（Build → PDF 163 ページを右 → ch16:33 の iii の後に X）: +0.57 秒で resident 更新（typeset 235ms）と anchor ready（proof 380ms）、+0.64 秒 staging、+0.74 秒に同じ activation のまま Live。スクリーンショット `r28/shots/t00739.png` で 163 ページの KKfbox1 直後の段落に「…整理しやすい iiiX。」、位置は Build の静的 PDF と同じ。canonical rev 3 は +101.5 秒で置換。** ch16:33 の即時反映は達成。

残り: 塗り色を証明しない穴（上）。warm 完了前の打鍵（cold 編集）は依然遅い（r17: 24 秒）。ChatGPT 案: warm 中も最新の完了境界を 1 個だけ kill 耐性のある breadcrumb checkpoint として残す（engine-v3 の core の変更）。長期案として segmenter で「閉じた環境の後の段落」を独立 block にする（粒度の改善として）。新しい profile の初回 Build が PDF を開かない件はアプリ側の挙動として未調査。
- 注意: インストール版 TeX64 は同梱エンジンより `~/Desktop/tdom-engine` を優先して使う（`electron/services/tdom-engine.cjs` の `resolveDirectory()` の候補順）。つまり普段使うアプリの挙動はエンジンリポジトリの作業ツリーで決まる（daemon.lua は resident 起動のたびに読み直し、JS はエンジンサーバー起動時に読む）。deploy:local の同梱エンジンは、このチェックアウトがないときの fallback。

---

以下は同日前半（Codex セッション終了時）の設計案。§0 と食い違う箇所は §0 を優先する。

## 1. 必須の動作

大規模文書でも、編集箇所を最優先で速く更新する。文書全体の正規組版（以下 canonical）が追いつくまでは、その他の領域に同一文書の古い表示が残ってよい。編集中に過去の領域へ頻繁に移動することを前提に、全文の再構築を待たせてはならない。

通常のビルド結果を古い非同期出力が上書きすることは防ぐ。ただし、そのためにエンジン、チェックポイント、ウォーム状態、ライブ表示の接続を毎回破棄しない。この要件は文書サイズによらず共通。小規模文書に一律の待ち時間や再初期化を導入しない。

## 2. 作業場所と現状

- アプリ: `/Users/majinkuu/Desktop/TeX64-Pro`
- エンジン: `/Users/majinkuu/Desktop/tdom-engine`
- 両方のブランチ: `codex/issue52-preview-convergence`
- アプリの確定済み HEAD: `b30e123ac0330a0b1de9a1eabe72f718134313ca`
- エンジンの確定済み HEAD: `23a5a4f85044f0f8e3b3f1a028323e2ab035196e`
- `/Applications/TeX64.app` は上記の以前の修正版。今回の追補変更は未配備。
- アプリには下記7ファイルの未コミット変更がある。破棄せずレビューして継続する。エンジンには今回の追補変更なし。

```
web-src/app/code-live-preview.ts
Resources/web/app/code-live-preview.js      # TSからの生成物
web-src/app/viewer.ts
Resources/web/app/viewer.js                 # TSからの生成物
Resources/web/pdf-viewer.js                 # 直接編集する資産
Resources/web/pdf-viewer.css
docs/realtime-preview.md
```

実装済みの追補は、ビルド後のエンジン保持、dirty bufferだけの入力比較、外部変更の同一セッション更新、ビルド中の入力保持、ライブiframeを残す表示保留とスクロール位置引き継ぎ。ビルド・構文・差分検査は通ったが、実機受入試験は不合格。とくにiframeの表示保留と位置引き継ぎは完成扱いにしない。

以前の `/open` の90秒タイムアウト／重複初期化問題は、10分の専用タイムアウトと同一要求の冪等化で修正済み。この修正を今回の原因と混同して戻さない。

## 3. 最新の有効な再現結果

対象原本: `testing/sandbox-pro/main.tex`。原本は変更せず、コピーで検証した。

検証コピー: `/tmp/tex64-local-latency/build-live-e2e-1789052231`

開始条件は正常な main.tex の通常ビルド成功、右側にPDF163ページ、左側に `content/ch16.tex`、engine `srcRev=22`、`canonical.rev=22`、canonical id9、316ページ、`documentEpoch=8`、queue0。

`ch16.tex` の33行目の `iii` の直後に `X` を1文字だけ入力。実際の差分と入力位置を確認済み。ユーザーが元から入れた `aaa` と `iii` は保持。

| 観測 | 結果 |
|---|---|
| 入力完了 | 1789056054743 ms |
| 入力後の画面取得完了 | 1789056056494 ms。約1.75秒後にはPDFが163→1ページに移動し、Updating表示 |
| 最初のSSE更新 | 1789056058531 ms。入力から約3.79秒、srcRev23 |
| エンジン処理時間 | total 2.790秒、typeset 2.360秒 |
| 再初期化 | なし。epoch8維持、rebooted=false |
| 局所更新 | canonicalAnchor=null、fallback理由 `dirty-source-without-structured-patch` |
| 後続更新 | srcRev24/25。autosave・overlay除去・外部refreshのどれかは既存ログだけでは断定不可 |

ページ移動は最初のSSE更新より約2秒早い。したがって初回のページ移動は、後続の組版結果が届く前の表示切替で発生している。また最初の編集処理からanchorがないので、「後続autosaveが完成済みanchorを消した」だけでは説明できない。ただしautosaveのディスク書込が最初の編集要求の処理より先行した可能性まで否定したわけではない。

2RAFを使った画面取得時刻は取得処理の時間を含む。1.75秒を正確な初回描画遅延として扱わない。今回、編集文字がPDFに現れるまでの時間は測定できていない。

## 4. 修正方針A: 表示の所有権とiframeの寿命を分ける

### 疑わしい箇所

`web-src/app/viewer.ts` の `holdLivePreview()` は、PDF viewerがreadyかつ対象一致のときだけ `live-hold` を単発送信する。まだreadyでない場合に保留意図を保存していない。

`Resources/web/pdf-viewer.js` の `setLiveMode()` は、heldかつ同じURLの場合だけ既存iframeを再利用する。それ以外で表示generationが変わると、新しいactivationとiframe遷移を作る。初回PDF生成時などにholdが抜けた場合、編集開始だけでiframeが作り直され、既定の1ページになる可能性がある。保存ログにはholdの成立を示すイベントがなく、これは有力な仮説であって確定原因ではない。

### 提案する状態管理

表示先ごとに、以下を明示的に保持する。

- 文書の識別子: workspace、main/PDF対象、engine session。別文書の表示を再利用しない。
- 入力revisionと、その通常ビルドが実際に組版した入力の識別子。
- 表示generation: 古い非同期結果の採用を拒否するための値。
- iframe activation/session: iframeの寿命とメッセージの送信元を検証するための値。
- 表示状態: 通常PDF保留、ライブ表示への移行待ち、ライブ表示中。
- 復帰させるページとページ内位置。

表示generationの更新だけをiframe破棄の条件にしない。送信元、文書、epochの検証は維持したまま、同一セッションでの表示世代の更新を受け入れる。URL一致だけで同一文書と決めない。

| 条件 | 処理 |
|---|---|
| 通常ビルド成功、以後の入力なし | 通常PDFを表示。hold意図をviewerモデルに保存し、iframeのready前後どちらでも適用する。エンジンと既存iframeは生かす |
| ビルド成功までに新しい入力が入った | ビルドが扱った入力と最新入力を比較し、新しい編集を過去のビルドで退行させない |
| 清浄なmain/childタブ移動 | 入力変更・エンジン再初期化・ライブ再生成を起こさない |
| ビルド後の最初の実編集 | 同一セッションで編集を送る。表示中のページ位置を保持し、編集箇所の描画準備ができるまでは現在の紙面を隠さない |
| viewportだけの移動 | 表示中の面を動かし、保留中のライブへの復帰位置も追従させる |
| プロジェクト切替、履歴表示、Live OFF、エンジン消失 | 既存の明示的な破棄経路を使う |

ready時に古いLive payloadを再送してholdを解除する競合も防ぐ。iframeなしでビルドが先に終わった場合も、初めて作るライブ面が正しい位置で準備できるまで通常PDFを保持する。

通常PDF→ライブの切替は「URLを渡した」「readyメッセージが来た」だけでは成立させない。正しい文書と表示位置で描画準備が整ったことを既存の描画確認機構と合わせて確認する。待機が成立しないときは元の表示を保持する。

TDOMのcanonical-anchorは一過性のSSE。`/events` の再接続や `/doc` は過去のpatchを再送しない。`lastAnchorPresentation` も再生用patchキャッシュではない。iframe再生成で最初の局所更新を取り逃す設計にしない。

## 5. 修正方針B: 局所更新が生成されない判定を特定する

最初に、`canonicalAnchor=null` を返した正確な分岐を観測する。全文を再ビルドしてから推測する試行を繰り返さない。

優先調査箇所はエンジン `server.js` の `childAnchorEditBeforeOverlay()`、その呼出しとanchor計画の生成・公開、および `engine.onExternalChange`。

一時的な診断には要求識別子、srcRev、documentEpoch、anchor世代、対象ファイル、入力の由来、各判定の棄却理由、比較した内容のhashを記録する。本文全体のログは不要。以下のどこで止まったかを一つの入力から追跡できるようにする。

1. 子ファイル一つの編集として認識されたか。
2. root変更やoverlay除去が混在したか。
3. 以前のinclude読込内容と今回の変更前内容が一致するか。
4. 同じ子ファイルを一度だけ読むなど、既存の安全条件を満たすか。
5. anchorの基準となるcanonicalと入力revisionの対応が成立するか。
6. 局所組版とpatch計画が生成されたか。
7. 計画完成までに世代が変わって棄却されたか。
8. viewerが受信し、正しい表示面へ描画したか。

### autosaveとの競合で注意すること

アプリの入力debounceは80ms、autosaveは400ms。エンジン処理が詰まると、編集要求の処理前にディスクが保存後の内容になる可能性がある。

`childAnchorEditBeforeOverlay()` は以前読んだ内容とディスク内容の一致を要求する。ディスクが今回の新しいoverlay内容になっただけでも、旧内容と不一致になりうる。またoverlay変更・除去や外部変更通知がanchor世代を進める経路がある。

ただし、ここを無条件に緩めない。修正が必要だと証明された場合は、判定を「同一内容を保存しただけ」と「実際に有効な入力が変わった」に分ける。

- 変更前の不変な入力証拠と今回の新内容を保持する。
- ディスクが旧内容または今回の新内容のどちらなのかを明示的に確認する。
- 保存やoverlay除去の前後で実効入力が同じ場合に限り、不要なanchor無効化を抑える。
- 第三の内容、依存ファイル変更、読み込み順の変化、別入力のrevisionは従来どおり無効化する。

autosave停止、anchorの証拠検証の撤去、canonicalの強制実行を恒久対策にしない。変更は観測された棄却分岐に限定する。

## 6. 表示合成の原則

同一文書の既存紙面を基底として保持し、根拠のある編集領域だけを優先して差し替える。局所patchの座標は、それが基準とした紙面と結びつける。座標基準の一致が未確認のまま通常PDFへ直接重ねない。

canonicalが新しい入力に追いついたら、それと対応する領域・ページを置き換え、不要になった局所patchを除去する。新しい編集後に古いcanonicalが届いても、その編集を消してはならない。ページ数や改ページが変わる場合も、現在位置を文書内の対応箇所へ引き継ぐ。

既存エンジンが行っている証拠確認と古い紙面の保持をまず活用する。今回の修正で別の大きな合成機構を無条件に追加しない。

## 7. 実装・検証の順序

1. 未コミット差分を読み、Aの状態管理を確認する。hold要求・ready・activation変更・viewport復帰の最小ログで仮説を確定する。
2. Bの棄却理由を取得する。最初の編集と保存後の要求を別々に追う。
3. 原因の確認できた箇所だけを修正。表示とエンジンで独立した修正なら分けて確認する。
4. ビルドと構文検査、対象経路の短い確認を行う。
5. 次の大規模試験を一回の準備済みセッションで実施し、入力からPDF上の文字が現れるまでを測る。

大規模試験は原本のコピーを使用。main.texを通常ビルドし、canonicalが現srcRevと一致して316ページ、queue0になったら、PDF163ページを右に、ch16を左に表示する。33行目の元の内容とカーソルを確認し、`iii` の後へX一字だけ入力する。編集前後でリロードしない。SSEは入力前から記録する。

過去の無効試行では、Cmd+Gの誤操作、別行への入力、ディスク復元後の古いMonacoモデル、PDF側のエディタグループをソースで置き換える操作が混ざった。これらの結果を速度の証拠に使わない。元の本文とモデルが一致すること、PDFが右側に残ることを入力直前に確認する。

### 合格条件

- PDFが1ページへ戻らず、編集箇所が表示され続ける。
- 入力が実際に変更した文字としてPDF上に現れ、canonical全文完了を待たない。
- その間、周囲の既存表示が消えない。同一文書の古い表示保持は許容する。
- documentEpochとウォーム状態を通常ビルドや清浄なタブ移動だけで失わない。
- 保存後にも編集表示が消えず、最終canonicalへ収束する。
- 古いビルド結果や古いSSEが新しい編集を上書きしない。
- 小規模文書にも不要な待機を導入しない。

「即時」の数値基準はユーザーと未合意。まず入力→局所計算→受信→実描画を分離して実測値を出す。「canonicalより先だった」だけで即時更新の達成としない。暫定の設計目標としてウォームな一文字編集の可視反映1秒以内を置けるが、合意済み仕様や達成済み数値とは扱わない。

通常ビルド中の追加入力、同じ内容の保存、外部ファイル変更、改ページを伴う編集は、基本の一文字編集が通った後に必要な範囲で確認する。

## 8. 開発上の制約と証拠

- 各リポジトリと親のAGENTS.mdを読む。アプリに常設の自動テスト・テスト専用設定を追加しない。TSの生成JSは直接修正しない。
- 16GB環境。エンジンは一つ、`TDOM_MAX_CHECKPOINTS=8`。重い全件テストや複数エンジンを並行起動しない。
- 最新検証終了時点で試験用Electronとエンジンは停止済み。検証コピーには証拠のXが残っているので、新しい試験の基準に無条件で使わない。
- 原本のmain.tex SHA256: `bd20ea0d36d84cd136f39498e79383a854c44163f34d308f342041e0ca12898e`
- 原本のch16.tex SHA256: `6b188b8ee4b03eb0f5675269567263851cc4cc635d82baba8decbaa44247d341`
- 最新の有効結果: `/tmp/tex64-local-latency/build-live-e2e-valid-result.md`
- SSE: `/tmp/tex64-local-latency/build-live-e2e-valid-sse.jsonl`
- ビルドと入力のtrace: `/tmp/tex64-local-latency/pdf-open-dev-trace.jsonl`
- 一時診断用アプリ: `/tmp/tex64-pdf-open-diag`。入力位置確認helper等を含むため、ここからそのまま配布しない。
- `/tmp/tex64-local-latency/RESUME.md` は過去の記録が混在し、古い完了宣言や無効試験の記述を含む。現状判定には本書と最新valid-resultを優先する。

実機で上記の必須動作が確認できるまでは、今回の変更を「直った」と報告せず、普段使うアプリへの反映も行わない。
