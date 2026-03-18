# AI チャット UI パーツ一覧

AI 使用中に表示されるすべてのビジュアルコンポーネント。

---

## 1. トップバー

| パーツ | ID / Class | 種類 | 表示タイミング |
|--------|-----------|------|---------------|
| 履歴トグル | `#ai-history-toggle` `.ai-icon-btn` | アイコンボタン | 常時 |
| チャットタイトル | `#ai-topbar-title` `.ai-topbar-title` | テキスト | 常時 |
| ステータスラベル | `#ai-topbar-status` `.ai-topbar-status` | テキスト | エージェント実行中 |
| 使用量メーター | `#ai-usage-meter` `.ai-usage-meter` | 円形リング(16px) | クォータ情報取得後 |
| 使用量テキスト | `#ai-usage-meter-text` `.ai-usage-meter-text` | テキスト | メーター内部(現在display:none) |
| 使用量ツールチップ | `.ai-usage-tooltip` | ホバーポップアップ | メーターhover時に動的生成 |
| ツールチップ行 | `.ai-usage-tooltip-row` | ラベル+値 | 使用/上限/残り%/リセット日 |
| ツールチップバー | `.ai-usage-tooltip-bar-track` + `.ai-usage-tooltip-bar-fill` | プログレスバー | ツールチップ内 |
| ログインボタン | `#ai-auth-topbar` `.ai-topbar-auth` | ボタン | 未認証時(認証済みで非表示) |
| 新規チャットボタン | `#ai-chat-new` `.ai-icon-btn` | アイコンボタン | 常時 |

**メーター状態クラス**: `.is-warn`(80-94%), `.is-critical`(95%+)

---

## 2. ログインオーバーレイ

| パーツ | ID / Class | 種類 | 表示タイミング |
|--------|-----------|------|---------------|
| オーバーレイ背景 | `#ai-login-overlay` `.ai-login-overlay` | 全画面モーダル | 未ログイン時 |
| グロー装飾 | `.ai-login-overlay-glow` | 装飾要素 | オーバーレイ内 |
| ログインカード | `.ai-login-overlay-card` | カード | オーバーレイ内 |
| アイコン | `.ai-login-overlay-icon-wrap` + `.ai-login-overlay-icon` | SVGアイコン | カード内 |
| タイトル | `.ai-login-overlay-title` | テキスト | "Axiom でTeX執筆を加速しよう" |
| サブタイトル | `.ai-login-overlay-subtitle` | テキスト | "ログインして Axiom を利用" |
| ログインボタン | `#ai-login-overlay-btn` `.ai-login-overlay-btn` | ボタン | カード内 |

---

## 3. 履歴パネル

| パーツ | ID / Class | 種類 | 表示タイミング |
|--------|-----------|------|---------------|
| 履歴パネル | `#ai-history` `.ai-history` | スライドアウト | トグルで`.is-open` |
| 履歴リスト | `#ai-history-list` `.ai-history-list` | スクロールリスト | 常時 |
| 履歴アイテム | `.ai-history-item-wrap` > `.ai-history-item` | ボタン | チャットごとに1つ |
| 削除ボタン | `.ai-history-delete` | アイコンボタン | 各アイテム横 |
| 空状態 | `.ai-history-empty` | テキスト | チャットなし時 |
| 削除確認モーダル | `#ai-chat-delete-modal` `.ai-chat-delete-modal` | モーダル | 削除ボタン押下時 |
| 削除対象テキスト | `#ai-chat-delete-target` | テキスト | チャット名表示 |

**アイテム状態**: `.is-active`(現在のチャット), `.is-running`(実行中)

---

## 4. チャットメッセージ

### 4a. ユーザーメッセージ
| パーツ | Class | 種類 | 内容 |
|--------|-------|------|------|
| メッセージ枠 | `.ai-message.is-user` | バブル | ユーザー入力テキスト |
| メッセージ内容 | `.ai-message-content` | テキスト | プレーンテキスト or "画像を送信しました。" |

### 4b. アシスタントメッセージ
| パーツ | Class | 種類 | 内容 |
|--------|-------|------|------|
| メッセージ枠 | `.ai-message.is-assistant` | バブル | AIレスポンス |
| メッセージ本体 | `.ai-message-body` | コンテナ | 内部ラッパー |
| メッセージ内容 | `.ai-message-content` | HTMLコンテナ | レンダリング済みMarkdown |
| インジケーター | `.ai-message-indicator` | 視覚要素 | メッセージ内 |

### 4c. システムメッセージ
| パーツ | Class | 種類 | 内容 |
|--------|-------|------|------|
| メッセージ枠 | `.ai-message.is-system` | バブル | エラー/ログ/思考/計画 |
| 思考過程 | `.ai-thought-content` | テキスト | 💭 接頭辞 → "思考過程" |
| ツールログ | `.ai-tool-log-content` | テキスト | 🔧 接頭辞 → ツール実行ログ |
| 計画メモ | テキスト(📋接頭辞) | テキスト | "エージェント計画メモ" |

---

## 5. ストリーミング/思考中表示

| パーツ | Class | 種類 | 表示タイミング |
|--------|-------|------|---------------|
| 思考中メッセージ | `.ai-message.is-assistant.ai-thinking-message` | バブル | エージェント思考中 |
| 思考中テキスト | `.ai-message-content` | テキスト | "思考中..." or ステータス |
| ストリーミングテキスト | `.ai-message-content` (delta更新) | HTML | レスポンスのリアルタイム描画 |
| トップバーステータス | `#ai-topbar-status` | テキスト | 実行中のツール名等 |

---

## 6. Markdownレンダリング

| パーツ | Class | 種類 | 内容 |
|--------|-------|------|------|
| コードブロック | `.ai-code-block` | コンテナ | 言語付きコード |
| コードヘッダー | `.ai-code-header` | ヘッダー行 | 言語ラベル+コピーボタン |
| コード言語 | `.ai-code-lang` | テキスト | "python", "latex" 等 |
| コピーボタン | `.ai-code-copy` | ボタン | "コピー" → "コピー済み" |
| コード本体 | `pre > code` | プリフォーマット | シンタックスハイライト済み |
| インラインコード | `.ai-inline-code` | span | バッククォート内テキスト |
| 見出し | `.ai-md-heading.ai-md-heading-{1,2,3}` | h1-h3 | Markdown見出し |
| リスト | `.ai-md-list` | ul/ol | 箇条書き/番号付きリスト |
| リストアイテム | li (`.ai-md-list-item-heading` / `.ai-md-list-item-sub`) | li | リスト項目 |
| テーブル | `.ai-table-wrapper` > `.ai-md-table` | table | Markdownテーブル |
| KaTeX数式(display) | `$$...$$` → `.katex` | ブロック数式 | 数式表示 |
| KaTeX数式(inline) | `$...$` → `.katex` | インライン数式 | 文中数式 |

---

## 7. プロポーザルカード

| パーツ | ID / Class | 種類 | 表示タイミング |
|--------|-----------|------|---------------|
| カードコンテナ | `#ai-proposals` `.ai-proposals` | コンテナ | プロポーザル存在時 |
| カード | `.ai-proposal` `data-proposal-id` | カード | プロポーザルごとに1つ |
| ヘッダー | `.ai-proposal-header` | ヘッダー行 | カード内 |
| ファイルアイコン | `.ai-proposal-icon` | SVGアイコン | ドキュメントアイコン |
| ファイルパス | `.ai-proposal-path` | テキスト | 変更対象ファイルパス |
| バッジ | `.ai-proposal-badge` | ラベル | 状態表示(下記参照) |
| 概要 | `.ai-proposal-summary` | テキスト | ファイル名 + 差分カウント |
| 差分サマリー | `.diff-summary.ai-proposal-diff-summary` | インライン | "+N" "-N" 表示 |
| アクションボタン群 | `.ai-proposal-actions` | ボタンコンテナ | 2-3個のボタン |

**バッジ種類**: `新規` / `編集` / `削除` / `移動` / `フォルダ` / `auto-applied` / `適用済み`

**ボタン種類**(状態依存):
- 適用済み: 「レビュー」「元に戻す」
- 未適用: 「差分を見る」「取り消し」「適用」

**カード状態**: `.is-applied`(適用済み)

---

## 8. 差分表示(Diff)

| パーツ | Class | 種類 | 表示タイミング |
|--------|-------|------|---------------|
| 差分コンテナ | `.ai-proposal-diff` | 折りたたみ | レビュー/差分ボタン押下時 |
| 差分ヘッダー | `.ai-proposal-diff-header` | ヘッダー | 差分サマリー表示 |
| 差分ノート | `.ai-proposal-diff-note` | テキスト | リネーム/mkdir/バイナリ |
| 差分空状態 | `.ai-proposal-diff-empty` | テキスト | "変更なし" |
| 差分本体 | `.ai-diff` | コードコンテナ | 行ごとの差分表示 |
| 差分行 | `.ai-diff-line` | コード行 | 色分け表示 |

**差分行状態**: `.is-add`(緑/追加), `.is-del`(赤/削除), `.is-same`(変更なし)

**差分コンテナ状態**: `.is-open`(展開中)

---

## 9. 入力エリア

| パーツ | ID / Class | 種類 | 表示タイミング |
|--------|-----------|------|---------------|
| 入力エリア全体 | `.ai-input-area` | コンテナ | 常時 |
| コンテキストバー | `#ai-context-bar` `.ai-context-bar` | チップバー | アクティブファイル/選択範囲 |
| コンテキストチップ | `.ai-context-chip` | チップ | ファイル名/選択範囲/カーソル位置 |
| 添付バー | `#ai-attachments` `.ai-attachments` | チップバー | 画像添付時 |
| 添付チップ | `.ai-attachment-chip` | チップ | 各添付画像 |
| 添付名 | `.ai-attachment-name` | テキスト | ファイル名 or "image-N" |
| 添付削除 | `.ai-attachment-remove` | ボタン | "×" ボタン |
| 入力コンテナ | `.ai-chat-input` | flex | テキストエリア+ボタン群 |
| ファイル入力(hidden) | `#ai-attach-input` `.ai-attach-input` | file input | 非表示 |
| 添付ボタン | `#ai-attach` `.ai-btn-attach` | アイコンボタン | クリップアイコン |
| テキストエリア | `#ai-input` `.ai-chat-textarea` | textarea | メッセージ入力 |
| 停止ボタン | `#ai-stop` `.ai-btn-stop` | アイコンボタン | 実行中のみ表示 |
| Undoボタン | `#ai-undo` `.ai-btn-undo` | アイコンボタン | Undo可能時のみ表示 |
| 送信ボタン | `#ai-send` `.ai-btn-send` | アイコンボタン | 実行中は非表示 |

**添付バー状態**: `.is-empty`(添付なし)
**送信ボタン状態**: `.is-loading`(送信中アニメ)

---

## 10. ステータス表示

| パーツ | ID / Class | 種類 | 表示タイミング |
|--------|-----------|------|---------------|
| ステータスエリア | `#ai-status` `.ai-status` | コンテナ | 各種ステータス時 |
| 見出し行 | `.ai-status-line` | テキスト | メインメッセージ |
| 詳細行 | `.ai-status-detail` | テキスト | 補足情報 |
| アクション群 | `.ai-status-actions` | ボタンコンテナ | ログイン/プラン表示 |
| アクションボタン | `.ai-status-action` `data-ai-status-action` | ボタン | "ログイン" / "プランを見る" |

**ステータス種類**:
- `QUOTA_EXCEEDED` → "今月のトークン上限に達しました。" + 使用量/リセット日
- `PLAN_REQUIRED` / `FEATURE_NOT_ENABLED` / `PAYMENT_PAST_DUE` → "現在の契約状態ではAI機能を利用できません。"
- ログインエラー → 各種エラーメッセージ
- ログイン処理中 → "Googleログインを処理中です。"

**状態クラス**: `.ai-status--actions-only`, `.ai-status--error`, `.ai-status--warn`, `.ai-status--ok`

---

## 11. 空状態(新規チャット)

| パーツ | Class | 種類 | 表示タイミング |
|--------|-------|------|---------------|
| 空状態コンテナ | `.ai-empty-state` | コンテナ | メッセージなし時 |
| タイトル | `.ai-empty-title` | テキスト | 空状態タイトル |
| 説明 | `.ai-empty-desc` | テキスト | 説明文 |
| ヒント群 | `.ai-empty-hints` | リスト | 使い方提案 |
| ヒント項目 | `.ai-empty-hint` | ボタン | 各提案(クリック可) |

---

## 12. メンションポップオーバー

| パーツ | Class | 種類 | 表示タイミング |
|--------|-------|------|---------------|
| ポップオーバー | `.ai-mention-popover` | ドロップダウン | "@" 入力時 |
| メンション項目 | `.ai-mention-item` | リスト項目 | マッチするファイルごと |
| 選択状態 | `.is-selected` | CSSクラス | キーボード選択中 |
| 空状態 | `.ai-mention-empty` | テキスト | "一致するファイルがありません" |
| 件数超過 | `.ai-mention-more` | テキスト | 追加件数表示 |

---

## 13. バックグラウンドトースト

| パーツ | Class | 種類 | 表示タイミング |
|--------|-------|------|---------------|
| トースト | `.ai-bg-toast` | トースト通知 | バックグラウンドチャット完了時 |
| ラベル | テキスト | 通知テキスト | チャットタイトル+ステータス |
| 表示ボタン | `.ai-bg-toast-action` | ボタン | "表示" → チャットに切替 |

**状態**: `.is-error`(エラー時)

---

## 共通状態クラス一覧

| クラス | 意味 | 使用箇所 |
|--------|------|----------|
| `.is-hidden` | 非表示 | メーター, ログインボタン, プロポーザル |
| `.is-visible` | 表示 | モーダル |
| `.is-open` | 展開中 | 履歴パネル, 差分コンテナ |
| `.is-active` | 選択中 | 履歴アイテム |
| `.is-running` | 実行中 | 履歴アイテム |
| `.is-applied` | 適用済み | プロポーザルカード |
| `.is-selected` | ハイライト | メンション項目 |
| `.is-warn` | 警告(80-94%) | メーター |
| `.is-critical` | 危険(95%+) | メーター |
| `.is-error` | エラー | トースト, ステータス |
| `.is-empty` | 空 | 添付バー |
| `.is-loading` | 読込中 | 送信ボタン |
| `.is-add` | 差分追加行 | 差分行 |
| `.is-del` | 差分削除行 | 差分行 |
| `.is-same` | 差分変更なし行 | 差分行 |
