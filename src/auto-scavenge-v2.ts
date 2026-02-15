/**
 * Auto-Scavenge V2
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │                         判定フロー                                │
 * ├──────────────────────────────────────────────────────────────────┤
 * │  Cond < 70% & RepairBay空きあり ─────────────→ RepairBay        │
 * │  Cond < 70% & RepairBay満 & Bat ≥ 95% ───────→ ScrapHeaps       │
 * │  Cond < 70% & RepairBay満 & Bat < 95% ───────→ Charging→後で稼働│
 * │  充電中 & Battery ≥ 95% ─────────────────────→ ScrapHeaps       │
 * │  充電中 ─────────────────────────────────────→ 継続             │
 * │  修理中 & Cond ≥ 95% & Battery ≥ 95% ────────→ ScrapHeaps       │
 * │  修理中 & Cond ≥ 95% & Battery < 95% ────────→ Charging         │
 * │  修理中 ─────────────────────────────────────→ 継続             │
 * │  スカベンジ中 & Battery < 80% ───────────────→ Charging         │
 * │  スカベンジ中 ───────────────────────────────→ 継続             │
 * │  Battery ≥ 95% ──────────────────────────────→ ScrapHeaps       │
 * │  それ以外 ───────────────────────────────────→ Charging         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 高速化: 並列実行 + 失敗時は個別リトライ
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// 1st Army Roster (16 bots)
const TARGET_BOTS = [
  // Elite
  9943, 7486, 5677, 2669, 1315, 5136,
  // Raider
  8313, 820, 5028, 8895,
  // Junker
  3535, 1722, 3674,
  // Scrap
  3406, 631, 406,
];

// Thresholds
const MAX_REPAIR_BAY = 4;         // RepairBay capacity (user has 4 bays)
const BATTERY_FULL = 95;          // Can start scavenging
const BATTERY_LOW = 80;           // Must return to charge
const CONDITION_FULL = 95;        // Repair complete
const CONDITION_LOW = 70;         // Need repair

interface BotStatus {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
}

async function getBotStatuses(client: PokedRaceMCPClient): Promise<BotStatus[]> {
  // 並列で全ボットのステータスを取得
  const statusPromises = TARGET_BOTS.map(async (tokenIndex) => {
    try {
      const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });

      if (!result || !result.content || !result.content[0] || !result.content[0].text) {
        return null;
      }

      const data = JSON.parse(result.content[0].text);
      const battery = data.condition?.battery || 0;
      const condition = data.condition?.condition || 0;
      const name = data.name || `Bot #${tokenIndex}`;

      let zone: string | null = null;
      if (data.active_scavenging &&
          data.active_scavenging.status &&
          typeof data.active_scavenging.status === "string" &&
          data.active_scavenging.status.includes("Active")) {
        zone = data.active_scavenging.zone || null;
      }

      return { tokenIndex, name, battery, condition, zone } as BotStatus;
    } catch {
      return null;
    }
  });

  const results = await Promise.allSettled(statusPromises);
  return results
    .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);
}

async function completeScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      if (errorMsg.includes("No active mission")) {
        return true;
      }
      console.error(`  ✗ Failed to complete for bot #${tokenIndex}: ${errorMsg}`);
      return false;
    }
    return true;
  } catch (error: any) {
    console.error(`  ✗ Exception for bot #${tokenIndex}:`, error.message);
    return false;
  }
}

async function startScavenging(client: PokedRaceMCPClient, tokenIndex: number, zone: string): Promise<boolean> {
  try {
    const result = await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      if (errorMsg.includes("already on a scavenging mission")) {
        return true;
      }
      console.error(`  ✗ Failed to start for bot #${tokenIndex}: ${errorMsg}`);
      return false;
    }
    return true;
  } catch (error: any) {
    console.error(`  ✗ Exception for bot #${tokenIndex}:`, error.message);
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

    console.log("\n🤖 ========================================");
    console.log("🤖  AUTO-SCAVENGE V2");
    console.log("🤖 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🎯 Managing ${TARGET_BOTS.length} bots\n`);
    console.log(`📊 Thresholds: Battery ${BATTERY_LOW}%-${BATTERY_FULL}%, Condition ${CONDITION_LOW}%-${CONDITION_FULL}%\n`);

    // Get all bot statuses
    console.log("📊 Fetching bot statuses...");
    const statuses = await getBotStatuses(client);
    console.log(`✅ Got status for ${statuses.length}/${TARGET_BOTS.length} bots\n`);

    // Categorize current state
    const chargingBots = statuses.filter(s => s.zone === "ChargingStation");
    const repairingBots = statuses.filter(s => s.zone === "RepairBay");
    const scavengingBots = statuses.filter(s => s.zone === "ScrapHeaps");
    const idleBots = statuses.filter(s => s.zone === null);

    console.log("📈 Current Status:");
    console.log(`   Charging: ${chargingBots.length}`);
    console.log(`   Repairing: ${repairingBots.length}`);
    console.log(`   Scavenging: ${scavengingBots.length}`);
    console.log(`   Idle: ${idleBots.length}\n`);

    // Display all bots sorted by battery
    const sortedByBattery = [...statuses].sort((a, b) => a.battery - b.battery);
    console.log("🔋 Bot Status (sorted by battery):");
    for (const bot of sortedByBattery) {
      const zoneIcon = bot.zone === "ChargingStation" ? "🔌" :
                       bot.zone === "RepairBay" ? "🔧" :
                       bot.zone === "ScrapHeaps" ? "⛏️" : "💤";
      console.log(`   ${zoneIcon} #${bot.tokenIndex} ${bot.name}: Battery=${bot.battery}%, Condition=${bot.condition}%, Zone=${bot.zone || "None"}`);
    }
    console.log("");

    // Track RepairBay usage
    let repairBayCount = repairingBots.length;
    console.log(`🔧 RepairBay: ${repairBayCount}/${MAX_REPAIR_BAY} slots used\n`);

    // Plan actions first (sequential to track RepairBay capacity)
    console.log("── Planning actions ──");

    interface BotTask {
      bot: BotStatus;
      action: "repair" | "scrapheaps" | "charging" | "none";
      reason: string;
    }

    const tasks: BotTask[] = [];

    for (const bot of statuses) {
      const { tokenIndex, name, battery, condition, zone } = bot;
      const displayName = `#${tokenIndex} ${name}`;

      // 1. Condition < 70% → RepairBay (if capacity available), else wait at ChargingStation
      if (condition < CONDITION_LOW) {
        if (zone === "RepairBay") {
          console.log(`🔧 ${displayName}: Repairing... (${condition}%)`);
          tasks.push({ bot, action: "none", reason: "repairing" });
          continue;
        }

        if (repairBayCount < MAX_REPAIR_BAY) {
          tasks.push({ bot, action: "repair", reason: `Cond ${condition}%` });
          repairBayCount++;
        } else if (zone === "ChargingStation") {
          // RepairBay満で充電中 → そのまま待機
          console.log(`🔌 ${displayName}: Waiting for RepairBay (${condition}%)`);
          tasks.push({ bot, action: "none", reason: "waiting for repair" });
        } else {
          // RepairBay満 → ChargingStationで待機（ScrapHeapsには送らない！）
          tasks.push({ bot, action: "charging", reason: "waiting for RepairBay" });
        }
        continue;
      }

      // 2. Charging & Battery ≥ 95% → ScrapHeaps
      if (zone === "ChargingStation" && battery >= BATTERY_FULL) {
        tasks.push({ bot, action: "scrapheaps", reason: "charged" });
        continue;
      }

      // 3. Charging → Continue
      if (zone === "ChargingStation") {
        console.log(`🔌 ${displayName}: Charging... (${battery}%)`);
        tasks.push({ bot, action: "none", reason: "charging" });
        continue;
      }

      // 4. Repairing & Cond ≥ 95% & Battery ≥ 95% → ScrapHeaps
      if (zone === "RepairBay" && condition >= CONDITION_FULL && battery >= BATTERY_FULL) {
        tasks.push({ bot, action: "scrapheaps", reason: "repaired" });
        continue;
      }

      // 5. Repairing & Cond ≥ 95% & Battery < 95% → Charging
      if (zone === "RepairBay" && condition >= CONDITION_FULL && battery < BATTERY_FULL) {
        tasks.push({ bot, action: "charging", reason: "repaired, need charge" });
        continue;
      }

      // 6. Repairing → Continue
      if (zone === "RepairBay") {
        console.log(`🔧 ${displayName}: Repairing... (${condition}%)`);
        tasks.push({ bot, action: "none", reason: "repairing" });
        continue;
      }

      // 7. Scavenging & Battery < 80% → Charging
      if (zone === "ScrapHeaps" && battery < BATTERY_LOW) {
        tasks.push({ bot, action: "charging", reason: "low battery" });
        continue;
      }

      // 8. Scavenging → Continue
      if (zone === "ScrapHeaps") {
        console.log(`⛏️ ${displayName}: Scavenging... (${battery}%)`);
        tasks.push({ bot, action: "none", reason: "scavenging" });
        continue;
      }

      // 9. Battery ≥ 95% → ScrapHeaps
      if (battery >= BATTERY_FULL) {
        tasks.push({ bot, action: "scrapheaps", reason: "battery full" });
        continue;
      }

      // 10. Otherwise → Charging
      tasks.push({ bot, action: "charging", reason: "need charge" });
    }

    // Execute actions in parallel
    const activeTasks = tasks.filter(t => t.action !== "none");
    console.log(`\n⚡ Executing ${activeTasks.length} actions in parallel...`);

    const taskPromises = activeTasks.map(async (task): Promise<{ task: BotTask; success: boolean }> => {
      const targetZone = task.action === "repair" ? "RepairBay" :
                         task.action === "scrapheaps" ? "ScrapHeaps" : "ChargingStation";
      try {
        await moveBot(client, task.bot.tokenIndex, targetZone);
        return { task, success: true };
      } catch {
        return { task, success: false };
      }
    });

    const results = await Promise.allSettled(taskPromises);

    const succeeded: BotTask[] = [];
    const failed: BotTask[] = [];
    const actions: string[] = [];

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
      const targetZone = task.action === "repair" ? "RepairBay" :
                         task.action === "scrapheaps" ? "ScrapHeaps" : "ChargingStation";
      const icon = task.action === "repair" ? "🔧" : task.action === "scrapheaps" ? "⛏️" : "🔌";
      console.log(`   ${icon} #${task.bot.tokenIndex} ${task.bot.name} → ${targetZone} (${task.reason})`);
      actions.push(`#${task.bot.tokenIndex} ${task.bot.name} → ${targetZone}`);
    }

    // Retry failed actions sequentially
    if (failed.length > 0) {
      console.log(`\n⚠️ ${failed.length} failed, retrying sequentially...`);
      for (const task of failed) {
        const targetZone = task.action === "repair" ? "RepairBay" :
                           task.action === "scrapheaps" ? "ScrapHeaps" : "ChargingStation";
        try {
          await moveBot(client, task.bot.tokenIndex, targetZone);
          console.log(`   ✅ #${task.bot.tokenIndex} ${task.bot.name} → ${targetZone}`);
          actions.push(`#${task.bot.tokenIndex} ${task.bot.name} → ${targetZone} (retry)`);
        } catch (e) {
          console.log(`   ❌ #${task.bot.tokenIndex} ${task.bot.name} failed: ${e}`);
        }
      }
    }

    // Summary
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Actions taken:");
    if (actions.length === 0) {
      console.log("   (none)");
    } else {
      for (const action of actions) {
        console.log(`   • ${action}`);
      }
    }

    // Final count
    const finalStatuses = await getBotStatuses(client);
    const finalCharging = finalStatuses.filter(s => s.zone === "ChargingStation").length;
    const finalRepairing = finalStatuses.filter(s => s.zone === "RepairBay").length;
    const finalScavenging = finalStatuses.filter(s => s.zone === "ScrapHeaps").length;

    console.log(`\n✅ Complete - Charging: ${finalCharging}, Repairing: ${finalRepairing}, Scavenging: ${finalScavenging}`);
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
