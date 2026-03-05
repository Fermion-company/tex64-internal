## 8. ビルド・clean・整形

### 8.1 ビルド

- `latexmk` でビルド実行
- engine:
  - `lualatex`
  - `pdflatex`
  - `xelatex`
  - `uplatex`
- 実行時オプション:
  - `-synctex=1`
  - `-interaction=nonstopmode`
  - `-halt-on-error`
  - `-file-line-error`

### 8.2 Build Profiles

- プロファイル管理（最大 20）
- 項目:
  - `name`
  - `outDir`
  - `extraArgs`
- active profile を選択して適用
- 変更は自動保存
- `.tex64/settings.json` に保存

### 8.3 outDir/args の扱い

- `extraArgs` 内 `-outdir` 解析対応
- `extraArgs` 内 `-jobname` 解析対応（出力 PDF の検出に反映）
- 不正 `outDir`（ワークスペース外・絶対パスなど）は拒否
- clean/deep clean でも同一 profile を反映

### 8.4 clean

- 通常 clean（`-c`）
- 全削除 clean（`-C`）

### 8.5 ビルド結果の解析

- latexmk 出力から error/warning を抽出
- path/line/column を推定
- 失敗要約を生成して Issues へ反映
- build log を保持して UI に表示
- PDF は通常は `jobname.pdf` を開く。見つからない場合は `.fls` / `.fdb_latexmk` から生成 PDF を検出する
- ツール未導入（latexmk/synctex）系は `open-runtime` アクションを付与

### 8.6 整形（formatter）

- `latexindent` 優先
- 失敗時は fallback formatter へ降格
- 設定:
  - インデント
  - begin/end 改行
  - `document` no-indent
  - 数式/表 delims align
  - blank lines
  - custom verbatim
- save 時整形と手動整形の両方を提供

---

## 9. SyncTeX（forward / reverse）

### 9.1 forward

- トリガ:
  - SyncTeX ボタン
  - ビルド成功後の自動 forward（設定 ON 時）
  - `tex64://view-on-pdf` deep link
- 主な挙動:
  - in-flight 重複抑制
  - request order 管理
  - 短期キャッシュ
  - stale 結果破棄
  - 一部行（コメント等）は補助探索

### 9.2 reverse

- PDF 位置（page/x/y）から source path/line に逆引き
- 逆引き成功時はエディタジャンプ
- 失敗時は Issues へ反映（必要に応じ runtime 導線）

### 9.3 reverse の有効/無効

- 設定トグルで OFF の場合、PDF 側 reverse 要求を無視

---

## 10. Outline / Search / Issues

### 10.1 Index 生成

- `.tex` / `.bib` を走査して抽出:
  - labels
  - references
  - citations
  - sections
  - figures
  - tables
  - todos
- 重複除去済みスナップショットを UI 更新

### 10.2 Outline

- 表示モード:
  - current（アクティブファイル）
  - project（全体）
- セクション階層表示
- todo/label/citation へジャンプ

### 10.3 Search

- `.tex` 全文検索（大小無視）
- 最大 200 件
- ファイルごとにグルーピング表示
- クリックで secondary にジャンプ

### 10.4 Search 内シンボルリネーム

- 対象:
  - `label/ref`
  - `cite`（`.bib` 含む）
- 入力検証:
  - from/to 必須
  - 同一不可
  - 空白・カンマ・`{}` 不可
- 実行:
  - `rename_latex_symbol` ツールを AI 経由で実行
  - 結果件数を `search:renameResult` で表示

### 10.5 Issues

- 収集元:
  - build/format/save/runtime
  - duplicate label 警告
- 表示:
  - severity
  - location
  - message
  - 解決ヒント
- `open-runtime` action 付き項目は Runtime 設定へ遷移
- build failed 後は error 到着時に Issues タブへ自動フォーカス

---

## 11. Blocks（数式編集）

### 11.1 モード

- `insert`: 新規挿入
- `edit`: 既存数式ブロック検出して編集
- 対象は `.tex` の math ブロック

### 11.2 自動検出

- 対象:
  - `$...$`, `$$...$$`, `\(...\)`, `\[...\]`
  - `\begin{...}` ... `\end{...}`
- コメント/verbatim 系環境は除外
- env registry とヒューリスティックで math/table 判定
- 検出位置をハイライト表示

### 11.3 入力 UI

- MathLive が使える場合は `<math-field>` を使用
- 利用不可時は textarea fallback
- 画面キャプチャボタンから OCR 導線あり

### 11.4 挿入フォーマット

- `inline`
- `display`
- `align`
- `gather`
- `none`（raw）
- wrap 設定（inline/display の記法選択）を保持

### 11.5 適用フロー

- 挿入/置換候補を Diff Modal で確認
- Submit で適用
- 適用後に必要に応じ整形
- 履歴を `.tex64/blocks.json` に追記

### 11.6 WYSIWYG 候補

- 自動/手動サジェスト
- キーボードナビ
- MRU 学習
- packs:
  - `core`
  - `math`
  - `physics`
  - `cs`
  - `personal`
  - `jp`

### 11.7 数式キーボード（実装状態）

- ドック UI とキー定義は実装済み
- ただし現行は `MATH_KEYBOARD_VISIBLE = false` のため常時非表示

---

## 12. 画面キャプチャ / OCR

- 画面ソース一覧から対象を選択
- クロップ範囲指定
- OCR 実行:
  - ONNX ベースの数式認識
  - フォールバック手段あり
  - 前処理バリエーションを比較して最良候補を採用
- 結果を Blocks 入力へ注入し、そのまま編集・挿入できる

---

## 13. AI アシスタント

### 13.1 チャット基本

- 複数会話
- 履歴切替
- ストリーミング応答
- 停止（abort）
- 会話クリア

### 13.2 コンテキスト注入

- active file（上限あり）
- 選択範囲（上限あり）
- open files snapshot
- recent issues（最大 5）
- root main tex（auto/manual の判定結果）
- ユーザーがメッセージ内で言及したファイルは、可能な範囲で事前読取してスナップショットを注入（最大 3 件 / 上限あり）

### 13.3 画像添付

- 画像のみ
- 最大 4 件
- 1 件 5MB まで
- 合計 8MB まで
- 超過・非画像・読込失敗は UI で理由を通知

### 13.4 ツール実行と提案

- AI はツール呼び出しでワークスペース情報を取得・検索・検証可能
- 代表ツール:
  - `list_files`
  - `read_file` / `read_files`
  - `search_files`
  - `get_project_structure`
  - `get_index`
  - `rename_latex_symbol`
  - `run_build`
  - `run_command`（設定で許可時のみ）
  - `get_app_settings` / `set_app_settings`
  - `propose_write` / `propose_patch` / `propose_delete` / `propose_rename` / `propose_create_directory`

### 13.5 提案適用

- proposal card で差分確認
- Diff Modal で最終確認して apply
- `適用して続ける` フローあり
- apply 後は proposal を消し、必要なら自動 build
- `undoLastApply` で直近適用を戻せる（履歴上限あり）

### 13.6 AI 実行制約

- policy:
  - 読み取りファイルサイズ上限
  - 読み取りファイル数上限
  - 許可拡張子
  - 許可/禁止トップレベルパス
- `run_command`:
  - 許可コマンドのみ
  - パイプ/リダイレクト等のシェル演算子を禁止
  - タイムアウト/出力量制限あり

### 13.7 使用量記録

- input/output/total tokens
- requests
- 概算コスト（モデル別集計）
- リセット機能あり

### 13.8 認証・契約導線（AIタブ / Ghost）

AI（チャット/ツール）と Ghost Completion は、Platform API v2 の **ログイン状態 + AI契約状態 + クォータ** によって利用可否が決まる。

#### 13.8.1 状態モデル（ユーザーに見える）

- 未ログイン:
  - AI は利用不可（理由を表示し、ログイン導線を出す）
- ログイン済み/未契約・支払い遅延・quota超過:
  - AI は利用不可（理由を表示し、pricing への導線を出す）
- ログイン済み/契約OK:
  - AI 利用可（使用量メーターを表示）
- 重要: AI が利用不可でも、編集/ビルド/保存など **ローカル機能は常に利用可能**（機能分離）

#### 13.8.2 ログイン（Google OAuth）

- 開始:
  - AIタブの「ログイン」から開始（外部ブラウザを開く）
  - PKCE + state を使い、`tex64://oauth/callback` の deep link で結果を受け取る
- 完了:
  - deep link 受信後に code/state を Platform API へ交換し、access/refresh をローカルに保存
  - 期限が近い/401 の場合は refresh を自動実行（refresh token は rotate/revoke 対応）
- 中断/サインアウト:
  - OAuth 進行中はキャンセル可能
  - Settings > Runtime からサインアウト可能

#### 13.8.3 AI契約状態（Entitlement）と使用量（Quota）

- プラン:
  - `free/basic/pro`
  - 表示は「トークン量のみ」（USD 等の金額は出さない）
- 状態:
  - `active/grace/past_due/canceled`
  - `grace` は 3日（支払い失敗後も一時的に利用可。grace終了で AI 無効）
- クォータ:
  - tokens: `limit/used/remaining`
  - requests: `used/remaining`
  - 期間: `periodStart/periodEnd`（月次）
- 取得タイミング:
  - AI送信/補完の直前に entitlement を確認（短時間キャッシュあり。目安 60秒）
  - 使用量表示は `再試行` で再取得できる

#### 13.8.4 課金/状態反映（tex64.com）

- アプリ内の課金導線は「pricing ページを開く」のみ（購入UIは持たない）
- 購入/管理は tex64.com の Account 画面で行う:
  - Checkout: `/account/billing` → `POST /api/v2/billing/checkout` → Stripe Checkout
  - 管理: `/account/billing/manage` → `POST /api/v2/billing/portal` → Customer Portal
- Stripe webhook（`POST /api/v2/billing/webhook`）で subscription を DB に反映し、`GET /api/v2/me/features` が plan/status/quota を返す
- 例外対応（返金・手動調整等）は Admin API/UI で plan/status/extraTokens 等をパッチできる
- （任意）別システムへ中継する場合は `TEX64_APP_PLATFORM_*`（subscription-bridge）を設定する

#### 13.8.5 本番運用の前提（tex64.com / Platform API）

- 必須（代表）:
  - Google OAuth credential（`GOOGLE_OAUTH_CLIENT_ID/SECRET`）+ redirect URI 登録（Web callback + Desktop bridge）
  - `TEX64_PLATFORM_JWT_SECRET`（production で必須）
  - `DATABASE_URL`（永続化。billing/refresh token は DB 前提）
  - `GEMINI_API_KEY`（AI を有効にする場合）
  - Stripe を有効にする場合: `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_BASIC_PRICE_ID` / `STRIPE_PRO_PRICE_ID`
  - Admin を使う場合: `TEX64_ADMIN_TOKEN`
- 本番で原則無効化すべきもの（モック/フォールバック）:
  - `TEX64_PLATFORM_MOCK_OAUTH`
  - `TEX64_PLATFORM_STATE_FALLBACK`
  - `TEX64_AI_MOCK`

---

## 14. 設定

### 14.1 Editor

- compile engine
- build 後 auto forward SyncTeX
- reverse SyncTeX ON/OFF
- PDF 表示モード（window/tab）
- Ghost completion ON/OFF
- Ghost debounce
- Ghost max chars
- align env ON/OFF

### 14.2 Format

- indent style
- begin/end 改行
- `document` no-indent
- align math/table delims
- blank lines 方針
- custom verbatim 追加/削除

### 14.3 Build Profiles

- プロファイル追加/削除/選択
- `name/outDir/extraArgs` 編集
- clean / clean-all 実行

### 14.4 Runtime（実行環境・アップデート）

- 実行環境チェック:
  - `lualatex/pdflatex/xelatex/uplatex/latexmk/latexindent/synctex` をチェック
  - 不足時は Runtime のバッジとオンボーディング表示へ反映（Build 側も不足時にガードして Runtime へ誘導）
- 初回オンボーディング:
  - Runtime に「1/3 実行環境 → 2/3 ワークスペース → 3/3 最初のビルド」ステータスを表示
  - `最初のビルドを実行` ボタン（条件を満たすまで disabled）
- インストール導線（best-effort）:
  - 未導入時のインストールボタン（platform 別）
  - （要修正）`env:installStart` / `env:installResult` を現行UIが受け取らないため、進捗/成否が見えない（チェック結果のみ反映）
- アップデート:
  - Runtime を開くと `update:status:get` と `update:check(force=false)` を実行
  - 自動チェックは 6時間間隔（`tex64.update.lastAutoCheckAt.v1` を基準に抑制）
  - （任意/要修正）更新がある場合の OS 通知は background チェック時のみ（現行未結線）
  - 更新UIで `現在/最新バージョン`、状態、進捗バーを表示
  - 更新操作:
    - `更新を確認`
    - `ダウンロード`（manifest の `artifactUrl` + 検証情報が必要）
    - `適用`（ダウンロード済みインストーラを起動）
    - `手動ダウンロード`（`artifactUrl` → `notesUrl` → `TEX64_LINKS.download` の順で開く）
  - ダウンロード後に `sha256` 検証を実施し、不一致時は適用しない
    - 受理する検証値: `artifactSha256` / `sha256` / `checksum` / `signature`（sha256 として解釈可能な形式）
  - manifest は tex64.com の Platform API（`GET /api/v2/updates/manifest`）を前提にする（MVP本番では tex64.com 側で `artifactUrl/sha256/notesUrl` を供給する）

### 14.5 Env Registry

- 既定環境 + custom 環境の管理
- math/table 種別指定
- 有効/無効切替
- discouraged/package 表示
- Blocks 検出・整形設定へ反映

### 14.6 フィードバック・法務/サポート導線

- フィードバック送信（Settings > Runtime）:
  - カテゴリ・本文・連絡先（任意）
  - `Cmd/Ctrl+Enter` でも送信可能
  - 失敗時は送信キューに保存して自動再送（指数バックオフ）
  - 任意で診断情報を添付（設定でON/OFF）
  - 送信先は tex64.com の Platform API v2（`POST /api/v2/feedback`）
    - 本番では `DATABASE_URL`（保存先）と `TEX64_FEEDBACK_WEBHOOK_URL`（通知先、任意）を設定する
- 法務/サポートリンク（利用規約、プライバシー、特商法、返金、ヘルプ、問い合わせ、リリースノート）を Settings から開ける

### 14.7 エラーレポート（任意）

- Renderer 側の例外や重要イベントを Native 経由で送信できる（Settings で ON/OFF）
- 送信先は tex64.com の Platform API v2（`POST /api/v2/internal/error-report`）
  - 本番では `DATABASE_URL`（保存先）と `TEX64_ERROR_WEBHOOK_URL`（通知先、任意）を設定する

---

