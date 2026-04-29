export const UI_LOCALE_STORAGE_KEY = "tex64.ui.locale.v1";
const EN_TO_JA = {
    ". Exclude: {var}": "。除外: {var}件",
    ". You can check it on the AI ​​panel.": "。AIパネルで確認できます。",
    "... {var} more": "… 他 {var} 件",
    "/ cannot be used in name": "名前に / は使えません",
    "/ cannot be used in the name.": "名前に / は使えません。",
    "[attached images {var}]": "[添付画像 {var}件]",
    "```tex\n(No excerpt)\n```": "```tex\n(抜粋なし)\n```",
    "A LaTeX engine and a set of basic tools, including TeX Live / MacTeX / BasicTeX.": "TeX Live / MacTeX / BasicTeX など、LaTeX エンジンと基本ツール一式。",
    "A new version is available.": "新しいバージョンを利用できます。",
    "A new version of {var} is available.": "新しいバージョン {var} を利用できます。",
    "Aborted.": "中断しました。",
    "Absolute path cannot be used": "絶対パスは使えません",
    "Absolute paths cannot be used.": "絶対パスは使えません。",
    "Account": "アカウント",
    "Action required": "要対応",
    "add column": "列を追加",
    "add row": "行を追加",
    "Added to send queue.": "送信キューに追加しました。",
    "Added {var}.": "{var} を追加しました。",
    "addition": "追加",
    "AI functions are not available under the current contract status.": "現在の契約状態ではAI機能を利用できません。",
    "Align & in table": "表の & を揃える",
    "align / myenv etc.": "align / myenv など",
    "Align \\\\begin / \\\\end": "\\\\begin / \\\\end を揃える",
    "Align \\begin / \\end": "\\begin / \\end を揃える",
    "Align the & in the formula": "数式の & を揃える",
    "Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app.": "システム設定 > プライバシーとセキュリティ > 画面収録 で TeX64 を許可し、アプリを再起動してください。",
    "Allow TeX64 in System Settings > Privacy & Security > Screen Recording, then restart the app. Click \"Formula import\" again to open the settings guide.": "システム設定 > プライバシーとセキュリティ > 画面収録 で TeX64 を許可し、アプリを再起動してください。もう一度「数式取り込み」をクリックすると、設定を開くガイドが表示されます。",
    "Already registered in another category.": "既に別カテゴリで登録されています。",
    "Already registered.": "既に登録されています。",
    "An error has occurred.": "エラーが発生しました。",
    "Analysis failure": "解析失敗",
    "anonymous error report": "匿名エラーレポート",
    "Applied": "適用済み",
    "Applied: {var}": "適用完了: {var}",
    "Apply": "適用",
    "Apply all": "すべて適用",
    "Apply conflict": "適用競合",
    "Apply failure": "適用失敗",
    "Apply updates": "更新を適用",
    "Anonymous error report": "匿名エラーレポート",
    "arrow": "矢印",
    "Attach diagnostic information": "診断情報を添付",
    "Attach diagnostic information (optional)": "診断情報を添付（任意）",
    "Attach image": "画像を添付",
    "automatic detection": "自動検出",
    "Automatically jumps to PDF when build is successful.": "ビルド成功時に自動でPDFへジャンプします。",
    "auxiliary": "補助",
    "Available": "利用可能",
    "Axiom": "AIチャット",
    "Axiom error": "Axiom エラー",
    "Axiom is not available.": "Axiom を利用できません。",
    "Axiom proposal diff": "AI提案の差分",
    "Axiom usage": "Axiom 使用量",
    "Axiom usage: {var}": "AI使用量: {var}",
    "Back": "戻る",
    "Background": "背景",
    "Block list": "ブロック一覧",
    "Blocks": "ブロック",
    "Blocks can only be inserted in .tex files.": "ブロックは .tex ファイルでのみ挿入できます。",
    "bottom panel": "ボトムパネル",
    "bottom panel border": "ボトムパネルの境界",
    "build": "ビルド",
    "Build (Cmd+B)": "ビルド (Cmd+B)",
    "build error": "ビルドエラー",
    "build failed": "ビルドに失敗しました",
    "Build in separate window": "別ウィンドウでビルド",
    "build profile": "ビルドプロファイル",
    "Build to generate PDF and run SyncTeX on the .tex file.": "ビルドしてPDFを生成し、.tex ファイルでSyncTeXを実行してください。",
    "can't open file": "ファイルを開けません",
    "cancel": "キャンセル",
    "cancel build": "ビルドをキャンセル",
    "Canceling build...": "ビルドをキャンセルしています...",
    "Cancellation completed: {var}": "取り消し完了: {var}",
    "Cancellation failure: {var}": "取り消し失敗: {var}",
    "Canvas initialization failed.": "キャンバスの初期化に失敗しました。",
    "Bug": "不具合",
    "Captureable window": "取り込み可能なウィンドウ",
    "category": "カテゴリ",
    "Category": "カテゴリ",
    "Changes are saved automatically.": "変更は自動で保存されます。",
    "chapter": "章",
    "chapter and verse": "章節",
    "Chapter/Chart/TODO": "章節 / 図表 / TODO",
    "character": "文字",
    "character not detected": "文字を検出できません",
    "Chat": "チャット",
    "Check and apply the differences.": "差分を確認して適用します。",
    "Check for updates": "更新を確認",
    "Check that TeX Distribution and latexmk are detected in Settings > Environment. Click \"Install\" if not detected.": "設定 > 環境 で TeX Distribution と latexmk が検出されているか確認してください。未検出の場合は「インストール」をクリックしてください。",
    "Check the status of latexindent in Settings > Environment. You can disable formatting in settings if not needed.": "設定 > 環境 で latexindent の状態を確認してください。整形が不要なら設定でオフにできます。",
    "Check the status of latexmk in Settings > Environment and click \"Install\".": "設定 > 環境 で latexmk の状態を確認し、「インストール」をクリックしてください。",
    "Check the terms of use and privacy policy.": "利用規約やプライバシーポリシーを確認します。",
    "Checking file content": "ファイル内容を確認中",
    "Checking file list": "ファイル一覧を確認中",
    "Checking for updates.": "更新を確認しています。",
    "Checking project structure": "プロジェクト構成を確認中",
    "Checking references": "参照情報を確認中",
    "Checking settings": "設定を確認中",
    "Checking the execution environment.": "実行環境を確認中です。",
    "Checking the execution environment. Please run Build again after completion.": "実行環境チェック中です。完了後に再度 Build を実行してください。",
    "Checking...": "確認中...",
    "clean": "クリーン",
    "clean -C also removes PDFs etc. A confirmation dialog will be displayed before execution.": "clean -C は PDF なども削除します。実行前に確認ダイアログが表示されます。",
    "Click to go to definition.": "クリックで定義に移動します。",
    "Click to move": "クリックで移動",
    "Click to move to the corresponding location.": "クリックで該当箇所へ移動します。",
    "Click to open Environment": "クリックでRuntimeを開く",
    "close": "閉じる",
    "Close": "閉じる",
    "Close panel": "パネルを閉じる",
    "Color": "色",
    "Commands to automate builds. Often bundled with TeX Distribution.": "ビルドを自動化するコマンド。TeX Distribution に同梱されることが多い。",
    "compilation engine": "コンパイルエンジン",
    "compile": "コンパイル",
    "Compile / SyncTeX / Profile": "コンパイル / SyncTeX / プロファイル",
    "Confirm": "確定",
    "Confirm after previewing.": "プレビュー後に確定します。",
    "Confirm changes": "変更内容の確認",
    "Confirm changes (format after finalization)": "変更内容の確認（確定後に整形）",
    "Confirm deletion": "削除の確認",
    "Contact information (optional)": "連絡先（任意）",
    "Content": "内容",
    "Continue autonomously, prioritizing last-minute user instructions and the purpose of the conversation.": "直前のユーザー指示と会話の目的を最優先して、自律的に継続してください。",
    "Copied": "コピー済み",
    "Copy": "コピー",
    "Create": "作成",
    "Create a new folder.": "新しいフォルダを作成します。",
    "Create and continue": "作成して次へ",
    "Create destination": "作成先",
    "Create New": "新規作成",
    "create new file": "新規ファイルを作成",
    "Create new folder": "新規フォルダを作成",
    "Created suggestion in {var} file ({var} place)": "{var}ファイルに提案を作成しました（{var}箇所）",
    "Creating a proposal...": "提案を作成中...",
    "Creating delete proposal": "削除案を作成中",
    "Creating directory proposal": "ディレクトリ作成案を作成中",
    "Creating edit proposal": "編集案を作成中",
    "Creating index.": "インデックスを作成中です。",
    "Creating rename proposal": "リネーム案を作成中",
    "current key": "現在のキー",
    "current version": "現在のバージョン",
    "Cut": "切り取り",
    "cut range": "範囲を切り取る",
    "Cutting failed.": "切り取りに失敗しました。",
    "Default": "デフォルト",
    "defect": "不具合",
    "Delete": "削除",
    "Delete and continue": "削除して次へ",
    "Delete auxiliary files (.aux/.log/.synctex.gz, etc.).": "補助ファイル（.aux/.log/.synctex.gz 等）を削除します。",
    "delete column": "列を削除",
    "delete file": "ファイルを削除",
    "delete folder": "フォルダを削除",
    "Delete from recent": "最近から削除",
    "delete row": "行を削除",
    "Destination for output of products (default if empty). Example: build": "生成物の出力先（空ならデフォルト）。例: build",
    "Detailed log": "詳細ログ",
    "Difference (-delete/+add)": "差分（-削除 / +追加）",
    "Difference preview is omitted because it is a binary file.": "バイナリファイルのため差分プレビューは省略しています。",
    "Directly below the workspace": "ワークスペース直下",
    "Dismiss": "取り消し",
    "Done.": "完了しました。",
    "display": "表示",
    "Display / AI completion": "表示 / AI補完",
    "Display automatically": "自動で表示",
    "display delay": "表示遅延",
    "Displays a list of build and operation errors.": "ビルドや操作のエラーを一覧で表示します。",
    "Displays a list of chapters, diagrams, TODOs, and references.": "章節や図表、TODO、参照を一覧で表示します。",
    "Displays predictions dimly at the end of the line. Completion candidates by AI will be displayed.": "行末で予測を薄く表示します。AIによる補完候補が表示されます。",
    "Displays settings common to all editors.": "エディタ共通の設定を表示します。",
    "division": "分割",
    "do not indent document": "document をインデントしない",
    "Do you want to delete profile \"{var}\"?": "プロファイル「{var}」を削除しますか？",
    "Don't display suggestions that are too long.": "長すぎる提案は表示しません。",
    "Done": "完了",
    "Download completed. You can launch the installer with the Apply button.": "ダウンロード完了。適用ボタンでインストーラを起動できます。",
    "Downloading updates ({var} / {var}).": "更新をダウンロード中です（{var} / {var}）。",
    "Drag to adjust range": "ドラッグして範囲を調整",
    "Duplicate label: {var} ({var} location: {var})": "Duplicate label: {var} ({var} 箇所: {var})",
    "Edit": "編集",
    "Edit mode": "編集モード",
    "Edit with Axiom": "Axiomで編集",
    "Edit with Monaco.": "Monacoで編集します。",
    "Editing area": "編集エリア",
    "editor": "エディタ",
    "Editor area not found.": "エディタ領域が見つかりません。",
    "Editor is not ready.": "エディタの準備が完了していません。",
    "Editor settings": "エディタ設定",
    "Enter formula": "数式を入力",
    "Enter LaTeX": "LaTeX を入力",
    "enter name": "名前を入力",
    "Environment": "環境",
    "Environment Check": "環境チェック",
    "Environment name is empty.": "環境名が空です。",
    "Environment name only (`*` not required)": "環境名のみ（`*` 不要）",
    "Example: -use-biber -shell-escape": "例: -use-biber -shell-escape",
    "Example: sections": "例: sections",
    "Example: sections/intro.tex": "例: sections/intro.tex",
    "Excerpt failed.": "抜粋に失敗しました。",
    "Excerpt timed out.": "抜粋がタイムアウトしました。",
    "execution": "実行",
    "Execution environment is insufficient.": "実行環境が不足しています。",
    "Execution environment is insufficient. Please check Settings > Execution environment.": "実行環境が不足しています。Settings > 実行環境で確認してください。",
    "explorer": "エクスプローラー",
    "failed to cut": "切り取りに失敗",
    "Failed to get window list.": "ウィンドウ一覧の取得に失敗しました。",
    "Failed to get window list. Please confirm permission for screen recording.": "ウィンドウ一覧の取得に失敗しました。画面収録の許可を確認してください。",
    "Failed to initialize formula editor:": "数式エディタの初期化に失敗しました:",
    "Failed to initialize formula editor: {var}": "数式エディタの初期化に失敗しました: {var}",
    "Failed to load image.": "画像の読み込みに失敗しました。",
    "Failed to load Monaco.": "Monacoの読み込みに失敗しました。",
    "Failed to obtain thumbnail of selected screen. Please select another screen.": "選択した画面のサムネイル取得に失敗しました。別の画面を選択してください。",
    "Failed to save": "保存に失敗",
    "Failed to send feedback.": "フィードバック送信に失敗しました。",
    "Failed to send feedback. I will resend it.": "フィードバック送信に失敗しました。再送します。",
    "Failed to start browser.": "ブラウザを起動できませんでした。",
    "Failed to start build": "ビルドの起動に失敗",
    "Failed to start sending feedback.": "フィードバック送信を開始できませんでした。",
    "Feedback": "フィードバック",
    "file": "ファイル",
    "file name": "ファイル名",
    "File name (with extension)": "ファイル名（拡張子付き）",
    "File not found": "ファイルが見つかりません",
    "file not found.": "ファイルが見つかりません。",
    "File tab is selected.": "ファイルタブが選択されています。",
    "First time setup: 1) Checking the execution environment 2) Opening the workspace 3) Running the first build": "初回セットアップ: 1) 実行環境を確認中 2) ワークスペースを開く 3) 最初のビルドを実行",
    "First time setup: 1/3 Missing runtime ({var}). Click the \"Install\" button above.": "初回セットアップ: 1/3 実行環境が不足 ({var})。上の「インストール」ボタンをクリックしてください。",
    "First time setup: 1/3 Runtime is missing. Click the \"Install\" button above.": "初回セットアップ: 1/3 実行環境が不足しています。上の「インストール」ボタンをクリックしてください。",
    "First time setup: 2/3 Open your workspace.": "初回セットアップ: 2/3 ワークスペースを開いてください。",
    "First time setup: 3/3 Run your first build.": "初回セットアップ: 3/3 最初のビルドを実行してください。",
    "First-time setup complete: You can run Build at any time.": "初回セットアップ完了: いつでも Build を実行できます。",
    "fold": "折りたたむ",
    "folder": "フォルダ",
    "folder name": "フォルダ名",
    "Font style": "フォントスタイル",
    "Format": "整形",
    "Formatting failed.": "整形に失敗しました。",
    "Formula block settings": "数式ブロック設定",
    "Formula import": "数式取り込み",
    "Formula input (text)": "数式入力（テキスト）",
    "Formula input listener error:": "数式入力リスナーのエラー:",
    "Formula input listener error: {var}": "数式入力リスナーのエラー: {var}",
    "Formula OCR is not available.": "数式OCRが利用できません。",
    "Formula/Table Environment": "数式/表 環境",
    "Full storage capacity": "保存容量が一杯",
    "Google login": "Googleログイン",
    "Google login has been canceled.": "Googleログインがキャンセルされました。",
    "Google login is required to use Axiom.": "AI機能を使うにはGoogleログインが必要です。",
    "Handling of blank lines": "空行の扱い",
    "help": "ヘルプ",
    "Hide details": "詳細を閉じる",
    "Hide diff": "差分を閉じる",
    "History": "履歴",
    "How to enclose inline/separate line": "インライン/別行の囲み方",
    "I started the installer. Follow the on-screen instructions to update.": "インストーラを起動しました。画面の手順に沿って更新してください。",
    "If OFF, the PDF will open in a separate tab.": "OFF の場合は PDF を別タブで開きます。",
    "If ON, wrap long lines at the editor width.": "ON の場合、長い行をエディタ幅で折り返します。",
    "If sending feedback fails, save it to a resend queue within the app and try again.": "フィードバック送信に失敗した場合は、アプリ内で再送キューに保存して再試行します。",
    "If the build fails: Identify the reason for the failure and suggest only the minimum necessary fixes (do not force fixes on minor issues).": "ビルドが失敗した場合: 失敗理由を特定し、必要最小限の修正提案だけを出してください（軽微な気になる点は無理に直さない）。",
    "If the build is successful: Please provide only one suggestion for moving forward (no blind wholesale changes).": "ビルドが成功した場合: 次に進むための提案を1つだけ出してください（闇雲な大規模変更はしない）。",
    "Image data is empty.": "画像データが空です。",
    "Images larger than 5MB cannot be attached ({var}).": "5MBを超える画像は添付できません（{var}件）。",
    "indentation": "インデント",
    "Info": "情報",
    "inline": "インライン",
    "inline box": "インラインの囲み",
    "inquiry": "問い合わせ",
    "insert": "挿入",
    "Insert format: {var}": "挿入形式: {var}",
    "Insert formulas as blocks.": "数式をブロックとして挿入します。",
    "insert mode": "挿入モード",
    "Insertion format": "挿入形式",
    "install": "インストール",
    "Installation has started.": "インストールを開始しました。",
    "Installation instructions": "インストール手順",
    "Installing {var}...": "{var} をインストールしています...",
    "Installing...": "インストール中...",
    "Introduction": "はじめに",
    "Invalid destination": "移動先が不正",
    "Issues": "エラー",
    "Japanese": "日本語",
    "Japanese trigger": "日本語トリガー",
    "Jump": "ジャンプ",
    "Jump to the Ctrl/Cmd+Click position on the PDF.": "PDF上でCtrl/Cmd+Clickした位置へジャンプします。",
    "label": "ラベル",
    "Language": "言語",
    "Latest version": "最新バージョン",
    "Latest version {var}.": "最新バージョン {var} です。",
    "latexindent / environment detection": "latexindent / 環境検出",
    "latexmk additional options": "latexmk 追加オプション",
    "legal affairs": "法務",
    "Legal/Support": "法務 / サポート",
    "Limit": "上限",
    "line is invalid.": "line が不正です。",
    "Line {var}": "行 {var}",
    "Log in with Google": "Googleでログイン",
    "Logged in: {var}": "ログイン済み: {var}",
    "logic": "論理",
    "Login": "ログイン",
    "login failed.": "ログインに失敗しました。",
    "Login required": "ログインが必要です",
    "Login result validation failed.": "ログイン結果の検証に失敗しました。",
    "Login status could not be confirmed.": "ログイン状態を確認できませんでした。",
    "Login timed out.": "ログインがタイムアウトしました。",
    "Login/Update": "ログイン / アップデート",
    "Logout": "ログアウト",
    "Main TeX": "メインTeX",
    "Make sure it's open in the desktop app and try restarting.": "デスクトップアプリで開いているか確認し、再起動してください。",
    "Manage main TeX and environment registration.": "メインTeXや環境登録を管理します。",
    "Manage per-workspace settings.": "ワークスペース単位の設定を管理します。",
    "Manual display:": "手動表示:",
    "manual download": "手動ダウンロード",
    "manual only": "手動のみ",
    "math extension": "数学拡張",
    "math keyboard": "数式キーボード",
    "Math menu": "数式メニュー",
    "mathematical formula": "数式",
    "Maximum number of characters": "最大文字数",
    "measure": "小節",
    "Mini outline: main.tex": "ミニアウトライン: main.tex",
    "minted / myenv etc.": "minted / myenv など",
    "Missing execution environment: {var}": "実行環境が不足しています: {var}",
    "Missing: {var}. Please prepare the TeX environment and check again.": "不足: {var}。TeX環境を整備して再チェックしてください。",
    "Mode": "モード",
    "Monaco initialization failed.": "Monacoの初期化に失敗しました。",
    "Monaco loader not found.": "Monacoのローダーが見つかりません。",
    "move": "移動",
    "Move and continue": "移動して次へ",
    "Names that include parent directories cannot be used": "親ディレクトリを含む名前は使えません",
    "Names that include parent directories cannot be used.": "親ディレクトリを含む名前は使えません。",
    "Native integration": "ネイティブ連携",
    "Native integration is not available.": "ネイティブ連携が利用できません。",
    "New": "新規",
    "New Chat": "新しいチャット",
    "New chat": "新規チャット",
    "new file name": "新規ファイル名",
    "New file name (e.g. chapter/intro.tex)": "新規ファイル名（例: chapter/intro.tex）",
    "New file...": "新しいファイル...",
    "New folder name (e.g. chapter)": "新規フォルダ名（例: chapter）",
    "New folder...": "新しいフォルダー...",
    "new key": "新しいキー",
    "new name": "新しい名前",
    "Next reset: {var}": "次回リセット: {var}",
    "No change": "変更なし",
    "No change detected.": "変更がありません。",
    "No file selected.": "ファイルが未選択です。",
    "No files have been selected to save.": "保存するファイルが選択されていません。",
    "No history": "履歴なし",
    "No image available": "画像がありません",
    "No index entries found.": "インデックス項目が見つかりません。",
    "No issues.": "問題はありません。",
    "No matching results found.": "一致する結果がありません。",
    "No operations to undo.": "取り消せる操作がありません。",
    "No project opened yet": "まだプロジェクトを開いていません",
    "No workspace is selected.": "ワークスペースが未選択です。",
    "No workspace selected": "ワークスペース未選択",
    "Not enclosed": "囲まない",
    "Not found": "未検出",
    "not found": "見つかりません",
    "Not recommended": "非推奨",
    "Not selected": "未選択",
    "Notice": "お知らせ",
    "OCR failed.": "OCRに失敗しました。",
    "OCR result was empty.": "OCR結果が空でした。",
    "OCR timed out.": "OCRがタイムアウトしました。",
    "Only image files can be attached (excluding {var}).": "画像ファイルのみ添付できます（{var}件を除外）。",
    "open": "開く",
    "Open a text file such as .tex and edit it.": ".tex などのテキストファイルを開いて編集してください。",
    "Open all public tex64.com pages in your browser.": "すべて tex64.com の公開ページをブラウザで開きます。",
    "Open Folder": "フォルダを開く",
    "Open Help, Contact Us, Release Information.": "ヘルプ、問い合わせ、リリース情報を開きます。",
    "Open details": "詳細を開く",
    "open in terminal": "ターミナルで開く",
    "Open Settings > Environment and click \"Install\" for missing tools.": "設定 > 環境 を開き、不足しているツールの「インストール」をクリックしてください。",
    "Other": "その他",
    "others": "その他",
    "Outline": "アウトライン",
    "paragraph": "段落",
    "Partial editing": "部分編集",
    "Paste": "貼り付け",
    "Paused": "一時停止",
    "Paste is .tex": "貼り付けは .tex",
    "path is empty.": "path が空です。",
    "PDF not found": "PDFが見つかりません",
    "PDF preview": "PDFプレビュー",
    "Performed {var} installation.": "{var} のインストールを実行しました。",
    "personal/decoration": "個人/装飾",
    "physics/quantum": "物理/量子",
    "Please analyze the attached image.": "添付画像を解析してください。",
    "Please check the build log, correct any errors in the relevant file, and rebuild.": "ビルドログを確認し、該当ファイルのエラーを修正して再ビルドしてください。",
    "Please check the destination folder and move to another location.": "移動先フォルダを確認して、別の場所へ移動してください。",
    "Please check the existence and path of the file and try opening it again.": "ファイルの存在とパスを確認し、再度開いてください。",
    "Please check the format of your contact email address.": "連絡先メールアドレスの形式を確認してください。",
    "Please check the log and the relevant line and correct it.": "ログと該当行を確認して修正してください。",
    "Please check the permissions and disk space of the save destination and try again.": "保存先の権限とディスク容量を確認して再試行してください。",
    "Please check your input.": "入力を確認してください。",
    "Please check your plan/contract status.": "プラン・契約状態を確認してください。",
    "Please enable screen recording permission and try again.": "画面収録の許可を有効にして再試行してください。",
    "Please enter the path relative to your workspace without including / or ...": "ワークスペース内の相対パスで、/ や .. を含めずに入力してください。",
    "Please enter your current key and new key.": "現在のキーと新しいキーを入力してください。",
    "Please enter your feedback.": "フィードバック内容を入力してください。",
    "Please enter your name so that it is not blank.": "空欄にならないよう名前を入力してください。",
    "Please enter your name.": "名前を入力してください。",
    "Please free up space by deleting unnecessary files and caches.": "不要なファイルやキャッシュを削除して容量を確保してください。",
    "Please open the .tex file and try again.": ".tex ファイルを開いてから再実行してください。",
    "Please open the folder.": "フォルダを開いてください。",
    "Please re-obtain the image and check that the characters and formulas are clearly visible.": "画像を再取得し、文字や数式が鮮明に写っているか確認してください。",
    "Please reselect the capture range and try again.": "キャプチャ範囲を選択し直して再試行してください。",
    "Please retake the image, increase the contrast and re-import it.": "画像を撮り直し、コントラストを上げて再度取り込んでください。",
    "Please review your formatting settings or turn formatting off and resave.": "整形設定を見直すか、整形をオフにして再保存してください。",
    "Please save the relevant file before moving/renaming.": "移動/リネーム前に該当ファイルを保存してください。",
    "Please select a folder at startup.": "起動時にフォルダを選択してください。",
    "Please select an image file such as PNG/JPEG and try again.": "PNG/JPEG などの画像ファイルを選択して再試行してください。",
    "Please select the target (label/reference/citation).": "対象（ラベル/参照・引用）を選んでください。",
    "Please specify the font size in the documentclass option (e.g. \\\\documentclass[10pt]{revtex4-2}).": "documentclass のオプションに文字サイズを指定してください（例: \\\\documentclass[10pt]{revtex4-2}）。",
    "Please specify the font size in the documentclass option (e.g. \\documentclass[10pt]{revtex4-2}).": "documentclass のオプションに文字サイズを指定してください（例: \\documentclass[10pt]{revtex4-2}）。",
    "Please tell me what to write...": "執筆内容を指示してください...",
    "Please verify by building first.": "まずビルドで検証してください。",
    "Points to be improved and steps to reproduce the problem, etc.": "改善してほしい点や不具合の再現手順など",
    "Pre-apply validation failed.": "適用前の検証に失敗しました。",
    "Preparations for start of use are complete.": "利用開始の準備が完了しています。",
    "Preparing for initial setup.": "初回セットアップを準備中です。",
    "preview": "プレビュー",
    "Preview failed.": "プレビューに失敗しました。",
    "Preview timed out.": "プレビューがタイムアウトしました。",
    "privacy": "プライバシー",
    "Processing": "処理中",
    "Processing Google login.": "Googleログインを処理中です。",
    "profile name": "プロファイル名",
    "Project": "プロジェクト",
    "Proposal not found.": "提案が見つかりません。",
    "Project settings": "プロジェクト設定",
    "Project settings are in a separate tab.": "プロジェクト設定は別タブにあります。",
    "Proposals {var}": "提案 {var}",
    "Proposed file changes": "ファイルの変更案",
    "Put \\\\begin / \\\\end on separate lines": "\\\\begin / \\\\end を別行にする",
    "Put \\begin / \\end on separate lines": "\\begin / \\end を別行にする",
    "qcircuit/xypic may fail with lualatex. Please change the Engine in Settings > Build to pdflatex and rebuild.": "qcircuit/xypic は lualatex で失敗することがあります。設定 > ビルド の Engine を pdflatex に変更して再ビルドしてください。",
    "Ready to start using (optional: latexindent not detected).": "利用開始の準備は完了しています（任意: latexindent 未検出）。",
    "Recent Projects": "最近のプロジェクト",
    "Recheck": "再チェック",
    "Recognizing...": "認識中…",
    "Recognizing... ({var}/{var})": "認識中… ({var}/{var})",
    "Recommended: 200–400ms delay and 80–200 maximum characters are less distracting.": "推奨: 遅延 200–400ms、最大文字数 80–200 くらいが邪魔になりにくいです。",
    "redetection": "再検出",
    "References": "参考文献",
    "Refund policy": "返金ポリシー",
    "release notes": "リリースノート",
    "Remaining": "残り",
    "remove attachment": "添付を削除",
    "Removed {var}.": "{var} を削除しました。",
    "rename": "名前の変更",
    "Rename": "変更",
    "Rename failed.": "リネームに失敗しました。",
    "Rename...": "名前の変更...",
    "request": "要望",
    "Request": "要望",
    "Reset": "リセット",
    "Restored input that could not be sent. Please check the contents and resend.": "送信できなかった入力を復元しました。内容を確認して再送信してください。",
    "Restored unsent input (including {var} attached images). Please review and resend.": "送信できなかった入力を復元しました（画像{var}件含む）。内容を確認して再送信してください。",
    "Resume": "再開",
    "retention": "保持",
    "Reverse SyncTeX (PDF → source)": "逆SyncTeX（PDF→ソース）",
    "revert to automatic": "自動に戻す",
    "Reviewing multiple files": "複数ファイルを確認中",
    "run build": "ビルドを実行",
    "Run clean -C. PDFs etc. will also be deleted. Are you sure?": "clean -C を実行します。PDF なども削除されます。よろしいですか？",
    "Run clean. Delete auxiliary files. Are you sure?": "clean を実行します。補助ファイルを削除します。よろしいですか？",
    "Run the build and generate the PDF.": "ビルドを実行してPDFを生成してください。",
    "run the first build": "最初のビルドを実行",
    "Running": "実行中",
    "Running command": "コマンドを実行中",
    "Runtime Environment": "実行環境",
    "Saving failed.": "保存に失敗しました。",
    "Saving...": "保存中...",
    "screen capture": "画面キャプチャ",
    "Screen capture is not available.": "画面キャプチャが利用できません。",
    "Screen capture is not available. Please confirm permission for screen recording.": "画面キャプチャが利用できません。画面収録の許可を確認してください。",
    "Screen recording": "画面収録",
    "Search": "検索",
    "Search results": "検索結果",
    "search term": "検索語",
    "Search within your workspace.": "ワークスペース内を検索します。",
    "Searching related locations": "関連箇所を検索中",
    "Searching...": "検索中...",
    "section": "節",
    "See plan": "プランを見る",
    "Select all": "すべて選択",
    "Share your thoughts.": "一言お願いします。",
    "Select import target": "取り込み対象を選択",
    "Select main TeX": "メインTeXを選択",
    "Select the engine to use for your build.": "ビルドに使用するエンジンを選択します。",
    "Select the working folder from \"Open Folder\".": "「フォルダを開く」から作業フォルダを選択してください。",
    "Selected": "選択中",
    "Send": "送信",
    "Send a bug/request": "不具合・要望を送信",
    "Sending...": "送信中...",
    "Sends diagnostic information such as OS/version.": "OS/バージョンなどの診断情報を送信します。",
    "Sends diagnostic information to tex64.com on fatal errors.": "致命的エラー時に診断情報を tex64.com へ送信します。",
    "Separate line": "別行",
    "separate line box": "別行立ての囲み",
    "set": "集合",
    "set/logic": "集合/論理",
    "Settings": "設定",
    "Settings could not be retrieved.": "設定が取得できませんでした。",
    "Setup needed": "要設定",
    "Show All": "すべて表示",
    "Show in Finder": "Finderで表示",
    "Show suggestions": "候補の表示",
    "sidebar": "サイドバー",
    "Sidebar details": "サイドバー詳細",
    "Signed in": "ログイン済み",
    "Signed out": "未ログイン",
    "Signing in": "ログイン処理中",
    "Signing in...": "ログイン処理中...",
    "small paragraph": "小段落",
    "Space: 2": "スペース: 2",
    "Space: 4": "スペース: 4",
    "Spaces, commas, and {} cannot be used in keys.": "キーに空白・カンマ・{} は使えません。",
    "Special commercial law": "特商法",
    "Specify a font-size option in documentclass (e.g. \\\\documentclass[10pt]{revtex4-2}).": "documentclass のオプションに文字サイズを指定してください（例: \\\\\\\\documentclass[10pt]{revtex4-2}）。",
    "Split view boundaries": "分割ビューの境界",
    "Start the build.": "ビルドを開始します。",
    "Stop": "停止",
    "subject": "対象",
    "Submitted feedback{var}{var}": "フィードバックを送信しました{var}{var}",
    "Submitting feedback...": "フィードバックを送信しています...",
    "subsection": "小項",
    "Suggest files and create templates via chat.": "チャットでファイル提案やテンプレート作成を行います。",
    "summarize in one line": "1行にまとめる",
    "support": "サポート",
    "Switch latexmk's output destination and additional options to suit your project style.": "プロジェクトの流儀に合わせて latexmk の出力先や追加オプションを切り替えます。",
    "Switch the suggestions to be included in automatic suggestions (search all packs for manual display)": "自動サジェストに含める候補を切り替えます（手動表示は全パックを検索）",
    "Switch the UI language.": "UI の表示言語を切り替えます。",
    "symbol rename": "シンボルリネーム",
    "SyncTeX at build time": "ビルド時SyncTeX",
    "SyncTeX failed.": "SyncTeX に失敗しました。",
    "SyncTeX is only available for .tex files.": "SyncTeX は .tex ファイルでのみ利用できます。",
    "tab": "タブ",
    "table": "表",
    "term": "項",
    "terms of service": "利用規約",
    "TeX Distribution / Tool Status": "TeX Distribution / ツール確認",
    "TeX Distribution and latexmk / latexindent / synctex are required for building/formatting/SyncTeX of this application (many are included).": "本アプリのビルド/整形/SyncTeX には TeX Distribution と latexmk / latexindent / synctex が必要です（多くは同梱）。",
    "TeX environment": "TeX環境",
    "TeX environment guide": "TeX環境ガイド",
    "TeX file is missing": "TeXファイルがありません",
    "Thanks for sharing your feedback.": "送信しました。ご協力ありがとうございます。",
    "The block is .tex": "ブロックは .tex",
    "The build results are summarized here.": "ビルド結果はここに要約します。",
    "The destination is invalid.": "移動先が不正です。",
    "The folder and all files within it will be deleted. This operation cannot be undone.": "フォルダとその中のすべてのファイルが削除されます。この操作は取り消せません。",
    "The formatting request failed.": "整形のリクエストに失敗しました。",
    "The image could not be attached because it failed to load ({var} items).": "画像の読み込みに失敗したため添付できませんでした（{var}件）。",
    "The image has been sent.": "画像を送信しました。",
    "The login page could not be opened.": "ログインページを開けませんでした。",
    "The new key is the same.": "新しいキーが同じです。",
    "The total size of attached images is up to 8MB.": "添付画像の合計サイズは8MBまでです。",
    "There are no retrievable windows. Please confirm permission for screen recording.": "取り込み可能なウィンドウがありません。画面収録の許可を確認してください。",
    "There are unsaved changes": "未保存の変更があります",
    "There are unsaved changes. Please save and rename.": "未保存の変更があります。保存してから名前を変更してください。",
    "There are unsaved changes. Please save before deleting.": "未保存の変更があります。削除前に保存してください。",
    "There are unsaved changes. Please save before moving.": "未保存の変更があります。移動前に保存してください。",
    "Thinking...": "考えています...",
    "This file format cannot be edited": "このファイル形式は編集できません",
    "This file format cannot be edited.": "このファイル形式は編集できません。",
    "This file format cannot be opened with an editor.": "このファイル形式はエディタで開けません。",
    "This is an unsupported file.": "非対応ファイルです",
    "This is the currently open folder.": "現在開いているフォルダです。",
    "This is the main file to be built.": "ビルド対象の主ファイルです。",
    "This is the waiting time from input stop to display.": "入力停止から表示までの待ち時間です。",
    "This operation cannot be undone.": "この操作は取り消せません。",
    "Timed out waiting for a save response.": "保存の応答がタイムアウトしました。",
    "Trailing / cannot be used": "末尾の / は使えません",
    "Trailing / cannot be used in file names.": "ファイル名に末尾の / は使えません。",
    "trigger pack": "トリガーパック",
    "Type your feedback here.": "フィードバックを入力してください。",
    "Unable to determine destination. Check the build log": "移動先を特定できません。ビルドログを確認",
    "Unable to open file.": "ファイルを開けません。",
    "Unable to retrieve content to save: {var}": "保存対象の内容を取得できません: {var}",
    "Undo": "元に戻す",
    "Undo failed.": "取り消しに失敗しました。",
    "Unlimited": "無制限",
    "Unknown location": "位置不明",
    "Unsaved": "未保存",
    "Unsupported file formats": "対応していないファイル形式",
    "Up to 4 images can be attached.": "画像添付は最大4件までです。",
    "Up to date.": "最新状態です。",
    "update": "アップデート",
    "Update": "更新あり",
    "Update processing failed.": "アップデート処理に失敗しました。",
    "Update/Reinstall": "更新/再インストール",
    "Updating labels and references": "ラベル・参照の整合を更新中",
    "Updating settings": "設定を更新中",
    "Used": "使用",
    "Used for formatting. Often bundled with TeX Distribution.": "整形（Format）に使用。TeX Distribution に同梱されることが多い。",
    "Used to jump to PDF. Often bundled with TeX Distribution.": "PDF へのジャンプに使用。TeX Distribution に同梱されることが多い。",
    "verbatim environment": "verbatim 系環境",
    "Verifying build": "ビルドを検証中",
    "View details": "詳細を見る",
    "View diff": "差分を見る",
    "Waiting": "待機中",
    "Waiting for save timed out.": "保存の待機がタイムアウトしました。",
    "Waiting for update check.": "更新確認待ちです。",
    "Warning": "警告",
    "Warnings may not be able to automatically identify the destination. Please check the preceding and following lines in the build log and correct it.": "警告は自動で移動先を特定できないことがあります。ビルドログの前後行を確認して修正してください。",
    "We are waiting for the remaining {var} items to be resent.": "残り{var}件を再送待ちです。",
    "Window list": "ウィンドウ一覧",
    "work space": "ワークスペース",
    "Working...": "作業中...",
    "Wrap lines": "行を折り返して表示",
    "You can add an environment to skip formatting.": "整形をスキップする環境を追加できます。",
    "You can edit the build profile by opening the workspace.": "ワークスペースを開くとビルドプロファイルを編集できます。",
    "You can search by pressing Enter.": "Enterで検索できます。",
    "You have reached your token limit for this month.": "今月のトークン上限に達しました。",
    "{var} (not found)": "{var} (見つかりません)",
    "{var} (retry after {var} seconds)": "{var} ({var}秒後に再試行)",
    "{var} / {var} token": "{var} / {var} トークン",
    "{var} file changes": "{var}件のファイル変更",
    "{var} files": "{var}ファイル",
    "{var} has been disabled.": "{var} を無効にしました。",
    "{var} has been enabled.": "{var} を有効にしました。",
    "{var} installation failed.": "{var} のインストールに失敗しました。",
    "{var} is not detected. Please check Settings > Execution environment.": "{var} が未検出です。Settings > 実行環境で確認してください。",
    "{var} items": "{var}件",
    "{var} Saved in retransmission queue.": "{var} 再送キューに保存しました。",
    "{var} tokens": "{var} トークン",
    "{var}% remaining ({var})": "残り {var}% ({var})",
    "{var}: Done": "{var}: 完了",
    "{var}: Error": "{var}: エラー",
    "{var}: {var}": "{var}: {var}",
    "Accelerate TeX writing with Axiom": "Axiom でTeX執筆を加速しよう",
    "Align \begin / \end": "\begin / \end を揃える",
    "Auto-format on save": "保存時に自動整形",
    "Auto-format with latexindent on save": "保存時に latexindent で自動整形する",
    "Delete chat": "チャットを削除",
    "Log in to use Axiom": "ログインして Axiom を利用",
    "Open Settings": "設定を開く",
    "Put \begin / \end on separate lines": "\begin / \end を別行にする",
    "Retry": "再試行",
    "Screen recording permission required": "画面収録の許可が必要です",
    "You may need to restart the app after granting permission.": "許可後はアプリの再起動が必要な場合があります。",
    "Checking build log": "ビルドログを確認しています",
    "Checking environment": "環境を確認しています",
    "Checking folder structure": "フォルダ構成を確認しています",
    "Fetching BibTeX": "BibTeXを取得しています",
    "Installing environment": "環境をインストールしています",
    "Applying changes": "変更を適用しています",
    "Writing file": "ファイルを書き込んでいます",
    "Reading file": "ファイルを読んでいます",
    "Recognition failed": "認識に失敗しました",
    "Searching arXiv": "arXivを検索しています",
    "Unknown error": "不明なエラー",
};
const TRANSLATABLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];
let currentLocale = "ja";
const localeListeners = new Set();
const textOriginalMap = new WeakMap();
const attributeOriginalMap = new WeakMap();
let observer = null;
let applying = false;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN_ENTRIES = Object.entries(EN_TO_JA)
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
    const direct = EN_TO_JA[source];
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
    const next = currentLocale === "ja" ? translateKeepingWhitespace(original) : original;
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
        const next = currentLocale === "ja" ? translateKeepingWhitespace(originalValue) : originalValue;
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
export const uiText = (english, japanese) => currentLocale === "ja" ? japanese : english;
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
    currentLocale = stored !== null && stored !== void 0 ? stored : "en";
    applyUiLocaleToDocument(currentLocale);
    ensureObserver();
    applyI18n(document);
};
export const normalizeUiLocale = normalizeUiLocaleValue;
