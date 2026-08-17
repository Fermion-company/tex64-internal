# Codex バックエンド（ChatGPTサブスクでAIチャットを使う）— dev での使い方

TeX64 のAIチャットを、自分の ChatGPT サブスク（Codex枠）で動かせます。tex64.com のログインもトークン枠も不要です。

## 準備（初回だけ・2分）

```bash
npm i -g @openai/codex
codex login   # ブラウザで ChatGPT にログイン（有料プラン必須）
```

## 使い方

1. `npm run dev` で TeX64 を起動
2. AIチャット右上のモデル選択で **「Codex (ChatGPT)」** を選ぶ
3. あとは普通にチャットするだけ。編集・ビルド・差分表示は Axiom と同じUIで動く

`codex login` を飛ばした場合も、初回送信時にブラウザでログインが自動で開きます。

## 補足

- 枠が切れたときは OpenAI 側のエラーメッセージがそのままチャットに出ます（回復時刻付き）
- モデルを固定したいときは userData の `tex64-user-settings.json` の `agent` に
  `"codexModel": "gpt-5.3-codex-spark"` のように追記（UIは未提供の隠し設定）
- 実装は `electron/services/codex/`（app-server クライアント／サービス／Axiomアダプタ）。
  Axiom 経路（openprism）は無変更で並走
