# TeX64

macOS / Windows向けLaTeXエディタ。法人共通事項は [../AGENTS.md](../AGENTS.md)。

## 実装と資料

- Electron mainは `electron/main.cjs`、サービスは `electron/services/`、IPCは `electron/handlers/`（CommonJS）。
- Code UIは `web-src/` のTypeScriptを `tsc` で `Resources/web/` へ出力する。生成JSは直接編集しない。`index.html` / `theme.css` は直接編集する。
- MonacoはAMDグローバルとして読み込む。言語機能はそのprovider APIへ登録する。
- AI UIは `services/tex64-ai/` のNext.js standaloneを同梱し、Electronへbridge経由で接続する。
- 本番のプラットフォームAPI（tex64.com）は別リポジトリ `../tex64.com`（`src/app/api/v2/`、利用資格は `src/platform/entitlements.js`）から配信される。このリポジトリの `api/v2/` は Vercel プロジェクト `tex64`（tex64.vercel.app）にしか当たらない。デスクトップのAI推論は `ai/openai/chat/completions` のプロキシ経由。
- Code / AIと共有ワークスペースの仕様は [docs/app-modes.md](docs/app-modes.md)。通常PDFビューアとTikZは [docs/pro-mode-design.md](docs/pro-mode-design.md)。
- TeXの導入は [docs/tex-env-detection-and-install-choice.md](docs/tex-env-detection-and-install-choice.md)、TDOM連携は [docs/realtime-preview.md](docs/realtime-preview.md)。
- 公式サイトの指示は [../tex64.com/AGENTS.md](../tex64.com/AGENTS.md)。

## 開発と確認

```sh
npm run dev                 # renderer watch + Electron
npm run electron:dev:fast    # rendererを再ビルドせず起動
npm run web:build            # MathLive + rendererを生成
npm run web:watch            # rendererのtsc watch
npm run mathlive:rebuild     # MathLive forkを変更した場合
npm run texlab:fetch         # 配布用texlabを取得
```

- rendererのみの変更はリロード、main / preloadの変更はElectronを再起動する。
- 自動テストとテスト専用設定・スクリプトは置かない。変更確認はビルド・静的解析と対象画面・実行経路の確認で行う。
- サジェストの順位変更は代表的な打鍵で既存結果と比較する。大きな評価セットは必要な場合に使い、一時検証ファイルは終了時に削除する。
- ローカル配備 `npm run deploy:local` は明示依頼時だけ行う。通常の開発で `/Applications` を差し替えない。
- 配布物生成は `npm run electron:dist:mac` / `npm run electron:dist:win:store`。実際の公開は `tex64-ci-update` skillを参照する。
- Gitは [docs/branching.md](docs/branching.md)。

## 数式入力（MathLive + WYSIWYG）

- **WYSIWYG サジェストがコア機能**。これだけで十分という思想で、余計な設定 UI・オプションは持たない。
- **IME モデル**: 打鍵 → 候補表示 → Tab で遷移 → Enter で確定・挿入。確定はトリガー（未確定バッファ）の置換であって、**MathLive 内の既存の数式構造には一切影響を与えない**。確定後の再変換は不可（消して打ち直す）。
- **任意の LaTeX 数式を入力できること**。アプリが入力可能な数式を制限しない。`\` キーは横取りせず MathLive にそのまま渡す。`inlineShortcuts` は意図的に空（WYSIWYG が代替）。
- **IME モデルの意図的な例外**:
  - 選択範囲に対する操作（`/` で選択を `\frac{}{}` にラップ等）。
  - 行列の Enter（行追加）/ Ctrl+Enter（列追加）。
  - `\label{}` 等 aux command の環境外への自動ホイスト（LaTeX 仕様上環境内に書けないため）。
  - `&` / `\\` を含む式の `aligned` 暗黙ラップ（MathLive 内部表現とのアダプタ。読み取り時に剥がし、出力時に挿入フォーマットへ再ラップ）。
- **トリガー辞書**: LaTeX 標準コマンド名に忠実なトリガーのみ。パック概念・英語エイリアス・日本語ローマ字トリガーは廃止。トリガー名と同名のコマンドを最優先（例 `inf` → `\inf` > `\infty`）。
- **タイムアウトは持たない**。ゆっくり打っても候補は出続けるべき。確定したければ Enter。
- 現行UIにないもの: 数学キーボード UI、設定モーダルの Suggestions ページ、WYSIWYG パック設定 UI、`\` キー横取り。
- gotcha: MathLive の Shadow DOM で `.ML__content` に `overflow: visible !important` が必須（分数描画が vlist のため、`hidden` だと上端がクリップされる）。

## Axiom

- 実行ループとツールは `electron/services/openprism/`。Code / AIとも同じワークスペースを編集する。
- Agents APIの開発接続は `npm run dev:agents`。接続・制限・確認結果は [docs/agents-api-trial.md](docs/agents-api-trial.md)。通常起動・配布版は従来の実行経路を使う。
- 会話ごとにモデルが判断し、曖昧な点だけ質問する。固定の依頼分類・brief・plan・独立レビューのパイプラインは使わない。
- 組版は `compile_document`。編集後に組版が残っている場合はElectronが追加のモデル呼出しなしで行う。
- 現行モデル表示は `Axiom1.0` とPro限定 `Axiom1.0-pro`。上流モデル名・内部コストは公開しない。利用枠は `api/v2/_lib/runtime-config.js`、表示への換算は `subscription-domain.js` / `ai-request-budget.js` を確認する。
- LaTeX・数式・画像/PDFの扱いを重視する。ゴーストテキストやコンポーザの先回りチップは現在採用していない。文書を開くだけではAIを呼ばない。紙面操作と提案は [docs/app-modes.md](docs/app-modes.md) を参照する。
- ファイル編集の重複ガードは `agent-tools-file.cjs`。複数ファイルの差分は既存のMonaco差分エディタを使う。
- Web単体のHTTP API・文書DBは [services/tex64-ai/README.md](services/tex64-ai/README.md) に分けて扱う。

## エディタ・LSP

- texlabは別プロセスとして起動し、`web-src/app/lsp/` がMonacoへ接続する。バイナリは取得スクリプトで管理し、帰属は `NOTICE.md`。
- 自作hoverとプロジェクト全体のindex / outlineはtexlabのper-file情報と役割が異なる。modelの `file://` URIはクロスファイル解決に使う。
- 手動ビルドはビルドボタン。Cmd+Bは太字、Cmd+Iは斜体として使う。
