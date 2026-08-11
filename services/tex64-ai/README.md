# TeX64 文書作成サービス

自然文の依頼から、構成・本文・検査・PDFまでを一続きで作る独立Webサービスです。利用者は文書を直接編集できますが、生成ソースは画面やAPIへ公開しません。

## ローカル起動

必要なもの:

- Node.js 22.14以上
- LuaLaTeX（macOSではMacTeXを想定）

```bash
cp .env.example .env.local
npm install
npm run dev
```

`http://localhost:3100` で起動します。AI Gatewayの認証情報がないローカル環境では、決定的な代替処理で文書作成フローを確認できます。
`npm run dev` だけがローカルWorkflow用の開発markerを設定します。本番起動scriptはこのmarkerを明示的に無効化し、`WORKFLOW_TARGET_WORLD=local` だけではローカルcompiler・保存先・代替生成へ切り替わりません。

## 構成

- `src/domain/document`: 生成ソースを含まない文書モデル、検証、意味的な差分、決定的レンダラー
- `src/server/agent`: 文書の読取・変更・検査・質問・承認ポリシー
- `src/workflows/document-agent`: 再試行可能な長時間実行、進捗、修復、完成処理
- `src/server/persistence`: ローカルJSONまたはPostgresの文書・版・実行・成果物メタデータ
- `src/server/compiler`: ローカルLuaLaTeXまたはネットワーク遮断Sandboxでの組版
- `src/server/artifacts`: ローカル保存またはVercel Blobの非公開PDF

## 本番設定

本番では次の値を必須にします。

```dotenv
TEX64_SESSION_SECRET=<32文字以上のランダム値>
DATABASE_URL=<Postgres接続文字列>
TEX64_AI_MODEL=openai/gpt-5.6-sol
TEX64_SANDBOX_IMAGE=tex64-texlive:latest
TEX64_ALLOW_ANONYMOUS_PRODUCTION=true
TEX64_GLOBAL_RUNS_PER_HOUR=<サービス全体の1時間あたり上限>
```

Vercel上ではAI Gateway、Blob、Sandboxの認証に実行時OIDCを利用するため、OIDC tokenを環境変数へ保存する必要はありません。Vercel外では `AI_GATEWAY_API_KEY`、`BLOB_READ_WRITE_TOKEN`、`VERCEL_TOKEN`、`VERCEL_TEAM_ID`、`VERCEL_PROJECT_ID` を設定し、信頼するリバースプロキシが必ず上書きするIP header名を `TEX64_TRUSTED_CLIENT_IP_HEADER` に設定してください。
匿名アクセスを本番で有効にするには `TEX64_ALLOW_ANONYMOUS_PRODUCTION=true` が必要です。ブラウザcookieは本人確認ではないため、公開前はVercel Deployment Protectionなどで利用者を限定してください。実行枠はPostgres上でidentity・network・service全体の3段階を原子的に消費し、同じ実行キーの再送では再消費しません。`TEX64_IDENTITY_RUNS_PER_HOUR` と `TEX64_NETWORK_RUNS_PER_HOUR` は省略時に安全な既定値を使いますが、service全体の `TEX64_GLOBAL_RUNS_PER_HOUR` は必須です。
決定的な代替処理はローカル開発専用です。本番でモデル名またはAI Gatewayの認証が欠けている場合は、品質を偽装するテンプレート処理へ切り替えず、その実行を安全に失敗させます。

データベースへは、アプリ起動前に[永続化migrationの手順](./src/server/persistence/migrations/README.md)に従い、番号付きSQLを順番にすべてmigration用roleで適用します。実行roleにはDDL権限や`BYPASSRLS`を与えないでください。

### 組版イメージ

[`infra/texlive/Dockerfile`](./infra/texlive/Dockerfile) をOCI imageとしてVercel Container Registryへpushし、リポジトリ名とタグを `TEX64_SANDBOX_IMAGE` に設定します。

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --push \
  -t vcr.vercel.com/<team>/<project>/tex64-texlive:latest \
  infra/texlive
```

本番組版は短命なmicroVM内でネットワークを遮断し、shell escapeを無効化します。PDFは32 MiBまでに制限し、形式とハッシュを保存時・読取時に確認します。

## 品質確認

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

現在のセッションは署名付きHttpOnly cookieによるブラウザ単位の作業領域です。組織アカウント、端末間同期、共有権限が必要な公開運用では、`requireSession` を利用する認証基盤のユーザーIDへ接続してください。
