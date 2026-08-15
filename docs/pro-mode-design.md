# TeX64 Pro モード設計書

TeX64（ライトユーザー向け）と同一アプリ内に、プロの編集者・執筆者向けの「Pro モード」を追加する。
Claude と Claude Code の関係のように、同じ製品の中で対象ユーザー別の 2 つの顔を持たせる。
Pro はコードを書くこと（TeX/LaTeX/expl3/Lua を直接編集すること）を前提とする。

## 決定事項（2026-08-12）

- 実装先はこのリポジトリ（tex64-internal / Electron アプリ本体）。
- プレビューは fermion-tex-engine（常駐インクリメンタル LuaLaTeX ランタイム）によるライブプレビューを目標とし、既存 latexmk ビルドとは共存させる。
- OCR / TeX 化 / 翻訳は texize（ローカルの Python パイプライン、`ocr2tex` パッケージ）の機構を使う。
- スタッシュの AI 一括編集は texize と同じ OpenAI 互換 API に統一する。
- 開発体制: 設計・レビューは Claude、コード実装は Codex CLI（gpt-5.6-sol、軽め）に委譲する。

## レイアウト

Pro モードはトップバーのトグルで出入りする。2 つの分割レイアウトを持つ。

### レイアウト①: プレビュー | ソースコード

```
+-------------------+-------------------+
| プレビュー          | ソースコード        |
+-------------------+-------------------+
```

### レイアウト②: 執筆 | 参考 | コード（折り畳み）

参考文献 PDF や画像を見ながら書くとき用。コードペインは右端の細いストリップに折り畳まれ、
クリックで展開できる。

```
+-------------+-------------+--+
| 書いてるもの  | 参考         |код|
+-------------+-------------+--+
```

### ペイン共通要件

- ドラッグでスムーズにリサイズ（既存の `--split-primary`/`--split-secondary` CSS 変数方式を 3 ペインへ拡張）。
- 各ペインはワンクリックで折り畳み/展開。比率は localStorage に永続化。
- 参考ペインは PDF / 画像を開ける（既存 viewer.ts / pdf-viewer.html を流用）。

## 機能

### 1. 範囲選択キャプチャ → texize（Pro の中核）

macOS のスクリーンショット（Cmd+Shift+4）風の矩形選択を、プレビューペインと参考ペインの
両方で行える。既存の math-capture の crop UI（`web-src/app/math-capture.ts`）を汎用化する。

選択確定後にフローティングメニューで選ぶ:

- **TeX 化**: 選択画像を texize の OCR 機構に渡し、返ってきた TeX 断片をカーソル位置に挿入
  （または一旦プレビュー表示して確認後挿入）。
- **翻訳**: OCR 結果を任意言語へ翻訳してから挿入（texize の翻訳層と同じ API 系統）。
- **画像化**: 選択範囲を PNG としてプロジェクトの assets に保存し、`\includegraphics` 断片を
  即挿入できる UI を出す。
- **スタッシュへ**: 下記トレイに送る。

### 2. スタッシュトレイ + AI 一括編集

DropOver のイメージ。選択範囲（キャプチャ画像・TeX 断片・テキスト）を番号付きで一時保持し、
いくつか揃ったら「1と2を入れ替え、5はもっと短く、6は丸々カット」のような自然言語コメントを
AI に渡して一括編集した結果を得る。結果は差分表示して挿入/置換できる。
AI バックエンドは OpenAI 互換 API（既存 `api/v2/ai/openai` プロキシ経由）。

### 3. syntax highlight 強化

monaco の言語定義（`web-src/app/monaco-language.ts`）を強化する。少なくとも:

- **expl3**: `\cs_new:Npn` 等の `:` 付き引数指定子、`\l_`/`\g_`/`\c_` 変数、`_tl`/`_seq` 等の型接尾辞。
- **plain TeX / LaTeX**: 既存の強化。
- **Lua**: `\directlua{...}` / `luacode` 環境内の Lua 埋め込みハイライト。

### 4. 文書構造ジャンプメニュー

`\part`/`\chapter`/`\section`/`\subsection` 等の構造を一覧する引き出しメニューを Pro レイアウト
から引き出せるようにし、項目クリックでエディタの該当行へジャンプする。
既存の outline（`web-src/app/outline-ui.ts`、texlab ベース）を流用する。

### 5. fermion-tex-engine ライブプレビュー

常駐インクリメンタル LuaLaTeX ランタイムを electron service としてホストし、編集に追従する
ライブプレビューをレイアウト①のプレビューペインに出す。最終確認は従来の latexmk ビルド。

### 6. 作図キャンバス（ベクタ描画 → TikZ / 画像挿入）

Illustrator 的なベクタ描画キャンバスを Pro モードに追加する。対象はガチのブックデザイナー
（sty を直接書く層）。装飾枠・コーナーオーナメント・二重罫・繰り返しボーダー等の装丁系描画が
主戦場。**汎用の描画表現力を持ちつつ、生成 TikZ は「プロが手書きしたのと同じ構造」を保つ**。

#### 設計判断（2026-08-13 決定）

- **正本は独自シーン JSON**。TikZ / 画像はそこから生成する（TikZ の逆パースはしない）。
- **挿入は 2 モード**: TikZ コード挿入（既定）と、コンパイル済み PDF を assets に保存して
  `\includegraphics`（既存 P2 画像化フローを流用）。
- **round-trip はコメント埋め込み**（quiver 方式）: 生成 tikzpicture の先頭に
  `%% tex64-figure: <base64 シーン JSON>` + シーン外コードのハッシュを埋め、そこから再編集。
  コメント以降が手編集されていたら detached 扱いで警告（マージはしない）。
- **キャンバス描画はハイブリッド**: ドラッグ等の操作中は自前 SVG 近似、操作確定・アイドル時に
  fermion-tex-engine で実コンパイルした見た目（プロジェクトのプリアンブル反映可）に差し替える。
  TikZ レンダラは自作しない。
- **スコープは制約しない**。座標スープ回避は語彙制限ではなく、下記の「構造を持った生成」で行う。

#### 綺麗な TikZ を保つための生成規則

- **シンボル（コンポーネント）**: オーナメント類は 1 回定義 → 変換付きインスタンス配置。
  TikZ では `\pic` 定義 + `\begin{scope}[...]` 変換に 1:1 対応。四隅の角飾りは座標を 4 回
  吐かず `xscale=-1` / `rotate` の鏡映・回転インスタンスで表現する。
- **パスに沿ってリピート** ツール（繰り返しボーダー用）: `\foreach` または
  `decorations.markings` に落とす。要素を N 回展開しない。
- 名前付きスタイルは先頭の `\tikzset` に集約。塗り/グラデは `\shade`（axis/radial）・
  patterns ライブラリのサブセットへマップ。
- フリーハンドベジェは `.. controls ..` のまま許容。オブジェクト単位でグループ化し
  コメントを付す。座標は精度を丸める（既定 3 桁）。
- **コードオブジェクト**: シーンモデルで表現できない任意の TikZ 断片をキャンバスに
  オブジェクトとして配置できる（fermion で描画、移動・変換のみ可、中身は不透明）。
  表現力の穴を塞ぐ恒久的な逃げ道。

#### ブックデザイナー向けの追加出力

- **.sty へのエクスポート**: シンボル/図を `\pic` 定義や `\NewDocumentCommand` として
  スタイルファイルに書き出せる（オーナメントライブラリを視覚的に構築 → sty で再利用）。

#### 実装フェーズ（C 系列）

1. **C1**: シーンモデル + キャンバス基盤（選択/変換・ペン・図形・テキストノード・
   名前付きスタイル）+ TikZ 生成 + コメント埋め込み round-trip + 画像化挿入。キャンバスは
   自前 SVG 近似のみ — **完了 (2026-08-13)**。詳細仕様は
   [pro-canvas-c1-spec.md](pro-canvas-c1-spec.md)。実装:
   `web-src/app/pro-canvas/{scene,tikz-generate,figure-codec,canvas-math,canvas-ui}.ts` +
   `tests/pro-canvas-*.test.mjs`。ノードの MathLive 入力（C1 では生 LaTeX テキスト入力）と
   レイヤ UI は C2 以降に送った。
2. **C2**: fermion 実コンパイル差し替え（操作中は近似、確定時に実レンダリング）—
   **完了 (2026-08-13)**。仕様: [pro-canvas-c2-spec.md](pro-canvas-c2-spec.md)。キャンバス専用の
   第2 fermion インスタンス + `tex64:fermion:canvas-render` IPC + Live トグル。実エンジンで
   E2E 確認済み（100mm 角 standalone が 283.46bp 角 PDF になることを実走検証）。
3. **C3**: シンボル/`\pic`・鏡映/回転インスタンス・パスに沿ってリピート・.sty エクスポート —
   **完了 (2026-08-13)**。仕様: [pro-canvas-c3-spec.md](pro-canvas-c3-spec.md)。リピートは
   弧長等間隔サンプリング（`samplePathPoints`）を `\foreach \p/\a` に展開。実エンジンで
   pic/foreach 生成コードのコンパイルを実走確認済み。
4. **C4**: コードオブジェクト・AI 経路（画像/下絵 → texize → コードオブジェクト）・
   SVG インポート — **完了 (2026-08-13)**。仕様: [pro-canvas-c4-spec.md](pro-canvas-c4-spec.md)。
   SVG は style="" インライン CSS も解釈。コードオブジェクトの scope 出力を実エンジンで
   コンパイル確認済み。

## texize ブリッジ

- 新規 `electron/services/texize.cjs`: texize のローカルインストール
  （開発時は `/Users/majinkuu/Desktop/texize`、設定でパス変更可）の Python を spawn し、
  画像 1 枚 → TeX 断片の変換を行う。既存 `electron/services/math-ocr/service.cjs` +
  `electron/handlers/` の IPC 配線パターンに合わせる。
- **常駐デーモン方式**（2026-08-12 調査）: texize は都度起動だと torch + PP-DocLayoutV3 の
  ロードで数秒かかるため、texize 側に stdio JSON-RPC の常駐サーバーエントリポイント
  （例 `python -m ocr2tex.serve`）を追加する（別リポジトリ作業）。リクエスト
  `{image(base64|path), translate?: lang}` → レスポンス `{tex断片, assets?}`。プリアンブルなしの
  断片のみ返し、コンパイルはしない。初回リクエスト時に遅延起動し、アイドルで自動終了。
- API キーは texize と同じ `OCR2TEX_API_KEY` 系統を尊重しつつ、アプリの設定 UI からも渡せるようにする。

## 実装フェーズ

1. **P1**: Pro モード切替 + 分割レイアウト基盤（レイアウト①②、リサイズ・折り畳み・永続化）— **完了 (2026-08-12)**
2. **P2**: 範囲選択キャプチャ → texize ブリッジ（TeX 化 / 翻訳 / 画像化 + 即挿入）— **完了 (2026-08-12)**
   - texize 側: `ocr2tex/serve.py`（stdio JSONL 常駐サーバー、texize リポジトリ）
   - main 側: `electron/services/texize.cjs` + `tex64:texize:*` IPC + `tex64:files:write-base64`
   - renderer 側: `web-src/app/pro-capture-ui.ts` + pdf-viewer.js の `capture-region`
3. **P3**: スタッシュトレイ + AI 一括編集 — **完了 (2026-08-12)**
   - `web-src/app/pro-stash-ui.ts`、AI は `completeSingleChat`（openprism run-loop から抽出）+ `tex64:ai:complete`
   - エディタ右クリックは monaco `addAction`（`tex64.pro-stash-add-selection`）
4. **P4**: syntax highlight 強化（expl3・embedded Lua）/ 構造ジャンプメニュー（`pro-structure-ui.ts`、Cmd/Ctrl+Alt+O）— **完了 (2026-08-12)**
5. **P5**: fermion-tex-engine ライブプレビュー統合 — **完了 (2026-08-12)**
   - エンジンは `/Users/majinkuu/Desktop/fermion-tex-engine`（`node server.js`、POST /edit + SSE /events + 内蔵ビューア、`TEX64_FERMION_ENGINE_DIR` で上書き可）
   - `electron/services/fermion-engine.cjs`（遅延spawn・空きポート選択・クラッシュ後再起動・quit時kill）+ `tex64:fermion:*` IPC
   - `web-src/app/pro-live-preview.ts`: プレビューペインの Live トグル + 専用 iframe + 300ms デバウンス。push は main 側が毎回 `/doc` でサーバー実テキストを取得してから全文置換を送るため再接続でずれない
   - CSP は `frame-src http://127.0.0.1:*` のみ追加（`connect-src` 不変、編集は IPC 経由）
6. **C1–C4**: 作図キャンバス（機能 6 参照）— **全フェーズ完了 (2026-08-13)**。
7. **D1–D3**: キャンバスのプロジェクト連動 — **完了 (2026-08-13)**。仕様:
   [pro-canvas-d-spec.md](pro-canvas-d-spec.md)。Doc トグル（root 文書のプリアンブルを
   standalone に verbatim 注入、失敗時は自動でプリアンブルなし再試行）、プロジェクト
   `\tikzset` スタイルの読み取り専用取り込み（`scene.styles` とは分離、.sty エクスポート
   非汚染）、二重罫（`double distance`）、X/Y/W/H 数値入力。root 検出は既存
   `WorkspaceManager.rootInfo()` を再利用し、`tex64:files:read-text`（2MiB 上限、
   `workspace.readFile` の既存ガードに委譲）を追加。
8. **G1–G3**: mathcha 系 UX 全面改修 — **完了 (2026-08-13)**。仕様:
   [pro-canvas-g1-spec.md](pro-canvas-g1-spec.md) /
   [pro-canvas-g2-spec.md](pro-canvas-g2-spec.md) /
   [pro-canvas-g3-spec.md](pro-canvas-g3-spec.md)。Codex と設計討議→実装→監査→差し戻しの
   ループで実施。選択モデル {ids, primaryId}・マーキー・複数移動/複製/ナッジ/整列/分配・
   重なり順・カーソル固定ホイールズーム・ホバー/Illustrator 級クローム・スマートガイド・
   寸法チップ・Shift 制約・ペンプレビュー・インラインノード編集（prompt 全廃）・
   パスアンカー編集。native dblclick は再描画で不安定なため pointerup ベースの自前
   ダブルクリック検出を採用。Esc はキャンバスを閉じない。
9. **E0–E2**: 対称オーナメント配置 + 図ギャラリー — **完了 (2026-08-13)**。仕様:
   [pro-canvas-e-spec.md](pro-canvas-e-spec.md)。対称シンボル化（鏡映ペア `tx=W, sx=-1`）、
   四隅配置（シンボル bounds + inset から 4 変換を導出）、`%% tex64-figure` ブロックの
   文書内ギャラリー（`gallery-ui.ts`、fermion 逐次サムネイル）。前提修正として
   `renderPdf` をサービス内 Promise キューで直列化（Live コンパイルとサムネイルの競合防止）。
10. **H1–H2**: chrome 修正 + 直線選択 + pgfplots グラフツール — **完了 (2026-08-13)**。仕様:
   [pro-canvas-h-spec.md](pro-canvas-h-spec.md)。H1a: topbar に hiddenInset 信号機ぶんの
   `padding-left: 84px` + `-webkit-app-region: drag`。H1b: パスの選択/ホバーは bbox でなく
   パス形状アウトライン、2 点直線は端点ハンドル直接ドラッグ（リサイズ 8 ハンドル・回転を抑止、
   anchorEdit なしで `kind:"anchor"` ドラッグ再利用）。H2: `plot` オブジェクト（pgfplots
   axis を 1 オブジェクトとして配置、G キー）。式は `plot-math.ts` の自前再帰下降パーサ
   （eval 不使用、trig は pgfplots 準拠の度単位）でキャンバス近似描画し、書き出しは
   `\begin{axis}` + `\addplot`。plot を含むシーンは standalone/.sty に pgfplots を自動追加、
   図ブロック先頭に `% requires:` コメント。ymin/ymax 空欄 = 自動レンジ。プロットの
   ドラッグ配置は draw 分岐（`scene=cloneScene(drag.before)` 巻き戻し）内で処理する
   （別リスナーでのシーン変更は毎ムーブ捨てられるため不可 — 監査で修正済み）。
11. **H3**: グラフ UX の mathcha 型全面改修 — **完了 (2026-08-13)**。仕様:
   [pro-canvas-h3-spec.md](pro-canvas-h3-spec.md)。Codex 実装 → Opus 5 サブエージェントの実走監査
   （辛口批評）→ 修正、の 2 周ループで確定。プロットをダブルクリックで編集モード:
   浮遊カード（関数リスト = 色チップ/式ライブ入力/目トグル/⋯詳細、＋関数追加はパレット自動配色、
   範囲行 + y 自動、軸線/グリッドセグメント、ヘッダドラッグ移動・✕/Esc で閉じる）。
   プロット上のホイール = 数学窓ズーム（カーソル基準、`zoomRange`）、ドラッグ = パン（`panRange`、
   メイン pointermove の `plot-pan` 分岐）。学び・ガード:
   - **i18n の MutationObserver は placeholder を初見値で凍結・書き戻す**。動的な数値 placeholder を
     持つ入力には `data-no-i18n` を付けること（範囲入力で実害が出た）。
   - pgfplots の `at={(x,y)}` は**単位必須**（`at={(10mm,10mm)}`）。単位なしだと picture の
     `x=1mm,y=1mm` が効かず原点付近に落ちる。`scale only axis` + `anchor=south west` で
     プレビューと軸枠が mm 単位で一致（参照矩形コンパイルで検証済み）。
   - 式が打鍵途中で不正な間は直前の有効曲線を淡色保持しレンジを維持（`plotPreviewCache`）。
   - ライブ編集の undo は「初回 input で即 push」+ ホイール undo は pointerdown/入力開始で
     即時確定（時系列が壊れないように）。
   - カード系列行の淡色化クラスは `is-muted`（グローバル `.is-hidden{display:none!important}` と
     衝突するため `is-hidden` は使わない）。
12. **H4**: 数式 WYSIWYG 入力・系列種別・凡例・ナイス吸着 — **完了 (2026-08-14)**。仕様:
   [pro-canvas-h4-spec.md](pro-canvas-h4-spec.md)。Codex 実装 → Opus 実走監査（Round 3）→ 修正。
   `plot-math` を AST 化（`parseExpr`/`compileAst`/`astToPgf`、`compileExpr` の署名・度単位
   セマンティクスは不変）。`plot-latex.ts` が MathLive LaTeX ⇄ pgfplots 式を AST 経由で双方向変換
   （`\sin(u)` ⇄ `sin(deg(u))`、逆三角は `rad(asin(u))`、変換不能は null → テキストモード固定）。
   系列種別 fn/媒介変数/極座標/点列（極座標は媒介変数形に展開、点列は `coordinates`+only marks）。
   カードの式入力は `<math-field>`（⌨ トグルで生テキストと切替）。凡例のキャンバスプレビュー、
   ホイール終了時のナイス吸着（格子 = 目盛りステップ/10）、`axis equal` チェックボックス。
   学び・ガード:
   - **カード内 math-field は shadowRoot への style 注入が必須**（blocks/mathlive.ts と同じ）:
     仮想キーボード/メニューボタンを消し、`.ML__content{overflow:visible}` で分数クリップ回避。
     `::part()` だけでは `.ML__content` に届かない。`menuItems=[]` でコンテキストメニュー無効化、
     ダーク配色は `--caret-color`/`--selection-*` で指定。
   - `/` キーは capture 段で横取りし `extendSelectionBackward` → `\frac{#@}{#?}` 挿入
     （bubble 段だと MathLive 内部処理と二重発火する）。
   - **fn 系列はパース不能でも raw パススルー**（pgfplots の上位構文を制限しない。
     媒介/極座標は変数リネームが必要なため skip + コメント）。
   - 凡例・軸ラベル・タイトルは出力時に `%#&` をエスケープし、`^ _` を含む非 `$...$` は
     数式ラップ（`y=x^2` が Missing $ でビルドを落とすのを防ぐ）。
   - 動的 title を持つボタン（⌨ トグル）にも `data-no-i18n`（i18n は title 属性も凍結する）。

13. **スタイリング UX（H6, 2026-08-14）** — 塗り/編みかけ/グラデ/カラーウェル・矢印第一級化・複数選択スタイル適用（`docs/pro-canvas-h6-spec.md`, Codex 実装 + 監査2ラウンド）。恒久 gotcha:
   - **TikZ の `crosshatch` は斜め格子**（NE+NW の重ね）。`grid` が縦横。実コンパイルで確認済み — プレビュー/アイコンを縦横にすると「選んだものと違うものが出る」。
   - **下地色 + pattern の併用は `preaction={fill=...}`**。同一オプション列に `fill=` と `pattern=` を並べると pattern が fill を置き換えて下地が消える。
   - shading 時のコマンドは draw なし → `\shade`、draw あり → `\draw[shade,...]`。`\fill`+`shade` は不可。fill は shading 時に出さない。
   - **SVG プレビューは y 反転レイヤー内**なので `linearGradient` は `y1=0%→y2=100%` で stop0=bottom（objectBoundingBox の y0 が画面下）。`rotate(+angle)` が TikZ `shading angle` と一致（0°/45° を pdflatex と突き合わせ済み）。
   - カラーポップオーバーは**インスペクタの左側**に開く（下に開くと後続のウェルを覆い、stopPropagation でクリックを食う「無反応 UI」になる）。
   - ペン曲線の第1セグメントは c1 が始点と同一に退化する。**矢頭の接線は c1 → c2 → to のフォールバック**で取る（pgf と同じ）。
   - undo/redo は `retainSelection()`（生存オブジェクトの選択を維持）。無条件 clearSelection に戻すと「戻して見比べる」のたびにパネルが消える。
   - 塗りモード切替の設定は `fillMemory`（セッション内 Map）にスタッシュ。scene には残さない（emit 精度に影響させない）。
   - 監査残（未対応・次スプリント候補）: 両端別チップの混在表示（中4）/ ポップ dismiss クリックの素通り（中7）/ 開いたパスへの塗り行表示（中9）/ プレビューとコンパイルのパターン密度差（軽微4）/ `rx`・`viewBox` のコンソールエラー原因未特定（軽微7）。

14. **初見オンボーディング + エラー掃討（I1, 2026-08-14）** — `docs/pro-canvas-i1-spec.md`（Codex と討議して確定）。Opus 監査 → ゲート 6 件修正済み。恒久 gotcha:
   - **図の挿入位置は `insert-plan.ts` の純粋関数で決める**。初見ユーザーはエディタを一度もクリックしないのでカーソルは 1:1 のまま = プリアンブル内。素直に挿すと `\documentclass` の前に入って文書が壊れる。プリアンブル内なら `\end{document}` 直前へ回し、不足パッケージ（tikz / usetikzlibrary / pgfplots+compat）を `\begin{document}` の前に足す。**判定はコメント除去後**に行う（`%\usepackage{tikz}` を「有る」と誤判定する）。
   - **ヒントバーは描画ツールを選択より優先**。何か描くと選択が残り続けるため、選択優先だとツール説明が実運用でほぼ出ない。かつ select 専用機能（ダブルクリックでの頂点編集）を他ツール中に案内すると嘘になる。
   - **一回限りのヒントは「実際に読める状態で出たか」で消費する**。`showCoach` 時点で localStorage に書くと、ドラッグ中や直後に閉じる瞬間に使い切られて二度と出ない。1.5 秒表示されてから永続化し、ドラッグ中・select 以外・カードを閉じた直後は出さない。
   - node は bounds が点なので、吹き出しはグリフに重なる。上へ逃がす（lift 22px）。
   - 空状態のボタンは「描き始めたい場所」に居るので、描画ツール中はパネルごと隠す（`pointer-events:none` だけだと見えている死にボタンになり、次のクリックを奪う）。
   - キャンバス上の文字は**白い用紙に重なる**前提で色を決める（半透明背景だと 2.7:1 まで落ちる）。ヒントバー・空状態の説明は不透明背景を敷く。
   - 初回コンパイルの実測は約 40 秒（TeX エンジンの起動）。**具体的な秒数を約束しない**。進行中コンパイルを `invalidateCompiled()` で捨てるときはチップも畳む（でないと「コンパイル中…」で固まる）。
   - エディタ既定フォントは同梱の **Latin Modern Mono**（`Resources/web/fonts/`, GUST Font License）。`\texttt` と同じ書体。等幅性は実測済み（i/m とも同幅）。
   - renderer の CSP は `script-src 'self' 'unsafe-eval'`。**index.html にインラインスクリプト・インライン `onload`/`onerror` を書いても実行されない**（`mathlive-ready` が永久に発火しない事故があった）。外部 js から capture 段の load/error で拾う。
   - 監査残（未対応）: 用語ゆれ（グラフ/プロット・系列）/ node 入力欄に placeholder なし / `Cmd+A` 未実装 / 空キャンバスでも `コンパイル中…` が出る / インスペクタ空文言の位置。

15. **Illustrator 式ペン + desmos 式グラフ挿入（J, 2026-08-14）** — `docs/pro-canvas-j-spec.md`、Codex 実装 + 監査1ラウンド（ゲート3+推奨4を修正）。恒久 gotcha:
   - ペンの曲線は `penSegmentFor(prev,lastOut,anchor,handle)`（純関数・テスト済み）。**前アンカーの出ハンドルを c1 に継承**するのが肝で、これが無いと全セグメントが「直線で出て曲がって入る」半端な曲線になる。アンカーはスナップ・ハンドルは生座標。
   - **pen 状態はシーン配列への参照を持つ**。undo/redo・ツール切替で scene が差し替わったら `abortPen()` しないと、以後のクリックが死んだオブジェクトへ無音で吸われる（ゾンビ化）。
   - プロットの「空」判定は **kind ごとの実フィールド**で（parametric は expr2、points は points）。expr だけ見ると y(t) のみ入力した図を Esc が履歴ごと消す（データ消失）。
   - math-field を**空にした**ときは `series.expr=""` を明示的に書き戻す。`latexToExpr("")` は null なので放置すると「消したはずの曲線が残る + 空欄に赤エラー」になる。
   - 空の式は全種別で「未入力（valid・曲線なし）」。エラーは「書いて解釈できない」ときだけ。種別切替でプレースホルダ式を注入しない。
   - 空の式は**数式モードで開始**する（テキストモード開始だと初見の `sin(x)` が pgf の度数法でほぼ平坦な線になる罠）。
   - 監査残（未対応・軽微）: 1点ペン破棄後の空振り undo エントリ / Alt+クリック往復でハンドル既定値化。（「閉路が必ず角」「閉パス始点アンカー重複」は K で解消済み）

16. **曲線の見える化・直接編集・真の境界・自動スムース（K, 2026-08-14）** — `docs/pro-canvas-k-spec.md`、Codex（terra）実装 + Claude が配線を補完。恒久 gotcha:
   - **パスの境界は `pathTightPoints`（ベジェ微分の根から実インクの extents）で計算し、`allPoints` は使わない**。ただし `allPoints` は rotate/resize が「返された Vec 参照を直接変異させる」ための収集器なので**削除・変更しない**。境界（objectBounds）だけ tight 側を使う二本立てが正解。
   - ペンは `PenNode`（auto/corner/manual）列 + `buildPenSegments(nodes, closed)` の**全再構築**方式。クリック=auto、Alt+クリック=corner（**Alt でも吸着は維持**）、ドラッグ=manual（対称ハンドル）。auto 接線は **centripetal Catmull-Rom（α=.5）+ 開パス端は自然境界条件** — 一様版は不均一間隔で overshoot→ループするので戻さない（`tests/pro-canvas-curves.test.mjs` に L 字回帰テスト）。
   - **描画中のプレビューはゴースト線ではなく、シーン上のパス自体を「カーソルを仮 auto ノードに含めた provisional 形状」で描く**（draw() で pen.path のみ差し替え）。ゴースト併記は確定 ink と二又に見える（監査実測 2.37mm）。始点近傍では closed ビルドで「閉じたらこうなる」を予告。カーソル=最終アンカー同一点のときは仮ノードを足さない（重複ノードで偽セグメントが生える）。
   - **ペンの Esc は Enter と同じ「確定」**（破棄ではない）。中途半端な「確定するが未選択・ツール pen のまま」は UX が壊れる。
   - **pointer capture 中の pointerup は e.target が svg になる**。ダブルクリック系の判定を `closest("[data-id]")` に頼ると突然壊れる。頂点追加は「未移動の bend クリック（pointerdown 時点で nearestOnPath 済み）」で判定する。
   - セグメント曲げは最小ノルム解 `bendSegment`（w1=3(1−t)²t, w2=3(1−t)t², Δc=Δ·w/(w1²+w2²)）で **B(t) がちょうどマウス分動く**。t は [.15,.85] に clamp（端は発散）。line は曲げる前に 1/3-2/3 で cubic 化。
   - ミラーは **pointerdown 時に共線判定して drag に記録**（isMirrorPair、cos<−cos10°）。動的に判定すると折った直後のハンドルが勝手に貼り付く。Alt 押下中は解除。反対側は**自分の長さを維持**（Illustrator 準拠）。
   - 選択見た目: パスは曲線沿いアウトライン + アンカードット + **四隅のみの丸グリップ**（is-path-corner）。8 個の正方形は他タイプ専用。ヒット判定クローン（pro-canvas-hit）は data-id を複製するので DOM を数える検証では `:not(.pro-canvas-hit)`。
   - finishPen（Enter/閉路/同一点）は **select ツールへ戻して即 anchorEdit に入る**（plot 配置と同じパターン）。描いた直後に曲げ位置が全部見える。
   - 頂点編集の Delete は**オブジェクト削除より先に**アンカー削除として横取りする（キーハンドラの分岐順が仕様）。selectedAnchorIndex の clamp は **closed で `segments.length-1`**（closed は末尾アンカー非表示のため。`segments.length` まで許すと Delete 連打で removeAnchor が false を返しパスごと消えるデータ損失になる — Opus 監査で実証済み）。
   - Opus 監査残（未対応・優先度低）: 縦一直線パスは幅 0 で四隅グリップが 2 点に潰れ横に伸ばせない / 描画中 Cmd+Z が全点破棄（competitor は 1 点ずつ）/ auto ノードの out ハンドルは opacity .45 のまま（lastOut は manual のみ）/ 頂点編集中にオブジェクト自体を消すには Esc が先に要る / アンカー座標の数値編集・パス結合/切断・simplify なし（競合比較ギャップ）。

17. **選択した曲線の制御点 / 挿入コードのコメント 1 行化（L, 2026-08-14）** — `docs/pro-canvas-l-spec.md`。ユーザー指摘「選択しても制御点の操作表示が出ない」「挿入されるソースにおびただしい数のコメントアウトが入る」への対処。恒久 gotcha:
   - `anchorEdit` は**モードではなく選択の派生状態**（`{pathId, deep}`）。`render()` 先頭の `syncAnchorEdit()` が「単一パス選択 ⇔ anchorEdit あり」を常に一致させる。手で `anchorEdit=null` を書いても次の render で復活するので、状態を切りたいときは**選択を変える**か `deep` を落とす。
   - **レベル1（選択）＝表示と頂点・ハンドル操作、レベル2（`deep`, ダブルクリック）＝曲げ・頂点追加・頂点削除**。この線引きが命で、bend をレベル1に降ろすと**線だけの図形をドラッグで移動できなくなる**（線の上しか掴む場所が無いため）。同様に Delete をレベル1で頂点削除にすると「選んで Delete でオブジェクトを消す」が壊れる。両方 `anchorEdit?.deep` でゲートしている。
   - `syncAnchorEdit` は **`tool==="select"` を条件にしない**。線/矩形ツールは描いた後もツールが切り替わらないため、条件に入れると「描いた直後に頂点が見えない」退行になる。掴めるかどうかは pointerdown 側の `tool==="select"` が担保する。
   - 直線パス専用の頂点描画（`dataset.pathId` 経由）は廃止し、アンカーレイヤに一本化。`pro-canvas-path-dot`（飾りドット）も廃止。
   - 図の埋め込みは **v2 = `%% tex64-figure v2 h=… <base64>` の 1 行**（数値 6 桁丸め → 自前 LZSS → base64、チャンク分割なし）。旧 v1（`%% tex64-figure+` の 100 文字チャンク）は**復号のみ維持**し、開いて保存し直すと v2 に縮む。実測で 40 セグメントの曲線が 95 行 → 1 行。
   - 丸めは **6 桁**。3 桁だとプロットの `domain`（例 6.28319）などユーザーが打った値が書き換わる。圧縮率より安全側を取る。
   - `% requires …` 行は**挿入ブロックから除く**（`planFigureInsert` がプリアンブルに `\usepackage`/`\usetikzlibrary` を自動追加するので重複）。`generateTikz` 自体は変更しない（standalone プレビューが自前で剥がす既存実装 + 既存テストがある）。
   - **`removeAnchor` の `false` は「退化した」と「index が範囲外で何もしなかった」の両方を意味する**。呼び出し側（Delete）は false をパス削除と読むので、範囲外の `selectedAnchorIndex` を渡すと**曲線が丸ごと消える**。`syncAnchorEdit` が毎 render で `Math.min(idx, closed?n-1:n)` にクランプすることで範囲外を作らない（頂点追加 → undo で範囲外になる経路を Opus 監査が実証。`tests/pro-canvas-curves.test.mjs` に契約テスト）。
   - 描画ツール中は選択中パスのアンカー層に `is-inert`（pointer-events: none / opacity .5）を付ける。掴めるのは select ツールのときだけなので、掴めるように見せない。
   - Opus 監査残（未対応・K から継続）: 縮む undo（削除・パス消滅）でセレクションが復元されない（競合は復元する）/ ペンの 1 ストロークが undo 1 単位（Illustrator はクリック 1 点ごと）/ 全頂点のハンドルを同時表示する（競合は選択頂点のみが既定）/ v2 の 1 行は 400 セグメントで約 16,600 文字となり Monaco 既定の `stopRenderingLineAfter`（10,000）を超えて後半が描画されない（デコードは正常。M でメタデータ行自体を隠したので見た目には出ない）。

18. **矢頭の実物合わせ・挿入先・メタデータ行の畳み込み（M, 2026-08-15）** — ユーザー指摘 4 件（矢印の先端が変 / 挿入先がカーソルでない / 長いコメント / 「矢印を描く」の文言）への対処。恒久 gotcha:
   - **矢頭の寸法は推測しない**。`web-src/app/pro-canvas/arrow-math.ts` の係数は、`\draw[line width=W, -{Tip}] (0,0) -- (2,0);` を 0.4/0.8/1.0/1.5/2.0pt でコンパイルし、`pdftocairo -svg` で PDF のパス座標を取り出して最小二乗で `寸法 = 定数 + 係数 × 線幅` に当てた**実測値**（残差 ≤ 0.003pt）。触るときは同じ手順で取り直し、`tests/pro-canvas-arrow-math.test.mjs` の REFERENCE も更新する。
   - **TikZ の矢頭は「塗り」だけでなく「同じ線幅での縁取り」も掛かる**。縁取りを省くと線幅 1pt で矢頭が線とほぼ同じ幅になり、ユーザーには「先端のレンダリングが壊れている」に見える（実際の初期報告がこれ）。SVG 側も fill + stroke（miter, miterlimit 10）で描く。
   - **見た目の先端＝パスの端点**。多角形の先端は縁取りのマイターぶん（`(線幅/2)/sin(先端半角)`、Bar は線幅/2）手前に置く（`backset`）。ここを 0 にすると矢印全体が端点より前へ 1.4pt はみ出す。
   - **線は矢頭の手前で止める**（`trim` = backset + 多角形先端からの距離）。止めないと Stealth の切り欠きが線で埋まる。曲線は `trimPathForArrows` が de Casteljau で分割するので**元の曲線の上に載ったまま**縮む（TikZ 自身の短縮は近似で、曲線中央が最大 0.15mm ズレる。ズレているのは TikZ 側）。
   - 挿入先は**キャンバスを開いた瞬間の編集タブとカーソル**に固定（`anchorEditor` / `anchorPosition`）。閉じるまでに別グループがアクティブになっても、ユーザーが見ていた場所に入る。
   - カーソル位置に入れられないのは 2 通り: プリアンブル（`\begin{document}` 以前 → `\end{document}` 直前へ）と**図を入れられない環境の中**（tikzpicture・数式・verbatim 系 → その環境の直後へ）。`%% tex64-figure` の行は次の tikzpicture と 1 組として扱う。判定は `insert-plan.ts` の純関数。
   - 落とした場所は**必ず見せる**（`showInserted`）: カーソルをブロック内に移し、行を 2.2 秒光らせる（`.pro-canvas-inserted-line`）。移動したときだけ `revealLineInCenter` で強制的に中央へ送る。PNG 挿入も同じ経路。
   - メタデータ行は消せない（シーン実体）ので**エディタ上だけ畳む**（`figure-meta-chip.ts`）。`inlineClassName` で base64 を `display:none`、`beforeContentClassName` の CSS `content` でチップを 1 個だけ出す。**`textContent` には残る**ので、検証は要素幅（隠し span の幅が 0）で見ること。折り返し（wordWrap）を入れても 1 行のままなのは、Monaco が実描画幅で折り返しを決めるため。
   - **グリッド吸着は磁石式**（`snapToGrid` の `pull`、既定 `GRID_PULL=.25`）。全点が格子に乗る絶対吸着だと「格子に沿わない線が引けない」になる。軸ごとに独立して判定する。Alt での一時解除はツールチップだけでなく**ヒントバーにも出す**（知られていなければ無いのと同じ）。ペンの Alt は角ノードなので吸着解除には使えない（意図的な例外）。
   - **ペンの印は `pen` ができる前から出す**。1 点目をドラッグしている間は `pen` がまだ null（`penDrag` だけ）なので、`if(pen)` で描いていると「引っ張っている最中だけ制御点が見えない」。描画条件は `pen||penDrag||(tool==="pen"&&penCursor)` で、`pen` 依存の参照は全部オプショナルにする。次の頂点が落ちる位置は点線の丸で常時予告する。
   - **端点から続きを描く**（`penSeedFromEnd` + `pen.base`）。既存セグメントは `base` として手前に残し、後ろに足すだけ。`buildPenSegments` はノード列から全再構築するので、既存パスをノードに戻して作り直すと**非対称ハンドルが潰れて曲線が歪む**。始点側を掴んだときは `reversePath` で向きを揃え、見た目を保つため矢頭も入れ替える。
   - **pointer capture 中の pointerup は `e.target` が svg になる**（K の gotcha の再来）。頂点ダブルクリックでの削除は `e.target.dataset.anchorIndex` ではなく、pointerdown 時に記録した `drag.anchorIndex` から取る。
   - ＋−の予告は**実際に効く操作とだけ**結びつける（追加の当たり判定 8px はダブルクリック側と同じ値、削除は退化しない場合のみ）。印を出しておいて効かないのが一番たちが悪い。
   - `display: grid` のモーダルは、行トラックが `auto` のままだと **`max-height` を突き抜ける**（`auto` トラックは min-content より縮まない。中の要素に `min-height: 0` を書いても効かない）。伸びる行に `minmax(0, 1fr)` を与える。図ギャラリーがこれで「閉じる」ボタンごと画面外へ流れていた。

19. **初見ユーザー視点の実走監査（N, 2026-08-16）** — 「開発者でない初見の人が画面だけを見て使えるか」を
   `tests/e2e/pro-mode-flow.test.cjs`（Playwright `_electron`、実マウス座標・実キー入力）で全操作を通しながら詰めた。
   恒久 gotcha:
   - **i18n のソース言語は英語で、既定ロケールは `en`**（`initI18n()` は `stored ?? "en"`。モジュール初期値の
     `let currentLocale = "ja"` は `initI18n()` 前の値でしかない）。つまり **DOM に直接書いた日本語は
     どのロケールにも翻訳されず、かつ既定ユーザーには言語違いとして出る**。Pro モードの renderer には
     こうした日本語リテラルが 190 個あり、新規プロファイル（＝全員）が日本語だけの作図キャンバスを見ていた。
     追加する UI 文言は必ず `uiText("English", "日本語")`（`pro-stash-ui.ts` と同じ規約）。
   - **`uiText` はモジュールトップレベルで評価しない**。`initI18n()` より先に走るとロケールが固まる。
     定数にしたいときは `const label = () => uiText(...)` と関数にする。
   - **CSS の `content:` は翻訳パスが届かない**。図メタデータのチップ（`figure-meta-chip.ts`）はラベルを
     `--tex64-figure-meta-chip` カスタムプロパティに publish し、CSS 側は
     `content: var(--tex64-figure-meta-chip, "…")` で受ける。`onUiLocaleChange` で貼り直す。
   - **文字列リテラルを機械的に置換するときは「表示文字列」以外を巻き込まない**。`Record` のキー・
     `dataset` 値・比較対象は置換してはいけない（キーが表示文字列と同一なら `[uiText(...)]:` の
     計算プロパティにする）。`innerHTML` テンプレート内の属性は
     `title="${uiText(...)}"` と `${}` ごと書く（クォートを食うと属性値が壊れる）。
   - **スタッシュトレイは畳んだ状態で始める**（`parseProStashUiState` の既定 `collapsed: true`）。
     開いた状態は 340px のパネルがエディタ右下に浮き、初回起動でまさにキャンバスが挿入したコードを覆っていた。
     畳めば名前と件数だけのピルになり、隠さずに見つけられる。
   - **空のシーンはコンパイルしない**（`compileNow` の早期 return）。組む物が無いのに「コンパイル中…」の
     チップだけが出て何も起きない、という I1 監査残の再現だった。
   - 左ツールレールは 32px 幅で `text-overflow: ellipsis`。**5〜6 文字を超えるラベルは `Rect…` と切れる**ので、
     レールは短縮名・ツールチップにフル名を置く。
   - レイアウト切替の `①` `②` は初見で意味が取れない。トップバーの他のレイアウトトグルと同じく
     **分割の形そのものを描いた SVG** にした（言語にも依存しない）。

- renderer は `web-src/`（TypeScript, バンドラなし, plain tsc）。`Resources/web/**/*.js` は生成物なので手で編集しない。`Resources/web/index.html` は手編集対象。
- monaco は AMD グローバル。バンドル前提ライブラリを持ち込まない。
- renderer のみの変更は Cmd+R で反映。main プロセス（`electron/*.cjs`）は Electron 再起動。
- 型チェック: `tsc -p web-src/tsconfig.json`。テスト: `node --test tests/`。
