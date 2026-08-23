# ブランチ運用

## 役割

| ブランチ | 役割 |
|---|---|
| `main` | **開発の本流。ここが最新。** 機能はまず main に入る。ローカル配備（`npm run deploy:local`）とリリースの基準 |
| `dev` | 共同作業用の受け皿。main から分岐し、まとまったら PR で main へマージする。**main に自動追従しない** |
| `codex/*` | エージェント作業用の一時ブランチ。マージ後は削除してよい |

## セットアップ時の注意

`dev` に留まったまま `git pull --ff-only` すると `Already up to date.` と出ますが、
これは「dev が最新」という意味ではなく「dev のリモートに新しいコミットが無い」という意味です。
main に入った機能は取り込まれません。

新しい機能を試すときは main を見てください。

```bash
git switch main && git pull --ff-only
```

差分の確認:

```bash
git log --oneline origin/dev..main   # main にあって dev に無いもの
git log --oneline main..origin/dev   # dev にあって main に無いもの
```

## 作業の流れ

1. `main` を最新にする
2. 作業ブランチを切る（直接 main にコミットしない）
3. コミットは機能で分けず、全変更を1つにまとめる（[CLAUDE.md](../CLAUDE.md) の作業規約）
4. PR で main へ。`dev` を使う場合も、最終的な取り込み先は main
