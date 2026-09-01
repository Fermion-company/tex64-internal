# TeX64 デスクトップのモード状態

デスクトップ版は現在 **Code ワークスペースのみ**を提供する。トップバーにモード切替は表示せず、
保存済みの `tex64.appMode.v1` が `ai` でも Code で起動する。

Code ではソース編集、通常 PDF / Live プレビュー、TikZ 作図、左サイドバーの Axiom チャットを使える。
Basic / Pro の課金、利用量表示、Checkout、Customer Portal も Code 側の機能として維持する。

## AI モードの扱い

`services/tex64-ai` と埋め込み用の関連実装は、将来の再検証に備えてコードベース内に保持する。
ただし公開デスクトップでは次を満たすこと。

- `Resources/web/index.html` に Code | AI スイッチャーを置かない。
- AI workspace の `<webview>` ホストを置かない。
- renderer 起動時に `initAiModeUi` を呼ばず、AI サービスへ接続しない。
- Live プレビューには常に `code` モードを渡す。

AI モードを再公開する場合は、認証・課金・利用枠・Checkout後の反映・実ファイル編集・組版・停止・
エラー回復を本番相当で一通り検証したうえで、モード切替、AI surface、初期化配線、ドキュメントを
同じ変更で戻す。

## 実装上の注意

- renderer は `web-src/` を編集し、`Resources/web/**/*.js` は `tsc` で生成する。
- `Resources/web/index.html` と `Resources/web/theme.css` は直接編集する。
- 無効状態の回帰確認は `tests/app-mode.test.mjs` が担う。
