# TeX64 Code ワークスペース設計

旧 Pro モードは廃止済み。画面上のモードは Code | AI の 2 つだけとし、旧 Pro 専用機能のうち
Code に残すのは TikZ 作図キャンバスだけとする。

## Code の基本レイアウト

Code はソース左・通常ビューア右の固定構成にする。

```
+-------------------+-------------------+
| ソースコード        | PDF / Live        |
+-------------------+-------------------+
```

- 境界はドラッグでリサイズでき、両側とも最小幅 220px を保つ。
- 比率は既存ユーザーの状態を引き継ぐため `localStorage["tex64.proMode.v1"]` に保存する。
  このキー名は移行互換のためだけに残す。
- 右側は既存の `viewer.ts` / `pdf-viewer.html` をそのまま使う。
- 専用ペインヘッダー、手動 Open、範囲 Capture、構造ドロワー、折り畳み UI は持たない。
- PDF の紙面はテーマで反転しない。ダークテーマでも PDF 自体の色は原稿どおり表示する。

## Live プレビュー

設定の Real-time Preview が有効なときは `code-live-preview.ts` が TDOM エンジンへ変更を送り、
右側の通常ビューアを Live 表示へ切り替える。Live は通常の PDF ビューアを置き換える表示状態であり、
別の Pro ビューアではない。

Code の右ビューアは editor-session の group viewer とは別インスタンスなので、Live URL と generation を
`setWorkspaceLivePreview` 経由で必ず同時に配布する。ある箇所を編集した後に別の箇所を編集しても、
同じ表示面が新しい generation を受け取り続けること。

主な実装:

- `web-src/app/code-live-preview.ts`
- `web-src/app/pro-mode-ui.ts`（旧名。固定 Code ワークスペースのレイアウトと右ビューアを所有）
- `web-src/app/viewer.ts`
- `Resources/web/pdf-viewer.html`

## 残す旧 Pro 機能: TikZ 作図

TikZ 作図キャンバスは Code の図作成機能として残す。独自シーン JSON を正本にし、TikZ 挿入・
埋め込みメタデータからの再編集・PNG 画像化・SVG 取り込み・`.sty` 書き出しを維持する。

主な実装:

- `web-src/app/pro-canvas/`
- `web-src/app/pro-editor-insert.ts`
- `docs/pro-canvas-c1-spec.md` ほか `docs/pro-canvas-*.md`

`pro-` という内部識別子は既存の図データ、イベント名、テストとの互換性のため残す。製品上の
Pro モードや権限制御を意味しない。

## 撤去済みの旧 Pro 機能

- Preview の Capture / OCR ツールバー
- スタッシュと AI 一括編集
- 専用の文書構造ドロワー
- ペインの折り畳み、レイアウト選択、手動ファイル Open
- 専用 Preview ヘッダーと補助ストリップ

通常の Outline、アプリ全体の数式画像取り込み、Axiom は別機能なので撤去対象ではない。

## 検証

```bash
npx tsc -p web-src/tsconfig.json
node --test tests/code-workspace-surface.test.mjs tests/code-live-preview-boundary.test.mjs tests/pro-mode-ui.test.mjs
```
