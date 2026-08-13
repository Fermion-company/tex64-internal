# TeX64 — フロントエンド

`design_handoff_tex64_builder/README.md` のデザインハンドオフ(実装対象: 7a 統合版メイン画面)を
React + TypeScript + Vite で再現実装したフロントエンド。起動方法はリポジトリ直下の README を参照
(バックエンドと同時起動: ルートで `npm run dev`)。

## 紙面の二層構造

- **PDFビュー(デフォルト)** — バックエンドが LuaLaTeX で組版した実PDFを pdf.js で表示。
  文書が変わるたびにデバウンス(700ms)して `/api/compile` を叩き、静かに差し替える
  (ツールバーに小さな「組版中」表示のみ。エラーUIは存在しない)
- **編集ビュー** — KaTeX による即時プレビュー。紙面をクリックして直接編集(WYSIWYG)。
  入力停止(900ms)または blur で documentModel にコミットされ、裏でPDFが再組版される

## 実装済みの画面・インタラクション

- メイン画面(7a) — ヘッダー / チャット380px / ツールバー / アウトライン230px / 紙面620px
- チャット(実AI) — `/api/chat` のSSEをストリーミング表示。編集モードではAIが
  update_document ツールで文書を書き換え、「書き込み中 `main.tex`」ステータス行が流れる
- 直接編集(4a) — 段落・見出し・概要のインライン編集、選択で白いフローティングツールバー(B/I/引用/脚注)
- 数式 — 選択枠+ツールバー(↻/編集/ソースを表示/×)。追加モーダル(6a/6b)は
  「説明する」(AIでLaTeX化・入力停止で自動変換)/「写真から」(AIでOCR)。未接続時はローカル変換にフォールバック
- 画像挿入 — プレースホルダーへD&D。PDF側にも `\includegraphics` で反映
- アウトライン — クリックでスクロール(PDFビューでは比率スクロール)、追従ハイライト、セクション追加
- Undo/Redo — 直接編集・AI編集すべて履歴化(Cmd+Z / Shift+Cmd+Z)
- 公開 — 現在のPDFをダウンロード
- ビルド中状態(1a) — 新しい文書をAIが生成するときに表示

## 構成

```
src/
  components/   Header / ChatPanel / PreviewPanel / Paper(編集ビュー) / PdfView / EquationModal ほか
  state/        store.tsx — useReducer + Context(undo/redo履歴・localStorage永続化)
  lib/          api.ts(チャットSSE・コンパイル・数式API) / latex.ts(KaTeX描画) / outline.ts
  data/         initial.ts — シード文書(AttentionPaper)と初期チャット
  styles/       global.css — デザイントークン(色・タイポグラフィ)一式
```
