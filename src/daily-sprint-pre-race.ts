/**
 * Daily Sprint Pre-Race Maintenance
 *
 * レース開始15分前に実行:
 * 1. バッテリー < 100% → 有料リチャージ (0.1 ICP)
 * 2. コンディション < 100% → 有料リペア (0.05 ICP)
 *
 * 順番: リチャージ → リペア = Perfect Tune獲得
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

async function rechargeBot(client: PokedRaceMCPClient, tokenIndex: number, name: string): Promise<boolean> {
  try {
    console.log(`   🔋 ${name}: Recharging... (0.1 ICP)`);
    const result = await client.callTool("garage_recharge_robot", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.log(`   ❌ ${name}: ${errorMsg}`);
      return false;
    }
    console.log(`   ✅ ${name}: Recharged`);
    return true;
  } catch (error) {
    console.log(`   ❌ ${name}: ${error}`);
    return false;
  }
}

async function repairBot(client: PokedRaceMCPClient, tokenIndex: number, name: string): Promise<boolean> {
  try {
    console.log(`   🔧 ${name}: Repairing... (0.05 ICP)`);
    const result = await client.callTool("garage_repair_robot", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.log(`   ❌ ${name}: ${errorMsg}`);
      return false;
    }
    console.log(`   ✅ ${name}: Repaired → Perfect Tune!`);
    return true;
  } catch (error) {
    console.log(`   ❌ ${name}: ${error}`);
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  DAILY SPRINT PRE-RACE MAINTENANCE");
    console.log("🏁 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}\n`);

    // 対象ボット取得
    const bots = await getTargetBots(client);

    if (bots.length === 0) {
      console.log("⚠️  No target bots found");
      await client.close();
      return;
    }

    // Phase 0: スカベンジング中のボットを呼び戻す
    const scavengingBots = bots.filter(b => b.zone !== null);
    if (scavengingBots.length > 0) {
      console.log(`📥 Phase 0: Recalling ${scavengingBots.length} bot(s) from scavenging...`);
      for (const bot of scavengingBots) {
        console.log(`   → ${bot.name} from ${bot.zone}`);
        await completeScavenging(client, bot.tokenIndex);
      }
      console.log("");
    }

    // 状態表示
    console.log("📊 Current Status:");
    for (const bot of bots) {
      const batteryIcon = bot.battery < 100 ? "⚠️" : "✓";
      const condIcon = bot.condition < 100 ? "⚠️" : "✓";
      console.log(`   ${batteryIcon}${condIcon} ${bot.name}: Battery=${bot.battery}%, Condition=${bot.condition}%`);
    }

    let rechargeCount = 0;
    let repairCount = 0;

    // Phase 1: バッテリー < 100% → 有料リチャージ
    const needRecharge = bots.filter(b => b.battery < 100);
    if (needRecharge.length > 0) {
      console.log(`\n🔋 Phase 1: Recharging ${needRecharge.length} bot(s)...`);
      for (const bot of needRecharge) {
        const success = await rechargeBot(client, bot.tokenIndex, bot.name);
        if (success) rechargeCount++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      console.log("\n✓ Phase 1: All bots have 100% battery");
    }

    // Phase 2: コンディション < 100% → 有料リペア (Perfect Tune!)
    const needRepair = bots.filter(b => b.condition < 100);
    if (needRepair.length > 0) {
      console.log(`\n🔧 Phase 2: Repairing ${needRepair.length} bot(s) → Perfect Tune...`);
      for (const bot of needRepair) {
        const success = await repairBot(client, bot.tokenIndex, bot.name);
        if (success) repairCount++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      console.log("\n✓ Phase 2: All bots have 100% condition");
    }

    // Summary
    const totalCost = (rechargeCount * 0.1) + (repairCount * 0.05);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Summary:");
    console.log(`   Recharged: ${rechargeCount}/${needRecharge.length}`);
    console.log(`   Repaired: ${repairCount}/${needRepair.length}`);
    console.log(`   Total cost: ${totalCost.toFixed(2)} ICP (+ fees)`);
    if (repairCount > 0) {
      console.log(`   🌟 Perfect Tune applied to ${repairCount} bot(s)!`);
    }

    console.log(`\n✅ Pre-race maintenance complete - Ready to race!`);

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
