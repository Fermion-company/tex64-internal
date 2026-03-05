## 15. 永続化（どこに何を保存するか）

### 15.1 ワークスペース内

- `.tex64/settings.json`
  - `rootFile`
  - `buildProfiles`
  - `buildProfileId`
- `.tex64/.trash/*`
  - 削除ファイルの一時退避
- `.tex64/blocks.json`
  - Blocks 適用履歴
- `.tex64/.format/*`
  - formatter 作業用

### 15.2 userData

- `tex64-user-settings.json`
  - AI 設定
  - recent projects
- `tex64-api-usage.json`
  - API usage 集計
- `tex64-platform-session.json`
  - Google OAuth セッション
  - access/refresh token（`safeStorage` が使える場合は暗号化して保存）
  - plan/status のキャッシュ
  - OAuth 進行中 state
- `updates/*`
  - アップデート用にダウンロードしたインストーラ

### 15.3 localStorage（主なキー）

- 編集/表示:
  - `tex64.compileEngine`
  - `tex64.editor.autoSynctexOnBuild`
  - `tex64.editor.reverseSynctex`
  - `tex64.editor.pdfViewerMode`
  - `tex64.editor.ghostCompletion`
  - `tex64.editor.ghostCompletion.debounceMs`
  - `tex64.editor.ghostCompletion.maxChars`
  - `tex64.editorSplitRatio`
- サイドバー/タブ:
  - `tex64.sidebar.primaryTabs`
  - `tex64.activeTab`
- ファイルツリー:
  - `tex64.tree.<workspace>`
- Outline:
  - `tex64.outline.mode`
- Blocks/WYSIWYG:
  - `tex64.math-insert-mode`
  - `tex64.math-insert-inline-wrap`
  - `tex64.math-insert-display-wrap`
  - `tex64.math-wysiwyg.autoSuggest`
  - `tex64.math-wysiwyg.packs`
  - `tex64.math-wysiwyg.mru*`
- PDF viewer:
  - `tex64.pdf.invert`
  - `tex64.pdf.sidebarTab`
- Runtime/運用:
  - `tex64.runtimeSetupPrompted.v1`
  - `tex64.onboarding.firstBuildCompleted.v1`
  - `tex64.update.lastAutoCheckAt.v1`
  - `tex64.feedback.queue.v1`
  - `tex64.feedback.includeDiagnostics.v1`
  - `tex64.errorReporting.enabled.v1`

---

## 16. 外部リンク・ショートカット

### 16.1 `tex64://` アクション

- `tex64://open-source?path=...&line=...&column=...`
  - ソース位置をエディタで開く
- `tex64://view-on-pdf?path=...&line=...&column=...`
  - forward SyncTeX を実行

### 16.2 グローバル操作

- `Cmd/Ctrl+B`: build 実行

### 16.3 `tex64.com` 公開ページ導線

- AI タブの `pricing` は `TEX64_LINKS.pricing`（現行既定: `https://tex64.com/pricing`）へ遷移
- Settings の法務/サポートボタンは `TEX64_LINKS.*` で定義した `tex64.com` 公開ページを開く
- 手動アップデートは `artifactUrl` が無い場合に `notesUrl` または `TEX64_LINKS.download`（現行既定: `https://tex64.com/download`）へフォールバック

---

## 17. 主要制限値（実装値）

- ワークスペース列挙: 5000
- Search 結果: 200
- Index/Issues は UI 側で必要に応じ上位表示制御
- ファイルプレビュー画像: 2MB
- ファイル抜粋: radius 最大 180、maxLines 最大 360、本文 12KB で切り詰め
- Ghost API 補完:
  - minPrefix 10
  - cooldown 3s
  - 最大 12 req/min
- Platform（AI契約/使用量）キャッシュ:
  - entitlement: 60s
  - usage: 60s
- OAuth pending（ログイン開始→完了の猶予）: 10 分
- Update 自動チェック間隔: 6 時間
- AI 画像添付:
  - 4 件
  - 1件 5MB
  - 合計 8MB
- 最近プロジェクト: 10 件

---

## 18. 現行仕様として重要な注意点

- 数式キーボードは実装されているが現状は表示無効
- ランチャー新規作成は現行 UI では paper テンプレート運用
- ランチャーの失敗理由メッセージ（`launcherStatus.message`）は現行UIに表示されない
- ランチャーのテンプレート切替UI（paper/lecture）は非表示/未接続
- 最近プロジェクトの手動削除UIは未接続（無効項目は自動除去のみ）
- 削除は OS ゴミ箱ではなく `.tex64/.trash` を使用
- `rename_latex_symbol` は Search 画面から AI ツール経由で実行される
- reverse SyncTeX は設定 OFF で無効化される
- アップデート導線は Settings > Runtime に集約（AIタブに更新操作は置かない）
- TeX導入の install 開始/結果イベントは Main から送られるが UI が未表示（チェック結果のみ反映）
- 課金（Stripe等）・Update manifest・Feedback・Error report は tex64.com 側に実装があるが、本番では「デプロイ + 環境変数 + DB/Stripe/OAuth設定 + 運用（通知/保存/監査）」が必須

---

## 19. 機能チェックリスト（網羅確認用）

### 19.1 プロジェクト・ワークスペース

- [x] フォルダを開く
- [x] 新規プロジェクト作成
- [x] 最近プロジェクト表示/再開
- [x] root TeX 手動設定
- [x] root TeX 自動検出/再検出
- [x] `%!TEX root` 追跡

### 19.2 編集・ファイル操作

- [x] テキスト編集
- [x] 2ペイン分割
- [x] タブ操作
- [x] 作成/改名/移動/コピー/削除
- [x] 削除 Undo / 移動 Undo
- [x] Finder 表示 / Terminal 起動

### 19.3 ビルド・整形・PDF

- [x] latexmk build
- [x] clean / deep clean
- [x] build profile
- [x] latexindent + fallback format
- [x] タブ内 PDF
- [x] 別ウィンドウ PDF
- [x] forward/reverse SyncTeX

### 19.4 参照支援

- [x] Outline
- [x] Search
- [x] Search から secondary ジャンプ
- [x] シンボル一括リネーム
- [x] Issues 集約と runtime 導線

### 19.5 数式支援

- [x] Blocks insert/edit
- [x] 数式ブロック自動検出
- [x] MathLive 入力
- [x] WYSIWYG 候補
- [x] OCR 連携
- [x] Diff 確認適用

### 19.6 AI

- [x] 会話履歴/複数会話
- [x] ストリーミング
- [x] 画像添付
- [x] ツール実行
- [x] 提案カード
- [x] 提案適用
- [x] 適用 Undo
- [x] usage 集計

### 19.7 設定・オンボーディング

- [x] Runtime で実行環境チェック
- [x] Runtime 初回オンボーディング表示（1/3 ... + 最初のビルド導線）
- [ ] Runtime のインストール進捗/成否表示（`env:installStart` / `env:installResult`）
- [x] Runtime で更新確認/ダウンロード/適用（クライアント側）
- [x] 更新ファイルの `sha256` 検証（クライアント側）
- [x] Runtime でフィードバック送信UI（キュー/再送込み）
- [x] Runtime でサインアウト
- [x] Settings から法務/サポート/リリース導線

### 19.8 プラットフォーム結線（ログイン/課金/更新/フィードバック）

- [x] Google OAuth start/exchange/refresh/logout（API v2 + Desktop）
- [x] Entitlement/quota（`free/basic/pro` + `active/grace/past_due/canceled`）判定と UI 表示
- [x] 決済連携（Stripe）: `POST /api/v2/billing/checkout` / `portal` / `webhook`（tex64.com 実装。production は `DATABASE_URL` + Stripe 設定が必須）
- [x] Update manifest API（`GET /api/v2/updates/manifest`）
- [x] Feedback API（`POST /api/v2/feedback`）
- [x] Error report API（`POST /api/v2/internal/error-report`）
- [x] 運用管理API（Admin: `/api/v2/admin/*`）

---

## 20. MVP公開に向けて足りないもの（不足洗い出し）

この章は「MVPとして公開配布を開始する」ために、tex64（Desktop）と tex64.com（Web/Platform）の両面で不足しているものを機能ベースで列挙します。
（ローカル編集/ビルド等の中核機能は概ね成立している前提で、**ユーザー導線**と**運用上の安全弁**の欠けを優先する。）

### 20.1 P0（公開前に必須）

- tex64.com（Platform）を本番として成立させる
  - `DATABASE_URL` を用意し、永続化を有効にする（billing/refresh token/usage/feedback の基盤）
  - `TEX64_PLATFORM_JWT_SECRET` を本番用に設定（production で必須）
  - Google OAuth を本番設定し、redirect URI を登録する
    - Web: `https://tex64.com/account/oauth/callback`
    - Desktop bridge: `https://tex64.com/v2/auth/google/callback`（環境により `/api/v2/...` も追加登録）
  - AI を有効にする場合: `GEMINI_API_KEY` とモデル/上限（コスト制御）を確定
  - 課金（AIのみ）を有効にする場合: Stripe 設定（`STRIPE_*`）+ webhook 受信（`POST /api/v2/billing/webhook`）
  - 運用: `TEX64_ADMIN_TOKEN` を設定し、`/admin` でユーザー/契約/フィードバック/監査を扱えるようにする
- 配布/アップデート情報源を「運用できる」形で確定する（manifest の中身を埋める）
  - artifact のホスティング（GitHub Releases / オブジェクトストレージ / remote feed など）を決める
  - `artifactSha256`（Desktop が検証する）の生成・公開フローを確立する
  - `notesUrl`（`/releases/[version]` 等）を提供する
  - 反映手段: `TEX64_UPDATE_*`（env）または `src/content/releases.js`（静的データ）を運用方針として固定
  - [x] Desktop 側の手動公開スクリプト（`npm run -s release:upload-downloads`）と公開整合チェック（`npm run -s release:go-no-go`）を追加
- Desktop 配布（macOS）
  - Developer ID 署名 + Notarization の手順を確定（Gatekeeper 対応）
  - バージョン付けとリリースノート作成を update/manifest 運用に組み込む
- 初回UXの詰まりどころを潰す（ユーザーが「使い始められない」系）
  - [x] ランチャーの失敗理由が UI に出ない（`launcherStatus.message` が描画されない）
  - [x] Runtime の TeX インストール進捗/成否が UI に出ない（`env:installStart` / `env:installResult`）
  - [x] テンプレート切替UIが非表示（paper/lecture）
  - [x] 最近プロジェクトの手動削除が未接続

### 20.2 P1（公開後すぐに欲しい）

- アップデート通知
  - [x] background チェック（OS通知）: 起動後に自動チェック + 6時間ごとに再チェック
- サポート運用
  - `TEX64_FEEDBACK_WEBHOOK_URL` / `TEX64_ERROR_WEBHOOK_URL` を Slack/Jira/Sentry 等へ接続する
  - triage（タグ/担当/優先度）の運用を決め、`/admin` の運用手順を整備する
- セキュリティ/運用ハードニング
  - CSP/権限の最小化、PII/ログ保持/削除方針を明文化する
  - トークン保存（`safeStorage` が使えない環境の扱い）を本番方針として固定する

### 20.3 運用整合（リリース事故を減らす）

- [x] Desktop 側 runbook に「ローカル署名/Notarize -> R2/S3 へ手動公開 -> Go/No-Go 自動検証」の導線を追加（`docs/distribution.md`）
- Desktop と tex64.com の Runbook を1つに集約（OAuth/Stripe/webhook/update/初回ビルドの確認手順）
- README と `package.json` のコマンド/環境変数の整合を取る（両リポジトリ）

---

## 21. モック/開発モード一覧（本番での扱い）

### 21.1 Platform API v2（サーバー側）

- mock OAuth:
  - `TEX64_PLATFORM_MOCK_OAUTH=true` で Google OAuth の代わりに `mock:` コードでログイン可能
  - 本番では必ず無効化し、Google OAuth credential を設定する
- state fallback（DBなし動作）:
  - `TEX64_PLATFORM_STATE_FALLBACK=true` で JSON ストアへ退避（`TEX64_PLATFORM_STATE_FILE`）
  - 本番では `DATABASE_URL` を必須にし、fallback を無効化する
- user overrides（テスト用）:
  - `TEX64_PLATFORM_USER_OVERRIDES`（JSON）で特定ユーザーの plan/status/extraTokens を強制できる
  - 本番では原則無効化し、Admin/Stripe を正とする
- AI mock:
  - `TEX64_AI_MOCK=true` で AI をモック応答へ切替できる
  - 本番では原則無効化し、実プロバイダ（例: Gemini）を設定する
- JWT secret:
  - 非production では未設定時に開発用デフォルトへフォールバックする
  - 本番では必ず強度の高い secret を設定する

### 21.2 Desktop app（Electron）

- entitlement bypass（開発/E2E）:
  - `TEX64_AI_BYPASS_ENTITLEMENT=1` などで契約判定をバイパス
  - packaged 本番では常に無効化される前提で運用する
- Platform API base URL の上書き（開発）:
  - `TEX64_PLATFORM_API_BASE_URL` / `TEX64_PLATFORM_WEB_BASE_URL` / `TEX64_PLATFORM_OAUTH_REDIRECT_URI`
  - 本番では `https://tex64.com` へ固定して運用する
- legacy AI proxy（開発）:
  - `TEX64_AI_PROXY_URL`（旧 `/api/ai-chat` プロキシ）
  - 本番では Platform API v2（`/api/v2/ai/*`）へ統一する
- update channel（運用）:
  - `TEX64_UPDATE_CHANNEL`（既定: `stable`）

以上。

