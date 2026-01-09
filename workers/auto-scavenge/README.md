# PokedBots Auto-Scavenge Worker

Cloudflare Workers版の自動スカベンジングバッチ処理

## セットアップ

### 1. 依存関係のインストール

```bash
cd workers/auto-scavenge
npm install
```

### 2. Wranglerにログイン

```bash
npx wrangler login
```

### 3. Secretsの設定

```bash
npx wrangler secret put MCP_API_KEY
# プロンプトでAPI Keyを入力
```

### 4. デプロイ

```bash
npm run deploy
```

## 実行方法

### Cron Trigger（自動）
- 15分ごとに自動実行されます
- `wrangler.toml` の `crons` 設定で変更可能

### 手動実行
デプロイ後、Worker URLにアクセスすると手動実行できます：

```bash
curl https://pokedbots-auto-scavenge.<your-subdomain>.workers.dev
```

## ログの確認

リアルタイムログ:
```bash
npm run tail
```

Dashboard:
https://dash.cloudflare.com/ → Workers & Pages → pokedbots-auto-scavenge → Logs

## ボットリストの更新

`src/index.ts` の `SCAVENGING_BOTS` 配列を更新してデプロイし直してください。

または、GitHub Actionsの auto-group-assignment で更新された `bots-config.json` を定期的に同期する仕組みを追加することも可能です。
