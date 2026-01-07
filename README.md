# PokedBots

## プロジェクト概要

PokedBots Wasteland Racing というゲームのためのMCPサーバーに接続して、AIによるゲーム操作を自動実行するプロジェクト。

## 目的

MCPサーバーを通じて、PokedBots Wasteland Racing の様々な操作を自動化し、AIによる自動プレイを実現する。

## 技術スタック

- **言語**: TypeScript
- **MCP通信**: HTTP POST + JSON-RPC 2.0
- **環境変数管理**: dotenv
- **パッケージマネージャー**: npm

## 現在の機能

- ✅ MCP サーバーへの接続（HTTP POST ベース）
- ✅ APIキー認証
- ✅ 利用可能なツール・リソースの一覧取得
- ✅ 23種類のゲームツールへのアクセス

## ゲーム機能カテゴリ

1. **ガレージ管理**: ロボット登録、充電、修理、アップグレード、スカベンジング
2. **マーケットプレイス**: ロボット閲覧・購入
3. **レース**: レース検索、エントリー、スポンサー
4. **ベッティング**: レースへの賭け、オッズ確認

詳細は [GAME_API.md](./GAME_API.md) を参照。

## セットアップ

1. 依存関係のインストール:
```bash
npm install
```

2. 環境変数の設定:
`.env` ファイルを作成（`.env.example` を参照）:
```
MCP_SERVER_URL=https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp
MCP_API_KEY=your_api_key_here
```

3. 実行:
```bash
npm run dev
```

## プロジェクト構成

```
PokedBots/
├── src/
│   ├── index.ts          # エントリーポイント（サーバー調査）
│   └── mcp-client.ts     # HTTP POST ベース MCP クライアント
├── package.json
├── tsconfig.json
├── .env                  # 環境変数（Gitにコミットしない）
├── .env.example          # 環境変数のサンプル
├── README.md             # このファイル
└── GAME_API.md           # ゲームAPI詳細リファレンス
```

## 今後の実装予定

- [ ] スカベンジング自動化
- [ ] レース参加自動化
- [ ] ロボットメンテナンス自動化
- [ ] マーケット監視
- [ ] ベッティング戦略
