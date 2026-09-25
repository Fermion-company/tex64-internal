# TeX64

macOS / Windows 向け LaTeX エディタ。法人共通事項は [../AGENTS.md](../AGENTS.md)。仕様の一覧は [docs/README.md](docs/README.md)、Git は [docs/branching.md](docs/branching.md)。

## 構成

- Electron main `electron/main.cjs`、サービス `electron/services/`、IPC `electron/handlers/`（CommonJS）。
- Code UI は `web-src/` の TypeScript を `tsc` で `Resources/web/` へ出力。生成 JS は編集しない。`index.html` / `theme.css` は直接編集。
- Monaco は AMD グローバル。言語機能は provider API へ登録。
- AI UI は `services/tex64-ai/`（Next.js standalone）。本番 API は別リポジトリ `../tex64.com`。
- ライブプレビューは tdom-engine（`electron/services/tdom-engine.cjs`）。`~/Desktop/tdom-engine` があれば同梱版より優先して起動する。pin は `.github/workflows/release.yml` の `TDOM_ENGINE_COMMIT`。pin を変えたら `~/Desktop/tdom-engine` も同じ commit にする。

## 開発

```sh
npm run dev                 # renderer watch + Electron
npm run electron:dev:fast   # renderer を再ビルドせず起動
npm run web:build           # MathLive + renderer を生成
npm run tdom:sync           # TDOM_ENGINE_DIR の engine を Resources/tdom-engine へ
npm run deploy:local        # 再ビルドして /Applications/TeX64.app を差し替え
```

- renderer のみの変更はリロード、main / preload は Electron を再起動。
- 自動テストは置かない。変更確認はビルド・静的解析と、対象画面・実行経路の実走で行う。
- テスト用の文書・ドライバ・記録は `testing/`（規則は [testing/README.md](testing/README.md)）。E2E ドライバは `scripts/e2e/`。
- 配布は `npm run electron:dist:mac` / `npm run electron:dist:win:store`。公開手順は `tex64-ci-update` skill。

## 数式入力（MathLive + WYSIWYG）

- 打鍵 → 候補 → Tab で遷移 → Enter で確定。確定はトリガーの置換だけで、MathLive 内の既存構造には触れない。タイムアウトなし。
- 任意の LaTeX 数式を入力できること。`\` キーは横取りせず、`inlineShortcuts` は空。トリガーは LaTeX 標準コマンド名のみ（同名コマンド最優先）。
- 例外: 選択範囲のラップ（`/` → `\frac{}{}`）、行列の Enter / Ctrl+Enter、`\label{}` の環境外ホイスト、`&` / `\\` の `aligned` 暗黙ラップ。
- MathLive の `.ML__content` には `overflow: visible !important` が必須。

## Axiom（AI）

- 実行ループとツールは `electron/services/openprism/`。モデル表示は `Axiom1.0` / Pro 限定 `Axiom1.0-pro` だけで、上流モデル名は出さない。利用枠は `api/v2/_lib/runtime-config.js`。
- 文書を開くだけでは AI を呼ばない。

## エディタ

- texlab は別プロセス、`web-src/app/lsp/` が Monaco へ接続。帰属は `NOTICE.md`。
- Cmd+B は太字、Cmd+I は斜体（ビルドはビルドボタン）。
- 活動計測で原稿の内容・パスは送らない（[docs/product-activity.md](docs/product-activity.md)）。
