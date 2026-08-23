# TeX64 文書作成サービス

自然文の依頼から、構成・本文・検査・PDFまでを一続きで作るサービスです。
**利用者の既定の視界は紙面（PDF）** で、ソースを読まずに書き進められることを目指します。
ソースを見せないこと自体が目的ではありません（見たい人には見せてよい）。

> **移行中**: 正本をこのサービスの構造化文書から、ワークスペースの `.tex` へ移します。
> [docs/ai-mode-local-files.md](../../docs/ai-mode-local-files.md) を参照。以下は移行前の説明です。

体験の骨格:

- **会話 1 ターン = エージェントループ 1 回**: 送信すると `POST /documents/:id/messages` が
  1 回だけエージェントを回します。書くか、直すか、ただ答えるかは**モデルが決めます**。
  意図を分類する事前処理も、要件票や執筆計画を作る固定パイプラインもありません。
- **会話が続く**: スレッド全体（発言・ツール呼び出し・ツール結果）が毎ターンそのままモデルへ渡ります。
  質問・相談・雑談に文章だけで答えて終わるのは正常な結果で、文書は変わりません。
- **逐次表示と中断**: 返答は書かれる端から流れ、いま動かしているツールが見えます。
  停止ボタンで実行中のターンを切れ、実行中でも次のメッセージを送って順番待ちにできます。
- **組版はエージェントの手にある**: 内容を変えたターンは自分で `compile_document` を実行して紙面を更新します。
  失敗したら組版の指摘を読んで直します（呼び忘れた場合だけ、サーバー側が最後に 1 回だけ組版します）。
- **紙面が主サーフェス**: コンパイル済みPDFをアプリ内ビューアで常設表示。SyncTeX由来の要素マップで、PDF上の節・段落・数式・図表をクリックして選択→AIへの依頼のスコープにしたり、その場で直接編集できる。
- **常に生きている紙面**: 手動編集や版の復元後は現在の版を自動で再コンパイル（`POST /compile`）。失敗しても直前の紙面を保持し、ワンクリックでAIに修復を依頼できる。
- **巻き戻し**: 変更履歴パネルから任意の版を新しい版として復元（`POST /restore`）。

## ローカル起動

必要なもの:

- Node.js 22.14以上
- LuaLaTeX（macOSではMacTeXを想定）

```bash
cp .env.example .env.local
npm install
npm run dev
```

`http://localhost:3100` で起動します。モデルの認証情報（`AI_GATEWAY_API_KEY` または `OPENAI_API_KEY`）と
`TEX64_AI_MODEL` が無い場合、ターンは代替処理へ退避せずその場で失敗します。

## ネイティブ埋め込み（TeX64 デスクトップの AI モード）

このアプリは独立した Web サービスであると同時に、TeX64 デスクトップアプリの **AI モード**（トップバーの Code | AI | Pro 切り替え）に `<webview>` として埋め込まれます。単一のコードベースが両方の顔を持ちます。

- デスクトップ側は `electron/ai-web-preload.cjs` が `window.tex64Native` を注入し、`<html data-platform="native">` が立ちます。
- ネイティブ判定は `src/app/layout.tsx` のインラインスクリプトが `window.tex64Native` を見て `data-platform="native"` を立てる方式です。ネイティブ分岐は必ず `[data-platform="native"]` CSS に集約してください。それ以外の場所に散らさないこと。
- 接続先 URL は デスクトップ側の設定 `aiWeb.url`（`tex64-user-settings.json`）→ 環境変数 `TEX64_AI_WEB_URL` → 既定値（開発: `http://localhost:3100`、パッケージ版: `https://ai.tex64.com`）の順で解決されます。本番 URL が決まったら `electron/services/ai-web.cjs` の `DEFAULT_HOSTED_URL` を更新してください。
- 開発時は `npm run dev` でこのサーバーを起動しておけば、デスクトップの AI モードがそのまま接続します。

## 構成

- `src/domain/document`: 生成ソースを含まない文書モデル、検証、意味的な差分、決定的レンダラー
  （レンダラーは各ノードを `%%T64B:/%%T64E:` コメントで挟み、SyncTeX と突き合わせて
  PDF要素マップを作る。レイアウトへの影響はゼロ。将来 .tex を書き出す場合はこの行を除去する）
- `src/server/agent`: 会話ターンの実行（`turn.ts`）、エージェントのツール（`document-tools.ts` /
  `tool-handlers.ts`）、system instructions、モデル選択
- `src/server/persistence`: ローカルJSONまたはPostgresの文書・版・会話スレッド・ターン・成果物メタデータ
- `src/server/compiler`: ローカルLuaLaTeXまたはネットワーク遮断Sandboxでの組版
  （`synctex-regions.ts` が SyncTeX 出力からノード→PDF矩形のマップを生成）
- `src/server/artifacts`: ローカル保存またはVercel Blobの非公開PDFと要素マップ
  （配信は release 済みPDFに加え、所有者本人の current revision の draft も
  `/preview`・`/regions` で見える。release 境界そのものは不変）

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
ローカル開発では、gateway認証を設定せずに `OPENAI_API_KEY` を置くと、同じ `openai/...` のモデルIDをOpenAI APIへ直接送る直結トランスポートに切り替わります（gateway専用機能の `search_sources` とPDF視覚レビューは明示的に縮退）。`TEX64_AI_STRUCTURED_MODEL` を設定すると、条件抽出・執筆計画などの構造化呼び出しだけを別モデルで実行できます。
匿名アクセスを本番で有効にするには `TEX64_ALLOW_ANONYMOUS_PRODUCTION=true` が必要です。ブラウザcookieは本人確認ではないため、公開前はVercel Deployment Protectionなどで利用者を限定してください。実行枠はPostgres上でidentity・network・service全体の3段階を原子的に消費し、同じ実行キーの再送では再消費しません。`TEX64_IDENTITY_RUNS_PER_HOUR` と `TEX64_NETWORK_RUNS_PER_HOUR` は省略時に安全な既定値を使いますが、service全体の `TEX64_GLOBAL_RUNS_PER_HOUR` は必須です。
モデル名またはモデルの認証が欠けている場合は、品質を偽装するテンプレート処理へ切り替えず、そのターンを安全に失敗させます（本番・開発とも同じ）。

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
