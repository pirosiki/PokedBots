# PokedBots Wasteland Racing - Game API Reference

## サーバー情報
- **名前**: pokedbots-wasteland-racing
- **タイトル**: PokedBots Wasteland Racing
- **バージョン**: 0.4.3
- **プロトコル**: JSON-RPC 2.0
- **接続方式**: HTTP POST

## 利用可能なツール（23個）

### 1. ヘルプ・情報
#### `help_get_compendium`
ゲームメカニクス、派閥、バッテリー、地形、アップグレード、スカベンジングなどの包括的な情報を取得。
- **パラメータ**:
  - `section` (optional): "all", "core", "factions", "battery", "terrain", "upgrades", "scavenging"

### 2. ガレージ管理（所有ロボット）
#### `garage_list_my_pokedbots`
自分のウォレットにあるすべてのPokedBotsをリスト表示（ステータス、レース状況、スカベンジング状況含む）。

#### `garage_initialize_pokedbot`
レース用にPokedBotを登録（0.1 ICP登録料、一度のみ）。
- **パラメータ**:
  - `token_index` (required): PokedBotのトークンインデックス
  - `name` (optional): カスタム名（最大30文字）

#### `garage_get_robot_details`
特定のPokedBotの詳細情報を取得（ステータス、コンディション、キャリア、アップグレード状況）。
- **パラメータ**:
  - `token_index` (required): トークンインデックス

#### `garage_recharge_robot`
ロボットのバッテリーを充電（0.1 ICP、6時間クールダウン）。50-90バッテリー回復。
- **パラメータ**:
  - `token_index` (required): トークンインデックス

#### `garage_repair_robot`
ロボットのコンディションを修復（0.05 ICP、3時間クールダウン）。25コンディション回復。
- **パラメータ**:
  - `token_index` (required): トークンインデックス

#### `garage_upgrade_robot`
12時間のアップグレードセッションを開始。タイプ: Velocity（速度）、PowerCore（パワーコア）、Thruster（加速）、Gyro（安定性）。
- **パラメータ**:
  - `token_index` (required): トークンインデックス
  - `upgrade_type` (required): "Velocity", "PowerCore", "Thruster", "Gyro"
  - `payment_method` (optional): "parts", "icp"

#### `garage_cancel_upgrade`
進行中のアップグレードをキャンセルして全額返金。
- **パラメータ**:
  - `token_index` (required): トークンインデックス

#### `garage_transfer_parts`
パーツを他のユーザーに転送。
- **パラメータ**:
  - `recipient_principal` (required): 受取人のプリンシパルID
  - `speed_chips` (optional): スピードチップ数
  - `power_core_fragments` (optional): パワーコアフラグメント数
  - `thruster_kits` (optional): スラスターキット数
  - `gyro_modules` (optional): ジャイロモジュール数
  - `universal_parts` (optional): ユニバーサルパーツ数

#### `garage_start_scavenging`
スカベンジングミッションを開始（バッテリー消費のみ、ICP不要）。
- **パラメータ**:
  - `token_index` (required): トークンインデックス
  - `zone` (required): "ScrapHeaps", "AbandonedSettlements", "DeadMachineFields", "RepairBay", "ChargingStation"
  - `duration_minutes` (optional): ミッション時間（分）

**ゾーン詳細**:
- **ScrapHeaps**: 安全（1.0x パーツ、1.0x バッテリー、1.0x コンディション）
- **AbandonedSettlements**: 中程度（1.6x パーツ、2.0x バッテリー、2.0x コンディション）
- **DeadMachineFields**: 危険（2.5x パーツ、3.5x バッテリー、3.5x コンディション）
- **RepairBay**: メンテナンス（0x パーツ、コンディション回復 +12-18/時間）
- **ChargingStation**: 無料充電（0x パーツ、バッテリー回復 +1/15分）

#### `garage_complete_scavenging`
スカベンジングからロボットを回収して報酬を収集。
- **パラメータ**:
  - `token_index` (required): トークンインデックス

#### `garage_convert_parts`
パーツを別のタイプに変換（25%変換コスト、75%受取）。
- **パラメータ**:
  - `from_type` (required): "SpeedChip", "PowerCoreFragment", "ThrusterKit", "GyroModule"
  - `to_type` (required): "SpeedChip", "PowerCoreFragment", "ThrusterKit", "GyroModule", "UniversalPart"
  - `amount` (required): 変換するパーツ数

### 3. マーケットプレイス
#### `browse_pokedbots`
販売中のPokedBots NFTを閲覧。派閥、レーティング、価格などでフィルタリング可能。
- **パラメータ**:
  - `tokenIndex` (optional): 特定のトークンインデックス
  - `after` (optional): ページネーション用
  - `faction` (optional): 派閥でフィルタ
  - `minRating` (optional): 最低レーティング（30-100）
  - `maxPrice` (optional): 最高価格（ICP）
  - `minWins` (optional): 最低勝利数
  - `minWinRate` (optional): 最低勝率（0-100%）
  - `sortBy` (optional): "price", "rating", "winRate", "wins"
  - `sortDesc` (optional): 降順ソート

#### `purchase_pokedbot`
マーケットプレイスからPokedBot NFTを購入。
- **パラメータ**:
  - `token_index` (required): トークンインデックス

### 4. レース
#### `racing_list_races`
今後のレースを表示。クラス、地形、ステータスでフィルタリング可能。
- **パラメータ**:
  - `token_index` (optional): ボットのトークンインデックス（指定すると、そのボットが参加可能なレースのみ表示）
  - `after_race_id` (optional): ページネーション用
  - `race_class` (optional): "Scrap", "Junker", "Raider", "Elite", "SilentKlan"
  - `terrain` (optional): "ScrapHeaps", "WastelandSand", "MetalRoads"
  - `status` (optional): "open", "full", "closed"
  - `min_distance` (optional): 最小距離（km）
  - `max_distance` (optional): 最大距離（km）
  - `has_spots` (optional): 空き枠があるレースのみ表示
  - `sort_by` (optional): "prize_pool", "start_time", "entry_fee", "distance"

#### `racing_enter_race`
PokedBotをレースにエントリー。エントリー料をICRC-2で支払い。
- **パラメータ**:
  - `race_id` (required): レースID
  - `token_index` (required): トークンインデックス

#### `racing_sponsor_race`
レースにICPを追加して賞金プールをスポンサー。
- **パラメータ**:
  - `race_id` (required): レースID
  - `amount_icp` (required): ICP額（最低0.1 ICP）
  - `message` (optional): スポンサーメッセージ（最大100文字）

#### `racing_get_race_details`
特定のレースの詳細情報を取得（エントリー、参加者、結果、コメンタリー含む）。
- **パラメータ**:
  - `race_id` (required): レースID

#### `racing_get_bot_races`
特定のボットがエントリーしているレースを表示。
- **パラメータ**:
  - `token_index` (required): トークンインデックス
  - `category` (optional): "upcoming", "in_progress", "completed", "all"
  - `after_race_id` (optional): ページネーション用

### 5. ベッティング
#### `betting_place_bet`
レースにベットを配置。Win（1位）、Place（トップ3）、Show（トップ5）。
- **パラメータ**:
  - `race_id` (required): レースID
  - `token_index` (required): ベット対象のボットのトークンインデックス
  - `bet_type` (required): "Win", "Place", "Show"
  - `amount_icp` (required): ベット額（0.1-100 ICP）

#### `betting_list_pools`
ベッティングプールをリスト表示。ステータスやクラスでフィルタリング可能。
- **パラメータ**:
  - `status_filter` (optional): "Open", "Closed", "Settled", "Pending"
  - `limit` (optional): 最大返却数（デフォルト10、最大50）

#### `betting_get_pool_info`
特定のベッティングプールのライブオッズを含む詳細情報を取得。
- **パラメータ**:
  - `race_id` (required): レースID

#### `betting_get_my_bets`
自分のベッティング履歴とパフォーマンス統計を表示。
- **パラメータ**:
  - `limit` (optional): 最大返却数（デフォルト20、最大100）

## 利用可能なリソース

### `file:///main.py`
アプリケーションのメインロジックを含むPythonスクリプト。

### `file:///README.md`
プロジェクトドキュメント。

## 自動操作の戦略アイデア

1. **スカベンジング自動化**: パーツ収集を自動化
2. **レース参加自動化**: 適切なレースを自動的に検索してエントリー
3. **ロボットメンテナンス**: バッテリー・コンディション管理の自動化
4. **マーケット監視**: お買い得なロボットを自動検出
5. **ベッティング戦略**: オッズ分析に基づく自動ベット
