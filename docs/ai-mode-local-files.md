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

## 未解決（決めてから着手する）

- **版の復元**: いまは revision テーブル。ファイルでは git か、TeX64 側の履歴機能か、独自スナップショットか。
- **ブラウザ単体では動かなくなる**。`services/tex64-ai` は Electron 前提の UI になる。
  Web 版として公開する道はここで一旦閉じる（決定どおり）。
- **Codex と AI モードの相性**: Codex は「ファイルを編集するエージェント」なので、
  ファイル方式にすればそのまま乗る。逆に言えば、この移行が終わるまで AI モードで Codex は使えない。
