# Codex バックエンド — 開発者向けの互換経路

Codex app-server 経路は既存ユーザー設定との互換と開発検証のため内部に残している。
**製品 UI には出さない**。ユーザーが選べるモデルは Code / AI とも
`Axiom1.0` と Pro 限定の `Axiom1.0-pro` の2つで、認証・利用枠・課金も共通である。

## 対象ブランチ

Codex バックエンドは `main` にあります。`dev` は追従していないことがあるので、
手元が `dev` のままだと `git pull` しても機能が入りません（`Already up to date.` と出ます）。

```bash
git switch main && git pull --ff-only
```

ブランチの役割は [branching.md](branching.md) を参照。

## 準備（初回だけ・2分）

```bash
npm i -g @openai/codex
codex login   # ブラウザで ChatGPT にログイン（有料プラン必須）
```

## 開発時の使い方

1. `npm run dev` で TeX64 を起動
2. userData の `tex64-user-settings.json` で `agent.model` を `codex` にする
3. トップバーは **Code** のまま、左サイドバーの **Axiom アイコン**からチャットを開く
4. 編集・ビルド・差分表示を検証する

`codex login` を飛ばした場合も、初回送信時にブラウザでログインが自動で開きます。

### トップバーの「AI」モードとは別物

トップバーの **AI** は別サーフェス（`services/tex64-ai` の UI を webview で埋め込む文書エージェント）で、
Codex 経路は使わず必ずプラットフォーム Axiom を使う。パッケージ版は Next standalone を同梱して
Electron が動的 loopback port で起動するため、別プロセスを手で立ち上げる必要はない。

開発版で AI UI だけを単独起動するときは:

```bash
cd services/tex64-ai && npm run dev
```

| | 内部 Codex 経路 | AI モード |
|---|---|---|
| 場所 | Code モード内の Axiom パネル | トップバーの `AI` タブ |
| 実体 | ローカル Codex app-server（`electron/services/codex/`） | `services/tex64-ai`（Next、`:3100`） |
| 起動 | `npm run dev` | パッケージ版は自動。単独開発時だけ `services/tex64-ai` を起動 |
| 対象 | 手元の LaTeX ワークスペース | Code と同じ LaTeX ワークスペース |

内部 Codex 経路だけは開発者自身の ChatGPT 認証を使う。通常の製品動作では TeX64 アカウントと
匿名 Free 枠を使い、UI から Codex へ切り替えることはできない。

## 補足

- 枠が切れたときは OpenAI 側のエラーメッセージがそのままチャットに出ます（回復時刻付き）
- モデルを固定したいときは userData の `tex64-user-settings.json` の `agent` に
  `"codexModel": "gpt-5.3-codex-spark"` のように追記（UIは未提供の隠し設定）
- Codex は sandbox 内で直接ファイルを書きます。書き込み後はファイルツリーを更新し、
  チャットの最終回答に出るファイル名（Codex の `codex-file-citation`）は
  ワークスペース相対のリンクに変換してエディタで開けるようにしています
  （`electron/services/codex/axiom-adapter.cjs`）
- エディタに出る `元に戻す / 完了` バーは**事後確認**です。Codex/Axiom はどちらも承認前に
  ディスクへ書き、必要なら自動ビルドまで走ります。`完了` は差分表示を閉じるだけ、
  `元に戻す` は取り消したうえでファイルを保存し直します
- 実装は `electron/services/codex/`（app-server クライアント／サービス／Axiomアダプタ）。
  Axiom 経路（openprism）は無変更で並走
