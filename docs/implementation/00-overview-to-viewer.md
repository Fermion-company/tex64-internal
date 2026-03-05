# TeX64 機能設計図（実装同期版 / MVP導線込み）

この文書は、TeX64 を構成する **2つのリポジトリ**の現行実装を読み直して、
**ユーザーができること**を機能ベースで整理し、MVP公開に必須の導線（ダウンロード/初回起動/ログイン/課金/アップデート）まで含めて記述します。

- Desktop app（tex64）: `/Users/wedd/tex64`
- Web + Platform API（tex64.com）: `/Users/wedd/tex64.com`

- 基準日: 2026-02-23
- 方針: コード構造の説明ではなく、画面操作・挙動・制約・保存先を中心に記述
- 対象: 起動/ランチャー、編集、ビルド、SyncTeX、検索、Blocks、OCR、AI、ログイン（Google OAuth）、課金/契約状態（AIのみ）、アップデート、設定、永続化、運用導線（サポート/法務/フィードバック/管理）
- 注記: 課金/アップデート/フィードバック/エラーレポートの **API は tex64.com 側に実装がある**。MVP公開では「tex64.com のデプロイ + 環境変数 + DB/Stripe/OAuth設定 + 運用」を必須要件として扱う（末尾の不足洗い出しを参照）

---

## 0. MVPユーザー導線（DL→初回→継続）

この章は「ユーザーがダウンロードしてから初回で使い始め、継続利用する」ために必要な要素を導線として固定します。

### 0.1 ダウンロード/インストール（macOS）

- ダウンロード: `https://tex64.com/download`（最新版の参照は `GET /api/v2/updates/manifest`）
  - 共有用の固定リンク: `https://tex64.com/download/latest`
- 対応: macOS Apple Silicon（arm64）のみ（現行）
- 配布形式: DMG（現行）
- 典型手順: DMG を開く → `TeX64.app` を `Applications` にドラッグ → 起動
- 公開配布の前提: Developer ID 署名 + Notarization（Gatekeeper 回避のため）
- 重要: TeX Distribution（MacTeX/BasicTeX 等）は同梱しない（ユーザー側インストールが必要）

### 0.2 初回起動〜最初のビルド（ローカル機能）

- 起動直後はランチャーでワークスペース（フォルダ）を選ぶ
- ワークスペースを開く/新規作成の後に:
  - root TeX の自動検出（`main.tex` 優先）
  - 実行環境チェック（TeX engine/latexmk/synctex/latexindent）
  - 実行環境不足時は Build をガードし、Settings > Runtime へ誘導（初回オンボーディング表示あり）
- 初回成功体験のゴール: `main.tex` をビルドして PDF を表示できる
- （要修正）ランチャーの失敗理由メッセージが現行UIに表示されないため、操作不能に見えるケースがある
- （要修正）TeX導入の「インストール開始/結果」イベントは Main から送られるが UI が未表示（チェック結果のみ反映）

### 0.3 継続利用（執筆ループ）

- 最近のプロジェクトから再開 → 編集 → Build（`Cmd/Ctrl+B`）→ PDF確認 → SyncTeX（forward/reverse）
- 障害時は Issues に集約し、Runtime/ログ/設定へ誘導

### 0.4 AIを使い始める（ログイン/課金/使用量）

- AI はローカル機能とは独立し、未ログイン/未契約でも編集・ビルド等は利用可能
- AI利用時にだけ以下を判定:
  - Google OAuth ログイン状態
  - プラン/契約状態（`free/basic/pro` + `active/grace/past_due/canceled`）
  - 月次クォータ（tokens/requests）
- 未ログイン: Google ログイン導線（ブラウザ→deep link）を提示
- 未契約/支払い遅延/上限超過: pricing 導線と理由を提示
- 課金/契約の実体は tex64.com（Web + Platform API）で提供する（Stripe Checkout/Portal/Webhook）
- Desktop は pricing を開くのみ（購入UIは持たない）

### 0.5 アップデート（使い続けるための安全弁）

- Settings > Runtime に更新UIを集約（チェック/ダウンロード/適用/手動導線）
- 更新があれば OS 通知を出せる設計（通知ロジックは実装済み）
- （要修正）更新チェックを `background` として呼ぶ配線が現状無く、通知が出ない
- ダウンロード後に sha256 検証し、不一致なら適用しない
- 適用は「インストーラ起動」方式（自動置換/再起動ではない）
- update manifest は tex64.com の `GET /api/v2/updates/manifest` を利用する（Web の Download ボタンと Desktop の更新が同じ情報源を参照する）
  - 本番では artifact 配布先URL・`sha256`・リリースノートURLの運用を確立する（詳細は 1.5 / 20）

### 0.6 フィードバック/サポート/法務（困ったとき）

- Settings から規約/プライバシー/特商法/返金/ヘルプ/問い合わせ/リリースノートを開ける
- フィードバック送信フォーム（カテゴリ/本文/連絡先任意、任意で診断情報を添付）
- エラーレポート送信の ON/OFF（任意）
- 送信先は tex64.com の Platform API:
  - `POST /api/v2/feedback`（匿名でも送信可。必要ならログイン状態も付与）
  - `POST /api/v2/internal/error-report`（匿名でも送信可。必要ならログイン状態も付与）
  - 本番では保存先（DB）と通知先（Webhook/監視）を設定する（詳細は 1.5 / 20）

## 1. アプリでできること（全体像）

TeX64 は、1つの LaTeX ワークスペースに対して次を一体で提供します。

- プロジェクトの作成・オープン・最近のプロジェクト再開
- ファイルツリー操作（作成・改名・移動・コピー・削除・Undo）
- Monaco エディタでの編集、2ペイン分割、タブ管理
- PDF/画像ビューア（タブ内または別ウィンドウ）
- latexmk によるビルド、clean、SyncTeX（forward/reverse）
- Index に基づく Outline / Search / ラベル重複検出
- 数式編集支援（Blocks、MathLive、候補サジェスト、OCR）
- AI チャット（ツール実行、変更提案、差分確認、適用、Undo）
- 設定管理（ビルド、整形、環境チェック、補完、環境レジストリ）

---

## 1.5 tex64.com（Web + Platform API）でできること

tex64.com は「配布サイト」と「Desktop が呼ぶ Platform API v2」を **同一ドメイン**で提供します。

- ユーザー向け（Web）: ダウンロード、リリースノート、ドキュメント、価格/契約、アカウント、サポート、法務
- アプリ向け（API）: Google OAuth、AI（chat/completion）、契約状態/使用量、アップデートmanifest、フィードバック、エラーレポート
- 運用向け（Admin）: ユーザー/契約/フィードバック/監査の管理

### 1.5.1 Web（公開ページ）

- `/`（Landing）: 概要 + Download セクション（`#download`）
- `/download`: 最新版ダウンロードUI（`/api/v2/updates/manifest` を参照）
- `/download/latest`: JS無しの「最新版」リダイレクト（manifest を参照）
- `/releases`: リリース一覧
- `/releases/[version]`: リリース詳細（ノート + アーティファクト）
- `/docs/*`: ドキュメント（WIP/プレースホルダーを含む）
  - `/docs/getting-started`
  - `/docs/install-macos`
  - `/docs/tex-distribution`
  - `/docs/updates`
  - `/docs/troubleshooting`
  - `/docs/ai`
  - `/docs/blocks`
  - `/docs/synctex`
- `/pricing`: プラン案内（購入はログイン後に `/account/billing`）
- `/support`: サポート/問い合わせ（クエリでの prefill 対応）
- `/account/*`: アカウント（ログイン/課金/使用量）
  - `/account/login`（Google OAuth 開始）
  - `/account/oauth/callback`（OAuth 完了）
  - `/account/billing`（Checkout 開始）
  - `/account/billing/manage`（Customer Portal）
  - `/account/usage`（AI 使用量）
- `/admin`: 管理コンソール（admin token 必須）
- `/terms`, `/privacy`, `/legal`: 法務

### 1.5.2 Platform API v2（/api/v2）

Desktop app と Web の account 画面が共通で利用する API です。

#### 認証（Google OAuth + PKCE）

- `POST /api/v2/auth/google/start`
- `GET /api/v2/auth/google/callback`（Desktop deep link bridge）
- `POST /api/v2/auth/google/exchange`
- `POST /api/v2/auth/refresh`
- `POST /api/v2/auth/logout`

補足:

- Desktop の redirect URI は `tex64://oauth/callback`
- Google OAuth の redirect URI は「Web callback」と「Desktop bridge callback」を分けて扱う
  - Web: `https://tex64.com/account/oauth/callback`
  - Desktop bridge: `https://tex64.com/v2/auth/google/callback`（`/v2/* -> /api/v2/*` の rewrite 前提。環境により `/api/v2/...` を追加登録）

#### 契約状態/使用量（Entitlements/Quota）

- `GET /api/v2/me/features?names=ai`（enabled/plan/status/quota/period/grace など）
- `GET /api/v2/me/usage/ai?period=current_month`

#### AI（サーバー側でモデル/上限を固定）

- `POST /api/v2/ai/chat`
- `POST /api/v2/ai/completion`
- `TEX64_AI_MOCK` でモック応答に切替可能（本番では原則無効化）

#### 課金（Stripe）

- `POST /api/v2/billing/checkout`（Checkout URL 発行）
- `POST /api/v2/billing/portal`（Customer Portal URL 発行）
- `POST /api/v2/billing/webhook`（Stripe webhook 受信→subscription を保存/更新）
  - 必須: `DATABASE_URL`（billing は DB 前提）
  - 任意: webhook 後に subscription を別システムへ中継（`TEX64_APP_PLATFORM_*`）

#### アップデート（manifest）

- `GET /api/v2/updates/manifest?platform=darwin&arch=arm64&channel=stable`
  - Web の Download と Desktop の update が同じ情報源を参照
  - `latestVersion/notesUrl/artifactUrl/artifactSha256/required` を返す

#### フィードバック/エラーレポート

- `POST /api/v2/feedback`（匿名可。必要なら認証情報も付与）
- `POST /api/v2/internal/error-report`（匿名可。必要なら認証情報も付与）
  - どちらも DB または fallback に保存し、任意で Webhook へ通知できる

#### 管理（運用）

- `/admin` UI は `Authorization: Bearer <TEX64_ADMIN_TOKEN>` と `x-admin-actor` を使用
- 代表 API:
  - `GET /api/v2/admin/overview`
  - `GET /api/v2/admin/users`
  - `POST /api/v2/admin/users/subscription`
  - `POST /api/v2/admin/users/period-entitlement`
  - `POST /api/v2/admin/users/revoke-sessions`
  - `GET/POST /api/v2/admin/feedback`
  - `GET /api/v2/admin/audit`

---

## 2. 起動とプロジェクト導線

### 2.1 ランチャー

- ワークスペース未選択時にランチャーを表示
- ワークスペース確定後は非表示
- （要修正）Main 側が送る `launcherStatus.message`（失敗理由）が現行UIに描画されない（busy のみ反映）
- キーボード操作:
  - `ArrowUp/ArrowDown`: 「フォルダを開く」「新規作成」の選択移動
  - `Enter`: 選択中アクション実行

### 2.2 フォルダを開く

- OS のディレクトリ選択ダイアログでワークスペースを選択
- 選択後、ワークスペース情報と Index をロード

### 2.3 新規プロジェクト作成

- フォルダ選択後に `main.tex` テンプレートを作成
- `main.tex` が既存なら `main2.tex`, `main3.tex`... を自動採番して上書き回避
- テンプレート内容は LaTeX 文書の雛形（本文、数式、図表、文献のサンプル付き）
- 補足: バックエンドは `paper/lecture` 両テンプレートを受け取れるが、現行ランチャー UI からは `paper` 運用
- （要修正）テンプレート切替UI（`paper/lecture`）は HTML/CSS 側で非表示/未接続のため、ユーザー操作で切替できない

### 2.4 最近のプロジェクト

- 起動時に最近プロジェクトを取得してランチャー右側へ表示
- 保存件数は最大 10（新しいものが先頭）
- 初期表示は先頭 3 件、`すべて表示/折りたたむ` で展開切替
- 項目をクリックするとそのパスを再オープン
- 再オープン時に存在確認し、存在しない項目は最近一覧から自動除去
- （要修正）最近一覧の「手動削除」導線が現行UIから呼べない（無効項目をユーザーが消せない）
- （要修正）無効パス自動除去時の UI 即時同期（一覧の再配信）が弱く、表示が残る場合がある

---

## 3. ワークスペースモデル

### 3.1 走査対象と除外

- 対象はワークスペース配下のみ（パストラバーサル拒否）
- 主要除外ディレクトリ: `.git`, `.tex64`, `.swiftpm`, `node_modules`, `DerivedData`, `build`, `tex64.xcodeproj`
- 隠しエントリ（`.` 先頭）は基本除外
- ツリー非表示の補助拡張子例: `.aux`, `.toc`, `.synctex.gz`, `.fls`, `.fdb_latexmk`
- 列挙上限はファイル/フォルダともに最大 5000

### 3.2 root TeX（メイン TeX）

- `.tex64/settings.json` の `rootFile` に手動指定を保存
- 手動指定:
  - `.tex` かつ存在するファイルのみ有効
- 自動検出:
  - `main.tex` を最優先
  - なければ `.tex` 群をスコアリングして選択
  - 評価軸: `\documentclass`, `\begin{document}`, `\end{document}`, 代表ファイル名（`root.tex`, `paper.tex`, `thesis.tex`, `lecture.tex` など）、階層深さ
- UI:
  - 手動時ボタン表示は「自動に戻す」
  - 自動時ボタン表示は「再検出」

### 3.3 `%!TEX root` 追跡

- ビルド対象が個別 `.tex` のとき、先頭 40 行から `%!TEX root = ...` を解決
- 相対パス解決、拡張子補完（`.tex`）対応
- 最大 5 段追跡、ループ検出あり
- ワークスペース外/非 `.tex` は拒否

---

## 4. ファイルツリーとファイル操作

### 4.1 ツリー表示

- ファイル/フォルダを階層表示
- フォルダ開閉状態を `localStorage` に保存（ワークスペース単位）
- 選択中パスを保持し、rename/move 後も追従更新

### 4.2 右クリックメニュー

- ファイル/フォルダ別に以下を提供:
  - 開く
  - 新規ファイル/新規フォルダ
  - Finder で表示
  - ターミナルで開く
  - 名前変更
  - 削除

### 4.3 作成・改名・移動・コピー・削除

- 作成:
  - モーダル入力で検証後に作成
- 改名:
  - 同一ディレクトリ内 rename（`/` を含む名前は拒否）
- 移動:
  - DnD またはカット&ペーストで `moveItem`
  - 自分自身配下への移動など不正移動は拒否
- コピー:
  - コピー&ペーストで `copyItem`
- 削除:
  - 実体は `.tex64/.trash` への移動

### 4.4 Undo（ファイル操作）

- Undo 対象:
  - move
  - delete
- copy/rename/create は Undo 対象外
- 削除 Undo は `.trash` から元位置へ復元
- manual root が削除で消えた場合、Undo 復元時に root 設定も戻す

### 4.5 ショートカット（ツリー上）

- `Cmd/Ctrl+C`: コピー
- `Cmd/Ctrl+X`: カット
- `Cmd/Ctrl+V`: ペースト
- `Cmd/Ctrl+Z`: 最後の move/delete を Undo

### 4.6 安全ガード（未保存ファイル）

- UI 側で以下をブロック:
  - rename 対象に未保存変更がある
  - move 対象に未保存変更がある
  - delete 対象に未保存変更がある
- エラーは Issues に表示

---

## 5. エディタ・タブ・分割表示

### 5.0 画面レイアウト

- サイドバータブ:
  - `files`, `outline`, `blocks`, `ai`, `project`, `search`, `issues`, `settings`
- primary タブ可視性:
  - 右クリックメニューで表示/非表示を切替
  - 最低 1 タブは常時表示
  - 表示設定は `localStorage` に保存
- サイドバー幅:
  - リサイザで横幅を変更可能
  - 最小幅制約を維持してエディタ領域を保護

### 5.1 エディタ基盤

- Monaco エディタを使用
- 2グループ構成: `primary` / `secondary`
- split view を ON/OFF 可能
- split 比率を保存して復元

### 5.1.1 Monaco 言語登録とシンタックスカラー

- Monaco 初期化時に `latex` / `bibtex` を言語登録し、Monarch トークナイザを設定
- 言語割り当て:
  - `.bib` は `bibtex`
  - `.tex`, `.sty`, `.cls`, `.ltx`, `.dtx`, `.ins`, `.bbx`, `.cbx`, `.cfg`, `.def`, `.lbx`, `.bst` は `latex`
  - それ以外のテキストは `plaintext`
- `latex` の着色対象（現行実装）:
  - `%` コメント
  - `\begin`, `\end`, `\usepackage` などのコマンド
  - 一般的な `\command` 形式
  - `$...$`, `$$...$$`, `\(...\)`, `\[...\]` の数式デリミタ
  - 波括弧/角括弧/丸括弧、`& ^ _ ~`、数値
- `bibtex` の着色対象（現行実装）:
  - `%` コメント
  - `@article` などのエントリ種別
  - 文字列（`"..."`）
  - `{}`, `()`, `=`, 数値、識別子
- テーマは `tex64-deep-slate`（base: `vs-dark`）を適用

### 5.2 タブ管理

- 各グループに独立したタブ列
- タブのクローズ、グループ間移動（D&D）
- dirty 状態をタブに反映
- 同一ファイルは既存グループ優先で再利用

### 5.3 ファイル種別ごとの開き方

- `text`: Monaco で編集
- `image`: 画像ビューア
- `pdf`: PDF ビューア
- 非対応拡張子: Unsupported メッセージ表示
- PDF は未指定時に secondary へ自動オープンし split を有効化

### 5.4 保存と dirty 管理

- 保存:
  - 明示保存
  - 自動保存（タイマ）
- dirty 判定:
  - モデル内容と `savedContent` を比較
- save 成功時:
  - dirty 解除
  - 必要なら整形済み内容でバッファ更新
- 保存前に閉じる場合:
  - `beforeunload` で未保存警告

### 5.5 カーソル/ジャンプ

- `jumpToFileLine` で path:line ジャンプ
- Search/Outline は secondary へジャンプ（split 自動 ON, focus を奪わない）
- Issues はアクティブグループへジャンプ

---

## 6. 入力支援（Completion / Hover / Ghost）

### 6.1 コード補完（通常補完）

- `\ref` 系: Index の labels を候補
- `\cite` 系: Index の citations を候補
- `\input` / `\include`: `.tex` パス候補
- `\includegraphics`: 画像パス候補
- `\begin{...}`: 環境候補（env registry + 内蔵）
- 代表スニペット候補（figure/table/section など）

### 6.2 Hover

- 数式トークン上で数式プレビュー（MathLive レンダリング）
- `\cite{...}` で `.bib` エントリ抜粋表示
- `\includegraphics` で画像プレビュー（遅延ロード）
- `\input` / `\include` で対象ファイル抜粋表示
- `\ref` / `\eqref` などの参照先情報表示
- ホバー結果とプレビュー要求にキャッシュあり

### 6.3 Ghost Completion（インライン補完）

- ルールベース補完:
  - LaTeX コマンド・環境文脈から inline 候補生成
- API 補完（必要時のみ）:
  - 無効時は呼ばない
  - クールダウン・分あたり回数制限・negative cache を適用
  - 取得結果はキャッシュ（TTL）
- 設定:
  - ON/OFF
  - debounce
  - 最大文字数

### 6.4 補助ブローカー（プレビュー/抜粋/API）

- 画像プレビュー:
  - 2MB 以下のみ
  - タイムアウトあり
- ファイル抜粋:
  - 行中心で半径指定
  - 行数/バイト数上限で切り詰め
- API completion:
  - requestId 管理と timeout
  - usage snapshot を受け取り保持

---

## 7. ビューア（画像 / PDF）

### 7.1 タブ内ビューア

- 画像と PDF をエディタ領域内表示
- PDF は iframe 経由で専用 viewer を使用

### 7.2 PDF 別ウィンドウ

- 設定により PDF を別ウィンドウ表示
- Main と専用 IPC で同期（open/sync/reload/reverse）

### 7.3 PDF viewer 操作

- ページ移動（前/次、ページ番号入力）
- ズーム（ボタン、Ctrl/Cmd+wheel、pinch）
- fit-width / fit-page
- 回転（左右）
- 検索（前/次）
- Outline / Thumbnails 切替
- 色反転（保存）
- Download / Print / Reload
- reverse SyncTeX:
  - 右クリック or `Ctrl/Cmd+クリック` 位置から逆引き

### 7.4 親子通信

- 親 → iframe: `open` / `sync`
- iframe → 親: `ready` / `reverse`
- payload は `source: "tex64-pdf"` で識別

---

