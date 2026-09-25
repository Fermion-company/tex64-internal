# リアルタイムプレビュー（ベータ）

Code の設定トグルで有効化する、書きながら組版されるプレビュー。エンジンは兄弟リポジトリ **tdom-engine**（常駐 LuaLaTeX のインクリメンタル組版ランタイム、TDOM Engine）で、開発checkoutまたは同梱したコピーを別プロセスとして起動する。

- 設定: **設定 > Build > Preview > Real-time Preview (Beta)**（`preview.realtime`、default off、localStorage）
- **ライブ専用の表示面は作らない。** Code の通常の `pdf-viewer.html` とツールバーを維持し、ページキャンバスだけを TDOM の埋め込み表示へ切り替える。PDF の表示設定に従い、既存の PDF タブまたは通常 Build の別ウィンドウを同じ状態で切り替える。
- プレビュー上の文字・数式は直接編集できる。編集は同じ Monaco モデルへ入り、未保存状態・自動保存・Undo を通常のソース編集と共有する。ソース位置が競合した場合は推測で別箇所を書き換えず、その編集を拒否する。

## 配線

| 層 | ファイル | 役割 |
| --- | --- | --- |
| main | `electron/services/tdom-engine.cjs` | エンジン解決・spawn（`ELECTRON_RUN_AS_NODE` で `server.js`）・`/open`・`/edit` proxy・`/canonical.pdf` snapshot |
| main | `electron/handlers/tdom-engine.cjs` | IPC `tex64:tdom:{start,status,stop,push,focus,snapshot}` |
| preload | `electron/preload.cjs` | `window.tex64Tdom` |
| renderer | `web-src/app/code-live-preview.ts` | 設定購読・エディタ束縛（80ms debounce。400ms 以上止まった後の最初の打鍵は 16ms で送る。IME 中は送らない）・既存 PDF ビューアと通常の PDF 別ウィンドウへのライブ URL 配信 |
| renderer | `Resources/web/pdf-viewer.js` | 通常 PDF の last-good を保持しつつページ面を TDOM iframe に切替、ツールバー操作と直接編集イベントを中継。エンジンの `action: 'place'`（選択または右クリックの場所・文・ソース行）を受けて「Axiom に聞く」を浮かせ、`ask-axiom`（`source` 付き）をホストへ送る |
| renderer | `web-src/app/viewer.ts` | PDF iframe と Code 側のソース移動・直接編集を接続 |
| renderer | `web-src/app/editor-session/init.ts`・`live-edit-history.ts` | 表示時の原文範囲を Monaco の実変更履歴で追従し、直接編集を単一 Undo セッションとして適用 |

紙面の文字を選ぶか右クリックすると、エンジン（`web/app.js`、embedded のときだけ）が `srcOf` → `/dom` の `block.source`、無ければ `/synctex` でソース行を引き、`action: 'place'`（`kind: selection | point | clear`、`pageNumber`、`text`、`rect`、`file` / `line` / `column`）を親へ postMessage する。選択が消えるかスクロールすると `clear`。この変更は tdom-engine 側（`web/app.js`）にあり、配布前に `npm run tdom:sync` で同梱コピーへ反映する。

エディタ全文を main に送り、main 側が前回ソースとの共通 prefix/suffix を削った**最小レンジ編集**にして `POST /edit` する。ファイル切替時は `POST /open` で開き直す。編集が食い違ったら `/open` で再同期。

直接編集の `sourceText`・`sourceRev`・範囲は、編集開始時に表示していた該当ファイルの原文へ固定する。ホストは Monaco モデル取得時から変更イベントの `rangeOffset`・`rangeLength`・`text` を保持し、対象より前の変更分だけ範囲を移動する。対象内の変更、原文の不一致、履歴切れ、原文のない旧送信形式は拒否する。原文と完全一致する最新のモデル状態から追跡するため、Undo で本文が戻った後も同じ範囲を再編集できる。継続中の編集は直前のモデル状態と範囲を更新して追従し、同じ数式の文字列検索で別の出現箇所へ移さない。履歴はモデルごとの弱参照で管理し、全文1個と最大4096イベント・差分約8MBを保持し、モデル破棄時に解放する。

通常時は TDOM の canonical 面を表示する。編集中も数式を欠いた provisional 面は表示せず、直前の完成した紙面を保持する。未取得の数式・画像・脚注・float と初回rescueはエンジンが `pending-exact` で通知する。影響するページ群の全 chunk・フォント・文字座標・ソース対応を画面外で準備してから、まとめて切り替える。ページ数の減少は確定PDFの提示まで保留する。増分描画の座標とソース範囲はその紙面と一緒に保持し、canonical PDF へ切り替わったら対応する世代へ更新する。別文書の座標を混ぜないよう `documentEpoch` も照合する。

埋め込み直接編集では、原文・SyncTeXの世代対応と入力面の移動を証明できない shipping PDF は提示しない。マクロで隠れた多段組の `shipping-exact` 文書は直前の編集可能な紙面を保ち、対応情報が揃った canonical PDF へ切り替える。通常の structured 文書は完成した増分描画を引き続き使う。

確定PDFとresidentのページ構成が違う場合は、residentに削除通知がなくても増分ページ群を保持する。編集中のページの更新には、原文範囲と全文の文字座標が同じページに一意に残る証明も必要。改ページやUndo途中で一致しない配置は、確定PDFと入力面をまとめて移すまで提示しない。

表示を保留して確定PDFが必要になった場合は、その文書epoch・原文revisionに限って短いdisplay cadenceを要求する。通常の30秒のauthority待機を外し、既存の短いdebounceと組版コストに応じた間隔は維持する。完成したresidentページ群を実際に提示できたら表示側の需要IDを解消し、すべての需要がなくなった未開始予約だけを通常のauthority cadenceへ戻す。同じ版の再保留やiframeの再生成は新しい需要IDで受け付け、別の表示側や遅延した解消通知を混ぜない。開始済みの組版を中断せず、同じrevisionの要求で追加組版やエラーの再試行を発生させない。

現在の編集のresident描画が使える場合だけ、変換・crop完了後500msの表示通知猶予を置き、原文予約から計2000msで打ち切る。改ページなど確定PDFが必須の需要・失敗・isolated fallback・export/settle/opaqueは待機しない。

ツールバーの状態はresidentの処理中、実際の組版中、画面内の旧紙面の保持を分ける。完成した増分紙面が提示済みで、裏でauthority確認の予約を待つだけの間は通常のライブ表示にする。画面内の紙面が保留されている場合は描画待ちを維持する。可視ページの判定は既存のページ・スクロールsnapshotの走査を共有する。

直接編集のカーソルと選択範囲は、表示している PDF の文字送り・行列から取得する。TDOM の `pdf-edit-geometry.js` と `/canonical/glyphs`・`/chunk-glyphs`・`/ship-glyphs` が世代別の座標を渡し、`web/direct-edit-geometry.js` が文字位置や MathLive の要素位置へ対応させる。MathLive fork の `getElementInfo()` は記号・印字範囲と親要素・分子分母の枝・行列の行列位置を公開する。空セルは実glyphと照合したSyncTeXの行基線・列位置、空分子・分母は `/canonical/source-boxes` が同じPDF世代から返す兄弟hboxを使い、対応を証明できた場合だけカーソルを置く。取得には文書epochも照合する。MathLive 自体の透明な入力面の座標は紙面のクリック位置に使わない。

数式入力では元ソースの改行・空白を保ち、MathLive の初期正規化だけで式全体を置換しない。入力中の値と表示世代が一致しない間は、直前のカーソル位置を保持する。IME の未確定文字だけは紙面の入力位置に下線付きで表示し、候補の選択・確定・取消キーは IME に渡す。文字のドラッグ選択・Shift 選択も紙面の座標を使う。直接編集中の選択では「Axiom に聞く」を重ねず、右クリックの既存経路を維持する。入力に伴うブラウザの自動スクロールは抑える。クリック位置の照合中に届いた打鍵は、対応するカーソルが確定してから適用する。隔離組版された段落にも編集範囲を渡し、増分描画の式は chunk の文字配置から照合する。同じ式・文字列が繰り返される場合は、ソースの順序と紙面の全出現箇所をまとめて照合する。

行列・分数の後ろのカーソルは、各行や分子分母の実boxとSyncTeXの祖先IDから外側hboxを証明し、括弧やkernを含む右端と基線へ置く。証明できない構造境界を最後のセルや分母の文字位置へ置き換えない。空セル・空分子分母のクリックも同じ実boxの空境界へ対応させる。

各直接編集セッションの開始時に一度 `edit-anchor` を往復し、Monaco の履歴で補正した現在の範囲と、その時点の原文を表示用の基準として返す。前の編集が未反映の旧PDFから別箇所を選んでも、この基準とそのセッションの置換によって canonical 上の位置を証明できる。初回の打鍵が先着した場合は既存の編集アンカーを使い、未読込の子ファイルはバックグラウンドで読み込んでから返信する。全文の返信は開始時の一度だけ。activation・文書epoch・session・request・開始sourceRevを照合し、別文書や閉じたセッションへの遅延返信を破棄する。

同じ旧PDF上の編集済み領域へ戻る場合は、終了済みセッションを最大32件保持し、`previousSessionId`・開始原文・範囲・最終置換の一致をホストが確認する。追跡できた現在の本文を入力面へ復元し、その原文範囲を新セッションの送信基準へ固定してから待機中の入力を適用する。本文の位置は実 `beforeinput` 選択範囲、数式の位置は MathLive atom の `modelId` で追跡し、同じ文字の反復を文字列の前後一致だけで推測しない。内部 Undo snapshot は構造を照合して atom identity も復元し、通常の挿入・削除で同じ全文へ戻った状態とは区別する。通常の LaTeX / JSON 入力にはこの内部 identity を引き継がない。受信待ちの打鍵・貼付けは既存の入力キューで保持する。原文や境界を証明できない外部変更を別の同値文字列で補わない。

再訪の記録は `getModelMetadata()` で一度に取得する論理atom情報を使う。offset・親/前兄弟の境界・深さ・identityは線形の一括走査で求め、DOM座標の測定や部分式のLaTeX直列化は行わない。返値は呼出し時点のmodel snapshotで、編集を跨いで使い回さない。PDF glyphとの対応に実表示寸法が必要な場合だけ、別の `getElementInfo()` の描画情報を読む。

canonical 更新で入力面の親ページが変わらなければDOMを挿し直さない。改ページは `moveBefore` とMathLiveの `connectedMoveCallback` でフォーカス・選択・IMEを保持し、旧ページの削除より先に入力面を移す。未対応ブラウザでは変換中の移動を待ち、通常入力のフォーカスと選択を復元する。

紙面から適用する数式の選択位置は、MathLiveの現在のUndo状態にも反映する。内容の履歴は増やさず、最初の編集まで戻した後もクリックしたセルや分子・分母から入力を続けられるようにする。行列の行・列追加/削除コマンドは変更後の内容と選択を1回記録し、Undo/Redoの各段階でその内容に対応するセルへ戻す。モデル状態の復元時は空の最終行も保持し、TeX解析時の末尾空行除去を再適用しない。

元の数式の改行・空白を保つ差分は、適用後にも保存値と照合する。環境名やtext引数の空白は有意として扱い、構造変更で別のbrace内へ余白が移る場合は、その回の正しいMathLive直列化を使う。

クリックの照合中は、canonical・増分chunk・shippingを含む表示更新を保留する。連続クリックの入力を順に渡してから、保留したソース通知を順序どおり処理し、最新の表示へ進む。文書切替時は旧文書の保留入力・表示更新を破棄する。

ライブ表示と直接編集は、送信に成功したルートTeXと同じディレクトリ・同じ名前のPDFだけを対象にする。別のPDFタブでは直ちに静的PDF表示へ戻し、そのタブへ届いた旧ライブ編集・位置照合の通知を受け付けない。独自の出力先やjobnameは、Code側がビルド結果の原文とPDFの対応を保持するまでは静的表示を使う。

編集中の入力面が別ページへ移った場合だけ、旧caretの画面内Yをできる限り保ってスクロールを追従する。新glyphのcaretで補正し、途中の手動スクロールや選択変更は優先する。同じページの更新ではスクロールを動かさない。本文のクリックとcanonical後の再配置は、forward SyncTeXと実際のword boxで絞った全出現と原文範囲の同じ対応を使う。逆位置は整合するときに更に限定し、段落後の空行を指してもforwardの証明を失わない。同じ行の複数出現は全数が一致するときだけソース列順とPDF順を対応させ、改ページ前の近い同値本文へ移さない。

通常ビルドが成功し、ビルドが組版した入力がその時点でも最新なら、紙面の所有権をビルドへ移す。同じワークスペース・PDFのタブはビルドで更新されたPDFを表示し、ライブのiframe・activation・文書epochとエンジン入力・checkpointはその下に保持する。所有権（`hold`）はライブ状態の一部としてviewerへ配布し、ビルドが新しく開いたPDFタブではviewerのready後に適用する。ライブ表示中だった場合は、そのページでビルドのPDFを開く。保持中のiframeは静的PDFの表示位置を追う。遅れて届いたライブ応答も同じ所有権で再配布するため、旧紙面へ戻らない。

通常BuildとTDOMの重い全体組版はBuild leaseで直列化する。Build開始前にローカルgateを取得するため、TDOMがまだ起動していない場合もBuild中にcold bootstrapを始めない。起動済みの同一文書へ送る軽いresident editは継続する。エンジン側leaseはcanonical・open・warmの重い処理を保留し、すでに走っているauthority childを停止してcheckpointと表示世代を保持する。Buildの成功・失敗・中止・timeoutとアプリ終了の全経路で同じtokenを解放し、watchdogも残す。

LuaLaTeXの通常Buildが成功した場合は、staging中のPDF・SyncTeX・FLS・root auxと、FLSが記録したproject入力全件のhashをimmutable cache世代へ保存する。TeXを起動する前にもproject通常ファイルを時間・件数・総byte数で制限した範囲でhashし、FLSのproject入力全件がその事前観測に存在して同じhashである場合だけcanonical候補にする。未観測入力、Build中の保存、読取競合、観測上限の超過はcacheをstatic last-goodとして残し、canonical採用だけを行わない。同じアプリ実行中に取得した候補だけを、現在のdocument/source/input epoch、lease identity、LuaLaTeX profile、PDF producer、全入力hash、SyncTeX input mapが一致する場合にTDOM canonicalへ採用する。既存residentが同じidentityなら `/canonical/build-import`、cold openなら候補付き `/open` を使い、応答まではleaseを保持する。採用の拒否や通信失敗は通常Buildの成功を取り消さず、新PDFを表示してTDOM自身のcanonicalへ戻る。ディスクcacheをアプリ再起動後のauthorityとして採用する処理は、TeX toolchain/config fingerprintが未実装のため行わない。

事前・事後hashは、Build開始前と終了後で同じbytesであったことを示す。途中で別bytesへ変わって元へ戻るABA変更や、project外のTeX system入力がBuild中に変わらないことまでは観測しない。これはFLS入力照合とは別のobservable-input制約であり、完全なhermetic Buildや永続authorityの証明として扱わない。

canonical anchorが複数のソース行を照会するときは、同じ世代のSyncTeXをvendored MIT parserで一度だけ解析するbounded helperを使う。全行のJSON group、record数、有限座標、世代とlogical/recorded path対応が完全な場合だけ既存の座標変換へ渡す。compiler/zlibがない、process失敗、期限超過、JSON欠損、変換不能のいずれでも既存の`SyncTeX` CLIへ戻り、paint証明やpublish条件は変えない。

ビルド後の最初のソース変更は `/edit` として送り、エンジンがそれを受理した時点で所有権をライブへ戻す。受理した source revision を期待値としてviewerへ配布する。静的PDFの表示中心の紙面位置を token 付きの `goto-sync` でiframeへ渡し、iframeがその token を返し（位置の確認）、期待値以上の revision を適用して完成した紙面（`ready`、または `presentationPending` が false）を持つまで静的PDFを上に残す。認証済みの局所描画は canonical の確認まで `presentationPending` のままなので、完成の判定にはどちらも使う。確認できない間は再送を続け、静的PDFを外さない。静的PDFをスクロールした場合は新しい位置を渡し直す。iframeを作り直さず、ほかの領域はcanonicalが追いつくまで直前の正しい紙面を使う。token を返さない旧エンジンでは報告された先頭ページで位置を判定する。新しいiframeを作る場合も静的PDFの表示位置から始める。ビルド中の編集を含め、その時点のエディタ本文は変更しない。通常ビルドのプロセス上限は10分で、時間切れは取消とは区別してエラー通知し、直前の正常なPDFを保持する。

ビルド開始後にエディタ・外部同期によるソース変更があった場合や未保存ソースが残る場合は、保存済みPDFが旧版であることをProblemsへ通知し、追加の打鍵を待たずに最新ソースのライブ表示を再開する。成功通知より後着した旧編集応答は採用しない。

TDOM の `closure-deferred` は resident の紙面を保持しつつ最新ソースの確定組版を予約する。`\loop\ifnum...\repeat` は閉じた構文として認識する。確定組版のエラーでは部分PDFを採用せず、修復後の編集から自動で再組版する。`/status` の canonical 情報に `runningRev`・`scheduledRev`・`fallbackReason` が入り、現在のソースに対する収束処理を確認できる。

## エンジンの解決順序（tdom-engine.cjs）

1. `TDOM_ENGINE_DIR`（env。旧 `TEX64_TDOM_ENGINE_DIR` も互換対応）
2. 開発 checkout: `~/Library/Application Support/TeX64/engines/tdom-engine` → `~/Developer/tdom-engine` → `~/tdom-engine` → `~/Desktop/tdom-engine`。旧 `tdom-core` checkout はその後の互換フォールバック
3. vendored copy: パッケージ版の `resources/app.asar.unpacked/Resources/tdom-engine/`、開発配置の `Resources/tdom-engine/` の順（`server.js` の存在で判定）。

**開発フロー**: checkout が vendored より優先されるので、`~/tdom-engine` を変更したらプレビューを OFF→ON（またはアプリ再起動）するだけで新しいエンジンが動く。同期作業は不要。

**配布**: `npm run tdom:sync` が checkout の実行用構成（engine/・host/・vendor/・server.js・web/（pdfjs 除く）・templates/・samples/）を `Resources/tdom-engine/` に複製し、`VENDOR.json` にソースコミットを記録する。`vendor/` にはruntime helperが必要とする固定版ソースとライセンスを含む。`host/` は upstream の正式なホスト統合 API で、TeX64 の配布物にもエンジンと同じ版を保持する。gitignore 済み。パッケージ前に実行する。`asarUnpack` により実ファイルは `resources/app.asar.unpacked/Resources/tdom-engine/` へ配置され、外部 Node プロセスはこの実ディレクトリから起動する。リリースCIは `.github/workflows/release.yml` の `TDOM_ENGINE_COMMIT` を同梱するため、エンジンの確定コミットと合わせる。

## 実行時の前提と保護

- 必須バイナリ: `lualatex`（managed TeX / システム texbin を PATH に前置）、poppler の `pdftocairo` / `pdftotext` / `pdfinfo`、fork shim 初回ビルド用の `cc`（PATH に `/opt/homebrew/bin` `/usr/local/bin` を追加して spawn）。欠けるとエンジンが起動せず console にエラーが出る（ビューアは静的表示のまま）。従来ビルドには影響しない。
- `TDOM_MAX_CHECKPOINTS=8`（checkpoint 1 個 ≒ 常駐 lualatex fork 1 個 ≒ 100–300MB。エンジン既定の 64 は踏まない）。
- `TDOM_WORKDIR` は userData 配下の絶対パス（tdom-engine 側に絶対パス対応済み）。
- 数式の直接編集に使う MathLive / WYSIWYG 資産だけを `app.asar.unpacked` に展開し、`TDOM_HOST_WEB_ROOT` で外部 TDOM プロセスへ渡す。renderer 全体は公開しない。
- boot サンプルは `samples/` の実在ファイルから選ぶ（`demo-lua.tex` 優先）。既定の stress-test-ja は起動に数分かかるため使わない。
- トグル OFF・アプリ終了で SIGTERM → エンジン側の shutdown が常駐 lualatex ツリーを回収する。
- ポートは 4646 起点で空きを探す（tdom 開発サーバーの 4633 とは衝突させない）。

## 既知の制限（ベータ）

- TDOM の canonical が未着地のあいだは直前の通常 PDF / last-good PDF を保持する。
- Code の PDF タブはルート `.tex` と同階層の `.pdf` 名で開く。特殊な outDir を使う通常ビルドでは、先にその出力 PDF を開いておくと同じタブが更新される。
- 直接編集の文字座標抽出は横書きが対象。縦書き・Type3・回転した個別文字は水平カーソルへ変換しない。合字内部の文字境界は実 glyph の送りを分割する。
- Windows 不可（エンジンが fork 依存。POSIX のみ）。

## 実行上の注意

- workdirに空白が入るため、daemonとのパス通信はpercent-encodeと長さ付き受信を維持する。
- macOSでバックグラウンド起動によるQoS低下が疑われる場合は、LaunchServices経由で起動して確認する。
- galley停止時は `stats.diagnostics` のfork失敗・子プロセス応答を確認する。エンジン側の詳細はTDOMの現行資料を参照する。
