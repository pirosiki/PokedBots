/**
 * Special Race Preparation Batch
 *
 * 特別レース向けにコンディションを整えるバッチ
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │                         判定フロー                                │
 * ├──────────────────────────────────────────────────────────────────┤
 * │  【30分以上前】スカベンジングでボーナス獲得を狙う                  │
 * │    Battery < 50% ────────────────────────→ ChargingStation      │
 * │    Condition < 75% ──────────────────────→ RepairBay            │
 * │    それ以外 ─────────────────────────────→ ScrapHeaps           │
 * │                                                                  │
 * │  【30分前〜15分前】スカベンジング中止、準備開始                    │
 * │    スカベンジング中 ─────────────────────→ 中止                  │
 * │    Condition < 70% ──────────────────────→ RepairBay            │
 * │    Battery < 100% ───────────────────────→ ChargingStation      │
 * │                                                                  │
 * │  【15分前】有料メンテナンスでPerfect Tune                         │
 * │    Battery < 100% ───────────────────────→ 有料リチャージ        │
 * │    Condition < 100% ─────────────────────→ 有料リペア            │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 高速化: 並列実行 + 失敗時は個別リトライ
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// ========================================
// 設定: 対象イベント名（ここを変更して別のイベントに対応）
// ========================================
const TARGET_EVENT_NAME = "Weekend Warrior";  // イベント名の一部でOK

// Thresholds
const BATTERY_SCAVENGE_MIN = 50;    // スカベンジング時の最低バッテリー
const CONDITION_SCAVENGE_MIN = 75;  // スカベンジング時の最低コンディション
const CONDITION_PREP_MIN = 70;      // 準備期間の最低コンディション
const PREP_PHASE_MINUTES = 30;      // 準備開始（スカベンジング中止）
const FINAL_PHASE_MINUTES = 15;     // 有料メンテナンス開始

interface BotInfo {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
}

interface EventInfo {
  eventId: number;
  eventName: string;
  startTime: Date;
  minutesUntilStart: number;
}

async function getTargetEvent(client: PokedRaceMCPClient): Promise<EventInfo | null> {
  console.log(`📅 Looking for event: "${TARGET_EVENT_NAME}"...`);

  const result = await client.callTool("racing_list_events", {});
  const responseText = result.content[0].text;

  const eventBlocks = responseText.split('---').filter((block: string) => block.includes('Event #'));
  const now = new Date();

  for (const block of eventBlocks) {
    if (!block.toLowerCase().includes(TARGET_EVENT_NAME.toLowerCase())) continue;

    const eventIdMatch = block.match(/Event #(\d+)/);
    const nameMatch = block.match(/\*\*Event #\d+\*\*:\s*([^\n]+)/);
    const startTimeMatch = block.match(/📅 Start:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);

    if (!eventIdMatch || !startTimeMatch) continue;

    const eventId = parseInt(eventIdMatch[1]);
    const eventName = nameMatch ? nameMatch[1].trim() : TARGET_EVENT_NAME;
    const startTime = new Date(startTimeMatch[1]);
    const minutesUntilStart = Math.floor((startTime.getTime() - now.getTime()) / 60000);

    if (minutesUntilStart > 0) {
      console.log(`✅ Found: Event #${eventId} - ${eventName}`);
      console.log(`   Start: ${startTime.toISOString()}`);
      console.log(`   Minutes until start: ${minutesUntilStart}`);
      return { eventId, eventName, startTime, minutesUntilStart };
    }
  }

  return null;
}

async function getRegisteredBots(client: PokedRaceMCPClient, eventId: number): Promise<number[]> {
  console.log(`📝 Fetching registered bots for Event #${eventId}...`);

  const result = await client.callTool("racing_get_my_registrations", {});
  const responseText = result.content[0].text;

  const registered: number[] = [];
  const regMatches = responseText.matchAll(/\*\*Event #(\d+)\*\*:[^\n]*\n🤖 Bot: #(\d+)/g);

  for (const match of regMatches) {
    if (parseInt(match[1]) === eventId) {
      registered.push(parseInt(match[2]));
    }
  }

  console.log(`✅ Found ${registered.length} registered bots`);
  return registered;
}

async function getBotDetails(client: PokedRaceMCPClient, tokenIndexes: number[]): Promise<BotInfo[]> {
  console.log(`📡 Fetching details for ${tokenIndexes.length} bots in parallel...`);

  const detailPromises = tokenIndexes.map(async (tokenIndex) => {
    try {
      const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
      if (!result?.content?.[0]?.text) return null;

      const data = JSON.parse(result.content[0].text);
      const battery = data.condition?.battery || 0;
      const condition = data.condition?.condition || 0;
      const name = data.name || `Bot #${tokenIndex}`;

      let zone: string | null = null;
      if (data.active_scavenging?.status?.includes("Active")) {
        zone = data.active_scavenging.zone || null;
      }

      return { tokenIndex, name, battery, condition, zone } as BotInfo;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(detailPromises);
  return results
    .filter((r): r is PromiseFulfilledResult<BotInfo | null> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);
}

async function completeScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "";
      if (errorMsg.includes("No active mission")) return true;
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
      const errorMsg = result.content?.[0]?.text || "";
      if (errorMsg.includes("already on a scavenging mission")) return true;
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

async function rechargeBot(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_recharge_robot", { token_index: tokenIndex });
    return !result.isError;
  } catch {
    return false;
  }
}

async function repairBot(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_repair_robot", { token_index: tokenIndex });
    return !result.isError;
  } catch {
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏆 ========================================");
    console.log("🏆  SPECIAL RACE PREPARATION");
    console.log("🏆 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🎯 Target Event: "${TARGET_EVENT_NAME}"\n`);

    // Find target event
    const event = await getTargetEvent(client);
    if (!event) {
      console.log(`⚠️ Event "${TARGET_EVENT_NAME}" not found or already started`);
      await client.close();
      return;
    }

    // Determine phase
    const { minutesUntilStart } = event;
    let phase: "scavenge" | "prep" | "final";

    if (minutesUntilStart > PREP_PHASE_MINUTES) {
      phase = "scavenge";
      console.log(`\n📊 Phase: SCAVENGING (>${PREP_PHASE_MINUTES}min before race)`);
    } else if (minutesUntilStart > FINAL_PHASE_MINUTES) {
      phase = "prep";
      console.log(`\n📊 Phase: PREPARATION (${FINAL_PHASE_MINUTES}-${PREP_PHASE_MINUTES}min before race)`);
    } else {
      phase = "final";
      console.log(`\n📊 Phase: FINAL (<${FINAL_PHASE_MINUTES}min before race) - Paid maintenance`);
    }

    // Get registered bots
    const registeredIds = await getRegisteredBots(client, event.eventId);
    if (registeredIds.length === 0) {
      console.log("⚠️ No bots registered for this event");
      await client.close();
      return;
    }

    // Get bot details
    const bots = await getBotDetails(client, registeredIds);
    console.log(`✅ Got details for ${bots.length} bots\n`);

    // Display status
    console.log("📊 Bot Status:");
    for (const bot of bots) {
      const batteryIcon = bot.battery < (phase === "scavenge" ? BATTERY_SCAVENGE_MIN : 100) ? "⚠️" : "✓";
      const condIcon = bot.condition < (phase === "scavenge" ? CONDITION_SCAVENGE_MIN : phase === "prep" ? CONDITION_PREP_MIN : 100) ? "⚠️" : "✓";
      console.log(`   ${batteryIcon}${condIcon} #${bot.tokenIndex} ${bot.name}: Bat=${bot.battery}%, Cond=${bot.condition}%, Zone=${bot.zone || "None"}`);
    }

    // Plan actions
    interface BotTask {
      bot: BotInfo;
      action: "scrapheaps" | "charging" | "repair" | "recharge_paid" | "repair_paid" | "stop_scavenge" | "none";
      reason: string;
    }

    const tasks: BotTask[] = [];

    if (phase === "scavenge") {
      // Scavenging phase: keep battery >= 50%, condition >= 75%
      for (const bot of bots) {
        if (bot.condition < CONDITION_SCAVENGE_MIN && bot.zone !== "RepairBay") {
          tasks.push({ bot, action: "repair", reason: `Cond ${bot.condition}% < ${CONDITION_SCAVENGE_MIN}%` });
        } else if (bot.battery < BATTERY_SCAVENGE_MIN && bot.zone !== "ChargingStation") {
          tasks.push({ bot, action: "charging", reason: `Bat ${bot.battery}% < ${BATTERY_SCAVENGE_MIN}%` });
        } else if (bot.zone !== "ScrapHeaps" && bot.zone !== "RepairBay" && bot.zone !== "ChargingStation") {
          tasks.push({ bot, action: "scrapheaps", reason: "Start scavenging" });
        } else if (bot.zone === "ChargingStation" && bot.battery >= BATTERY_SCAVENGE_MIN && bot.condition >= CONDITION_SCAVENGE_MIN) {
          tasks.push({ bot, action: "scrapheaps", reason: "Resume scavenging" });
        } else if (bot.zone === "RepairBay" && bot.condition >= CONDITION_SCAVENGE_MIN && bot.battery >= BATTERY_SCAVENGE_MIN) {
          tasks.push({ bot, action: "scrapheaps", reason: "Resume scavenging" });
        } else {
          tasks.push({ bot, action: "none", reason: "OK" });
        }
      }
    } else if (phase === "prep") {
      // Preparation phase: stop scavenging, ensure condition >= 70%
      for (const bot of bots) {
        if (bot.zone === "ScrapHeaps") {
          tasks.push({ bot, action: "stop_scavenge", reason: "Stop scavenging" });
        } else if (bot.condition < CONDITION_PREP_MIN && bot.zone !== "RepairBay") {
          tasks.push({ bot, action: "repair", reason: `Cond ${bot.condition}% < ${CONDITION_PREP_MIN}%` });
        } else if (bot.battery < 100 && bot.zone !== "ChargingStation" && bot.condition >= CONDITION_PREP_MIN) {
          tasks.push({ bot, action: "charging", reason: `Charging to 100%` });
        } else {
          tasks.push({ bot, action: "none", reason: "OK" });
        }
      }
    } else {
      // Final phase: paid recharge and repair to 100%
      for (const bot of bots) {
        if (bot.zone === "ScrapHeaps") {
          // First stop scavenging
          await completeScavenging(client, bot.tokenIndex);
        }

        if (bot.battery < 100) {
          tasks.push({ bot, action: "recharge_paid", reason: `Bat ${bot.battery}% → 100%` });
        } else if (bot.condition < 100) {
          tasks.push({ bot, action: "repair_paid", reason: `Cond ${bot.condition}% → 100%` });
        } else {
          tasks.push({ bot, action: "none", reason: "Ready!" });
        }
      }
    }

    // Execute actions
    const activeTasks = tasks.filter(t => t.action !== "none");
    console.log(`\n⚡ Executing ${activeTasks.length} actions in parallel...`);

    if (activeTasks.length === 0) {
      console.log("   (No actions needed)");
    } else {
      const taskPromises = activeTasks.map(async (task): Promise<{ task: BotTask; success: boolean }> => {
        try {
          let success = false;
          switch (task.action) {
            case "scrapheaps":
              success = await moveBot(client, task.bot.tokenIndex, "ScrapHeaps");
              break;
            case "charging":
              success = await moveBot(client, task.bot.tokenIndex, "ChargingStation");
              break;
            case "repair":
              success = await moveBot(client, task.bot.tokenIndex, "RepairBay");
              break;
            case "stop_scavenge":
              success = await completeScavenging(client, task.bot.tokenIndex);
              break;
            case "recharge_paid":
              success = await rechargeBot(client, task.bot.tokenIndex);
              break;
            case "repair_paid":
              success = await repairBot(client, task.bot.tokenIndex);
              break;
          }
          return { task, success };
        } catch {
          return { task, success: false };
        }
      });

      const results = await Promise.allSettled(taskPromises);

      const succeeded: BotTask[] = [];
      const failed: BotTask[] = [];

      for (const result of results) {
        if (result.status === "fulfilled") {
          if (result.value.success) {
            succeeded.push(result.value.task);
          } else {
            failed.push(result.value.task);
          }
        }
      }

      // Log successes
      for (const task of succeeded) {
        const icon = task.action === "repair" || task.action === "repair_paid" ? "🔧" :
                     task.action === "scrapheaps" ? "⛏️" :
                     task.action === "charging" || task.action === "recharge_paid" ? "🔋" : "⏹️";
        console.log(`   ${icon} #${task.bot.tokenIndex} ${task.bot.name}: ${task.reason}`);
      }

      // Retry failed actions sequentially
      if (failed.length > 0) {
        console.log(`\n⚠️ ${failed.length} failed, retrying sequentially...`);
        for (const task of failed) {
          try {
            let success = false;
            switch (task.action) {
              case "scrapheaps":
                success = await moveBot(client, task.bot.tokenIndex, "ScrapHeaps");
                break;
              case "charging":
                success = await moveBot(client, task.bot.tokenIndex, "ChargingStation");
                break;
              case "repair":
                success = await moveBot(client, task.bot.tokenIndex, "RepairBay");
                break;
              case "stop_scavenge":
                success = await completeScavenging(client, task.bot.tokenIndex);
                break;
              case "recharge_paid":
                success = await rechargeBot(client, task.bot.tokenIndex);
                break;
              case "repair_paid":
                success = await repairBot(client, task.bot.tokenIndex);
                break;
            }
            if (success) {
              console.log(`   ✅ #${task.bot.tokenIndex} ${task.bot.name}: ${task.reason}`);
            } else {
              console.log(`   ❌ #${task.bot.tokenIndex} ${task.bot.name}: Failed`);
            }
          } catch (e) {
            console.log(`   ❌ #${task.bot.tokenIndex} ${task.bot.name}: ${e}`);
          }
        }
      }
    }

    // Summary
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`📋 Phase: ${phase.toUpperCase()}`);
    console.log(`⏰ Race starts in: ${minutesUntilStart} minutes`);
    console.log(`🤖 Bots managed: ${bots.length}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
