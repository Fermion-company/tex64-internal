# 配布（Release / Distribution）

tex64 は Electron アプリとして配布します（インストーラ/アプリバンドルを生成）。
現時点の公開対象は **macOS のみ** です。

## 前提

- Node.js / npm（CI は Node 20）
- `npm ci`
- TeX Distribution は **同梱しない**（ユーザー側で TeX Live / MacTeX / BasicTeX などが必要）
- `npm run -s dist:bootstrap`（macOS の場合。アイコン/entitlements を生成）
- 初回DL→課金→利用開始の運用E2Eは `docs/operations-e2e-checklist.md` を使用

## ローカルで配布物を作る

まず配布に必要なファイル（アイコン/NOTICE 等）を用意してからパッケージします。

### DMG の見た目（背景）

TeX64 の DMG は、Finder の背景を `assets/dmg/background.png`（+ `assets/dmg/background@2x.png`）でカスタマイズしています。

- ソース: `assets/dmg/background.html`
- 再生成: `npm run -s dmg:background`

また、`/Applications` へのショートカットは DMG 生成時に作成します。

補足: Electron-builder は Apple Silicon で **APFS DMG** を作ることがあり、最近の macOS で Finder の背景が表示されないケースがあります。
そのため `npm run -s release:mac`（署名/Notarization 含む）では、`scripts/build-macos-dmg.cjs` で **HFS+ DMG** を生成して背景/UIを安定させています。

```bash
npm run electron:pack
```

- `dist/` に unpacked アプリ（`--dir`）が生成されます。
- 起動確認用途（本番配布より速い）。

配布用（インストーラ等）を作る:

```bash
npm run electron:dist
```

- 現在は macOS のみ配布するため、`electron:dist` / `electron:dist:mac` のどちらでも macOS 配布物を生成します。

### 公開向け（macOS）

```bash
npm run electron:dist:mac
```

配布物（`dist/*.dmg` / `dist/*.zip`）から、公開用の補助ファイルを作る（tex64.com 連携用）:

```bash
npm run -s release:bundle
```

- `release/checksums-sha256.txt` と `update/stable.json` を生成します。

## 初回導入（macOS）

1. `TeX64-<version>-mac-<arch>.dmg` を開く
2. `TeX64.app` を `Applications` にドラッグ
3. `Applications` から起動し、Settings > 実行環境で `lualatex` / `latexmk` / `latexindent` / `synctex` を確認

### 初回起動でブロックされた場合

- 正式リリースでは署名 + Notarization によりブロックされない前提
- 署名前の開発版でのみ回避が必要な場合は、Finder の「開く」から許可する

## 重要: ネイティブ依存（Math OCR / onnxruntime）

- `onnxruntime-node` はネイティブバイナリを含むため、ASAR 内だと動かないファイルがあります。
- `Resources/math-ocr/*`（モデル）も実ファイルパスが必要です。
- そのため `package.json` の `build.asarUnpack` で `Resources/math-ocr/**` とネイティブ拡張子（`.node/.dll/.dylib/.so*`）を unpack 対象にしています。

## 署名 / Notarization（公開必須）

TeX64 を一般配布（Gatekeeper を通す）するには、macOS の **Developer ID 署名 + Notarization** が必須です。

- macOS: Developer ID 署名 + Hardened Runtime + Notarization（必須）

### 署名（Developer ID）

- 必要な証明書: **Developer ID Application**
- Electron 側の要件として Hardened Runtime を有効にし、JIT 等に必要な entitlements を付与します。
  - `build/entitlements.mac.plist`
  - `build/entitlements.mac.inherit.plist`

### Notarization（notarytool）

electron-builder は、次のいずれかの認証情報がある場合に Notarization を実行します（未設定ならスキップ）。

1) Apple ID + App-Specific Password:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

2) App Store Connect API key:

- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

3) keychain profile（推奨）:

- `APPLE_KEYCHAIN_PROFILE`（必要なら `APPLE_KEYCHAIN` も）

### ローカルで「署名 + Notarization + 検証」まで通す（macOS）

GitHub Actions が使えない/使わない場合でも、macOS だけならローカルで完結できます。

前提:

- Xcode Command Line Tools（`xcrun notarytool` が使えること）
- Developer ID Application 証明書が Keychain にあること

手順（keychain profile 推奨）:

1. notarytool の認証情報を Keychain に保存

```bash
xcrun notarytool store-credentials tex64-notary \
  --apple-id "<your-apple-id>" \
  --team-id "<your-team-id>" \
  --password "<app-specific-password>"
```

2. 環境変数を設定してリリースビルド（署名/Notarization/検証まで実行）

```bash
export APPLE_KEYCHAIN_PROFILE=tex64-notary
# （任意）update feed 生成用。未指定なら https://downloads.tex64.com を使います。
export TEX64_DOWNLOADS_PUBLIC_BASE_URL=https://downloads.tex64.com
# （任意）arm64/x64。未指定なら実行環境に合わせます。
export TEX64_RELEASE_ARCH=arm64
# （任意）notarytool の待機タイムアウト（デフォルト: 120m）
export TEX64_NOTARY_TIMEOUT=180m
npm run -s release:mac
```

`release:mac` は以下を実施します:

- `web:build` → `electron-builder --mac --dir`（署名済み `.app` を生成）
- `ditto` で Notarization 用 zip を作成 → `notarytool submit --wait` で Notarization 完了まで待機
- `xcrun stapler staple/validate` で ticket を stapling
- stapled `.app` から `dmg/zip` を生成（`--prepackaged`。再署名しない）
- `release/`（配布物 + `checksums-sha256.txt`）と `update/stable.json`（update feed）を生成

※このスクリプトは **アップロードはしません**（アップロードは最後に行う想定）。

### GitHub Actions を使わず手動公開する（R2 / S3）

`release:mac` 実行後に、ローカルから `downloads.tex64.com` へ公開します。

```bash
export TEX64_DOWNLOADS_PUBLIC_BASE_URL=https://downloads.tex64.com
export TEX64_DOWNLOADS_BUCKET=tex64-downloads
export TEX64_DOWNLOADS_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export TEX64_DOWNLOADS_REGION=auto
export AWS_PROFILE=tex64-r2

npm run -s release:upload-downloads -- --version 0.1.0
npm run -s release:go-no-go -- --version 0.1.0
```

- `TEX64_DOWNLOADS_ENDPOINT` は **バケットを含まない endpoint** を設定する（例: `...r2.cloudflarestorage.com`）。
- `release:upload-downloads` は `release/` と `update/stable.json` を `tex64/vX.Y.Z/` と `tex64/updates/stable.json` へ配置する。
- `release:go-no-go` は `downloads.tex64.com` と `tex64.com` の manifest/redirect の整合を検証する。
- 単一archのみ公開する場合は `release:go-no-go -- --archs arm64`（または `x64`）を指定する。

## CI（GitHub Actions）

- タグ push（例: `v0.1.0`）で **macOS 向けのみ** ビルドし、`downloads.tex64.com`（S3/R2 等のオブジェクトストレージ + CDN）へ配布物をアップロードします。
- 公開対象: `dmg/zip`
- 併せて `checksums-sha256.txt` を生成してアップロードします（自動アップデートの sha256 用）。
- さらに `tex64/updates/stable.json` を生成してアップロードします（`tex64.com` の update manifest が参照）。

### downloads.tex64.com へアップロードするための Secrets（GitHub Actions）

`.github/workflows/release.yml` は次の secrets を参照します（S3 互換を想定。Cloudflare R2 も可）。

- `TEX64_DOWNLOADS_PUBLIC_BASE_URL`（例: `https://downloads.tex64.com`）
- `TEX64_DOWNLOADS_BUCKET`（バケット名）
- `TEX64_DOWNLOADS_ACCESS_KEY_ID`
- `TEX64_DOWNLOADS_SECRET_ACCESS_KEY`
- `TEX64_DOWNLOADS_ENDPOINT`（任意。R2 等の S3 互換 endpoint。AWS S3 の場合は空で OK）
- `TEX64_DOWNLOADS_REGION`（任意。R2 の場合は `auto`、AWS の場合は `us-east-1` など）
- （補足）タグリリース時は GitHub Releases に `release/*`（`dmg/zip` + `checksums-sha256.txt`）も自動添付される（追加 secret 不要）

### downloads.tex64.com の疎通（R2 / S3）

リリース前に「アップロードできる」「公開 URL から読める」ことだけ先に確認する場合は、
GitHub Actions の `Downloads Smoke Test`（`.github/workflows/downloads-smoke.yml`）を手動実行します。

- 成功すると `https://downloads.tex64.com/health.txt` が取得できる（`ok` などが表示される）

### 署名用 Secrets（公開タグでは必須）

- macOS code signing:
  - `TEX64_MACOS_CERT_P12_BASE64`（Developer ID Application 証明書の p12 を base64 化）
  - `TEX64_MACOS_CERT_PASSWORD`
- macOS notarization:
  - `TEX64_APPLE_ID`
  - `TEX64_APPLE_APP_SPECIFIC_PASSWORD`
  - `TEX64_APPLE_TEAM_ID`

## リリース手順（推奨チェックリスト）

1. **バージョンを決める**（例: `0.1.0`）
2. **（任意）サイトのリリースノートを更新**（`tex64.com/src/content/releases.js`）
3. **タグを作成して push**

```bash
git tag -a v0.1.0 -m "TeX64 v0.1.0"
git push origin v0.1.0
```

4. GitHub Actions（`Build Distributables`）が完走し、`downloads.tex64.com` で配布物 + `checksums-sha256.txt` + `tex64/updates/stable.json` が見えることを確認
5. `tex64.com` 側の env を設定:
   - `NEXT_PUBLIC_TEX64_DOWNLOADS_PUBLIC_BASE_URL=https://downloads.tex64.com`
   - `TEX64_GITHUB_RELEASE_REPO=<owner>/<repo>`（任意: GitHub Releases を参照する場合）
   - `TEX64_UPDATE_SOURCE_PRIORITY=remote-first`
   - `TEX64_UPDATE_REMOTE_BASE_URL=https://downloads.tex64.com/tex64/updates`
6. `checksums-sha256.txt` を `tex64.com` に取り込む:

```bash
cd /Users/wedd/tex64.com
npm run -s release:import-checksums -- --version 0.1.0 --file /path/to/checksums-sha256.txt
```

7. `tex64.com` 側で `/api/v2/updates/manifest` が配布物 URL / sha256 を返せる状態か確認（下記の連携方法）
8. アプリで更新チェック → ダウンロード → 検証 → インストーラ起動まで動作確認
9. アナウンス（tex64.com / X / Discord など）
10. `LICENSE` と `NOTICE.md`（`npm run -s legal:notice` で更新）を配布物に同梱していることを確認

## 運用 Runbook（macOS 公開）

### 役割（最低限）

- Release owner: タグ作成、Go/No-Go 判定、公開宣言
- Operator: GitHub Actions 監視、`downloads.tex64.com` 反映確認、`tex64.com` 連携
- Verifier: 実機で更新導線を検証（既存版 -> 新版）

### Go/No-Go 判定

- `Build Distributables` が成功し、`dmg/zip` と `checksums-sha256.txt` と `tex64/updates/stable.json` が公開済み
- `tex64.com` の update manifest が `artifactUrl` と `artifactSha256` を返す
- 既存版アプリで「更新確認 -> ダウンロード -> 検証 -> インストーラ起動」が通る
- 主要導線（起動、ビルド、Google OAuth サインイン）が回帰していない

自動チェック:

```bash
npm run -s release:go-no-go -- --version 0.1.0 --channel stable
```

### ロールバック

- `stable.json` を直前版へ戻す（`latestVersion` / `artifactUrl` / `artifactSha256` を前バージョンへ）
- 破損配布物を `downloads.tex64.com/tex64/vX.Y.Z/` から退避または差し替え
- `tex64.com` リリースノートに障害情報と復旧見込みを追記

## アップデート配信時の必須項目

- `GET /updates/manifest` には `artifactUrl` に加えて `artifactSha256`（推奨）を含める。
- アプリはダウンロード後に `sha256` を検証し、一致しない場合は適用しない。
- macOS のアプリ内アップデートは `.zip` を使用（初回導入は `.dmg`）。`stable.json` には `dmg/zip` の両方を載せ、manifest 側で `kind` を選択します。

配布物から `sha256` を作る（単体）:

```bash
npm run -s release:artifact-hash -- \
  --file dist/TeX64-0.1.0-mac-arm64.dmg \
  --url https://downloads.tex64.com/tex64/v0.1.0/TeX64-0.1.0-mac-arm64.dmg
```

（古い方式）出力される `TEX64_UPDATE_*` を `tex64.com` の環境変数（Production）へ設定する。

配布物から `sha256` をまとめて作る（複数）:

```bash
npm run -s release:checksums -- --dir dist --version 0.1.0 --out dist/checksums-sha256.txt
```

## tex64.com 側の update manifest 連携（推奨）

`tex64.com` の `GET /api/v2/updates/manifest` は、`TEX64_UPDATE_SOURCE_PRIORITY=remote-first` の場合、
`TEX64_UPDATE_REMOTE_BASE_URL`（`${base}/{channel}.json`）を優先して配布物 URL / sha256 を解決し、
不足時は GitHub Releases（`TEX64_GITHUB_RELEASE_REPO`）をフォールバックで参照します。

- `TEX64_GITHUB_RELEASE_REPO=<owner>/<repo>`
- `TEX64_UPDATE_SOURCE_PRIORITY=remote-first`
- `TEX64_UPDATE_REMOTE_BASE_URL=https://downloads.tex64.com/tex64/updates`
- CI が `tex64/updates/stable.json` を更新するため、GitHub障害時も `downloads` 経由で継続可能

## 配布後にユーザーが使い始めるまでの完全監査（2026-02-21）

この章は「配布したアプリを新規ユーザーがインストールし、初回起動して、AI機能（OAuth/課金含む）を使い始めるまで」に必要な項目を、リポジトリ全体の実装ベースで棚卸ししたものです。

監査対象:

- `electron/**`
- `web-src/**`
- `Resources/web/**`
- `api/**`
- `docs/**`
- `tests/**`
- `.github/workflows/**`
- `package.json`
- `README.md`

判定ルール:

- 「実装済み」: このリポジトリ内のコードで動作実装が確認できる
- 「未実装」: このリポジトリ内に実装が存在しない（仕様/計画のみ）
- 「要修正」: 実装はあるが、利用開始導線として欠け・不整合がある

### 総合判定

- macOS配布、初回起動、ローカル編集/ビルドの導線は概ね成立
- ただし、ユーザーがAI有料利用を開始する導線（ユーザーDB/決済連携/権限反映）はこのリポジトリだけでは完結していない
- さらに、ランチャーと環境インストール導線に「初回体験を阻害する欠け」が残っている

### 1. OAuth 認証（Google）

実装済み:

- OAuth開始/交換/更新/サインアウト:
  - `electron/services/platform-access.cjs`
  - `startGoogleAuth`（`/auth/google/start`）
  - `completeGoogleAuthFromCallback`（`/auth/google/exchange`）
  - `refreshAccessToken`（`/auth/refresh`）
  - `signOut`（`/auth/logout`）
- Deep Link callback 受信:
  - `electron/main.cjs`（`tex64://oauth/callback` を `open-url` / `second-instance` で処理）
- 認証UIイベント:
  - `web-src/app/ai-chat-ui.ts`（`auth:google:start`, `auth:google:cancel`, `auth:signout`）
  - `electron/main.cjs`（IPCルーティング）
- URLスキーム登録:
  - `package.json` の `build.protocols`（`tex64`）

要注意（要件として未完了になり得る点）:

- OAuth バックエンドは `api/v2/auth/*` として実装済みだが、本番では `DATABASE_URL` と Google OAuth credential の設定が必須
- `TEX64_PLATFORM_STATE_FALLBACK` を本番で有効化しない（開発向け）

### 2. ユーザー情報DB（アカウント永続化）

実装済み（接続設定が必要）:

- `api/v2/_lib/db-adapter.js` で Postgres 永続化を実装
  - `tex64_users`, `tex64_subscriptions`, `tex64_usage`
  - `tex64_auth_requests`, `tex64_refresh_tokens`
- `api/v2/me/features`, `api/v2/me/usage/ai`, `api/v2/ai/*`, `api/v2/auth/*` は DB-first で動作
- `DATABASE_URL` 未設定時は `TEX64_PLATFORM_STATE_FALLBACK=true` の場合のみ JSON fallback

現状の保存先（ローカル）:

- 認証セッション: `electron/services/platform-access.cjs` → `tex64-platform-session.json`
- ユーザー設定/最近のプロジェクト: `electron/services/user-settings.cjs` → `tex64-user-settings.json`

セキュリティ注意点:

- セッションファイルは `0600` 保存（権限は適切）
- `safeStorage` が使えない場合はトークン暗号化が平文フォールバックになる設計

出荷前に必要なこと:

- `DATABASE_URL` 接続先の本番運用（バックアップ/監視/権限分離）
- Stripe Webhook から `POST /api/v2/internal/subscription` を呼んで subscription 状態を同期
  - `X-Tex64-Webhook-Source` / `X-Tex64-Event-Id` で冪等キーを送る
- クライアントの `me/features`, `me/usage`, `auth/refresh` の実運用検証

追記（2026-02-23）:

- このリポジトリに `api/v2` の entitlement/quota ロジックを追加済み
  - `GET /api/v2/me/features?names=ai`
  - `GET /api/v2/me/usage/ai?period=current_month`
  - `POST /api/v2/ai/chat`, `POST /api/v2/ai/completion`
  - `POST /api/v2/internal/subscription`（Webhook等からの状態反映用）
- ただし、Stripe本体と外部DB接続は引き続き別実装（この監査章の「未実装」判定範囲）

### 3. Stripe 等の課金導線

未実装（このリポジトリ内）:

- Stripe SDK/Checkout/Webhook/Customer Portal の実装は見当たらない
- `stripe` / `checkout.session` / `webhook` 等のコード参照は `electron web-src api docs tests package.json README.md` 上でヒットなし

現状実装:

- アプリ内からは pricing ページへ外部遷移するのみ
  - `electron/services/platform-access.cjs`（`getPricingUrl()`）
  - `web-src/app/ai-chat-ui.ts`（`openPricingPage()`）
  - `web-src/app/platform-links.ts`

仕様上の期待（ドキュメントのみ）:

- `docs/ai-subscription-implementation-plan.md`:
  - `active -> grace(3days) -> past_due` の状態遷移
- `docs/platform-api-contract-v2-google-oauth.md`:
  - entitlement/quota/API エラーコードの契約

出荷前に必要なこと:

- サーバーに決済連携（Stripe等）を実装し、支払い状態を `features.ai.enabled` に反映
- Grace/Past Due の遷移と復旧を本番データで検証
- pricing遷移だけでなく、決済完了後にアプリへ戻した際に entitlement が更新される導線を確立

### 4. ランチャー導線（初回UX）

要修正:

- テンプレート選択UIの不整合
  - TS側は `.launcher-template-button` を前提にテンプレート管理
  - HTML側にテンプレートボタンがない
  - CSSはテンプレートセクションを `display: none`
  - 影響: 新規作成テンプレート選択の仕様と実UIが不一致
- ランチャーステータスメッセージが表示されない
  - Main側は `launcherStatus.message` を送信（例: 「フォルダが見つかりません。」）
  - Rendererは受けるが `launcher-ui.ts` の `setStatus` が `message` を描画していない
  - 影響: 失敗理由が見えず、ユーザーが操作不能に見える
- 最近のプロジェクト削除導線が未接続
  - `onRemoveRecent` は定義されているが UI から呼ばれていない
  - 影響: 無効エントリをユーザーが明示削除しにくい
- 無効パス自動除去時の即時UI同期が弱い
  - 存在しない recent を除去しても `recentProjects` 再送がその経路にない
  - 影響: 同期タイミング次第で古い表示が残る可能性

出荷前に必要なこと:

- テンプレートUIの設計を統一（表示するか、機能自体を撤去するか）
- `launcherStatus.message` の表示領域を実装
- recent の削除/自動除去の双方で `recentProjects` を即時再配信

### 5. 実行環境セットアップ（TeX導入）

要修正:

- `electron/services/env.cjs` に MVP コメントが残り、インストールは best-effort 実行
- 自動インストール失敗時は手動コマンド案内へフォールバック
- `env:installStart` / `env:installResult` は Main から送っているが、bridge 側に受信処理がない
  - `web-src/app/bridge-handlers.ts` は `env:checkResult` のみ処理

影響:

- ユーザーはインストール進捗/成否をUIで追えない
- 「1クリック導入」体験として不完全

出荷前に必要なこと:

- install start/progress/result をUI表示
- 権限昇格・失敗時リトライ・手動導線への遷移を仕様化
- macOSに加え将来のWindows配布まで考えるなら、OSごとの確実な導線を定義

### 6. 配布対象と制約

現状:

- 配布対象は macOS のみ（`electron-builder --mac` / release workflow も macOS）
- TeX Distribution は同梱しない（ユーザー側インストール必須）

注意:

- 初回ビルド成功までの体験品質はランタイム導線に強く依存
- macOS以外（Windows/Linux）を対象にする場合は、配布・署名・導入手順を別途整備する必要がある

### 7. テスト不足（利用開始導線）

不足:

- `tests/e2e/implementation-coverage.md` は広範囲だが、以下を明示的に網羅していない
  - OAuth ログイン成功/失敗/キャンセルのE2E
  - 課金状態（active/grace/past_due）別のAI可否E2E
  - 決済復旧後の entitlement 復帰E2E
- OAuth は主に unit レベル（`tests/unit/platform-access-update-manifest.test.mjs`）で確認されている

出荷前に必要なこと:

- 上記3系統のE2Eを追加し、リリースゲートに組み込む

### 8. ドキュメント差分（運用ミスの原因）

要修正:

- `README.md` に記載の E2E 実行コマンド/環境変数が現行 `package.json` とずれている箇所がある
  - 例: `e2e:install`, `e2e`, `TEX180_*` 系の記述

影響:

- 開発者/QAが古い手順で検証し、導線不備を見逃す可能性がある

出荷前に必要なこと:

- README を実際の script/env に合わせる
- 配布前の最終確認手順を1つの Runbook に集約

### 9. セキュリティ・ハードニング（利用開始前に確認）

要確認:

- `Resources/web/index.html` の CSP が `default-src * 'unsafe-inline' 'unsafe-eval' ...` と広い
- OAuth/課金導線を本番公開する段階では、必要最小限の CSP へ絞ることを推奨

### 10. 最終E2E（OAuth→課金→反映）実行手順

`tex64.com` リポジトリで下記を実行する。

1. OAuth/初期entitlement（mock）
   - `npm run -s e2e:auth-billing:smoke -- --mode mock --base-url http://localhost:3000`
2. Checkout URL 発行確認
   - `npm run -s e2e:auth-billing:smoke -- --mode mock --plan basic --base-url http://localhost:3000`
3. 本番系最終確認（Google OAuth + Stripe）
   - `stripe listen --forward-to https://tex64.com/api/v2/billing/webhook`
   - `npm run -s e2e:auth-billing:smoke -- --mode google --oauth-code "<code>" --plan basic --wait-active-sec 180 --base-url https://tex64.com`
   - 合格条件: `features.after.enabled=true` かつ `reason=active|PAYMENT_GRACE`

### 利用開始導線の最終チェックリスト（必須）

以下がすべて満たされるまで、一般公開（外部ユーザー向け配布）は Go にしないこと。

- [ ] OAuth バックエンド（start/exchange/refresh/logout）が本番で稼働し、アプリから疎通できる
- [ ] ユーザーDB（アカウント・セッション・購読状態）が本番で永続化される
- [ ] Stripe等の決済連携（Checkout/Webhook/Portal）から entitlement へ反映される
- [ ] `active/grace/past_due` の遷移が本番データで検証済み
- [ ] pricing遷移後にアプリへ戻って利用可能状態が更新される
- [ ] ランチャー失敗メッセージが表示され、無効recentの除去が即時反映される
- [ ] recentの手動削除UIが使える（または仕様として削除機能なしに統一）
- [ ] 実行環境インストールの開始/完了/失敗がUIで見える
- [ ] TeX未導入ユーザーが迷わず初回ビルド成功まで到達できる
- [ ] OAuth/課金状態別のE2EがCIで安定通過する
- [ ] README/Runbookが現行コマンドと一致している
- [ ] CSPとトークン保存方針の本番ハードニング方針が確定している
