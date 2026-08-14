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

- renderer は `web-src/`（TypeScript, バンドラなし, plain tsc）。`Resources/web/**/*.js` は生成物なので手で編集しない。`Resources/web/index.html` は手編集対象。
- monaco は AMD グローバル。バンドル前提ライブラリを持ち込まない。
- renderer のみの変更は Cmd+R で反映。main プロセス（`electron/*.cjs`）は Electron 再起動。
- 型チェック: `tsc -p web-src/tsconfig.json`。テスト: `node --test tests/`。
