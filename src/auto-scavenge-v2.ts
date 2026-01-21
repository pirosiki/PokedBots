/**
 * Auto-Scavenge V2
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │                      判定フロー                          │
 * ├─────────────────────────────────────────────────────────┤
 * │  Cond < 70% ─────────────────────────────→ RepairBay   │
 * │  充電中 & Battery ≥ 95% ─────────────────→ ScrapHeaps  │
 * │  充電中 ─────────────────────────────────→ 継続        │
 * │  修理中 & Cond ≥ 95% & Battery ≥ 95% ───→ ScrapHeaps  │
 * │  修理中 & Cond ≥ 95% & Battery < 95% ───→ Charging    │
 * │  修理中 ─────────────────────────────────→ 継続        │
 * │  スカベンジ中 & Battery < 80% ──────────→ Charging    │
 * │  スカベンジ中 ───────────────────────────→ 継続        │
 * │  Battery ≥ 95% ──────────────────────────→ ScrapHeaps  │
 * │  それ以外 ───────────────────────────────→ Charging    │
 * └─────────────────────────────────────────────────────────┘
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// Target bots (10 total)
const TARGET_BOTS = [
  2669,  // Bach (Silent, Rating 54)
  5143,  // ハチワレ (Silent, Rating 54)
  2630,  // Noboru (Elite, Rating 44)
  2441,  // neopirosiki (Elite, Rating 44)
  9381,
  5357,
  389,
  2957,
  2740,
  9616
];

// Thresholds
const MAX_CHARGING = 2;           // Reduced to match RepairBay capacity
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
  const statuses: BotStatus[] = [];

  for (const tokenIndex of TARGET_BOTS) {
    try {
      const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });

      if (!result || !result.content || !result.content[0] || !result.content[0].text) {
        console.warn(`  ⚠️  Empty response for bot #${tokenIndex}`);
        continue;
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

      statuses.push({ tokenIndex, name, battery, condition, zone });
    } catch (error) {
      console.error(`  ✗ Failed to get status for bot #${tokenIndex}:`, error);
    }
  }

  return statuses;
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

    const actions: string[] = [];

    // Process each bot according to the flow
    console.log("── Processing bots ──");

    for (const bot of statuses) {
      const { tokenIndex, name, battery, condition, zone } = bot;
      const displayName = `#${tokenIndex} ${name}`;

      // 1. Condition < 70% → RepairBay
      if (condition < CONDITION_LOW) {
        if (zone !== "RepairBay") {
          console.log(`🔧 ${displayName}: Condition ${condition}% < ${CONDITION_LOW}% → RepairBay`);
          await moveBot(client, tokenIndex, "RepairBay");
          actions.push(`${displayName} → RepairBay`);
        } else {
          console.log(`🔧 ${displayName}: Repairing... (${condition}%)`);
        }
        continue;
      }

      // 2. Charging & Battery ≥ 95% → ScrapHeaps
      if (zone === "ChargingStation" && battery >= BATTERY_FULL) {
        console.log(`⛏️ ${displayName}: Charged to ${battery}% → ScrapHeaps`);
        await moveBot(client, tokenIndex, "ScrapHeaps");
        actions.push(`${displayName} → ScrapHeaps (charged)`);
        continue;
      }

      // 3. Charging → Continue
      if (zone === "ChargingStation") {
        console.log(`🔌 ${displayName}: Charging... (${battery}%)`);
        continue;
      }

      // 4. Repairing & Cond ≥ 95% & Battery ≥ 95% → ScrapHeaps
      if (zone === "RepairBay" && condition >= CONDITION_FULL && battery >= BATTERY_FULL) {
        console.log(`⛏️ ${displayName}: Repaired & charged → ScrapHeaps`);
        await moveBot(client, tokenIndex, "ScrapHeaps");
        actions.push(`${displayName} → ScrapHeaps (repaired)`);
        continue;
      }

      // 5. Repairing & Cond ≥ 95% & Battery < 95% → Charging
      if (zone === "RepairBay" && condition >= CONDITION_FULL && battery < BATTERY_FULL) {
        console.log(`🔌 ${displayName}: Repaired, battery ${battery}% → ChargingStation`);
        await moveBot(client, tokenIndex, "ChargingStation");
        actions.push(`${displayName} → ChargingStation (repaired)`);
        continue;
      }

      // 6. Repairing → Continue
      if (zone === "RepairBay") {
        console.log(`🔧 ${displayName}: Repairing... (${condition}%)`);
        continue;
      }

      // 7. Scavenging & Battery < 80% → Charging
      if (zone === "ScrapHeaps" && battery < BATTERY_LOW) {
        console.log(`🔌 ${displayName}: Battery ${battery}% < ${BATTERY_LOW}% → ChargingStation`);
        await moveBot(client, tokenIndex, "ChargingStation");
        actions.push(`${displayName} → ChargingStation (low battery)`);
        continue;
      }

      // 8. Scavenging → Continue
      if (zone === "ScrapHeaps") {
        console.log(`⛏️ ${displayName}: Scavenging... (${battery}%)`);
        continue;
      }

      // 9. Battery ≥ 95% → ScrapHeaps
      if (battery >= BATTERY_FULL) {
        console.log(`⛏️ ${displayName}: Battery ${battery}% → ScrapHeaps`);
        await moveBot(client, tokenIndex, "ScrapHeaps");
        actions.push(`${displayName} → ScrapHeaps`);
        continue;
      }

      // 10. Otherwise → Charging
      console.log(`🔌 ${displayName}: Battery ${battery}% → ChargingStation`);
      await moveBot(client, tokenIndex, "ChargingStation");
      actions.push(`${displayName} → ChargingStation`);
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
