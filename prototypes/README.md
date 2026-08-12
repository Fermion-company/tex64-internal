# prototypes/

出荷物ではない参照実装・デザイン資産の置き場。ここのコードはビルド・CI の対象外。

## tex64-builder

`/Users/wedd/tex64-ai` にあった初代「TeX64 Builder」プロトタイプの保全コピー（2026-08-12 取り込み）。

- **UIデザインの正**: `tex64-builder/design_handoff_tex64_builder/`（実装対象アートボード **7a**）。
  現行の AI モード（`services/tex64-ai`）の UI はこのデザインへ移植する。
- `frontend/` — React+Vite 実装（チャット380px + 組版紙面WYSIWYG、KaTeX/pdf.js切替、数式モーダル等）
- `backend/` — 旧 Express バックエンド（**レガシー**: 認証・利用枠・sandboxなし、旧モデル直呼び）。
  本番アーキテクチャは `services/tex64-ai` が正であり、これは挙動リファレンスとしてのみ参照する。
