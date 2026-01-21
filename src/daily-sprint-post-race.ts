/**
 * Daily Sprint Post-Race Maintenance
 *
 * 15分毎に実行（レース30分後から次のレースまで）:
 * 1. コンディション < 70% → RepairBay（無料）
 * 2. バッテリー < 100% → ChargingStation（無料）
 * 3. バッテリー100% → Retrieve（待機状態へ）
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

    // 各ボットの処理内容を決定
    interface BotTask {
      bot: BotInfo;
      action: "repair" | "standby" | "charge" | "none";
    }

    const tasks: BotTask[] = bots.map(bot => {
      if (bot.condition < CONDITION_THRESHOLD && bot.zone !== "RepairBay") {
        return { bot, action: "repair" };
      }
      if (bot.battery >= 100 && bot.zone !== null) {
        return { bot, action: "standby" };
      }
      if (bot.battery < 100 && bot.zone !== "ChargingStation") {
        return { bot, action: "charge" };
      }
      return { bot, action: "none" };
    });

    const activeTasks = tasks.filter(t => t.action !== "none");
    console.log(`\n⚡ Processing ${activeTasks.length} bots in parallel...`);

    // 並列実行
    const taskPromises = activeTasks.map(async (task): Promise<{ task: BotTask; success: boolean }> => {
      const { bot, action } = task;
      try {
        if (action === "repair") {
          await moveBot(client, bot.tokenIndex, "RepairBay");
        } else if (action === "standby") {
          await completeScavenging(client, bot.tokenIndex);
        } else if (action === "charge") {
          await moveBot(client, bot.tokenIndex, "ChargingStation");
        }
        return { task, success: true };
      } catch {
        return { task, success: false };
      }
    });

    const results = await Promise.allSettled(taskPromises);

    // 結果を集計
    const succeeded: BotTask[] = [];
    const failed: BotTask[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          succeeded.push(result.value.task);
        } else {
          failed.push(result.value.task);
        }
      } else {
        // Promise自体が失敗した場合
        failed.push(activeTasks[results.indexOf(result)]);
      }
    }

    // 成功したアクションをログ
    for (const task of succeeded) {
      const actionLabel = task.action === "repair" ? "RepairBay" :
                          task.action === "standby" ? "Standby" : "ChargingStation";
      console.log(`   ✅ ${task.bot.name} → ${actionLabel}`);
      actions.push(`${task.bot.name} → ${actionLabel}`);
    }

    // 失敗したボットを個別にリトライ
    if (failed.length > 0) {
      console.log(`\n⚠️  ${failed.length} failed, retrying sequentially...`);
      for (const task of failed) {
        const { bot, action } = task;
        try {
          console.log(`   🔄 Retrying ${bot.name}...`);
          if (action === "repair") {
            await moveBot(client, bot.tokenIndex, "RepairBay");
            console.log(`   ✅ ${bot.name} → RepairBay`);
            actions.push(`${bot.name} → RepairBay (retry)`);
          } else if (action === "standby") {
            await completeScavenging(client, bot.tokenIndex);
            console.log(`   ✅ ${bot.name} → Standby`);
            actions.push(`${bot.name} → Standby (retry)`);
          } else if (action === "charge") {
            await moveBot(client, bot.tokenIndex, "ChargingStation");
            console.log(`   ✅ ${bot.name} → ChargingStation`);
            actions.push(`${bot.name} → ChargingStation (retry)`);
          }
        } catch (e) {
          console.log(`   ❌ ${bot.name} failed again: ${e}`);
        }
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
