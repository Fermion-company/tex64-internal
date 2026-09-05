# TeX64 — AIとの対話でLaTeX文書が完成するアプリ

旧AIアプリの試作。現行サービスは `/Users/wedd/Development/fermion/tex64-internal/services/tex64-ai` を参照する。

「LaTeXを書けない人でも、AIとの対話だけで学術レベルのLaTeX文書が完成する」Webアプリ。
チャットで執筆を依頼すると、右側に**実際にLuaLaTeXで組版されたPDF**が常に表示されます。
TeXコードは前面に出ず、コンパイルは常にAIとバックエンドが完了させます(エラーUIは存在しません)。


## 必要環境

- Node.js 18+
- TeX Live(`lualatex` + `luatexja`)— macOSなら [MacTeX](https://tug.org/mactex/)
- OpenAI APIキー(チャット・数式変換・OCR・LaTeX自己修復に使用)

## セットアップ

```sh
npm run setup                 # backend / frontend の依存をインストール
cp backend/.env.example backend/.env
# backend/.env に OPENAI_API_KEY を記入

npm run dev                   # backend(8787) + frontend(5173) を同時起動
```

APIキー未設定でも起動でき、PDFプレビュー・直接編集・Undo/Redoは動作します
(チャットには設定を促す案内が表示されます)。

## アーキテクチャ

```
frontend/  React + TypeScript + Vite
           ├ 紙面: 実PDF表示(pdf.js) / 即時プレビュー(KaTeX)を切替
           ├ チャット: SSEでAI応答をストリーミング表示
           └ 直接編集: contenteditable + 入力停止で自動コミット
backend/   Node + Express + openai SDK (gpt-5.4-mini)
           ├ /api/chat          チャット(SSE)。update_documentツールで文書を編集
           ├ /api/compile       documentModel → LaTeX → lualatex → PDF
           ├ /api/math/describe 自然文の説明 → LaTeX数式
           └ /api/math/ocr      数式の写真 → LaTeX(vision)
```

設計上の前提(デザインハンドオフ準拠):

1. **TeXコードは前面に出さない** — LaTeXソースはAIとバックエンドが所有。「ソースを表示」の控えめな導線のみ
2. **コンパイルは常に完了する** — 失敗時はAIがログを読んで自動修正しリトライ。それでも失敗したら直前の正常なPDFを表示し続ける。**エラーUI・警告バッジ・ログビューアは作らない**
3. **見た目とコンパイルの分離** — 編集ビューはKaTeXで体感ゼロ遅延、実PDFは編集の合間にバックグラウンドで組版(約1秒)

## 主な操作

- **チャット** — 「編集」モードで文書を生成・変更(AIがプランを述べてから反映)、「ディスカス」モードで相談のみ
- **PDF / 編集 切替** — ツールバーのセグメント。PDFページをクリックしても編集ビューへ
- **直接編集** — 段落・見出しをクリックして書き換え。選択で書式ツールバー(B / I / 引用 / 脚注)
- **数式** — クリックで選択し「編集」または「ソースを表示」。追加はチャット欄の「+」から(自然文で説明 / 写真からOCR)
- **公開** — 現在のPDFをダウンロード
- **Undo/Redo** — 直接編集もAI編集もすべて履歴に積まれる(Cmd+Z / Shift+Cmd+Z)
