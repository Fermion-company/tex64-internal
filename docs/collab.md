# 共同編集（ローカルファースト）

File › 共同編集… から、開いているワークスペースを他の TeX64 と同時に編集する。設計の経緯は親セッションの設計メモ（tex64-collab-design.md）。

## できること

- **ホスト方式**。開いているフォルダを持つ人が「セッションを開始」すると、その TeX64 の main が WebSocket サーバー（`ws`、0.0.0.0 の空きポート、トークン必須、同時 10 人）になり、招待リンク `tex64://collab/join?h=&p=&t=&n=` を配る。参加者はリンクを貼る（または OS のディープリンクで開く → ダイアログに入る）。
- **参加者もローカル**。参加者は `~/TeX64 Collab/<セッション名>-<id 先頭 8 桁>/` に写しを持ち、通常のワークスペースとして開く（自分の TeX で Build、Live プレビュー、`rootFile` は `.tex64/settings.json` に配布）。退出・終了後も写しはそのまま残る。
- **テキストはファイル 1 本 = Y.Doc 1 つ**（yjs）。合流は CRDT。バイナリ（図版 PDF を含む、50 MB まで）は参加時と変更時にハッシュ付きで送る。除外: `.git` `.tex64` `node_modules`、組版中間物、`\documentclass` を含む `.tex` と同名の `.pdf`、`.env*` `*.key` `*.pem` などの秘密ファイル。
- **ディスクが正**。セッション中、共有テキストの保存は collab 層だけが行う（renderer の autosave は予約しない。Cmd+S・Build・退出は flush）。main の `disk-sync` が 500 ms デバウンスで `withWorkspaceMutation` / `withFileMutation` を通して書き、History・Git・Axiom の lease 中はキューして解放後に書く。保存は `collab:saved {path, hash}` で renderer に届き、`editorSession.markSavedExternally` が同じ内容のときだけ保存済みにする。
- **ディスク→Y.Doc は 3-way**。ファイルごとに baseline（最後に書いた／読んだ内容）を持ち、watch や 3 秒ごとの走査で届いた内容を baseline→ディスクの差分として現在の本文に再配置する。未保存の編集と重なる hunk は本文を優先してディスクへ書き戻し、一行で知らせる。Axiom の編集、Git、History 復元の結果もこの経路で合流する（エポックは進めない。後述）。
- **編集中**: 相手のカーソル・選択は y-monaco の装飾（名前はキャレットの上）。IME 変換中は届いた更新を保留し、確定後に適用する。Undo / Redo は `Y.UndoManager`（自分の編集だけ）。セッション中は Edit メニューの取り消し／やり直しが renderer のコマンドになる。
- **コメント**: `<workspace>/.tex64/comments.json` に保存（旧 localStorage 分は初回に移行）。セッション中はセッション Y.Doc の `comments` が正で、位置は本文の RelativePosition、返信は Y.Array。右クリックに「返信」「解決・再開」。一覧パネルは無い。
- **版の自動記録**: 開始・終了・入退室の直後に、flush 後 lease が取れたときだけ各自の History に `共同編集: <名前, …>` を記録する（取れなければ黙って飛ばす）。ホストは参加者の更新を `.tex64/collab/<session>/updates.log`（JSON Lines、200 MB で rotate）に残す。行単位の著者表示は無い。
- **参加者側の制限**: Git・History の変更系・Axiom の実行はホストだけ。参加者側は一行「ホストが行います / The host does this」で断る。参加者の Build は自由。

## UI（これだけ）

1. File › 共同編集… のダイアログ 1 つ（開始／リンクで参加、セッション中は招待リンクのコピー・参加者一覧・終了／退出）。
2. セッション中だけトップバーの Build 左に参加者の色丸（最大 5、超過は +n）。押すと 1 のダイアログ。

## 扱っていないこと

- **中継サーバーは無い**。届く範囲は LAN・VPN・Tailscale・ポート転送のみ。トランスポートは `transport-ws.cjs` に閉じていて、後で WSS の中継に差し替える。
- **平文 ws**。暗号化は中継を作るときに WSS で。macOS が受信接続の許可を求めることがある。
- **History 復元ではコメントは戻らない**（`.tex64` は履歴の対象外）。
- **エポックは進めない**。ホストの History 復元・Git checkout の結果は外部変更として 3-way で合流し、重なった参加者の未保存編集は本文側を優先する。
- 切断中の編集は再接続時に state vector から再同期する。ホストが落ちたら参加者は写しを持ったまま切断状態になり、手動で退出する。

## 実装

- main: `electron/services/collab/{hub,transport-ws,disk-sync,manifest,invite}.cjs`、`electron/handlers/collab.cjs`（`tex64:collab` / `tex64:collab:send` / `tex64:collab:message`）、`main.cjs` の `collabHub`。
- renderer: `web-src/app/collab/{session,binding,cursors,comments(=code-comments.ts),ui}.ts`。yjs / y-monaco / y-protocols / lib0 は `scripts/build-collab-vendor.cjs` で `Resources/web/vendor/collab.js`（`window.TeX64Collab`）に同梱（`npm run web:build` の前段）。
- 検証は 2 プロセス（`TEX64_E2E_USERDATA` を分ける）。ドライバは `testing/collab-20261031/`。
