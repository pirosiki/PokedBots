/**
 * Auto-Scavenge V2 (Optimized for 5-bot charging limit)
 *
 * Manages 15 bots with efficient charging rotation:
 * - Max 5 bots in ChargingStation at once
 * - Priority-based charging (lowest battery first)
 * - Never let battery drop below 75%
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// Target bots (14 total - #9581 excluded as not registered)
const TARGET_BOTS = [
  5357, 389, 2957, 9716,        // Group A (9581 excluded)
  1722, 5597, 3586, 6790, 3606, // Group B
  8255, 8623, 6613, 359, 8603   // Group C
];

// Thresholds
const MAX_CHARGING = 5;           // Max bots in ChargingStation
const BATTERY_CRITICAL = 75;      // Must stop and wait for charging
const BATTERY_NEED_CHARGE = 80;   // Should enter ChargingStation
const BATTERY_FULL = 95;          // Ready to scavenge
const CONDITION_LOW = 80;         // Need repair

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
        return true; // Already not scavenging
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
        return true; // Already scavenging
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
    console.log("🤖  AUTO-SCAVENGE V2 (5-bot charging limit)");
    console.log("🤖 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🎯 Managing ${TARGET_BOTS.length} bots\n`);

    // Get all bot statuses
    console.log("📊 Fetching bot statuses...");
    const statuses = await getBotStatuses(client);
    console.log(`✅ Got status for ${statuses.length}/${TARGET_BOTS.length} bots\n`);

    // Count bots currently charging
    const chargingBots = statuses.filter(s => s.zone === "ChargingStation");
    const repairingBots = statuses.filter(s => s.zone === "RepairBay");
    const scavengingBots = statuses.filter(s => s.zone === "ScrapHeaps");
    const idleBots = statuses.filter(s => s.zone === null);

    console.log("📈 Current Status:");
    console.log(`   Charging: ${chargingBots.length}/${MAX_CHARGING}`);
    console.log(`   Repairing: ${repairingBots.length}`);
    console.log(`   Scavenging: ${scavengingBots.length}`);
    console.log(`   Idle: ${idleBots.length}\n`);

    // Sort by battery (lowest first) for priority charging
    const sortedByBattery = [...statuses].sort((a, b) => a.battery - b.battery);

    // Display all bots
    console.log("🔋 Bot Status (sorted by battery):");
    for (const bot of sortedByBattery) {
      const zoneIcon = bot.zone === "ChargingStation" ? "🔌" :
                       bot.zone === "RepairBay" ? "🔧" :
                       bot.zone === "ScrapHeaps" ? "⛏️" : "💤";
      console.log(`   ${zoneIcon} #${bot.tokenIndex} ${bot.name}: Battery=${bot.battery}%, Condition=${bot.condition}%, Zone=${bot.zone || "None"}`);
    }
    console.log("");

    // Process each bot
    let currentCharging = chargingBots.length;
    const actions: string[] = [];

    for (const bot of sortedByBattery) {
      const { tokenIndex, name, battery, condition, zone } = bot;
      const displayName = `#${tokenIndex} ${name}`;

      // Priority 1: Condition too low → RepairBay (unlimited)
      if (condition < CONDITION_LOW && zone !== "RepairBay") {
        console.log(`🔧 ${displayName}: Condition ${condition}% low → RepairBay`);
        await moveBot(client, tokenIndex, "RepairBay");
        if (zone === "ChargingStation") currentCharging--;
        actions.push(`${displayName} → RepairBay`);
        continue;
      }

      // Priority 2: Currently charging, check if done
      if (zone === "ChargingStation") {
        if (battery >= BATTERY_FULL) {
          if (condition < CONDITION_LOW) {
            console.log(`🔧 ${displayName}: Charged! But condition ${condition}% → RepairBay`);
            await moveBot(client, tokenIndex, "RepairBay");
            currentCharging--;
            actions.push(`${displayName} → RepairBay`);
          } else {
            console.log(`⛏️ ${displayName}: Charged to ${battery}%! → ScrapHeaps`);
            await moveBot(client, tokenIndex, "ScrapHeaps");
            currentCharging--;
            actions.push(`${displayName} → ScrapHeaps`);
          }
        } else {
          console.log(`🔌 ${displayName}: Charging... (${battery}%)`);
        }
        continue;
      }

      // Priority 3: Currently repairing, check if done
      if (zone === "RepairBay") {
        if (condition >= BATTERY_FULL) {
          if (battery < BATTERY_NEED_CHARGE && currentCharging < MAX_CHARGING) {
            console.log(`🔌 ${displayName}: Repaired! Battery ${battery}% → ChargingStation`);
            await moveBot(client, tokenIndex, "ChargingStation");
            currentCharging++;
            actions.push(`${displayName} → ChargingStation`);
          } else if (battery >= BATTERY_FULL) {
            console.log(`⛏️ ${displayName}: Repaired! Battery ${battery}% → ScrapHeaps`);
            await moveBot(client, tokenIndex, "ScrapHeaps");
            actions.push(`${displayName} → ScrapHeaps`);
          } else {
            console.log(`⏳ ${displayName}: Repaired but waiting for charging slot (${battery}%)`);
          }
        } else {
          console.log(`🔧 ${displayName}: Repairing... (${condition}%)`);
        }
        continue;
      }

      // Priority 4: Battery critical - MUST charge (or wait)
      if (battery <= BATTERY_CRITICAL) {
        if (currentCharging < MAX_CHARGING) {
          console.log(`🔌 ${displayName}: Battery CRITICAL ${battery}%! → ChargingStation`);
          await moveBot(client, tokenIndex, "ChargingStation");
          currentCharging++;
          actions.push(`${displayName} → ChargingStation (CRITICAL)`);
        } else {
          // Stop scavenging and wait
          if (zone !== null) {
            console.log(`⚠️ ${displayName}: Battery CRITICAL ${battery}%! Stopping to wait for charging slot`);
            await completeScavenging(client, tokenIndex);
            actions.push(`${displayName} → WAIT (charging full)`);
          } else {
            console.log(`⏳ ${displayName}: Waiting for charging slot (${battery}%)`);
          }
        }
        continue;
      }

      // Priority 5: Battery needs charging (but not critical)
      if (battery <= BATTERY_NEED_CHARGE) {
        if (currentCharging < MAX_CHARGING) {
          console.log(`🔌 ${displayName}: Battery ${battery}% low → ChargingStation`);
          await moveBot(client, tokenIndex, "ChargingStation");
          currentCharging++;
          actions.push(`${displayName} → ChargingStation`);
        } else {
          // Continue scavenging until critical
          if (zone !== "ScrapHeaps") {
            console.log(`⛏️ ${displayName}: Battery ${battery}% low but charging full → ScrapHeaps (until critical)`);
            await moveBot(client, tokenIndex, "ScrapHeaps");
            actions.push(`${displayName} → ScrapHeaps (waiting)`);
          } else {
            console.log(`⛏️ ${displayName}: Scavenging (${battery}%, waiting for charging slot)`);
          }
        }
        continue;
      }

      // Priority 6: Good battery - scavenge
      if (zone !== "ScrapHeaps") {
        console.log(`⛏️ ${displayName}: Battery ${battery}% OK → ScrapHeaps`);
        await moveBot(client, tokenIndex, "ScrapHeaps");
        actions.push(`${displayName} → ScrapHeaps`);
      } else {
        console.log(`⛏️ ${displayName}: Scavenging (${battery}%)`);
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

    console.log(`\n✅ Complete - Charging: ${currentCharging}/${MAX_CHARGING}`);
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
