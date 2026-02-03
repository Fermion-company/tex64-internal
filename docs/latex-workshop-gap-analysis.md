# tex64 ⇄ VS Code LaTeX Workshop ギャップ（未実装のみ）

目的: VS Code の LaTeX Workshop から tex64 へ移行する際に、「執筆（書く/直す/コンパイルして確認する）」を止めうる **未実装/不足だけ** を残す。

注意: ここでは LaTeX Workshop が提供する執筆支援にフォーカスします（VS Code 本体の Git/拡張/タスク/キー設定などは別問題）。

## 参照（web）

- LaTeX Workshop: README（機能カテゴリ）: https://github.com/James-Yu/LaTeX-Workshop
- Wiki: Compile: https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile
- Wiki: View: https://github.com/James-Yu/LaTeX-Workshop/wiki/View
- Wiki: Intellisense: https://github.com/James-Yu/LaTeX-Workshop/wiki/Intellisense
- Wiki: Linters: https://github.com/James-Yu/LaTeX-Workshop/wiki/Linters
- Wiki: Hover: https://github.com/James-Yu/LaTeX-Workshop/wiki/Hover
- Wiki: Snippets: https://github.com/James-Yu/LaTeX-Workshop/wiki/Snippets

## 除外（tex64 の方針で不要）

- word count（`texcount`）: 執筆フローの必須要件ではないため対象外
- 自動ビルド: tex64 は自動保存が前提で、ビルドは明示操作で十分（勝手に走る方が不快になりやすい）

## 未実装/不足（移行障壁になりうるもの）

### Lint（LaTeX Workshop の既定体験との差）

- 自動 lint（`onType` / `onSave` 相当）: いまは手動実行中心のため、常時 Diagnostics を期待するユーザーには差が出る
- LaCheck サポート: ChkTeX 以外の linter を使っているユーザーの移行障壁になりうる
- ChkTeX 設定の露出: args/有効無効/プロジェクト別の振る舞いを UI から調整できない（`.chktexrc` に寄せる運用が必要）

### Snippets / Editing（書く速度）

- スニペットの拡充とユーザー定義: LaTeX Workshop のスニペット資産に依存している場合は差が出る
- `\\begin{...}` 補助: wrap selection / 自動クローズ（手入力でも end を補う）など編集補助の不足

### PDF / SyncTeX（閲覧の周辺機能）

- Reverse SyncTeX が複数候補のときの UI（候補選択/ペイン選択）
- 外部 PDF ビューア（Skim 等）と SyncTeX の連携（内蔵ビューア以外で作業するユーザー向け）

### Recipes / Tools（ビルドの柔軟性）

- 複数 tool chain/placeholder/env 変数まで含めた “recipe” 編集（latexmk 以外を混ぜるプロジェクトでは障壁になりうる）
