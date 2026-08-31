# リアルタイムプレビュー（ベータ）

Code / AI 共通の設定トグルで有効化する、書きながら組版されるプレビュー。エンジンは兄弟リポジトリ **tdom-core**（常駐 LuaLaTeX のインクリメンタル組版ランタイム、TDOM Engine）で、TeX64 本体には同梱せずプロセスとして起動する。

- 設定: **設定 > Build > Preview > Real-time Preview (Beta)**（`preview.realtime`、default off、localStorage）
- **ライブ専用の表示面は作らない。** TDOM が確定した PDF バイトを、Code では通常の `pdf-viewer.html`、AI では通常の `PdfPreview` へ渡す。ズーム、スクロール、検索、サイドバー、SyncTeX は通常ビルド後の PDF と同じ経路を通る。Code では既存の PDF タブを更新し、まだ無ければ通常と同じセカンダリグループに PDF タブを開く。別ウィンドウは起動しない。

## 配線

| 層 | ファイル | 役割 |
| --- | --- | --- |
| main | `electron/services/tdom-engine.cjs` | エンジン解決・spawn（`ELECTRON_RUN_AS_NODE` で `server.js`）・`/open`・`/edit` proxy・`/canonical.pdf` snapshot |
| main | `electron/handlers/tdom-engine.cjs` | IPC `tex64:tdom:{start,status,stop,push,focus,snapshot}` |
| preload | `electron/preload.cjs` | `window.tex64Tdom` |
| renderer | `web-src/app/code-live-preview.ts` | 設定購読・エディタ束縛（80ms debounce・IME 中は送らない）・確定 PDF snapshot の配信 |
| renderer | `web-src/app/viewer.ts` | ライブ PDF を通常の `showPdfViewer` と同じ PDF.js 読み込みへ渡し、静的 PDF を last-good として保持 |
| AI | `services/tex64-ai/src/lib/client/use-workspace-pdf.ts` | native host から受けた同じ PDF snapshot を既存の `PdfPreview` URL として採用 |

エディタ全文を main に送り、main 側が前回ソースとの共通 prefix/suffix を削った**最小レンジ編集**にして `POST /edit` する。ファイル切替時は `POST /open` で開き直す。編集が食い違ったら `/open` で再同期。

表示するのは TDOM の provisional DOM ではなく、確定した LuaLaTeX PDF だけである。したがって画面更新は canonical の着地単位になるが、通常 PDF と異なる字形・改ページ・操作系が混在しない。

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
- boot サンプルは `samples/` の実在ファイルから選ぶ（`demo-lua.tex` 優先）。既定の stress-test-ja は起動に数分かかるため使わない。
- トグル OFF・アプリ終了で SIGTERM → エンジン側の shutdown が常駐 lualatex ツリーを回収する。
- ポートは 4646 起点で空きを探す（tdom 開発サーバーの 4633 とは衝突させない）。

## 既知の制限（ベータ）

- TDOM の canonical が未着地のあいだは直前の通常 PDF / last-good PDF を保持する。
- Code の PDF タブはルート `.tex` と同階層の `.pdf` 名で開く。特殊な outDir を使う通常ビルドでは、先にその出力 PDF を開いておくと同じタブが更新される。
- Windows 不可（エンジンが fork 依存。POSIX のみ）。

## 解決済みの問題

- **アプリ内でだけ exact 画像・rescue・ヘッダジョブが全滅する（スペース入りパス）**（2026-08-20 解決、tdom-core f77db03）: エンジンの制御プロトコルはコマンド行を空白で分割するが、アプリの workdir は `~/Library/Application Support/...` — **パスの空白が行を剪断**し、`RENDER`/`ISO` の长さトークンがパスの一部になって len=0 → 本文バイトがストリームに残留 → 以降のコマンドが残骸として食われる。症状は「galley タイムアウト（no child ever announced）」「__hf ヘッダタイムアウト」「rescue が永遠に着地しない」= アプリ内でだけ数式 exact 画像やタイトルが出ない、スペース無しの開発 checkout では常に再現しない、という長時間の切り分け地獄。対処は 2 層: jobdir を **percent-encode して送り daemon 側で decode**（`encodeURIComponent`/`pctdecode`）、および本文受信を **`recv_exact`（len バイト揃うまで partial を蓄積）** にして「受信失敗を空文字に握り潰してフレーミングごと壊す」クラスを根絶。再現手順: workdir にスペースを含むパスを渡して boot→/open（headless で確定再現・修正確認済み）。
  - 調査中の副産物として: Bash から `nohup npm run electron:dev &` で起動したアプリは **darwin background QoS（nice 5, `SN`）** で走り、常駐 fork ツリー全体が飢餓してタイムアウトが多発する。検証目的でアプリを CLI 起動するときは `open -a node_modules/electron/dist/Electron.app --args <repo>` で launchd 経由（通常 QoS）にすること。

- **編集するとタイトル（\maketitle の出力）が provisional から消える**（2026-08-20 解決、tdom-core 29e8692）: `\newpage` は `\penalty-\@M` で終わり、ページの残量に関係なく output routine を発火させる。休眠ページではそこまでに送られた材料が output routine に吸収され、ブロックの harvest は**空ギャレー**になる。article の `\maketitle`（非 titlepage）は `\@maketitle` の前に `\newpage` を実行するため、タイトルブロックのギャレーが常に空 → どこを編集してもページ 1 が provisional に切り替わった瞬間、タイトル・著者・日付が canonical 到着まで消えていた（ページ収束の二値化で band splice の隠蔽がなくなり顕在化。band splice 時代から実は同根で欠けていた）。対処: `\maketitle` / `\newpage` / `\clearpage` / `\cleardoublepage` を含むブロックを **rescue 階層**（実 preamble・実 \textheight での隔離コンパイル）に分類。隔離側には本物のページビルダーがあるので、ギャレーは正しいタイトル高さを持ち、チャンク画像は印刷同一。rescue は非同期ポンプで着地（初回 ~1.6s、以後は rescue キーでキャッシュされ打鍵コストゼロ）し、以後どの順序で編集してもタイトルは provisional に残り続ける。

- **編集中に旧行と新行が同時に表示される（行の重複・欠落・混在）**（2026-08-20 解決、tdom-core 03c72a3）: クライアントは「canonical 画像を全面に重ね、編集で変わった y 帯だけ窓を開けて provisional を見せる」帯スプライスをしていたが、この合成は帯の外で provisional と canonical のレイアウトが一致している前提で、その検証がどこにもなかった。float/脚注の近似・改ページの相違・入力途中の壊れた文書などでレイアウトがドリフトすると、canonical の旧行と provisional の編集行が同時に見える（実機で provisional と canonical の改ページが 1 ページ近くずれる状態まで再現・確認）。**ページの収束を二値化**（そのページを現ソースの canonical が保証していれば canonical 全面、編集後は provisional 全面）して構造的に混在を排除した。帯最適化を戻す場合はエンジンが canonical の行座標を保証する仕組みが前提（将来課題）。

- **\maketitle 直下の編集が canonical 待ちになる**（2026-08-20 解決、tdom-core 082439a）: 空行を挟まず `\maketitle` の次の行に書いた本文が同一ブロックに併合され、そのブロックの常駐組版がタイムアウト（`timeout waiting for galley:bNN`）→ rescue もタイムアウト → 空ギャレーで凍結すると、以降の打鍵が「空→空」の再組版になり dirtyPages [] / patches 0（表示は canonical 到着まで更新されない）となっていた。対処は 2 層:
  1. **segmenter**: 単独行の生成系コマンド（\maketitle / \tableofcontents / \listoffigures / \listoftables）を前後両側で独立ブロック化。直下の本文は別ブロックになり、打鍵でタイトルブロックが再キーされない。
  2. **エンジンの自己修復**: fork() 失敗は daemon が `FORKFAIL` を即時通知（従来は無通知で 12 秒タイムアウト、しかも `FORKED -1` を送って kill(-1) を誘発し得た）。「fork 失敗」「子プロセスが一度も名乗らないタイムアウト」はブロック凍結ではなく**全面再構築リトライ（root 再ブート）へエスカレート**し数秒で治癒。タイムアウト二連発の凍結時は当該 checkpoint lineage を退役させ、次の編集は健全な snapshot から fork。子が名乗った後に黙るハング（ユーザーの壊れた TeX による無限ループの形）は従来どおりブロック単位の封じ込め。galley タイムアウトには forensics（ckpt 番号・FORKED 有無）が diagnostics に残る。fault 注入テスト `tests/infra-escalation.test.js`（`--test-force-exit` で実行）で 3 経路とも検証済み。

テスト: `tests/tdom-engine-service.test.cjs`（diff・解決順序・boot サンプル選択・spawn env・fake エンジンとの start/push 統合）。
