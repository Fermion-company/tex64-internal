# TeX64 アプリモード設計書（Code | AI）

トップバー左側（サイドバートグルの右隣）のピル型スイッチャーで、編集と AI の 2 つを切り替える。
Code の高度な編集機能の内部設計は [pro-mode-design.md](./pro-mode-design.md) を参照。

```
+----------------------------------------------------------+
| [sidebar] ( </> Code | ✦ AI )                 [actions]   |
+----------------------------------------------------------+
```

スイッチャーは `.topbar-left` 内に固定。モードによって右側のアクション群が増減しても
位置がズレない。AI モードではサイドバートグルを `visibility: hidden` にして
（`display: none` ではなく）スイッチャーの x 座標を完全に固定する。

## 2 つのモード

| モード | 中身 | 対象ユーザー |
| --- | --- | --- |
| **Code** | ソース＋PDF プレビュー・範囲キャプチャ・スタッシュ・作図を含む LaTeX エディタ（起動時デフォルト） | TeX を直接編集する人 |
| **AI** | tex64-ai 文書エージェント（`services/tex64-ai` を埋め込み） | 文書を「依頼して作る」人 |

## 実装の要点

- 状態は `web-src/app/app-mode.ts` が管理。`<html data-app-mode="code|ai">` を立て、
  `localStorage["tex64.appMode.v1"]` に永続化。表示切替は `theme.css` の属性セレクタ。
- 旧 `pro` 選択は `code` へ移行する。旧 Pro の編集機能はすべて Code に統合済み。
- Code のソース/プレビュー比率と折り畳み状態は `tex64.proMode.v1` に永続化する。
- AI は別サーフェスだが、切替時に Code のエディタ状態は破棄しない。

## AI モード = tex64-ai の「インポート」

AI モードは機能を移植したのではなく、**独立 Web アプリをそのまま埋め込む**。
一つのコードベース（`services/tex64-ai`）への変更が Web 版とネイティブ版の両方に反映される。

AI モードの製品思想は **Base44 型のノーコード執筆**（コードを見せずに AI が自律的に
文書を仕上げ、動く成果物＝コンパイル済み PDF が常に見えている）。体験の骨格
（build-first インテーク / 会話的反復編集 / PDF 要素クリック選択と直接編集 /
自動再コンパイル / 進捗チェックリスト / 版の復元）は
[services/tex64-ai/README.md](../services/tex64-ai/README.md) を参照。

- ホスト: `web-src/app/ai-mode-ui.ts` が `<webview partition="persist:tex64-ai">` を遅延生成。
- URL 解決: `electron/services/ai-web.cjs` — 設定 `aiWeb.url` → 環境変数 `TEX64_AI_WEB_URL` →
  既定値（開発: `http://localhost:3100` / パッケージ版: `https://ai.tex64.com`）。
  本番デプロイ URL が確定したら `DEFAULT_HOSTED_URL` を更新すること。
- ネイティブ分岐: `electron/ai-web-preload.cjs` が `window.tex64Native` を注入し、
  ページ側は `<html data-platform="native">` と `src/lib/platform.ts` だけで分岐する。
  **細かい仕様差はすべてこの 1 点に集約する**（例: ネイティブではブランドロックアップ非表示）。
- 外部リンクは guest → host → main 経由で `shell.openExternal`（webview 内で新窓は開かない）。
- 接続失敗時は `#ai-mode-fallback` が再接続/ブラウザで開く/開発サーバー起動手順を出す。

## モードごとのファイル/フォルダ選択

- **Code**: サイドバーのファイルツリーを使う。画像/PDF をツリーで選ぶと、エディタを潰さずに
  右側の Preview ペインへ表示し、折り畳まれていれば自動展開、ペインヘッダーにファイル名を表示する
  （タブとして既に開いている場合は通常のタブ動作）。ペインの Open ボタンからは
  ワークスペース外のファイルも従来どおり開ける。
- **AI**: ワークスペース非依存。文書の一覧・作成・履歴は埋め込みアプリ自身が持つ
  （署名付き cookie 単位の作業領域。`partition="persist:tex64-ai"` で再起動後も維持）。

## 変更するときの決まり

- レンダラー: `web-src/`（plain tsc、バンドラなし）。`Resources/web/**/*.js` は生成物、
  `Resources/web/index.html`・`theme.css` は手編集対象。
- モードを増やす/挙動を変える場合は `app-mode.ts` の `AppMode` 型 → `index.html` のタブ →
  `theme.css` の `[data-app-mode]` 規則 → 本書、の順で揃える。
- 検証: `npx tsc -p web-src/tsconfig.json` と `node --test tests/`。
  AI モードの実接続は `services/tex64-ai` で `npm run dev` を起動して確認。
