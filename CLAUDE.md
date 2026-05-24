# TeX64

Electron ベースの LaTeX エディタ（macOS、開発中 / `com.wedd.tex64`）。数式執筆体験と AI 支援（Axiom）を中心に据えた製品。素人でも迷わず使える「完成度の高い自己完結アプリ」を最優先する。

このファイルは恒久的な設計方針と作業規約。直近のタスクキューは [TODO.md](TODO.md) にある（セッション開始時に確認）。

---

## アーキテクチャ

3層構成。それぞれ役割と技術スタックが異なる。

1. **Electron main プロセス** — `electron/`（すべて `.cjs`、ESM ではない）
   - `electron/main.cjs` がエントリ。`services/` が機能本体、`handlers/` が IPC 配線。
   - latexmk / tlmgr / texlab / ターミナル等の外部プロセスをホストし、ファイル I/O・ビルド・LSP・OCR・AI エージェントループを担う。
2. **Renderer（UI）** — `web-src/`（TypeScript）→ `Resources/web/` に出力
   - プレーンな `tsc` でコンパイル。**バンドラは使わない**（`web-src/tsconfig.json`、出力先 `../Resources/web`）。
   - **monaco は AMD グローバルとしてロード**（`window.monaco` を `require(['vs/editor/editor.main'])` で取得）。npm import ではない。
   - `Resources/web/` には monaco / MathLive fork / pdfjs / tesseract 等を vendored 配置。`index.html` が renderer の起点。
3. **サーバー（tex64.com）** — `api/v2/`（Vercel、`vercel.json`）
   - AI は **OpenAI 互換プロキシ1本のみ**: `api/v2/ai/openai/chat/completions.js`。
   - ほかは認証（`auth/`・`_lib/`）と `me/features`・`me/usage/ai`（利用枠の照会）。

### 触る前に守る制約

- renderer の言語機能（補完・定義・参照・rename）は monaco のグローバル provider API に登録する。`monaco-languageclient` 等のバンドル前提ライブラリを持ち込まない（既存の AMD グローバル構成と衝突する）。
- TS を編集したら `Resources/web/**/*.js` は `tsc` の生成物。手で `.js` を編集しない。renderer のみの変更は **Cmd+R リロード**で反映（Electron 再起動不要）。
- main プロセスの `.cjs` を変更したら Electron の再起動が必要。

---

## コマンド

```bash
npm run dev              # 開発（tsc watch + electron） scripts/dev.cjs
npm run electron:dev     # web:build 後に electron 起動
npm run electron:dev:fast# 再ビルドせず electron 起動（main は既ビルド前提）
npm run web:build        # math:check → mathlive:build → tsc（renderer 一式）
npm run web:watch        # tsc -w（renderer のみ素早く回す）
tsc -p web-src/tsconfig.json   # renderer の型チェック/コンパイル単体

npm run mathlive:rebuild # MathLive fork を clean → build（fork を触ったら）
npm run texlab:fetch     # texlab バイナリを取得（sha256 ピン留め）
npm run electron:dist:mac# macOS 配布物（.dmg）をパッケージ

node --test tests/        # テスト（node:test。*.test.cjs / *.test.mjs）
```

- テストは `node:test`。`tests/` 直下の単体に加え `tests/e2e/`・`tests/nightly/` がある。
- ロジック変更は `node:test` で担保できる。UI の見た目は別（後述「検証」）。

---

## ディレクトリ構成（要所）

- `electron/services/openprism/` — AI エージェントループ（`run-loop.cjs` / `tools.cjs` / `llm-config.cjs` / `arxiv-service.cjs`）。
- `electron/services/agent-*.cjs` — エージェントのプロンプト・ツール実行・編集安全ガード（`agent-tools-file.cjs` に編集の決定的ガード）。
- `electron/services/env.cjs` — managed TeX 環境のインストール（`buildInstallProfile` = `scheme-full`）。
- `electron/services/texlab/` — texlab プロセスの spawn と JSON-RPC over stdio の中継。
- `electron/services/{build,synctex,spell,math-ocr,terminal,indexer,search}.cjs` — ビルド / SyncTeX / スペル / 数式OCR / ターミナル / 索引 / 検索。
- `web-src/math/wysiwyg/` — 数式 WYSIWYG サジェスト（コア機能）。`triggers-data/manual-part-*.ts` がトリガー辞書。
- `web-src/math/fork/` — MathLive fork（`tsc` の対象外、専用ビルド）。
- `web-src/app/lsp/` — 自作の軽量 LSP クライアント（monaco グローバル provider へアダプト）。
- `web-src/app/ai-chat-*.ts` — Axiom チャット UI / コンテキスト構築 / 提案・差分。
- `web-src/app/editor-session/` `blocks/` — エディタセッション管理、数式ブロック入力。

---

## サブシステム別の設計思想

### 数式入力（MathLive + WYSIWYG サジェスト）

数式入力 UI を触るときは必ずこの不変条件を守る。

- **WYSIWYG サジェストがコア機能**。これだけで十分という思想で、余計な設定 UI・オプションは持たない。
- **IME モデル**: 打鍵 → 候補表示 → Tab で遷移 → Enter で確定・挿入。確定はトリガー（未確定バッファ）の置換であって、**MathLive 内の既存の数式構造には一切影響を与えない**。確定後の再変換は不可（消して打ち直す）。
- **任意の LaTeX 数式を入力できること**。アプリが入力可能な数式を制限しない。`\` キーは横取りせず MathLive にそのまま渡す。`inlineShortcuts` は意図的に空（WYSIWYG が代替）。
- **IME モデルの意図的な例外**（これらは仕様）:
  - 選択範囲に対する操作（`/` で選択を `\frac{}{}` にラップ等）。
  - 行列の Enter（行追加）/ Ctrl+Enter（列追加）。
  - `\label{}` 等 aux command の環境外への自動ホイスト（LaTeX 仕様上環境内に書けないため）。
  - `&` / `\\` を含む式の `aligned` 暗黙ラップ（MathLive 内部表現とのアダプタ。読み取り時に剥がし、出力時に挿入フォーマットへ再ラップ）。
- **トリガー辞書**: LaTeX 標準コマンド名に忠実なトリガーのみ。パック概念・英語エイリアス・日本語ローマ字トリガーは廃止。トリガー名と同名のコマンドを最優先（例 `inf` → `\inf` > `\infty`）。
- **タイムアウトは持たない**。ゆっくり打っても候補は出続けるべき。確定したければ Enter。
- **既に削除済み**で復活させないもの: 数学キーボード UI、設定モーダルの Suggestions ページ、WYSIWYG パック設定 UI、`\` キー横取り。
- gotcha: MathLive の Shadow DOM で `.ML__content` に `overflow: visible !important` が必須（分数描画が vlist のため、`hidden` だと上端がクリップされる）。

### AI エージェント Axiom

- **「Agent Mode」という製品概念は存在しない**。AI が（ツールで）ファイル編集・コンパイル・検索するのは通常機能。プラン別の「Agent 権限ティア」は作らない。
- **サーバー側 AI は OpenAI 互換プロキシ1本のみ**（`api/v2/ai/openai/chat/completions.js`）。サーバーサイド agent・Gemini・複数 AI エンドポイントは撤去済み。**再導入しない**。
- **エージェントループ（複数ステップ・ツール実行・承認）は Desktop ローカル**（`electron/services/openprism/run-loop.cjs`）。Desktop がツールをホストしプロキシを呼ぶ。
- **ユーザー向けモデルは2つ**: `Axiom0.9.1`（全プラン）/ `Axiom0.9.1-pro`（**Pro 限定**）。上流の実モデル名・実価格はサーバー内部のみで**ユーザーに出さない**。
- 改善の方向性（確定）:
  - **LaTeX/数式ドメインの超機能を最優先**（自然言語→LaTeX、画像/PDF→LaTeX）。インライン編集（Cmd+K 等）は後回し。
  - **ゴーストテキスト自動補完は却下**（全打鍵発火＝コスト/遅延）。**再提案しない**。
  - **自律性は 9:1**: エラーは自動修正、数式・文章はほぼ自律で書き、本当に曖昧なときだけ1問だけ聞く。
  - 添付は画像と PDF の両方（PDF は vendored pdfjs でページを画像化し image_url 経路で送る）。
  - コンポーザに先回りのクイックアクション・チップ/ボタンを足さない（「邪魔」として全面削除済み）。
- 編集の品質ガード: ビルドエラー修正で「該当行を消さず隣で置換→重複」する癖は `agent-tools-file.cjs` の決定的ガード（`findIntroducedAdjacentDuplicate`）で対処済み。プロンプト調整だけで潰そうとしない。
- AI が複数箇所/複数ファイルを編集したときの差分表示は、**単一編集と同じ Monaco 差分エディタをファイルごとに生成して縦に並べる**（`showMultiFileDiff`）。自前 HTML の side-by-side レンダラは全廃済み。再導入しない。

### 課金（重要・厳守）

- **内部の使用量計算はドル（実コスト・OpenAI への実支払額）**。月額ドル予算から消費し、到達で停止（内部値: Free $1 / Basic $4 / Pro $15）。
- **⚠️ ユーザーに見せるのはトークン量のみ**。ドル予算・実コスト・モデル別単価・利益率など**内部の金額を一切表示しない**（使用量メーター・課金 UI・docs/pricing・API レスポンス全て）。`/me/features`・`/me/usage/ai` の quota は token のみ返す。
- ユーザー向けトークン表示は予算のブレンド換算の概算（Free ≈200,000 / Basic ≈800,000 / Pro ≈3,000,000 tokens/月）。

### TeX 環境（managed install）

- **ワンクリックで `scheme-full`（CTAN 全部）を一括導入**する方針で確定。「軽量化」「scheme-small＋オンデマンド」「段階導入」を**蒸し返さない**。
- 思想: 複雑さゼロで押すだけ、を最優先。速さ/容量より one-click simplicity。長い待ちは「実 % の進捗バー（install-tl/tlmgr の `[n/m]` を解析）」で許容される — **進捗の見せ方を磨く**のが仕事。
- 実体は `electron/services/env.cjs`（`/Users/Shared/TeX64/texlive/<year>` へ管理者権限なしで導入）。

### texlab LSP

- texlab（GPL-3.0）を**別プロセス**として spawn（リンクしないので TeX64 本体に GPL 影響なし）。バイナリは per-arch で `Resources/texlab/` に bootstrap 取得＋sha256 ピン、**gitignore**（コミットしない）。NOTICE.md に帰属。
- **自作の LSP クライアント**（`web-src/app/lsp/`）で protocol を処理し monaco グローバル provider にアダプト。main 側 `electron/services/texlab/` は stdio 中継のみ。
- command/ref/cite/definition/references/rename は texlab 経由。**ただし custom hover・プロジェクト全体の index/outline は KEEP**（texlab の documentSymbol は per-file、hover は素の markdown。TeX64 の hover は数式プレビュー・画像サムネ・.bib/ファイル抜粋を出す）。LSP hover は重複回避のため意図的に未登録。
- model に `file://` URI を持たせる（`ensureModelEntry`）— texlab のクロスファイル解決に必須。戻さない。

### Gallery（隠してある・削除ではない）

- Gallery はユーザー向けに**隠してある**だけ。nav/docs/pricing の導線を消し、`/app` は home へ 307 リダイレクト。
- **バックエンド/API（`/api/v2/gallery/*`）・`/app` 配下のコードは温存**。「使われていない死コード」と誤認して**削除しない**。再リンク・リダイレクト解除はユーザー確認の上で。

---

## 作業の進め方（このリポジトリでの規約）

### リファクタ・大規模改修

- **段階的に**: 新機能を旧実装と並走で入れる → ライブで検証 → **その後**重複を撤去。ビッグバン置換を避ける。
- 重複撤去は**外科的に**: 置換側が旧コードの全ケースをカバーしていることを確認してから消す。カバーできない機能（例: texlab で再現できない hover/outline）は**残し、理由を述べる**。
- 自分の環境に依存させず、**自己完結バンドル**を優先する（完成度を重視）。

### 検証

- **UI の見た目は検証しない**。Launch プレビューや computer-use でスクショ/クリックして「見た目」を確認しない。UI/CSS/HTML を変えたら `tsc` で通し、必要なら headless で no-crash 確認し、「何を変えたか（renderer のみ → Cmd+R）」だけ伝えてユーザーに見た目を委ねる。
  - 例外: ユーザーが**インタラクティブな挙動**のハンズオン検証を明示的に頼んだときは行う。「見た目を眺める」ためのプレビューだけが禁止。
- **「動く」と断言する前にバックエンドの実行経路を辿る**。フロント配線や `tsc` 成功だけで保証しない。install/build/runtime 系は renderer だけでなく `electron/`（`.cjs`）側を読み、必要なら**実走**で機能的に確認する（過去に「ワンクリック TeX インストール完成」と報告したが env.cjs の不具合で失敗していた）。
- **ランキング/サジェスト/ヒューリスティクスの改修は、まずシミュレーション**。実 LaTeX ユーザーの打鍵・選択をコーパス化して headless（node）で実走させ、top-1 率・MRR・退行有無で定量評価してから最適解を実装する。設計判断もシミュレーション結果で決める。一時ハーネスは検証後に削除可（恒久回帰テスト化は提案する）。

### 操作・コミット

- **ビルドはビルドボタンのクリックのみ**。キーボードショートカットを足さない（Cmd+B=`\textbf`、Cmd+I=`\textit` のまま）。Cmd+B/Cmd+Enter/Cmd+R をビルドに再割当てしない。
- **コミットは機能で分けず、全変更を1コミットに**。選択的に除外しない（`.env` 等の明らかな秘密情報は除く）。push は頼まれたら。
- 自作 LSP クライアントや model URI などの「KEEP と決めた実装」を勝手に戻さない。

### docs と実装

- docs/マーケ/課金 UI が実装と食い違うときは**実装（コード）が真**。古い docs を実装に合わせて書き換える（コードを docs に合わせない）。
- tex64.com の docs は各ページ `CONTENT={en,ja,zh,de,ko,fr,es}` の**全7ロケール**を揃える（base ページを直すと re-export で波及）。Axiom は英語版を先に仕上げてから7ロケール展開。
- ただし「未実装の宣伝機能を実装するか docs から削るか」のような**製品分岐は勝手に決めず**、AskUserQuestion で相談する（推奨案を先頭に）。

### ユーザーとのやり取り

- **確認・質問・選択肢は日本語で出す**（AskUserQuestion の question / header / options も全て）。技術用語・コード・パス・識別子は英語のままでよい。地の文も日本語が基本。
