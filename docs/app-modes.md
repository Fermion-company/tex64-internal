# TeX64 アプリモード設計書（Code | AI | Pro）

トップバー左側（サイドバートグルの右隣）のピル型スイッチャーで、1 つのアプリに 3 つの顔を持たせる。
2026-08-12 に導入。Pro モードの内部設計は [pro-mode-design.md](./pro-mode-design.md) を参照。

```
+----------------------------------------------------------+
| [sidebar] ( </> Code | ✦ AI | ▦ Pro )        [actions]   |
+----------------------------------------------------------+
```

スイッチャーは `.topbar-left` 内に固定。モードによって右側のアクション群が増減しても
位置がズレない。AI モードではサイドバートグルを `visibility: hidden` にして
（`display: none` ではなく）スイッチャーの x 座標を完全に固定する。

## 3 つのモード

| モード | 中身 | 対象ユーザー |
| --- | --- | --- |
| **Code** | 従来の LaTeX エディタ（起動時デフォルト） | ライトユーザー |
| **AI** | tex64-ai 文書エージェント（`services/tex64-ai` を埋め込み） | 文書を「依頼して作る」人 |
| **Pro** | 分割レイアウト・範囲キャプチャ・スタッシュ・ライブプレビュー（KKTeX 担当） | TeX を直接書くプロ |

## 実装の要点

- 状態は `web-src/app/app-mode.ts` が管理。`<html data-app-mode="code|ai|pro">` を立て、
  `localStorage["tex64.appMode.v1"]` に永続化。表示切替は `theme.css` の属性セレクタ。
- 旧 Pro トグル（`tex64.proMode.v1`.enabled）は初回起動時に移行される（ON なら Pro モードで開始）。
- Pro の有効/無効はスイッチャーが `initProModeUi(...).setEnabled()` を通じて駆動する。
  レイアウト①②・ペイン比率などの Pro 内部状態は従来どおり `tex64.proMode.v1`。
- モード切替でエディタ状態は破棄されない（Code/Pro は同じエディタの表示切替、AI は別サーフェス）。

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

- **Code**: 従来どおりサイドバーのファイルツリー。画像/PDF はエディタ領域のビューアで開く。
- **Pro**: ファイルツリーは共通。ただし画像/PDF をツリーで選ぶと、エディタを潰さずに
  **見えているビューアペイン**（レイアウト①: Preview、レイアウト②: Reference）へ表示し、
  折り畳まれていれば自動展開、ペインヘッダーにファイル名を表示する
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
