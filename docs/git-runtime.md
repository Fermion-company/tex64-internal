# 同梱 Git / Git Credential Manager

## 配布物

`node scripts/fetch-git-runtime.cjs --mac` が公式 [desktop/dugite-native v2.53.0-4](https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4) の macOS arm64 / x64 archive を取得する。Git 2.53.0、GCM 2.9.0、自己完結 .NET 10.0.9、Git LFS 3.7.1 を含む。Git LFS の同梱は TeX64 の LFS 操作対応を意味しない。

- Archive SHA-256 は `scripts/git-runtime-manifest.json` に固定。未指定 hash の受け入れや system Git への暗黙 fallback はしない。
- 一時領域に取得・検証・展開し、symlink が展開ルート内に解決されることを確認してから配置する。既存取得物も全ファイルの hash / mode / symlink を照合する。競合する既存資産を上書きしない。
- `Resources/git-runtime/<platform>-<arch>/` は生成資産。バイナリと .NET managed assemblies / dylib / runtimeconfig / localization を分離せず、ディレクトリ全体を `asarUnpack` する。`.download-*` は一時領域であり配布対象から除く。
- `Resources/git-runtime/legal/` は Git の対応するソース archive、同梱 build recipe、各ライセンスと .NET third-party notices を含む。上流 GCM NOTICE は `libexec/git-core/NOTICE` に保持する。NOTICE.md は生成器から同期する。
- ビルド時の inventory は署名前のファイルに対するもの。Electron の配布署名後のファイルを、この取得用 inventory で再ハッシュ照合しない。配布後の実行コードの完全性はアプリ署名で扱う。

## main からの使用

`require('./git-runtime.cjs').getGitRuntime()` は `binary`, `credentialManager`, `execPath`, `root`, `env` を返す。Electron resources 下の展開済みディレクトリを優先し、開発時だけ checkout 内を使う。起動・認証・設定変更は行わない。

`env` は bundle の `bin` / `libexec/git-core` を PATH 先頭に置き、GIT_EXEC_PATH と GIT_TEMPLATE_DIR を設定する。継承した GIT_* / GCM_* / DOTNET_* / COMPlus_* / DYLD_*、GitHub token env、BROWSER は除去する。通常は `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/false`, `SSH_ASKPASS=/usr/bin/false`, `GCM_INTERACTIVE=0`, `GCM_CREDENTIAL_STORE=keychain`。

実 runner はこの上で Git config / hook / filter / SSH / URL rewrite の信頼境界を検証する必要がある。この resolver は repository config を読むことも、任意 config を安全と認定することもしない。

明示認証では `credentialManager` に引数配列 `['github', 'login', '--url', 'https://github.com', '--browser']` を渡し、`GCM_INTERACTIVE=1` を指定する。GitHub account 名や PAT を renderer で入力させない。実認証時は信頼できる専用 cwd を使い、stdout / stderr を UI へ直通させず、成功後に非対話で remote の権限を再確認する。

[上流 AddAccountAsync](https://github.com/git-ecosystem/git-credential-manager/blob/v2.9.0/src/shared/GitHub/GitHubHostProvider.Commands.cs) は OAuth credential を credential store に保存し、0 を返す。credential 本体を stdout へ返す `get` と異なる。`--username` による既存 account の早期成功、`--force`、`--pat` は通常認証フローで使用しない。接続解除で上流の `logout` を自動実行して、他アプリの認証を消さない。

## 実確認（2026-09-08）

- 両 architecture を固定 SHA-256 で取得し、再実行時の全 inventory 照合を通過。
- arm64、空の専用 HOME、PATH は同梱 runtime と `/usr/bin:/bin` のみで、init → commit → 一時 bare remote へ push → branch → merge → tag → 選択 tag push を実行。remote HEAD / tag と作業ファイル一致。
- x64 Git も arm64 ホスト上の Rosetta で起動成功。Intel 実機での検証を意味しない。
- GCM 2.9.0 は外部 .NET のない PATH / isolated HOME で `--version` 起動成功。非対話 `get` は専用の空 plaintext store に限って実行し、即時失敗・資格情報返却なしを確認。個人 Keychain / token は読んでいない。実 OAuth 認証はこの検証では開始していない。
- arm64 内の Mach-O 31 個について LC_LOAD_DYLIB / LC_LOAD_WEAK_DYLIB / LC_REEXPORT_DYLIB を検査し、OS 以外の絶対依存先なし。Avalonia の `/usr/local/lib/...` は LC_ID_DYLIB（自身の識別子）であり load dependency ではない。
- runtime のコピー全 31 Mach-O を hardened runtime + 現行アプリ相当の JIT entitlements で ad-hoc 再署名し、Git / GCM の起動成功。Developer ID / notarization 済み最終 .app の確認を代替しない。

証拠: `/tmp/tex64-issue39-evidence/git-runtime-verification.json`、`/tmp/tex64-issue39-evidence/git-runtime-signing.json`。

## 残る配布条件

GCM の .NET 10 は [Microsoft の対応 OS 表](https://learn.microsoft.com/en-us/dotnet/core/install/macos)で macOS 14 / 15 / 26 が現行サポート対象。この表は OS publisher のサポート終了に伴って古い OS を除外する。実行ファイルの deployment target と区別する必要がある。

この checkout の Electron.app は LSMinimumSystemVersion=12.0。同梱 runtime の全 31 Mach-O の LC_BUILD_VERSION は 11.0 または 12.0、GCM / .NET 本体は 12.0 であり、バイナリの最低 OS 指定は Electron と一致している（`git-runtime-minimum-os.json`）。ただし、指定だけでは macOS 12 / 13 の実行・認証成功を証明しない。この OS の実環境確認は残る。

代替 GCM 2.6.1 は公式 csproj で net8.0 だが、.NET 8 の現在の公式サポート表も 14 以降であり、旧版への置換だけで現行正式サポート OS が広がるわけではない。更新済み GCM 修正を巻き戻すことにもなるため、検証なしの旧版切替は行っていない。最低 OS の変更もこの実装では行っていない。

クリーンな対応 Mac、最終署名 .app、GitHub ブラウザ認証の実行確認は製品統合の受け入れ条件として残る。実行環境がある開発機の成功だけで、この条件を完了にしない。
