# Git運用

ブランチは `main` / `dev` / `exp/large-document` の 3 本だけ（tdom-engine も同じ構成）。

- `main`: リリース基準。`dev` から PR で取り込む。
- `dev`: 日常の統合先。作業はここに集約する。
- `exp/large-document`: 大規模文書向けの実験（issue #52 の重い追加）。pin も deploy もしない。

新しいブランチを作らない。消す前に `git merge-base --is-ancestor <branch> dev` で包含を確認し、origin の実態は `git ls-remote --heads origin` で見る。
