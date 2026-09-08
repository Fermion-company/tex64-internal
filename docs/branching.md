# Git運用

- `main` は開発の本流とリリース基準。
- `dev` は共同開発の統合先。自動でmainには追従しない。
- 作業ブランチからPRでmainへ取り込む。コミットは今回の作業範囲を対象にする。

比較には `git log main..origin/dev` と `git log origin/dev..main` を使う。
