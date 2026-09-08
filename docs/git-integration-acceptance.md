# Git連携の受け入れ条件

2026-09-08追加目標。上流設計はChromeのGPT 6 Proから受領・全文確認済み（17分56秒）。ユーザー回答により「既存URLを貼って接続」と確定。GitHubリポジトリの新規作成APIは含めない。
https://chatgpt.com/c/6a9fd9ab-86f4-83e8-9ce8-38c17d61133d

## 製品範囲

- GitHubリポジトリURLから既存プロジェクトへ接続できる。別リポジトリの内容を取得するcloneと、既存フォルダのremote設定を混同させない。
- 現在のブランチを確認し、ブランチ作成・切替ができる。未保存/未コミット作業の暗黙破棄はしない。
- 変更と送信対象を確認してcommit/pushでき、初回の追跡先設定にも対応する。
- remote更新の取得・取り込みができ、双方の変更がある場合はマージへ進める。
- マージ対象を選択し、競合ファイルを編集・解決・完了、または中止できる。
- 対象コミットへタグを付け、必要なタグを送信できる。
- Gitや認証が不足する場合に、次の行動が分かる導線を持つ。
- 新しいローカル履歴はGit/GitHubなしで引き続き使える。通常保存・履歴の版・Gitコミットを混同させない。
- 文字と色は既存UIの階層に合わせ、補助操作はメニューへ。操作名と結果を短い日本語で伝える。

## 検証条件

- 専用一時リポジトリとbare remoteで接続・commit・push・fetch・branch・merge・競合解決/中止・tagを実走する。利用者の実remoteへ検証用commitを送信しない。
- 既存のrefs/index/config、staged/unstaged/untracked/ignoredファイルを勝手に上書きしない。Gitによる変更に必要な退避と回復は履歴snapshotの除外規則に依存させない。
- 未保存buffer、保存queue、Axiom、端末、組版、TDOM、watcher、同一rootでの世代更新を調停し、旧bufferが切替後のファイルを書き戻さない。
- 中断・再起動・外部変更・競合状態でも編集の再開条件と回復手段が明確である。
- sender/frame/identityをmainで検証し、URL・ref・pathをshell文字列に埋め込まない。秘密情報をUI・ログ・プロセス引数へ露出させない。
- Electronで主要フローを操作して画像を取得し、GPT 6 Proへレビュー依頼。指摘を検証して反映する。
- リアルタイムプレビューの基本機構・組版精度の変更や性能最適化は含めない。

## 現在の確認結果（2026-09-08）

既存GitHub URLを貼り付けて接続する方式を実装。接続は設定のみで、取得・統合・送信を別操作にした。Gitパネル、mainの固定IPC、同梱Git/GCM、暗号化保護、復旧、共有writer調停を接続済み。

| 対象 | 検証 |
| --- | --- |
| 接続・取得 | 専用Electronで公開リポジトリURLを接続しfetch。native親フォルダ選択→URL/保存先確認→別フォルダへcloneも実走し、READMEとclean状態を照合。元文書に変更なし。既存origin維持・重複・不正URL・異なる履歴を実Gitテスト。 |
| コミット・ブランチ・統合 | GUIでファイル選択→コミット→draft切替（B→A）→main取り込み（A→B）。別変更同士の競合を作り、Monacoで解決内容を保存→解決済みにする→統合完了まで実走。2親のmerge commitとclean状態を確認。 |
| 差分・退避 | GUIの実index差分B→Cを確認。Cをstageしたまま一時退避→B、復帰→C stagedを実走。部分stage/rename/削除/二値ファイルは実Gitテストも実施。 |
| タグ・送信 | GUIで注釈付きタグを作成し実オブジェクトを検証。branch/tagの選択送信、non-fast-forward、同名別タグ拒否、送信中断後の照合はローカルbare remoteで実走。利用者のremoteへ検証commitを送信していない。 |
| 保護・復旧 | 操作前後を専用AES-GCM領域へ保存。ファイル・index・refのCAS復旧、起動時journal診断、退避の復帰、native保存先への個別書き出し、故障・外部変更・秘密情報の非露出をテスト。 |
| 編集との連携 | 保存lease→Git実行→世代更新→Monaco同期ack。indexのみの操作はUndo/PDF鮮度を保持。競合中は専用解決操作のみ許可。同root更新がcustomApplyを消して保存画面が閉じない実機不具合を修正し、回帰テストを追加。 |
| 同梱runtime | 両Mac archの公式Git/GCMをpinして取得し、bootstrap/asarUnpackへ接続。arm64起動・ad-hoc署名後起動、x64 Rosetta実行を確認。システムGitへのfallbackなし。 |
| 視覚 | GPT 6 Proへ実画像を提出。無効ボタン枠、branch矢印、空行高さ、文言短縮、Git設定への集約を反映。再提出後「追加修正不要、通常画面と操作メニューの視覚面は完了」を全文受領。 |

`node --test tests/*.test.cjs`: **124件成功、失敗0件**。rendererのtsc、`git diff --check`も成功。Node 24ではディレクトリ引数 `node --test tests/` が解決されなかったため、上記globで全ファイルを実行した。

証拠は `/tmp/tex64-issue39-evidence/`。`git-merge-completed.png`、`git-staged-diff.png`、`git-unshelved-c-staged.png`、`git-visual-after-normal.png`、`git-visual-after-menu.png`。Pro回答は `gpt6-git-design.txt`、`gpt6-git-visual-review.txt`、`gpt6-git-visual-followup.txt`。

## 検証範囲と制約

- 実アカウントでのOAuth認証、macOS 12/13実機、Intel実機、最終配布.app全体は未検証。GCM実行経路と非対話/明示認証の分離はテスト済み。配布前の実環境確認が必要。
- 初期接続はgithub.comのHTTPS。SSH設定は無断変更せず明示的に拒否する。未承認hook・署名・実際に使われるfilter、特殊repository構成は検出して停止する。globalの未使用LFS登録だけでは通常操作を止めない。
- 任意の外部processとの完全なOS排他は保証しない。変更後状態が確定できないクラッシュ・外部変更では全体を推測して上書きせず、保護データと個別書き出しを残す。
- GitHub上のリポジトリ新規作成APIは含めない。ユーザー回答は「既存URLを貼って接続する」。
- 作業ブランチは `codex/issue39-history-issue38`。2026-09-08再fetch時点のHEADとorigin/mainは共に `08e98c8d369217a569e8f8d0aaa90fc63c1d817f`。配布版の公開・ローカル配備は今回の対象外。
