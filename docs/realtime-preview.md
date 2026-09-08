# リアルタイムプレビュー（ベータ）

Code の設定トグルで有効化する、書きながら組版されるプレビュー。エンジンは兄弟リポジトリ **tdom-core**（常駐 LuaLaTeX のインクリメンタル組版ランタイム、TDOM Engine）で、開発checkoutまたは同梱したコピーを別プロセスとして起動する。

- 設定: **設定 > Build > Preview > Real-time Preview (Beta)**（`preview.realtime`、default off、localStorage）
- **ライブ専用の表示面は作らない。** Code の通常の `pdf-viewer.html` とツールバーを維持し、ページキャンバスだけを TDOM の埋め込み表示へ切り替える。既存の PDF タブを使い、別ウィンドウは起動しない。
- プレビュー上の文字・数式は直接編集できる。編集は同じ Monaco モデルへ入り、未保存状態・自動保存・Undo を通常のソース編集と共有する。ソース位置が競合した場合は推測で別箇所を書き換えず、その編集を拒否する。

## 配線

| 層 | ファイル | 役割 |
| --- | --- | --- |
| main | `electron/services/tdom-engine.cjs` | エンジン解決・spawn（`ELECTRON_RUN_AS_NODE` で `server.js`）・`/open`・`/edit` proxy・`/canonical.pdf` snapshot |
| main | `electron/handlers/tdom-engine.cjs` | IPC `tex64:tdom:{start,status,stop,push,focus,snapshot}` |
| preload | `electron/preload.cjs` | `window.tex64Tdom` |
| renderer | `web-src/app/code-live-preview.ts` | 設定購読・エディタ束縛（80ms debounce・IME 中は送らない）・既存 PDF ビューアへのライブ URL 配信 |
| renderer | `Resources/web/pdf-viewer.js` | 通常 PDF の last-good を保持しつつページ面を TDOM iframe に切替、ツールバー操作と直接編集イベントを中継。エンジンの `action: 'place'`（選択または右クリックの場所・文・ソース行）を受けて「Axiom に聞く」を浮かせ、`ask-axiom`（`source` 付き）をホストへ送る |
| renderer | `web-src/app/viewer.ts` | PDF iframe と Code 側のソース移動・直接編集を接続 |
| renderer | `web-src/app/editor-session/init.ts`・`live-edit-history.ts` | 表示時の原文範囲を Monaco の実変更履歴で追従し、直接編集を単一 Undo セッションとして適用 |

紙面の文字を選ぶか右クリックすると、エンジン（`web/app.js`、embedded のときだけ）が `srcOf` → `/dom` の `block.source`、無ければ `/synctex` でソース行を引き、`action: 'place'`（`kind: selection | point | clear`、`pageNumber`、`text`、`rect`、`file` / `line` / `column`）を親へ postMessage する。選択が消えるかスクロールすると `clear`。この変更は tdom-core 側（`web/app.js`）にあり、配布前に `npm run tdom:sync` で同梱コピーへ反映する。

エディタ全文を main に送り、main 側が前回ソースとの共通 prefix/suffix を削った**最小レンジ編集**にして `POST /edit` する。ファイル切替時は `POST /open` で開き直す。編集が食い違ったら `/open` で再同期。

直接編集の `sourceText`・`sourceRev`・範囲は、編集開始時に表示していた該当ファイルの原文へ固定する。ホストは Monaco モデル取得時から変更イベントの `rangeOffset`・`rangeLength`・`text` を保持し、対象より前の変更分だけ範囲を移動する。対象内の変更、原文の不一致、履歴切れ、原文のない旧送信形式は拒否する。原文と完全一致する最新のモデル状態から追跡するため、Undo で本文が戻った後も同じ範囲を再編集できる。継続中の編集は直前のモデル状態と範囲を更新して追従し、同じ数式の文字列検索で別の出現箇所へ移さない。履歴はモデルごとの弱参照で管理し、全文1個と最大4096イベント・差分約8MBを保持し、モデル破棄時に解放する。

通常時は TDOM の canonical 面を表示する。編集中も数式を欠いた provisional 面は表示せず、直前の完成した紙面を保持する。未取得の数式・画像・脚注・float と初回rescueはエンジンが `pending-exact` で通知する。影響するページ群の全 chunk・フォント・文字座標・ソース対応を画面外で準備してから、まとめて切り替える。ページ数の減少は確定PDFの提示まで保留する。増分描画の座標とソース範囲はその紙面と一緒に保持し、canonical / shipping PDF へ切り替わったら対応する世代へ更新する。別文書の座標を混ぜないよう `documentEpoch` も照合する。

直接編集のカーソルと選択範囲は、表示している PDF の文字送り・行列から取得する。TDOM の `pdf-edit-geometry.js` と `/canonical/glyphs`・`/chunk-glyphs`・`/ship-glyphs` が世代別の座標を渡し、`web/direct-edit-geometry.js` が文字位置や MathLive の要素位置へ対応させる。MathLive fork の `getElementInfo()` は `symbol`・`beforeOffset`・`glyphBounds` を公開する。MathLive 自体の透明な入力面の座標は紙面のクリック位置に使わない。

数式入力では元ソースの改行・空白を保ち、MathLive の初期正規化だけで式全体を置換しない。入力中の値と表示世代が一致しない間は、直前のカーソル位置を保持する。IME の未確定文字だけは紙面の入力位置に下線付きで表示し、候補の選択・確定・取消キーは IME に渡す。文字のドラッグ選択・Shift 選択も紙面の座標を使う。直接編集中の選択では「Axiom に聞く」を重ねず、右クリックの既存経路を維持する。入力に伴うブラウザの自動スクロールは抑える。クリック位置の照合中に届いた打鍵は、対応するカーソルが確定してから適用する。隔離組版された段落にも編集範囲を渡し、増分描画の式は chunk の文字配置から照合する。同じ式・文字列が繰り返される場合は、ソースの順序と紙面の全出現箇所をまとめて照合する。

## エンジンの解決順序（tdom-engine.cjs）

1. `TEX64_TDOM_ENGINE_DIR`（env）
2. 開発 checkout: `~/Library/Application Support/TeX64/engines/tdom-core` → `~/Developer/tdom-core` → `~/tdom-core` → `~/Desktop/tdom-core`
3. vendored copy: `Resources/tdom-engine/`（パッケージ版フォールバック）

**開発フロー**: checkout が vendored より優先されるので、`~/tdom-core` を変更したらプレビューを OFF→ON（またはアプリ再起動）するだけで新しいエンジンが動く。同期作業は不要。

**配布**: `npm run tdom:sync` が checkout の最小構成（engine/・server.js・web/（pdfjs 除く）・templates/・samples/、約 900KB）を `Resources/tdom-engine/` に複製し、`VENDOR.json` にソースコミットを記録する。gitignore 済み。パッケージ前に実行する（`files` は `Resources/**` を含み、`asarUnpack` に `Resources/tdom-engine/**` を追加済み）。

## 実行時の前提と保護

- 必須バイナリ: `lualatex`（managed TeX / システム texbin を PATH に前置）、poppler の `pdftocairo` / `pdftotext` / `pdfinfo`、fork shim 初回ビルド用の `cc`（PATH に `/opt/homebrew/bin` `/usr/local/bin` を追加して spawn）。欠けるとエンジンが起動せず console にエラーが出る（ビューアは静的表示のまま）。従来ビルドには影響しない。
- `TDOM_MAX_CHECKPOINTS=8`（checkpoint 1 個 ≒ 常駐 lualatex fork 1 個 ≒ 100–300MB。エンジン既定の 64 は踏まない）。
- `TDOM_WORKDIR` は userData 配下の絶対パス（tdom-core 側に絶対パス対応を追加済み）。
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
