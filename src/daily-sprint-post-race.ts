/**
 * Daily Sprint Post-Race Maintenance
 *
 * 15分毎に実行（レース30分後から次のレースまで）:
 * 1. コンディション < 70% → RepairBay（無料）
 * 2. バッテリー < 100% → ChargingStation（無料）
 * 3. バッテリー100% → Retrieve（待機状態へ）
 *
 * 対象: Daily Sprint固定メンバー25体
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// Daily Sprint固定メンバー（25体）- register-daily-sprint.tsと同じ
const TARGET_NAMES = [
  "Hachiware", "Usagi", "らっこ", "うさぎ", "TAGGR",
  "Nora", "SonicBlue", "Ged", "Wasabi", "Bot #7486",
  "Motoko", "ちいかわ", "G-Max", "Char", "Papuwa",
  "Matai", "StraySheep", "Kafka", "クラムボン", "Guevara",
  "Noir", "Chiikawa", "仙台牛タン", "ねじまき鳥", "厚切り牛タン"
];

const CONDITION_THRESHOLD = 70; // これ未満ならリペア

interface BotInfo {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
}

async function getTargetBots(client: PokedRaceMCPClient): Promise<BotInfo[]> {
  console.log("📋 Fetching target bots...");

  const result = await client.callTool("garage_list_my_pokedbots", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get bot list");
  }

  const responseText = result.content[0].text;
  const bots: BotInfo[] = [];

  const botBlocks = responseText.split(/(?=🏎️ PokedBot #)/g).filter((b: string) => b.includes('PokedBot #'));

  for (const block of botBlocks) {
    const tokenMatch = block.match(/🏎️ PokedBot #(\d+)(?: "([^"]+)")?/);
    if (!tokenMatch) continue;

    const tokenIndex = parseInt(tokenMatch[1]);
    const name = tokenMatch[2] || `Bot #${tokenIndex}`;

    // 対象メンバーかチェック
    const isTarget = TARGET_NAMES.some(targetName =>
      name.toLowerCase() === targetName.toLowerCase() ||
      name.includes(targetName) ||
      targetName.includes(name)
    );

    if (!isTarget) continue;

    // 詳細を取得
    const detailResult = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    if (!detailResult || !detailResult.content || !detailResult.content[0] || !detailResult.content[0].text) {
      continue;
    }

    const data = JSON.parse(detailResult.content[0].text);
    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;

    let zone: string | null = null;
    if (data.active_scavenging &&
        data.active_scavenging.status &&
        typeof data.active_scavenging.status === "string" &&
        data.active_scavenging.status.includes("Active")) {
      zone = data.active_scavenging.zone || null;
    }

    bots.push({ tokenIndex, name, battery, condition, zone });
  }

  console.log(`✅ Found ${bots.length}/${TARGET_NAMES.length} target bots`);
  return bots;
}

async function completeScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      if (errorMsg.includes("No active mission")) {
        return true;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function startScavenging(client: PokedRaceMCPClient, tokenIndex: number, zone: string): Promise<boolean> {
  try {
    const result = await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone });
    if (result.isError) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function moveBot(client: PokedRaceMCPClient, tokenIndex: number, targetZone: string): Promise<boolean> {
  await completeScavenging(client, tokenIndex);
  await new Promise(resolve => setTimeout(resolve, 300));
  return startScavenging(client, tokenIndex, targetZone);
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🔧 ========================================");
    console.log("🔧  DAILY SPRINT POST-RACE MAINTENANCE");
    console.log("🔧 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}\n`);

    // 対象ボット取得
    const bots = await getTargetBots(client);

    if (bots.length === 0) {
      console.log("⚠️  No target bots found");
      await client.close();
      return;
    }

    // 状態表示
    console.log("\n📊 Current Status:");
    for (const bot of bots) {
      const condIcon = bot.condition < CONDITION_THRESHOLD ? "🔧" :
                       bot.battery < 100 ? "🔋" : "✅";
      console.log(`   ${condIcon} ${bot.name}: Battery=${bot.battery}%, Condition=${bot.condition}%, Zone=${bot.zone || "None"}`);
    }

    const actions: string[] = [];

    // 処理
    for (const bot of bots) {
      // 1. コンディション < 70% → RepairBay
      if (bot.condition < CONDITION_THRESHOLD) {
        if (bot.zone !== "RepairBay") {
          console.log(`\n🔧 ${bot.name}: Condition ${bot.condition}% → RepairBay`);
          await moveBot(client, bot.tokenIndex, "RepairBay");
          actions.push(`${bot.name} → RepairBay`);
        }
        continue;
      }

      // 2. バッテリー100% → Retrieve（待機状態へ）
      if (bot.battery >= 100) {
        if (bot.zone !== null) {
          console.log(`\n✅ ${bot.name}: Battery 100% → Retrieve (standby)`);
          await completeScavenging(client, bot.tokenIndex);
          actions.push(`${bot.name} → Standby`);
        }
        continue;
      }

      // 3. バッテリー < 100% → ChargingStation
      if (bot.zone !== "ChargingStation") {
        console.log(`\n🔋 ${bot.name}: Battery ${bot.battery}% → ChargingStation`);
        await moveBot(client, bot.tokenIndex, "ChargingStation");
        actions.push(`${bot.name} → ChargingStation`);
      }
    }

    // Summary
    const finalBots = await getTargetBots(client);
    const charging = finalBots.filter(b => b.zone === "ChargingStation").length;
    const repairing = finalBots.filter(b => b.zone === "RepairBay").length;
    const standby = finalBots.filter(b => b.zone === null).length;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Actions taken:");
    if (actions.length === 0) {
      console.log("   (none)");
    } else {
      for (const action of actions) {
        console.log(`   • ${action}`);
      }
    }

    console.log(`\n✅ Post-race maintenance complete`);
    console.log(`   ChargingStation: ${charging}`);
    console.log(`   RepairBay: ${repairing}`);
    console.log(`   Standby: ${standby}`);

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
