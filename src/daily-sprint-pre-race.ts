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
 *
 * 高速化: 並列実行 + 失敗時は個別リトライ
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
  const botBlocks = responseText.split(/(?=🏎️ PokedBot #)/g).filter((b: string) => b.includes('PokedBot #'));

  // 対象ボットのtokenIndexとnameを抽出
  const targetBotBasics: { tokenIndex: number; name: string }[] = [];

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

    if (isTarget) {
      targetBotBasics.push({ tokenIndex, name });
    }
  }

  // 並列で詳細を取得
  console.log(`📡 Fetching details for ${targetBotBasics.length} bots in parallel...`);
  const detailPromises = targetBotBasics.map(async (bot) => {
    try {
      const detailResult = await client.callTool("garage_get_robot_details", { token_index: bot.tokenIndex });
      if (!detailResult || !detailResult.content || !detailResult.content[0] || !detailResult.content[0].text) {
        return null;
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

      return { tokenIndex: bot.tokenIndex, name: bot.name, battery, condition, zone } as BotInfo;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(detailPromises);
  const bots: BotInfo[] = results
    .filter((r): r is PromiseFulfilledResult<BotInfo | null> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);

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

    // Phase 0: スカベンジング中のボットを呼び戻す（並列）
    const scavengingBots = bots.filter(b => b.zone !== null);
    if (scavengingBots.length > 0) {
      console.log(`📥 Phase 0: Recalling ${scavengingBots.length} bot(s) from scavenging in parallel...`);
      const recallPromises = scavengingBots.map(async (bot) => {
        try {
          await completeScavenging(client, bot.tokenIndex);
          return { bot, success: true };
        } catch {
          return { bot, success: false };
        }
      });
      const recallResults = await Promise.allSettled(recallPromises);

      // 失敗したボットをリトライ
      const failedRecalls = recallResults
        .filter((r): r is PromiseFulfilledResult<{bot: BotInfo, success: boolean}> =>
          r.status === "fulfilled" && !r.value.success)
        .map(r => r.value.bot);

      if (failedRecalls.length > 0) {
        console.log(`   ⚠️ ${failedRecalls.length} failed, retrying...`);
        for (const bot of failedRecalls) {
          await completeScavenging(client, bot.tokenIndex);
        }
      }
      console.log(`   ✅ Recalled ${scavengingBots.length} bots`);
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

    // Phase 1: バッテリー < 100% → 有料リチャージ（並列）
    const needRecharge = bots.filter(b => b.battery < 100);
    if (needRecharge.length > 0) {
      console.log(`\n🔋 Phase 1: Recharging ${needRecharge.length} bot(s) in parallel...`);

      const rechargePromises = needRecharge.map(async (bot) => {
        try {
          const result = await client.callTool("garage_recharge_robot", { token_index: bot.tokenIndex });
          if (result.isError) {
            return { bot, success: false, error: result.content?.[0]?.text };
          }
          return { bot, success: true };
        } catch (e) {
          return { bot, success: false, error: String(e) };
        }
      });

      const rechargeResults = await Promise.allSettled(rechargePromises);

      const succeeded: BotInfo[] = [];
      const failed: { bot: BotInfo; error?: string }[] = [];

      for (const result of rechargeResults) {
        if (result.status === "fulfilled") {
          if (result.value.success) {
            succeeded.push(result.value.bot);
          } else {
            failed.push({ bot: result.value.bot, error: result.value.error });
          }
        }
      }

      for (const bot of succeeded) {
        console.log(`   ✅ ${bot.name}: Recharged`);
        rechargeCount++;
      }

      // 失敗したボットを個別リトライ
      if (failed.length > 0) {
        console.log(`   ⚠️ ${failed.length} failed, retrying sequentially...`);
        for (const { bot } of failed) {
          const success = await rechargeBot(client, bot.tokenIndex, bot.name);
          if (success) rechargeCount++;
        }
      }
    } else {
      console.log("\n✓ Phase 1: All bots have 100% battery");
    }

    // Phase 2: コンディション < 100% → 有料リペア (Perfect Tune!)（並列）
    const needRepair = bots.filter(b => b.condition < 100);
    if (needRepair.length > 0) {
      console.log(`\n🔧 Phase 2: Repairing ${needRepair.length} bot(s) → Perfect Tune in parallel...`);

      const repairPromises = needRepair.map(async (bot) => {
        try {
          const result = await client.callTool("garage_repair_robot", { token_index: bot.tokenIndex });
          if (result.isError) {
            return { bot, success: false, error: result.content?.[0]?.text };
          }
          return { bot, success: true };
        } catch (e) {
          return { bot, success: false, error: String(e) };
        }
      });

      const repairResults = await Promise.allSettled(repairPromises);

      const succeeded: BotInfo[] = [];
      const failed: { bot: BotInfo; error?: string }[] = [];

      for (const result of repairResults) {
        if (result.status === "fulfilled") {
          if (result.value.success) {
            succeeded.push(result.value.bot);
          } else {
            failed.push({ bot: result.value.bot, error: result.value.error });
          }
        }
      }

      for (const bot of succeeded) {
        console.log(`   ✅ ${bot.name}: Repaired → Perfect Tune!`);
        repairCount++;
      }

      // 失敗したボットを個別リトライ
      if (failed.length > 0) {
        console.log(`   ⚠️ ${failed.length} failed, retrying sequentially...`);
        for (const { bot } of failed) {
          const success = await repairBot(client, bot.tokenIndex, bot.name);
          if (success) repairCount++;
        }
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
