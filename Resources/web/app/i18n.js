export const UI_LOCALE_STORAGE_KEY = "tex64.ui.locale.v1";
const JA_TO_EN = {
    ".tex などのテキストファイルを開いて編集してください。": "Open a text file such as .tex and edit it.",
    ".tex ファイルを開いてから再実行してください。": "Please open the .tex file and try again.",
    "1行にまとめる": "summarize in one line",
    "5MBを超える画像は添付できません（{var}件）。": "Images larger than 5MB cannot be attached ({var}).",
    "AIアシスタント": "Axiom",
    "AIエラー": "Axiom error",
    "AIチャット": "Axiom",
    "AI使用量": "Axiom usage",
    "AI使用量: {var}": "Axiom usage: {var}",
    "AI提案の差分": "Axiom proposal diff",
    "AI機能を使うにはGoogleログインが必要です。": "Google login is required to use Axiom.",
    "AI機能を利用できません。": "Axiom is not available.",
    "Duplicate label: {var} ({var} 箇所: {var})": "Duplicate label: {var} ({var} location: {var})",
    "Enterで検索できます。": "You can search by pressing Enter.",
    "Finderで表示": "Show in Finder",
    "Googleでログイン": "Log in with Google",
    "Googleログイン": "Google login",
    "Googleログインがキャンセルされました。": "Google login has been canceled.",
    "Googleログインを処理中です。": "Processing Google login.",
    "LaTeX を入力": "Enter LaTeX",
    "Monacoで編集します。": "Edit with Monaco.",
    "Monacoのローダーが見つかりません。": "Monaco loader not found.",
    "Monacoの初期化に失敗しました。": "Monaco initialization failed.",
    "Monacoの読み込みに失敗しました。": "Failed to load Monaco.",
    "OCRに失敗しました。": "OCR failed.",
    "OCR結果が空でした。": "OCR result was empty.",
    "OFF の場合は PDF を別タブで開きます。": "If OFF, the PDF will open in a separate tab.",
    "ON の場合、長い行をエディタ幅で折り返します。": "If ON, wrap long lines at the editor width.",
    "OS/バージョンなどの診断情報を送信します。": "Sends diagnostic information such as OS/version.",
    "PDF へのジャンプに使用。TeX Distribution に同梱されることが多い。": "Used to jump to PDF. Often bundled with TeX Distribution.",
    "PDFが見つかりません": "PDF not found",
    "PDFプレビュー": "PDF preview",
    "PDF上でCtrl/Cmd+Clickした位置へジャンプします。": "Jump to the Ctrl/Cmd+Click position on the PDF.",
    "PNG/JPEG などの画像ファイルを選択して再試行してください。": "Please select an image file such as PNG/JPEG and try again.",
    "SyncTeX に失敗しました。": "SyncTeX failed.",
    "SyncTeX は .tex ファイルでのみ利用できます。": "SyncTeX is only available for .tex files.",
    "TeX Distribution / ツール確認": "TeX Distribution / Tool confirmation",
    "TeX Live / MacTeX / BasicTeX など、LaTeX エンジンと基本ツール一式。": "A LaTeX engine and a set of basic tools, including TeX Live / MacTeX / BasicTeX.",
    "TeX Live などの環境をインストールしてから再実行してください。": "Please install an environment such as TeX Live and try again.",
    "TeXファイルがありません": "TeX file is missing",
    "TeX環境": "TeX environment",
    "TeX環境のインストールと PATH を確認し、もう一度ビルドしてください。": "Please check your TeX environment installation and PATH and try building again.",
    "TeX環境ガイド": "TeX environment guide",
    "[添付画像 {var}件]": "[attached images {var}]",
    "\\begin / \\end を別行にする": "Put \\begin / \\end on separate lines",
    "\\begin / \\end を揃える": "Align \\begin / \\end",
    "```tex\n(抜粋なし)\n```": "```tex\n(No excerpt)\n````",
    "align / myenv など": "align / myenv etc.",
    "clean -C は PDF なども削除します。実行前に確認ダイアログが表示されます。": "clean -C also removes PDFs etc. A confirmation dialog will be displayed before execution.",
    "clean -C を実行します。PDF なども削除されます。よろしいですか？": "Run clean -C. PDFs etc. will also be deleted. Are you sure?",
    "clean を実行します。補助ファイルを削除します。よろしいですか？": "Run clean. Delete auxiliary files. Are you sure?",
    "document をインデントしない": "do not indent document",
    "documentclass のオプションに文字サイズを指定してください（例: \\\\documentclass[10pt]{revtex4-2}）。": "Please specify the font size in the documentclass option (e.g. \\\\documentclass[10pt]{revtex4-2}).",
    "latexindent / 環境検出": "latexindent / environmental detection",
    "latexindent をインストール、または整形設定を見直してください。": "Please install latexindent or review your formatting settings.",
    "latexmk 追加オプション": "latexmk additional options",
    "line が不正です。": "line is invalid.",
    "minted / myenv など": "minted / myenv etc.",
    "path が空です。": "path is empty.",
    "qcircuit/xypic は lualatex で失敗することがあります。Settings > Build の Engine を pdflatex に変更して再ビルドしてください。": "qcircuit/xypic may fail with lualatex. Please change the Engine in Settings > Build to pdflatex and rebuild.",
    "verbatim 系環境": "verbatim environment",
    "{var} ({var}秒後に再試行)": "{var} (retry after {var} seconds)",
    "{var} (見つかりません)": "{var} (not found)",
    "{var} / {var} トークン": "{var} / {var} token",
    "{var} が未検出です。Settings > 実行環境で確認してください。": "{var} is not detected. Please check Settings > Execution environment.",
    "{var} のインストールに失敗しました。": "{var} installation failed.",
    "{var} のインストールを実行しました。": "Performed {var} installation.",
    "{var} をインストールしています...": "Installing {var}...",
    "{var} を削除しました。": "Removed {var}.",
    "{var} を有効にしました。": "{var} has been enabled.",
    "{var} を無効にしました。": "{var} has been disabled.",
    "{var} を追加しました。": "Added {var}.",
    "{var} 再送キューに保存しました。": "{var} Saved in retransmission queue.",
    "{var}: {var}": "{var}: {var}",
    "{var}ファイルに提案を作成しました（{var}箇所）": "Created suggestion in {var} file ({var} place)",
    "{var}件": "{var} items",
    "。AIパネルで確認できます。": ". You can check it on the AI ​​panel.",
    "。除外: {var}件": ". Exclude: {var}",
    "「フォルダを開く」から作業フォルダを選択してください。": "Select the working folder from \"Open Folder\".",
    "このファイル形式はエディタで開けません。": "This file format cannot be opened with an editor.",
    "このファイル形式は編集できません": "This file format cannot be edited",
    "このファイル形式は編集できません。": "This file format cannot be edited.",
    "この操作は取り消せません。": "This operation cannot be undone.",
    "すべて tex64.com の公開ページをブラウザで開きます。": "Open all public tex64.com pages in your browser.",
    "すべて表示": "Show All",
    "その他": "others",
    "はじめに": "Introduction",
    "まずビルドで検証してください。": "Please verify by building first.",
    "まだプロジェクトを開いていません": "No project opened yet",
    "アウトライン": "Outline",
    "アカウント": "Account",
    "アップデート": "update",
    "アップデート処理に失敗しました。": "Update processing failed.",
    "インストーラを起動しました。画面の手順に沿って更新してください。": "I started the installer. Follow the on-screen instructions to update.",
    "インストール": "install",
    "インストールを開始しました。": "Installation has started.",
    "インストール中...": "Installing...",
    "インストール手順": "Installation instructions",
    "インデックスを作成中です。": "Creating index.",
    "インデックス項目が見つかりません。": "No index entries found.",
    "インデント": "indentation",
    "インライン": "inline",
    "インライン/別行の囲み方": "How to enclose inline/separate line",
    "インラインの囲み": "inline box",
    "ウィンドウ一覧": "Window list",
    "ウィンドウ一覧の取得に失敗しました。": "Failed to get window list.",
    "ウィンドウ一覧の取得に失敗しました。画面収録の許可を確認してください。": "Failed to get window list. Please confirm permission for screen recording.",
    "エクスプローラー": "explorer",
    "エディタ": "editor",
    "エディタの準備が完了していません。": "Editor is not ready.",
    "エディタ共通の設定を表示します。": "Displays settings common to all editors.",
    "エディタ設定": "Editor settings",
    "エディタ領域が見つかりません。": "Editor area not found.",
    "エラー": "Issues",
    "エラーが発生しました。": "An error has occurred.",
    "カテゴリ": "category",
    "キャプチャ範囲を選択し直して再試行してください。": "Please reselect the capture range and try again.",
    "キャンセル": "cancel",
    "キャンバスの初期化に失敗しました。": "Canvas initialization failed.",
    "キーに空白・カンマ・{} は使えません。": "Spaces, commas, and {} cannot be used in keys.",
    "クリックでRuntimeを開く": "Click to open Runtime",
    "クリックで定義に移動します。": "Click to go to definition.",
    "クリックで移動": "Click to move",
    "クリックで該当箇所へ移動します。": "Click to move to the corresponding location.",
    "クリーン": "clean",
    "コンパイル": "compile",
    "コンパイル / SyncTeX / プロファイル": "Compile / SyncTeX / Profile",
    "コンパイルエンジン": "compilation engine",
    "ゴースト補完": "ghost completion",
    "ゴースト補完を有効化": "Enable ghost completion",
    "サイドバー": "sidebar",
    "サイドバー詳細": "Sidebar details",
    "サポート": "support",
    "シンボルリネーム": "symbol rename",
    "スペース: 2": "Space: 2",
    "スペース: 4": "Space: 4",
    "タブ": "tab",
    "ターミナルで開く": "open in terminal",
    "ダウンロード完了。適用ボタンでインストーラを起動できます。": "Download completed. You can launch the installer with the Apply button.",
    "チャットでファイル提案やテンプレート作成を行います。": "Suggest files and create templates via chat.",
    "デスクトップアプリで開いているか確認し、再起動してください。": "Make sure it's open in the desktop app and try restarting.",
    "トリガーパック": "trigger pack",
    "ドラッグして範囲を調整": "Drag to adjust range",
    "ネイティブ連携": "Native integration",
    "ネイティブ連携が利用できません。": "Native integration is not available.",
    "バイナリファイルのため差分プレビューは省略しています。": "Difference preview is omitted because it is a binary file.",
    "パネルを閉じる": "Close panel",
    "ビルド": "build",
    "ビルド (Cmd+B)": "Build (Cmd+B)",
    "ビルドが失敗した場合: 失敗理由を特定し、必要最小限の修正提案だけを出してください（軽微な気になる点は無理に直さない）。": "If the build fails: Identify the reason for the failure and suggest only the minimum necessary fixes (do not force fixes on minor issues).",
    "ビルドが成功した場合: 次に進むための提案を1つだけ出してください（闇雲な大規模変更はしない）。": "If the build is successful: Please provide only one suggestion for moving forward (no blind wholesale changes).",
    "ビルドしてPDFを生成し、.tex ファイルでSyncTeXを実行してください。": "Build to generate PDF and run SyncTeX on the .tex file.",
    "ビルドに使用するエンジンを選択します。": "Select the engine to use for your build.",
    "ビルドに失敗しました": "build failed",
    "ビルドの起動に失敗": "Failed to start build",
    "ビルドや操作のエラーを一覧で表示します。": "Displays a list of build and operation errors.",
    "ビルドをキャンセル": "cancel build",
    "ビルドをキャンセルしています...": "Canceling build...",
    "ビルドを実行": "run build",
    "ビルドを実行してPDFを生成してください。": "Run the build and generate the PDF.",
    "ビルドを自動化するコマンド。TeX Distribution に同梱されることが多い。": "Commands to automate builds. Often bundled with TeX Distribution.",
    "ビルドを開始します。": "Start the build.",
    "ビルドエラー": "build error",
    "ビルドプロファイル": "build profile",
    "ビルドログを確認し、該当ファイルのエラーを修正して再ビルドしてください。": "Please check the build log, correct any errors in the relevant file, and rebuild.",
    "ビルド対象の主ファイルです。": "This is the main file to be built.",
    "ビルド成功時に自動でPDFへジャンプします。": "Automatically jumps to PDF when build is successful.",
    "ビルド時SyncTeX": "SyncTeX at build time",
    "ビルド結果はここに要約します。": "The build results are summarized here.",
    "ファイル": "file",
    "ファイルが未選択です。": "No file selected.",
    "ファイルが見つかりません。": "file not found.",
    "ファイルの変更案": "Proposed file changes",
    "ファイルの存在とパスを確認し、再度開いてください。": "Please check the existence and path of the file and try opening it again.",
    "ファイルを削除": "delete file",
    "ファイルを開けません": "can't open file",
    "ファイルを開けません。": "Unable to open file.",
    "ファイルタブが選択されています。": "File tab is selected.",
    "ファイル名": "file name",
    "ファイル名に末尾の / は使えません。": "Trailing / cannot be used in file names.",
    "ファイル名（拡張子付き）": "File name (with extension)",
    "フィードバック": "Feedback",
    "フィードバックを送信しています...": "Submitting feedback...",
    "フィードバックを送信しました{var}{var}": "Submitted feedback{var}{var}",
    "フィードバック内容を入力してください。": "Please enter your feedback.",
    "フィードバック送信に失敗した場合は、アプリ内で再送キューに保存して再試行します。": "If sending feedback fails, save it to a resend queue within the app and try again.",
    "フィードバック送信に失敗しました。": "Failed to send feedback.",
    "フィードバック送信に失敗しました。再送します。": "Failed to send feedback. I will resend it.",
    "フィードバック送信を開始できませんでした。": "Failed to start sending feedback.",
    "フォルダ": "folder",
    "フォルダとその中のすべてのファイルが削除されます。この操作は取り消せません。": "The folder and all files within it will be deleted. This operation cannot be undone.",
    "フォルダを削除": "delete folder",
    "フォルダを開いてください。": "Please open the folder.",
    "フォルダを開く": "Open Folder",
    "フォルダ名": "folder name",
    "ブラウザを起動できませんでした。": "Failed to start browser.",
    "ブロック": "Blocks",
    "ブロックは .tex": "The block is .tex",
    "ブロックは .tex ファイルでのみ挿入できます。": "Blocks can only be inserted in .tex files.",
    "ブロック一覧": "Block list",
    "プライバシー": "privacy",
    "プランを見る": "See plan",
    "プラン・契約状態を確認してください。": "Please check your plan/contract status.",
    "プレビュー": "preview",
    "プレビューがタイムアウトしました。": "Preview timed out.",
    "プレビューに失敗しました。": "Preview failed.",
    "プレビュー後に確定します。": "Confirm after previewing.",
    "プロジェクト": "Project",
    "プロジェクトの流儀に合わせて latexmk の出力先や追加オプションを切り替えます。": "Switch latexmk's output destination and additional options to suit your project style.",
    "プロジェクト設定": "Project settings",
    "プロジェクト設定は別タブにあります。": "Project settings are in a separate tab.",
    "プロファイル「{var}」を削除しますか？": "Do you want to delete profile \"{var}\"?",
    "プロファイル名": "profile name",
    "ヘルプ": "help",
    "ヘルプ、問い合わせ、リリース情報を開きます。": "Open Help, Contact Us, Release Information.",
    "ボトムパネル": "bottom panel",
    "ボトムパネルの境界": "bottom panel border",
    "ミニアウトライン: main.tex": "Mini outline: main.tex",
    "メインTeX": "Main TeX",
    "メインTeXや環境登録を管理します。": "Manage main TeX and environment registration.",
    "メインTeXを選択": "Select main TeX",
    "ラベル": "label",
    "リネーム": "rename",
    "リネームに失敗しました。": "Rename failed.",
    "リリースノート": "release notes",
    "ログと該当行を確認して修正してください。": "Please check the log and the relevant line and correct it.",
    "ログアウト": "Logout",
    "ログイン": "Login",
    "ログイン / アップデート": "Login/Update",
    "ログインがタイムアウトしました。": "Login timed out.",
    "ログインに失敗しました。": "login failed.",
    "ログインページを開けませんでした。": "The login page could not be opened.",
    "ログイン処理中": "Signing in",
    "ログイン処理中...": "Signing in...",
    "ログイン済み": "Signed in",
    "ログイン済み: {var}": "Logged in: {var}",
    "ログイン状態を確認できませんでした。": "Login status could not be confirmed.",
    "ログイン結果の検証に失敗しました。": "Login result validation failed.",
    "ワークスペース": "work space",
    "ワークスペースが未選択です。": "No workspace is selected.",
    "ワークスペースを開くとビルドプロファイルを編集できます。": "You can edit the build profile by opening the workspace.",
    "ワークスペース内の相対パスで、/ や .. を含めずに入力してください。": "Please enter the path relative to your workspace without including / or ...",
    "ワークスペース内を検索します。": "Search within your workspace.",
    "ワークスペース単位の設定を管理します。": "Manage per-workspace settings.",
    "ワークスペース未選択": "No workspace selected",
    "ワークスペース直下": "Directly below the workspace",
    "一致する結果がありません。": "No matching results found.",
    "不具合": "defect",
    "不具合・要望を送信": "Send a bug/request",
    "不要なファイルやキャッシュを削除して容量を確保してください。": "Please free up space by deleting unnecessary files and caches.",
    "不足: {var}。TeX環境を整備して再チェックしてください。": "Missing: {var}. Please prepare the TeX environment and check again.",
    "今月のトークン上限に達しました。": "You have reached your token limit for this month.",
    "位置不明": "Unknown location",
    "作成": "Create",
    "作成して次へ": "Create and continue",
    "作成先": "Create destination",
    "例: -use-biber -shell-escape": "Example: -use-biber -shell-escape",
    "例: sections": "Example: sections",
    "例: sections/intro.tex": "Example: sections/intro.tex",
    "保存するファイルが選択されていません。": "No files have been selected to save.",
    "保存に失敗": "Failed to save",
    "保存に失敗しました。": "Saving failed.",
    "保存の待機がタイムアウトしました。": "Waiting for save timed out.",
    "保存中...": "Saving...",
    "保存先の権限とディスク容量を確認して再試行してください。": "Please check the permissions and disk space of the save destination and try again.",
    "保存容量が一杯": "Full storage capacity",
    "保存対象の内容を取得できません: {var}": "Unable to retrieve content to save: {var}",
    "保持": "retention",
    "個人/装飾": "personal/decoration",
    "候補の表示": "Show suggestions",
    "停止": "Stop",
    "入力を確認してください。": "Please check your input.",
    "入力停止から表示までの待ち時間です。": "This is the waiting time from input stop to display.",
    "内容": "Content",
    "再チェック": "Recheck",
    "再検出": "redetection",
    "再開": "Resume",
    "分割": "division",
    "分割ビューの境界": "Split view boundaries",
    "切り取りに失敗": "failed to cut",
    "切り取りに失敗しました。": "Cutting failed.",
    "列を削除": "delete column",
    "列を追加": "add column",
    "初回セットアップ: 1) 実行環境を確認中 2) ワークスペースを開く 3) 最初のビルドを実行": "First time setup: 1) Checking the execution environment 2) Opening the workspace 3) Running the first build",
    "初回セットアップ: 1/3 実行環境が不足 ({var})。": "First time setup: 1/3 Insufficient execution environment ({var}).",
    "初回セットアップ: 1/3 実行環境が不足しています。": "Initial setup: 1/3 Execution environment is insufficient.",
    "初回セットアップ: 2/3 ワークスペースを開いてください。": "First time setup: 2/3 Open your workspace.",
    "初回セットアップ: 3/3 最初のビルドを実行してください。": "First time setup: 3/3 Run your first build.",
    "初回セットアップを準備中です。": "Preparing for initial setup.",
    "初回セットアップ完了: いつでも Build を実行できます。": "First-time setup complete: You can run Build at any time.",
    "別ウィンドウでビルド": "Build in separate window",
    "別行": "Separate line",
    "別行立ての囲み": "separate line box",
    "利用可能": "Available",
    "利用規約": "terms of service",
    "利用規約やプライバシーポリシーを確認します。": "Check the terms of use and privacy policy.",
    "利用開始の準備が完了しています。": "Preparations for start of use are complete.",
    "利用開始の準備は完了しています（任意: latexindent 未検出）。": "Ready to start using (optional: latexindent not detected).",
    "削除": "Delete",
    "削除して次へ": "Delete and continue",
    "削除の確認": "Confirm deletion",
    "匿名エラーレポート": "anonymous error report",
    "参考文献": "References",
    "取り消し": "Dismiss",
    "取り消し失敗: {var}": "Cancellation failure: {var}",
    "取り消し完了: {var}": "Cancellation completed: {var}",
    "取り込み可能なウィンドウ": "Captureable window",
    "取り込み可能なウィンドウがありません。画面収録の許可を確認してください。": "There are no retrievable windows. Please confirm permission for screen recording.",
    "取り込み対象を選択": "Select import target",
    "名前に / は使えません": "/ cannot be used in name",
    "名前に / は使えません。": "/ cannot be used in the name.",
    "名前の変更": "rename",
    "名前の変更...": "Rename...",
    "名前を入力": "enter name",
    "名前を入力してください。": "Please enter your name.",
    "問い合わせ": "inquiry",
    "問題はありません。": "No issues.",
    "囲まない": "Not enclosed",
    "執筆内容を指示してください...": "Please tell me what to write...",
    "変更": "Rename",
    "変更なし": "No change",
    "変更は自動で保存されます。": "Changes are saved automatically.",
    "変更内容の確認": "Confirm changes",
    "変更内容の確認（確定後に整形）": "Confirm changes (format after finalization)",
    "実行": "execution",
    "実行中": "Running",
    "実行環境": "Execution environment",
    "実行環境が不足しています: {var}": "Missing execution environment: {var}",
    "実行環境が不足しています。": "Execution environment is insufficient.",
    "実行環境が不足しています。Settings > 実行環境で確認してください。": "Execution environment is insufficient. Please check Settings > Execution environment.",
    "実行環境を確認中です。": "Checking the execution environment.",
    "実行環境チェック中です。完了後に再度 Build を実行してください。": "Checking the execution environment. Please run Build again after completion.",
    "対応していないファイル形式": "Unsupported file formats",
    "対象": "subject",
    "対象（ラベル/参照・引用）を選んでください。": "Please select the target (label/reference/citation).",
    "小段落": "small paragraph",
    "小節": "measure",
    "小項": "subsection",
    "履歴": "History",
    "履歴なし": "No history",
    "差分を確認して適用します。": "Check and apply the differences.",
    "差分を見る": "View diff",
    "差分を閉じる": "Hide diff",
    "差分（-削除 / +追加）": "Difference (-delete/+add)",
    "待機中": "Waiting",
    "思考中": "Thinking",
    "思考中...": "Thinking...",
    "思考中: {var}": "Thinking: {var}",
    "情報": "Info",
    "戻る": "Back",
    "手動のみ": "manual only",
    "手動ダウンロード": "manual download",
    "手動表示:": "Manual display:",
    "折りたたむ": "fold",
    "抜粋がタイムアウトしました。": "Excerpt timed out.",
    "抜粋に失敗しました。": "Excerpt failed.",
    "挿入": "insert",
    "挿入モード": "insert mode",
    "挿入形式": "Insertion format",
    "挿入形式: {var}": "Insert format: {var}",
    "推奨: 遅延 200–400ms、最大文字数 80–200 くらいが邪魔になりにくいです。": "Recommended: 200–400ms delay and 80–200 maximum characters are less distracting.",
    "提案 {var}": "Proposals {var}",
    "提案を作成中...": "Creating a proposal...",
    "改善してほしい点や不具合の再現手順など": "Points to be improved and steps to reproduce the problem, etc.",
    "数学拡張": "math extension",
    "数式": "mathematical formula",
    "数式/表 環境": "Formula/Table Environment",
    "数式OCRが利用できません。": "Formula OCR is not available.",
    "数式の & を揃える": "Align the & in the formula",
    "数式をブロックとして挿入します。": "Insert formulas as blocks.",
    "数式エディタの初期化に失敗しました:": "Failed to initialize formula editor:",
    "数式キーボード": "math keyboard",
    "数式ブロック設定": "Formula block settings",
    "数式メニュー": "Math menu",
    "数式入力リスナーのエラー:": "Formula input listener error:",
    "数式入力（テキスト）": "Formula input (text)",
    "数式取り込み": "Formula import",
    "整形": "Format",
    "整形に失敗しました。": "Plastic surgery failed.",
    "整形のリクエストに失敗しました。": "The formatting request failed.",
    "整形をスキップする環境を追加できます。": "You can add an environment to skip formatting.",
    "整形設定を見直すか、整形をオフにして再保存してください。": "Please review your formatting settings or turn formatting off and resave.",
    "整形（Format）に使用。TeX Distribution に同梱されることが多い。": "Used for formatting. Often bundled with TeX Distribution.",
    "文字": "character",
    "文字を検出できません": "character not detected",
    "新しいキー": "new key",
    "新しいキーが同じです。": "The new key is the same.",
    "新しいチャット": "New Chat",
    "新しいバージョン {var} を利用できます。": "A new version of {var} is available.",
    "新しいバージョンを利用できます。": "A new version is available.",
    "新しいファイル...": "New file...",
    "新しいフォルダを作成します。": "Create a new folder.",
    "新しいフォルダー...": "New folder...",
    "新しい名前": "new name",
    "新規": "New",
    "新規チャット": "New chat",
    "新規ファイルを作成": "create new file",
    "新規ファイル名": "new file name",
    "新規ファイル名（例: chapter/intro.tex）": "New file name (e.g. chapter/intro.tex)",
    "新規フォルダを作成": "Create new folder",
    "新規フォルダ名（例: chapter）": "New folder name (e.g. chapter)",
    "新規作成": "Create New",
    "既に別カテゴリで登録されています。": "Already registered in another category.",
    "既に登録されています。": "Already registered.",
    "日本語トリガー": "Japanese trigger",
    "更新/再インストール": "Update/Reinstall",
    "更新あり": "Update",
    "更新をダウンロード中です（{var} / {var}）。": "Downloading updates ({var} / {var}).",
    "更新を確認": "Check for updates",
    "更新を確認しています。": "Checking for updates.",
    "更新を適用": "Apply updates",
    "更新確認待ちです。": "Waiting for update check.",
    "最初のビルドを実行": "run the first build",
    "最大文字数": "Maximum number of characters",
    "最新バージョン": "Latest version",
    "最新バージョン {var} です。": "Latest version {var}.",
    "最新状態です。": "Up to date.",
    "最近から削除": "Delete from recent",
    "最近のプロジェクト": "Recent Projects",
    "未ログイン": "Signed out",
    "未保存": "Unsaved",
    "未保存の変更があります": "There are unsaved changes",
    "未保存の変更があります。保存してから名前を変更してください。": "There are unsaved changes. Please save and rename.",
    "未保存の変更があります。削除前に保存してください。": "There are unsaved changes. Please save before deleting.",
    "未保存の変更があります。移動前に保存してください。": "There are unsaved changes. Please save before moving.",
    "未検出": "Not found",
    "未選択": "Not selected",
    "末尾の / は使えません": "Trailing / cannot be used",
    "本アプリのビルド/整形/SyncTeX には TeX Distribution と latexmk / latexindent / synctex が必要です（多くは同梱）。": "TeX Distribution and latexmk / latexindent / synctex are required for building/formatting/SyncTeX of this application (many are included).",
    "検索": "Search",
    "検索中...": "Searching...",
    "検索結果": "Search results",
    "検索語": "search term",
    "次回リセット: {var}": "Next reset: {var}",
    "残り{var}件を再送待ちです。": "We are waiting for the remaining {var} items to be resent.",
    "段落": "paragraph",
    "法務": "legal affairs",
    "法務 / サポート": "Legal/Support",
    "添付を削除": "remove attachment",
    "添付画像の合計サイズは8MBまでです。": "The total size of attached images is up to 8MB.",
    "添付画像を解析してください。": "Please analyze the attached image.",
    "物理/量子": "physics/quantum",
    "特商法": "Special commercial law",
    "現在のキー": "current key",
    "現在のキーと新しいキーを入力してください。": "Please enter your current key and new key.",
    "現在のバージョン": "current version",
    "現在の契約状態ではAI機能を利用できません。": "AI functions are not available under the current contract status.",
    "現在開いているフォルダです。": "This is the currently open folder.",
    "環境": "Environment",
    "環境チェック": "Environmental check",
    "環境名が空です。": "Environment name is empty.",
    "環境名のみ（`*` 不要）": "Environment name only (`*` not required)",
    "生成物の出力先（空ならデフォルト）。例: build": "Destination for output of products (default if empty). Example: build",
    "画像がありません": "No image available",
    "画像の読み込みに失敗したため添付できませんでした（{var}件）。": "The image could not be attached because it failed to load ({var} items).",
    "画像の読み込みに失敗しました。": "Failed to load image.",
    "画像を再取得し、文字や数式が鮮明に写っているか確認してください。": "Please re-obtain the image and check that the characters and formulas are clearly visible.",
    "画像を撮り直し、コントラストを上げて再度取り込んでください。": "Please retake the image, increase the contrast and re-import it.",
    "画像を添付": "Attach image",
    "画像を送信しました。": "The image has been sent.",
    "画像データが空です。": "Image data is empty.",
    "画像ファイルのみ添付できます（{var}件を除外）。": "Only image files can be attached (excluding {var}).",
    "画像添付は最大4件までです。": "Up to 4 images can be attached.",
    "画面キャプチャ": "screen capture",
    "画面キャプチャが利用できません。": "Screen capture is not available.",
    "画面キャプチャが利用できません。画面収録の許可を確認してください。": "Screen capture is not available. Please confirm permission for screen recording.",
    "画面収録": "Screen recording",
    "画面収録の許可を有効にして再試行してください。": "Please enable screen recording permission and try again.",
    "直前のユーザー指示と会話の目的を最優先して、自律的に継続してください。": "Continue autonomously, prioritizing last-minute user instructions and the purpose of the conversation.",
    "矢印": "arrow",
    "確定": "Confirm",
    "確認中...": "Checking...",
    "移動": "move",
    "移動/リネーム前に該当ファイルを保存してください。": "Please save the relevant file before moving/renaming.",
    "移動して次へ": "Move and continue",
    "移動先が不正": "Invalid destination",
    "移動先が不正です。": "The destination is invalid.",
    "移動先を特定できません。ビルドログを確認": "Unable to determine destination. Check the build log",
    "移動先フォルダを確認して、別の場所へ移動してください。": "Please check the destination folder and move to another location.",
    "空欄にならないよう名前を入力してください。": "Please enter your name so that it is not blank.",
    "空行の扱い": "Handling of blank lines",
    "章": "chapter",
    "章節": "chapter and verse",
    "章節 / 図表 / TODO": "Chapter/Chart/TODO",
    "章節や図表、TODO、参照を一覧で表示します。": "Displays a list of chapters, diagrams, TODOs, and references.",
    "節": "section",
    "範囲を切り取る": "cut range",
    "絶対パスは使えません": "Absolute path cannot be used",
    "絶対パスは使えません。": "Absolute paths cannot be used.",
    "編集": "Edit",
    "編集エリア": "Editing area",
    "編集モード": "Edit mode",
    "自動で表示": "Display automatically",
    "自動に戻す": "revert to automatic",
    "自動サジェストに含める候補を切り替えます（手動表示は全パックを検索）": "Switch the suggestions to be included in automatic suggestions (search all packs for manual display)",
    "自動検出": "automatic detection",
    "致命的エラー時に診断情報を tex64.com へ送信します。": "Sends diagnostic information to tex64.com on fatal errors.",
    "行 {var}": "Line {var}",
    "行を削除": "delete row",
    "行を折り返して表示": "Wrap lines",
    "行を追加": "add row",
    "行末で予測を薄く表示します。AIによる補完候補が表示されます。": "Displays predictions dimly at the end of the line. Completion candidates by AI will be displayed.",
    "表": "table",
    "表の & を揃える": "Align & in table",
    "表示": "display",
    "表示 / AI補完": "Display / AI completion",
    "表示遅延": "display delay",
    "補助": "auxiliary",
    "補助ファイル（.aux/.log/.synctex.gz 等）を削除します。": "Delete auxiliary files (.aux/.log/.synctex.gz, etc.).",
    "要対応": "Action required",
    "要望": "request",
    "要設定": "Setup needed",
    "見つかりません": "not found",
    "親ディレクトリを含む名前は使えません": "Names that include parent directories cannot be used",
    "親ディレクトリを含む名前は使えません。": "Names that include parent directories cannot be used.",
    "解析失敗": "Analysis failure",
    "設定": "Settings",
    "設定 > Runtime を開いて、TeX環境のインストール状態を確認してください。": "Check the installation status of your TeX environment by opening Settings > Runtime.",
    "設定が取得できませんでした。": "Settings could not be retrieved.",
    "診断情報を添付（任意）": "Attach diagnostic information (optional)",
    "詳細を見る": "View details",
    "詳細を閉じる": "Hide details",
    "詳細ログ": "Detailed log",
    "論理": "logic",
    "警告": "Warning",
    "警告は自動で移動先を特定できないことがあります。ビルドログの前後行を確認して修正してください。": "Warnings may not be able to automatically identify the destination. Please check the preceding and following lines in the build log and correct it.",
    "貼り付けは .tex": "Paste is .tex",
    "起動時にフォルダを選択してください。": "Please select a folder at startup.",
    "返金ポリシー": "Refund policy",
    "追加": "addition",
    "送信": "Send",
    "送信できなかった入力を復元しました。内容を確認して再送信してください。": "Restored input that could not be sent. Please check the contents and resend.",
    "送信キューに追加しました。": "Added to send queue.",
    "送信中...": "Sending...",
    "逆SyncTeX（PDF→ソース）": "Reverse SyncTeX (PDF → source)",
    "連絡先メールアドレスの形式を確認してください。": "Please check the format of your contact email address.",
    "連絡先（任意）": "Contact information (optional)",
    "適用": "Apply",
    "適用失敗": "Apply failure",
    "適用完了: {var}": "Applied: {var}",
    "適用競合": "Apply conflict",
    "選択した画面のサムネイル取得に失敗しました。別の画面を選択してください。": "Failed to obtain thumbnail of selected screen. Please select another screen.",
    "選択中": "Selected",
    "部分編集": "Partial editing",
    "長すぎる提案は表示しません。": "Don't display suggestions that are too long.",
    "閉じる": "close",
    "開く": "open",
    "集合": "set",
    "集合/論理": "set/logic",
    "非対応ファイルです": "This is an unsupported file.",
    "非推奨": "Not recommended",
    "項": "term",
    "表示言語": "Language",
    "UI の表示言語を切り替えます。": "Switch the UI language.",
    "言語": "Language",
    "日本語": "Japanese"
};
JA_TO_EN["\\\\begin / \\\\end を別行にする"] = "Put \\\\begin / \\\\end on separate lines";
JA_TO_EN["\\\\begin / \\\\end を揃える"] = "Align \\\\begin / \\\\end";
JA_TO_EN["documentclass のオプションに文字サイズを指定してください（例: \\\\\\\\documentclass[10pt]{revtex4-2}）。"] =
    "Specify a font-size option in documentclass (e.g. \\\\documentclass[10pt]{revtex4-2}).";
JA_TO_EN["処理中"] = "Processing";
JA_TO_EN["コマンドを実行中"] = "Running command";
JA_TO_EN["設定を確認中"] = "Checking settings";
JA_TO_EN["設定を更新中"] = "Updating settings";
JA_TO_EN["ファイル一覧を確認中"] = "Checking file list";
JA_TO_EN["ファイル内容を確認中"] = "Checking file content";
JA_TO_EN["プロジェクト構成を確認中"] = "Checking project structure";
JA_TO_EN["参照情報を確認中"] = "Checking references";
JA_TO_EN["関連箇所を検索中"] = "Searching related locations";
JA_TO_EN["複数ファイルを確認中"] = "Reviewing multiple files";
JA_TO_EN["編集案を作成中"] = "Creating edit proposal";
JA_TO_EN["削除案を作成中"] = "Creating delete proposal";
JA_TO_EN["ディレクトリ作成案を作成中"] = "Creating directory proposal";
JA_TO_EN["リネーム案を作成中"] = "Creating rename proposal";
JA_TO_EN["ラベル・参照の整合を更新中"] = "Updating labels and references";
JA_TO_EN["ビルドを検証中"] = "Verifying build";
const TRANSLATABLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];
let currentLocale = "ja";
const localeListeners = new Set();
const textOriginalMap = new WeakMap();
const attributeOriginalMap = new WeakMap();
let observer = null;
let applying = false;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN_ENTRIES = Object.entries(JA_TO_EN)
    .filter(([source]) => source.includes("{var}"))
    .map(([source, template]) => {
    const pattern = "^" + escapeRegExp(source).replace(/\\\{var\\\}/g, "(.+?)") + "$";
    return {
        regex: new RegExp(pattern),
        template,
    };
});
const normalizeUiLocaleValue = (value) => {
    if (typeof value !== "string")
        return null;
    const normalized = value.trim().toLowerCase();
    if (!normalized)
        return null;
    const base = normalized.split(/[-_]/, 1)[0];
    if (base === "ja")
        return "ja";
    if (base === "en")
        return "en";
    return null;
};
const translateCore = (source) => {
    var _a;
    const direct = JA_TO_EN[source];
    if (typeof direct === "string")
        return direct;
    for (const entry of PATTERN_ENTRIES) {
        const match = source.match(entry.regex);
        if (!match)
            continue;
        let rendered = entry.template;
        for (let index = 1; index < match.length; index += 1) {
            rendered = rendered.replace("{var}", (_a = match[index]) !== null && _a !== void 0 ? _a : "");
        }
        return rendered;
    }
    return source;
};
const translateKeepingWhitespace = (value) => {
    var _a, _b, _c, _d;
    const leading = (_b = (_a = value.match(/^\s*/)) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : "";
    const trailing = (_d = (_c = value.match(/\s*$/)) === null || _c === void 0 ? void 0 : _c[0]) !== null && _d !== void 0 ? _d : "";
    const core = value.trim();
    if (!core)
        return value;
    const translated = translateCore(core);
    return `${leading}${translated}${trailing}`;
};
const applyLocaleToTextNode = (node) => {
    var _a;
    if (!node.parentElement)
        return;
    const original = (_a = textOriginalMap.get(node)) !== null && _a !== void 0 ? _a : node.data;
    if (!textOriginalMap.has(node)) {
        textOriginalMap.set(node, original);
    }
    const next = currentLocale === "en" ? translateKeepingWhitespace(original) : original;
    if (node.data !== next) {
        node.data = next;
    }
};
const getAttributeOriginal = (element, attributeName, currentValue) => {
    var _a, _b;
    const record = (_a = attributeOriginalMap.get(element)) !== null && _a !== void 0 ? _a : new Map();
    if (!attributeOriginalMap.has(element)) {
        attributeOriginalMap.set(element, record);
    }
    if (!record.has(attributeName)) {
        record.set(attributeName, currentValue);
    }
    return (_b = record.get(attributeName)) !== null && _b !== void 0 ? _b : currentValue;
};
const applyLocaleToAttributes = (element) => {
    var _a;
    for (const attributeName of TRANSLATABLE_ATTRIBUTES) {
        if (!element.hasAttribute(attributeName))
            continue;
        const currentValue = (_a = element.getAttribute(attributeName)) !== null && _a !== void 0 ? _a : "";
        const originalValue = getAttributeOriginal(element, attributeName, currentValue);
        const next = currentLocale === "en" ? translateKeepingWhitespace(originalValue) : originalValue;
        if (currentValue !== next) {
            element.setAttribute(attributeName, next);
        }
    }
};
const applyLocaleToNode = (node) => {
    if (node instanceof Text) {
        applyLocaleToTextNode(node);
        return;
    }
    if (!(node instanceof Document || node instanceof DocumentFragment || node instanceof Element)) {
        return;
    }
    if (node instanceof Element) {
        applyLocaleToAttributes(node);
    }
    const root = node instanceof Document ? node.documentElement : node;
    if (!(root instanceof Element || root instanceof DocumentFragment))
        return;
    root.querySelectorAll("*").forEach((element) => {
        applyLocaleToAttributes(element);
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = walker.currentNode;
        if (textNode instanceof Text) {
            applyLocaleToTextNode(textNode);
        }
    }
};
const withApplyGuard = (handler) => {
    if (applying)
        return;
    applying = true;
    try {
        handler();
    }
    finally {
        applying = false;
    }
};
const ensureObserver = () => {
    if (observer || typeof MutationObserver === "undefined")
        return;
    observer = new MutationObserver((mutations) => {
        withApplyGuard(() => {
            mutations.forEach((mutation) => {
                if (mutation.type === "characterData" && mutation.target instanceof Text) {
                    applyLocaleToTextNode(mutation.target);
                    return;
                }
                if (mutation.type === "attributes" && mutation.target instanceof Element) {
                    applyLocaleToAttributes(mutation.target);
                    return;
                }
                if (mutation.type === "childList") {
                    mutation.addedNodes.forEach((addedNode) => {
                        applyLocaleToNode(addedNode);
                    });
                }
            });
        });
    });
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });
};
const applyUiLocaleToDocument = (locale) => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.uiLocale = locale;
};
export const getUiLocale = () => currentLocale;
export const getStoredUiLocale = () => {
    try {
        return normalizeUiLocaleValue(localStorage.getItem(UI_LOCALE_STORAGE_KEY));
    }
    catch {
        return null;
    }
};
export const applyI18n = (root = document) => {
    withApplyGuard(() => applyLocaleToNode(root));
};
export const setUiLocale = (locale) => {
    if (locale === currentLocale)
        return;
    currentLocale = locale;
    try {
        localStorage.setItem(UI_LOCALE_STORAGE_KEY, locale);
    }
    catch {
        // ignore storage failures
    }
    applyUiLocaleToDocument(locale);
    applyI18n(document);
    localeListeners.forEach((listener) => {
        try {
            listener(locale);
        }
        catch {
            // ignore listener failures
        }
    });
};
export const onUiLocaleChange = (listener) => {
    if (typeof listener !== "function") {
        return () => { };
    }
    localeListeners.add(listener);
    return () => localeListeners.delete(listener);
};
export const initI18n = () => {
    const stored = getStoredUiLocale();
    currentLocale = stored !== null && stored !== void 0 ? stored : "ja";
    applyUiLocaleToDocument(currentLocale);
    ensureObserver();
    applyI18n(document);
};
export const normalizeUiLocale = normalizeUiLocaleValue;
