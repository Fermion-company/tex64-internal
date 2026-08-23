# AI モードをローカルの .tex に載せ替える

## 原則（ここを取り違えない）

**「ユーザーが見るのは基本 PDF」であって、「AI がソースを根拠にしてはいけない」ではない。**

- ユーザーの既定の視界が紙面であればよい。必要なときにソースを見せることは禁止ではない。
- AI は `.tex` を読み、`.tex` を書く。それが最も確実で、最も能力が出る。
- この取り違えが、構造化文書モデル（JSON AST・独自パッチ・独自組版）という遠回りを生み、
  2 MiB 上限・500 版・`\chapter` なし・目次なし・画像なしという壁になっていた。**全部外す。**

## 決定

- AI モードは**独立した文書サービスをやめ**、Code モードと**同じワークスペースの .tex を直接**扱う。
- バックエンドは **Electron 側**に寄せる。ファイル読み書き・ビルド・SyncTeX・エージェントは
  Code モードと同じ実装（`electron/services/{build,synctex}.cjs`、`openprism/`、`agent-*.cjs`、`codex/`）を使う。
- `services/tex64-ai` は **UI だけ**になる（チャット、PDF ビューア、要素クリック、変更履歴）。
- モデルは **Axiom(OpenAI) と Codex(ChatGPT 枠) を選べる**。Code モードの切替と同じ経路に乗る。
- 当面 **パッケージ版は作らない**。ローカルで動かす前提。

## 何が変わるか

| | いま | これから |
|---|---|---|
| 正本 | 構造化文書 JSON（`.data/store.json`） | ワークスペースの `.tex` |
| 編集 | `apply_document_patch`（AST パッチ） | ファイル編集（Code モードのツール／Codex の apply_patch） |
| 組版 | tex64-ai の LocalLatexCompiler | `electron/services/build.cjs`（latexmk） |
| 紙面 | 生成 PDF を artifact store へ | ビルド成果の PDF をそのまま |
| 要素の対応 | `%%T64B/E` マーカー＋synctex-regions | SyncTeX の逆引き（PDF 座標 → .tex 行） |
| 履歴 | revision テーブル（500版上限） | 未定（下の「未解決」） |
| 通信 | Next の HTTP API | webview → embedder → main の既存メッセージバス |

## これで消える制約

[教科書計画](ai-mode-paper-e2e.md)で「壁」として記録したものの大半が、ファイルを正本にするだけで消える。

- 文書 JSON **2 MiB 上限** → 無くなる
- **500 版/文書** → 無くなる
- **`ltjsarticle` 固定・`\chapter` なし** → `jsbook` も学会クラスも使える。章別の式番号も出せる
- **目次・索引が作れない** → `\tableofcontents` / `makeindex` が使える
- **画像を貼れない** → `\includegraphics` が使える
- **組版 45 秒制限** → Code モードのビルド設定に従う

残るのは「文献検索が gateway 専用」だけになる。

## 段階（並走 → 検証 → 撤去）

既存の AI モードを壊さずに進める。CLAUDE.md の段階的改修の規約に従う。

### S1 — ブリッジ

`electron/ai-web-preload.cjs` に、ゲスト（AI webview）から使える**許可制の API** を足す。
今の `openExternal` と同じく guest → embedder renderer → main で中継し、ゲストが main と直接話さない形を保つ。

必要な口:

- ワークスペース: ルート取得、ファイル一覧、読み、書き
- ビルド: 実行、状態、成果 PDF のパス
- SyncTeX: PDF 座標 → .tex 位置、.tex 位置 → PDF 座標
- エージェント: ターン開始・中断、イベント購読（`agent:*`）、モデル選択（Axiom / Codex）

### S2 — 紙面をビルド成果に差し替える

AI モードの PDF ビューアが、tex64-ai の artifact ではなく**ビルド結果の PDF** を表示する。
この時点でチャットはまだ旧経路でよい。表示が正しいことだけを見る。

### S3 — エージェントを Electron 側に切り替える

チャットの送信先を Next の `POST /messages` から**ブリッジ経由のエージェント**へ。
ストリーミング・停止・順番待ちの UI はそのまま使えるよう、イベントを今の `TurnFrame` に合わせる。
ここで Axiom / Codex の選択を入れる。

### S4 — 要素クリックを SyncTeX に載せ替える

PDF 上のクリック → SyncTeX 逆引きで .tex の位置 → その範囲を依頼のスコープにする。
選択した箇所は**その場で直せる**。原則どおり既定の視界は紙面のままで、直したい人には
対応する `.tex` の断片をそこに出す（見せることは禁止ではない）。

S3 でエージェントがファイルを扱うようになった時点で、system instructions の
「TeX・LaTeX ソース・生成ファイルを直接編集してはいけない」を**逆に書き換える**。

### S5 — 撤去

旧経路が全部置き換わったことを確認してから、tex64-ai の
文書モデル・パッチ・レンダラ・組版・artifact・永続化・API を削除する。
UI（チャット、PDF ビューア、履歴パネル）だけを残す。

## 決まったこと

- **版の復元は git**。ワークスペースを git で追い、履歴パネルはコミットを見せて、復元はそのコミットへ戻す。
  revision テーブルは撤去する。
- **Web 版はあとで Web 用に調整して出す**。この移行では Electron 前提で進めてよい。
- **Codex は移行後に AI モードでも使える**（Codex はファイルを編集するエージェントなので、
  ファイル方式にすればそのまま乗る）。逆に、移行が終わるまでは使えない。

## 直接編集 — TeX を見せずに本文だけ直す

紙面をクリックしたら、**その段落の文章だけ**を編集できるようにする。ソースは出さない。

SyncTeX の逆引きで段落の範囲を取り、その範囲の `.tex` を **文章の断片**と
**不透明な命令**に分けて扱う:

- `文章` … そのまま編集できるテキスト
- `\emph{...}` `$...$` `\cite{...}` … 中身を見せない**チップ**（強調 / 数式 / 引用 のような表示）。
  移動と削除はできるが、中は打てない

編集はテキスト断片の**元の範囲へ書き戻す**ので、命令は一字一句そのまま残る。
数式そのものを直したいときは、チップから数式エディタ（既存の MathLive）へ渡す。

---

## 現状（2026-08-20 時点）と引き継ぎ

ブランチ `fix/issue-17-ai-mode-codex`。

### 動いているもの（実機で確認済み）

- **紙面** — AI モードを開くと、ワークスペースのビルド成果 PDF が出る。取得は
  ブリッジではなく `GET /api/workspace/file?root=<絶対>&path=<相対>`（この
  サービスが同じマシンで動くため直接読む。ルート外と非表示形式は拒否）。
- **チャット** — Electron 側エージェント（会話 ID `tex64-ai-mode`）に送られ、
  ワークスペースの `.tex` を直接編集する。
- **クリック → 段落の囲み** — PDF 自身のテキストから段落を組み立てて矩形を描く
  （`src/components/pdf-text-blocks.ts`、単体テスト 8 件）。
- **クリック → 本文の位置** — SyncTeX 逆引きで `main.tex` の行を返す。

### 解決済み: SyncTeX 逆引きの「時々失敗」（2026-08-20）

「この場所は本文と結び付けられませんでした」の原因は **main 側ではなくゲスト側の
二重アンラップ**だった。`requestFromHost` は listener 内で封筒を剥がして
**中身（payload）を resolve する**のに、`use-source-locator.ts` が戻り値へ
もう一度 `hostMessageBody()` を掛けていた。中身に `payload` キーは無いので
`found` は常に `{}` になり、成功応答も失敗に見えた（`error` も無いので常に既定文言）。
abac59a のリファクタで混入。

- 直し: `use-source-locator.ts` は戻り値をそのまま読む。`requestFromHost` の
  戻り型を `Promise<Record<string, unknown>>` に改め、「戻り値も封筒」という
  型の嘘を排除（`tests/native-host.test.ts` に回帰テスト）。
- 同じ二重アンラップを抱えた未使用の `fetchWorkspaceFileUrl` は削除
  （紙面は HTTP 直読みに移行済みのため死コードだった）。
- main 側は健全と実測で確認: `SynctexService.reverse()` を headless で
  AI モードと同条件（`bypassHint: true`・expanded なし）で実走し、3 点とも
  `ok: true`・約 350ms。doc 旧版の「`reverse()` が `ok` を含まない値を返す」は
  誤診だった（ゲストが何を受け取っても `{}` に潰していたため）。
- ゲストの打ち切りは 6 秒 → 20 秒に。逆引きは近傍グリッド掃引
  （synctex プロセス多数起動）なので、大きい文書ではミリ秒では済まない。

### 実装済み・実機未検証: 本文だけの直接編集（2026-08-20）

「この付近」カードに **文章を直す** ボタンが付き、押すと段落がその場で編集できる。
文章は打ち直せて、命令はチップ（強調・数式・引用…）のまま保たれる。

仕組み（設計の要はひとつ: **TeX の特殊文字は全部チップにする**。だから文章
セグメントに特殊文字は残らず、書き戻し時に「編集された文章」を機械的に
エスケープしても未編集部分は恒等変換になり、往復が壊れない）:

- `src/domain/source/paragraph-editing.ts` — 純ロジック。
  `findParagraphRange`（空行・構造行で段落境界）、`segmentParagraph`
  （文章/チップ分解、連結＝原文のバイト一致を保証）、`escapeParagraphText`、
  `serializeSegments`。`tests/paragraph-editing.test.ts`（14 件）。
- `src/lib/client/use-paragraph-editor.ts` — 読み出し（`file:excerpt`
  radius 60）→ 分解 → 書き戻し → `build`。
- `src/components/paragraph-edit-card.tsx` — contenteditable。チップは
  `contenteditable=false` の不透明要素（削除可・中は打てない）。保存時に
  DOM を辿って再構成。
- 書き戻しは新設の **`file:replaceLines`**（main 側
  `electron/handlers/workspace/file-handlers.cjs` の `handleReplaceLines`、
  `tests/file-replace-lines.test.cjs` 5 件）。**読んだ行がまだ同じときだけ
  置換する compare-and-swap** で、エージェントや Code モードが先に触って
  いたら `stale` で拒否する。全文はブリッジを渡らない（大きいメッセージは
  落ちるため）。embedder の allowlist（`web-src/app/ai-mode-ui.ts`）に
  request/result を追加済み。

わかっている制限（v1 として意図的）:

- チップは削除のみ。移動（切り取り→貼り付け）は plaintext 貼り付けで
  チップが失われる。
- 数式チップから MathLive エディタへの受け渡しは未実装（次の改善）。
- 段落が抜粋（radius 60 / 12KB）より長い場合は見えている範囲だけが対象
  （compare-and-swap により正しさは保たれる）。

### 実機フィードバックで直したもの（2026-08-20 午後）

スクリーンショット報告の 4 件。

1. **カードを開くとスクロールできない** — `pdf-preview.tsx` の selectionCard が
   inline ref コールバックで `scrollIntoView` していた。ref は再レンダーごとに
   呼び直されるので、スクロール→再レンダー→カードへ引き戻しの綱引きになる。
   「現れた最初の 1 回だけ」スクロールするようガード。
2. **段落の囲みが上にずれる** — `pdf-text-blocks.ts` の `itemRect` が
   `transform[5]`（ベースライン）から height を丸ごと引いていた。上端は
   `f - height * 0.78`（アセント分）が正しい。
3. **クリックした段落の隣に結び付く** — main 側 2 箇所:
   - `measureForwardDistance` の `maxBoxWidth = 200` を撤廃（高さだけで行ボックス
     判定）。1 ソース行=1 段落だと行ボックスは幅 453pt あり、上限で本来の箱判定が
     スキップされ「行頭の点との距離」に退化 → `refineReverseCandidate` が正解を
     隣の行へ動かしていた。あわせて箱の縦範囲を `[v-H, v+depth]` に修正
     （`v` はベースライン。旧実装は `[y, y+H]` で 1 行分下にずれていた）。
   - 厳密ヒットの**ハードフィルタを廃止**しスコアボーナス化
     （`reverse-core.cjs`）。synctex は段落間グルーを空行の行番号に帰属させる
     ので、クリック点そのものの答えが空行のことがあり、それが候補を独占していた。
   - 検証: e2e-paper の synctex view から行バンドを機械生成した 96 点評価で
     **top-1 38.5% → 97.9%**（confident 35 → 96）。残る 2 点は「段落最終行 vs
     直後の \section 見出し」の synctex 自体が曖昧な帯。回帰テスト
     `tests/synctex-reverse-scoring.test.cjs`（3 件）。Code モードの逆引きも
     同じ実装なので同様に良くなる。
4. **カードに生 TeX が漏れる** — 抜粋を `segmentParagraph` に通し、命令はチップ
   表示に（既定の視界は文章、の原則どおり）。長い段落用に 6 行でクランプ。

### 実機フィードバック第2弾（2026-08-20 夕方）

1. **スクロールがまだ戻る** — 前回のガードに穴。inline ref は毎レンダーで
   `ref(null)` → `ref(node)` と呼び直されるのに、`null` でガードをリセット
   していたため毎回 `scrollIntoView` が再発火していた。`null` では何もしない
   （ノードの同一性だけで判定。カードが本当に作り直されたときだけスクロール）。
2. **保存したのに紙面が変わらず、抜粋と食い違って見える** — 「This」消失は
   ユーザー編集が正しく保存された結果（単語選択→スペース）。壊れていたのは
   **保存後の再組版**で、ゲストからの 2 通目の `build` メッセージが実機で
   届かなかった（latexmk の副産物 mtime で確認: 保存 14:12:32、最終ビルド
   14:12:18）。対策として**再組版を main 側に移した**: `handleReplaceLines`
   が結果を返し、ディスパッチが成功時に `handleBuild` を直接呼ぶ
   （`electron/main.cjs`）。ゲストの `build` 送信は撤去。紙面は既存の
   `setBuildState: success` 購読で自動再読込される。
3. **AI モードの組版で Code モードの PDF 窓が開く問題** — `handleBuild` に
   `pdfViewerMode: "none"`（ビューアを一切開かない）を追加し、AI モード発の
   組版依頼（`use-workspace-pdf` / `requestWorkspaceBuild` / 保存後の main 直呼び）
   は全て "none" で通す。
4. テストワークスペースの `main.tex` は「This」を復元済み（`git checkout`）。

### 文書 = ワークスペース内のフォルダ（2026-08-20 決定・実装、実機未確認）

AI モードは**新しい文書を作ることに特化**する（Base44 と同じ思想）。ユーザーは
ファイルを一切意識せず、題名 → チャットだけで書き進める。

- **新規** — トップバーの「新規」→ 題名 1 入力 → main 側 `document:create` が
  ワークスペース直下にフォルダを作る（名前は題名をサニタイズ・重複は「名前 2」…、
  `electron/handlers/workspace/ai-documents.cjs`）。中に `ltjsarticle` +
  `\maketitle` の最小 main.tex を置き、即組版して 1 ページ目（題名）を出す。
- **切替** — スイッチャーは**作った文書（フォルダ）の一覧**（`document:list`。
  ルート直下の `<フォルダ>/main.tex` を列挙、ルート直置き main.tex も
  プロジェクト名の文書として含める）。選ぶとその文書へ移動（紙面・スレッド・
  組版ターゲットが全部切り替わる）。旧文書サービスの一覧・新規・変更履歴は
  native では非表示（履歴は git 化の際に別途）。
- **組版のターゲット** — `build` メッセージに `targetFile`（AI モード用、
  `exactTarget` でワークスペースの root 指定より優先）。保存後の main 側
  リビルドも編集ファイルの属するフォルダの main.tex を狙う。
- **エージェントのスコープ** — 会話は文書ごと（`tex64-ai-mode:<フォルダ>`）、
  `context.activeFilePath = <フォルダ>/main.tex`（run-loop が「Active file」
  としてモデルへ渡す既存経路）。
- **紙面** — `use-workspace-pdf` は「今の文書のビルド成果だけ」を表示する
  派生状態に書き換え（他文書や Code モードのビルドは素通し）。文書ごとに
  最後の紙面を記憶して再訪時に即表示。
- ゲスト側: `use-ai-documents.ts` / `native-new-document-panel.tsx` /
  `document-workspace.tsx` の native 分岐（web モードの挙動は不変）。
  テスト: `tests/ai-documents.test.cjs`（5 件）。

### 未解決（次に着手すべき順）

1. **新フロー一式の実機確認**（main を触ったので Electron 再起動が必要）:
   新規 → 題名だけで紙面が出る / 切替 / チャットが文書スコープで編集 /
   組版ボタン / 段落の直接編集 → 自動再組版。
2. **数式チップ → MathLive** の受け渡し。
3. **S5 の撤去**（tex64-ai の文書モデル・パッチ・レンダラ・組版・永続化・API を削除、
   履歴を git へ）は未着手。

### 動かし方

```bash
# AI サーバーは切り離して起動する（セッションと一緒に落ちるため）
cd services/tex64-ai && nohup npm run dev > /tmp/tex64-ai.log 2>&1 &

# デスクトップ
npm run dev
```

反映の範囲に注意:

- `electron/**`（main・preload）を変えたら **Electron の再起動**
- `web-src/**`（埋め込み側）を変えたら **Cmd+R**
- `services/tex64-ai/**`（ゲスト）は Next の HMR。効かないときは webview を Cmd+R

### 調べ方（この作業で唯一効いた方法）

推測で直すと必ず外れる。印を付けて機械的に辿ること。

- **ゲスト側**: 自分のサーバーへ `fetch("/api/documents?probe=...")`。dev サーバーのログに残る。
- **main 側**: `console.log`。ただし**自分で起動した場合だけ**ログが読める。
- **埋め込み側（renderer）は外に出せない**。`index.html` の CSP が
  `connect-src 'self' https:` なので localhost:3100 への fetch は落ちる。
  main 経由で出すか、ゲスト側から観測する。

### 踏んだ落とし穴（再発させないこと）

- **バスは封筒**。`{ type, payload }` で届く。中身は `payload` の中。
- **`requestWorkspace` / `openWorkspace` はフォルダ選択ダイアログを開く**。
  ゲストに許可してはいけない。状態を問うのは `workspace:state:get`（新設）。
- **`<webview>.send` はゲストが準備できるまで例外**。準備状態を追うのではなく、
  送ってみて失敗したら保持する。
- **大きなメッセージはブリッジで落ちる**。PDF（122KB）は届かず、小さいものは通っていた。
  ファイルは HTTP で渡す。
- **`updateWorkspace` はプロジェクトを開いた瞬間に一度だけ飛ぶ**。後から作られる
  webview には届かないので、ホスト側で最後の状態を保持して新しいゲストに配る。
