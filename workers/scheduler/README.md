# PokedBots Scheduler

Cloudflare Workers版のスケジューラー - GitHub Actionsワークフローを確実なスケジュールで実行

## 概要

このWorkerは以下を実行します:
- **自動スカベンジング**: 15分ごとに `auto-scavenge.yml` をトリガー
- **自動レース**: 30分ごとに `auto-racing.yml` をトリガー
- **グループ分け**: 1日4回（JST 3:10, 9:10, 15:10, 21:10）に `auto-group-assignment.yml` をトリガー

GitHub Actionsのcronスケジュールは不安定（4-52分の遅延）なため、Cloudflare Workersで確実にトリガーします。

## セットアップ

### 1. GitHub Personal Access Tokenの作成

1. GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. "Generate new token (classic)" をクリック
3. 権限:
   - `repo` (full control)
   - `workflow` (Update GitHub Action workflows)
4. トークンをコピー（`ghp_...`で始まる）

### 2. 依存関係のインストール

```bash
cd workers/scheduler
npm install
```

### 3. Wranglerにログイン

```bash
npx wrangler login
```

### 4. Secretsの設定

```bash
npx wrangler secret put GITHUB_TOKEN
# プロンプトでGitHub Personal Access Tokenを入力
```

### 5. デプロイ

```bash
npm run deploy
```

## 使用方法

### 自動実行（Cron）
デプロイ後、自動的に実行されます:
- **Auto-scavenge**: 毎時 :00, :15, :30, :45
- **Auto-racing**: 毎時 :00, :30
- **Auto-group-assignment**: 毎日 JST 3:10, 9:10, 15:10, 21:10

### 手動実行

特定のワークフローを手動トリガー:

```bash
# Scavengeをトリガー
curl "https://pokedbots-scheduler.<your-subdomain>.workers.dev?workflow=auto-scavenge.yml"

# Racingをトリガー
curl "https://pokedbots-scheduler.<your-subdomain>.workers.dev?workflow=auto-racing.yml"

# Group assignmentをトリガー
curl "https://pokedbots-scheduler.<your-subdomain>.workers.dev?workflow=auto-group-assignment.yml"
```

## ログの確認

リアルタイムログ:
```bash
npm run tail
```

Dashboard:
https://dash.cloudflare.com/ → Workers & Pages → pokedbots-scheduler → Logs

## GitHub Actionsワークフローの設定

既存のワークフローは `workflow_dispatch` トリガーが設定されているため、そのまま使用できます。

Cronスケジュールは削除してもOKですが、念のため残しておいても問題ありません（Cloudflare Workersが確実にトリガーするため）。
