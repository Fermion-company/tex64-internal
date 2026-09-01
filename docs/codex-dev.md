# Codex バックエンド（ChatGPTサブスクでAIチャットを使う）— dev での使い方

TeX64 のAIチャットを、自分の ChatGPT サブスク（Codex枠）で動かせます。tex64.com のログインもトークン枠も不要です。

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

## 使い方

1. `npm run dev` で TeX64 を起動
2. トップバーのモードは **Code**（既定）のまま。左サイドバーの **Axiom アイコン**をクリックして
   AIチャットのパネルを開く
3. パネル上部のモデル選択（既定は「Axiom 1.0」）から **「Codex (ChatGPT)」** を選ぶ
4. あとは普通にチャットするだけ。編集・ビルド・差分表示は Axiom と同じUIで動く

`codex login` を飛ばした場合も、初回送信時にブラウザでログインが自動で開きます。

### ⚠️ トップバーの「AI」モードとは別物

トップバーの **AI** は別サーフェス（`services/tex64-ai` を webview で埋め込む文書エージェント）で、
Codex とは無関係です。`npm run dev` はこのサーバーを起動しないため、AI モードを押すと
`http://localhost:3100` への接続エラーになります。AI モードを使いたいときだけ、別ターミナルで:

```bash
cd services/tex64-ai && npm run dev
```

| | Codex (ChatGPT) | AI モード |
|---|---|---|
| 場所 | Code モード内の Axiom パネル | トップバーの `AI` タブ |
| 実体 | ローカル Codex app-server（`electron/services/codex/`） | `services/tex64-ai`（Next、`:3100`） |
| 起動 | `npm run dev` だけでよい | `cd services/tex64-ai && npm run dev` が別途必要 |
| 対象 | 手元の LaTeX ワークスペース | 埋め込みアプリ自身が持つ文書 |

### パネル横の「TeX64 Login」について

モデル選択の隣に出るのは **TeX64（tex64.com）アカウント**のログインで、ChatGPT のログインとは別物です。
`Codex (ChatGPT)` を選んでいる間は TeX64 ログインもトークン枠も不要なので、未ログインのままで動きます。

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
