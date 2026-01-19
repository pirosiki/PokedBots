/**
 * Auto-Scavenge V2 (Always keep 5 bots charging)
 *
 * Manages 15 bots with efficient charging rotation:
 * - Always maintain 5 bots in ChargingStation (100% efficiency)
 * - When charged (95%+), move to ScrapHeaps and fill slot with lowest battery bot
 * - Never let battery drop below 75%
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// Target bots (15 total)
const TARGET_BOTS = [
  9381, 5357, 389, 2957, 9716,  // Group A
  1722, 5597, 3586, 6790, 3606, // Group B
  8255, 8623, 6613, 359, 8603   // Group C
];

// Thresholds
const MAX_CHARGING = 5;           // Always keep 5 bots charging (100% efficiency)
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
    console.log("🤖  AUTO-SCAVENGE V2 (Always 5 charging)");
    console.log("🤖 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🎯 Managing ${TARGET_BOTS.length} bots\n`);

    // Get all bot statuses
    console.log("📊 Fetching bot statuses...");
    const statuses = await getBotStatuses(client);
    console.log(`✅ Got status for ${statuses.length}/${TARGET_BOTS.length} bots\n`);

    // Categorize bots
    const chargingBots = statuses.filter(s => s.zone === "ChargingStation");
    const repairingBots = statuses.filter(s => s.zone === "RepairBay");
    const scavengingBots = statuses.filter(s => s.zone === "ScrapHeaps");
    const idleBots = statuses.filter(s => s.zone === null);

    console.log("📈 Current Status:");
    console.log(`   Charging: ${chargingBots.length}/${MAX_CHARGING}`);
    console.log(`   Repairing: ${repairingBots.length}`);
    console.log(`   Scavenging: ${scavengingBots.length}`);
    console.log(`   Idle: ${idleBots.length}\n`);

    // Sort by battery (lowest first)
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

    const actions: string[] = [];
    let currentCharging = chargingBots.length;

    // Track which bots are now charging (for slot filling later)
    const nowCharging = new Set(chargingBots.map(b => b.tokenIndex));
    const processed = new Set<number>();

    // === PHASE 1: Handle repairs and charged bots ===
    console.log("── Phase 1: Handle repairs and charged bots ──");

    for (const bot of statuses) {
      const { tokenIndex, name, battery, condition, zone } = bot;
      const displayName = `#${tokenIndex} ${name}`;

      // Condition too low → RepairBay
      if (condition < CONDITION_LOW && zone !== "RepairBay") {
        console.log(`🔧 ${displayName}: Condition ${condition}% low → RepairBay`);
        await moveBot(client, tokenIndex, "RepairBay");
        if (zone === "ChargingStation") {
          currentCharging--;
          nowCharging.delete(tokenIndex);
        }
        actions.push(`${displayName} → RepairBay`);
        processed.add(tokenIndex);
        continue;
      }

      // Currently charging and full → ScrapHeaps
      if (zone === "ChargingStation" && battery >= BATTERY_FULL) {
        console.log(`⛏️ ${displayName}: Charged to ${battery}%! → ScrapHeaps`);
        await moveBot(client, tokenIndex, "ScrapHeaps");
        currentCharging--;
        nowCharging.delete(tokenIndex);
        actions.push(`${displayName} → ScrapHeaps (charged)`);
        processed.add(tokenIndex);
        continue;
      }

      // Currently charging but not full → stay
      if (zone === "ChargingStation") {
        console.log(`🔌 ${displayName}: Charging... (${battery}%)`);
        processed.add(tokenIndex);
        continue;
      }

      // Currently repairing
      if (zone === "RepairBay") {
        if (condition >= BATTERY_FULL) {
          // Repaired! Will be handled in phase 2
          console.log(`✅ ${displayName}: Repair complete (${condition}%)`);
        } else {
          console.log(`🔧 ${displayName}: Repairing... (${condition}%)`);
          processed.add(tokenIndex);
        }
        continue;
      }
    }

    // === PHASE 2: Fill charging slots to maintain 5 ===
    console.log("\n── Phase 2: Fill charging slots ──");

    // Get candidates for charging (not already charging, not repairing, battery < 95%)
    const chargeCandidates = statuses
      .filter(b => !processed.has(b.tokenIndex))
      .filter(b => !nowCharging.has(b.tokenIndex))
      .filter(b => b.zone !== "RepairBay" || b.condition >= BATTERY_FULL) // Allow repaired bots
      .filter(b => b.battery < BATTERY_FULL)
      .sort((a, b) => a.battery - b.battery); // Lowest battery first

    const slotsToFill = MAX_CHARGING - currentCharging;

    if (slotsToFill > 0 && chargeCandidates.length > 0) {
      console.log(`   Need to fill ${slotsToFill} charging slot(s)`);

      for (let i = 0; i < Math.min(slotsToFill, chargeCandidates.length); i++) {
        const bot = chargeCandidates[i];
        const displayName = `#${bot.tokenIndex} ${bot.name}`;

        console.log(`🔌 ${displayName}: Battery ${bot.battery}% → ChargingStation`);
        await moveBot(client, bot.tokenIndex, "ChargingStation");
        currentCharging++;
        nowCharging.add(bot.tokenIndex);
        actions.push(`${displayName} → ChargingStation`);
        processed.add(bot.tokenIndex);
      }
    } else if (slotsToFill > 0) {
      console.log(`   ${slotsToFill} slot(s) available but all bots are fully charged!`);
    } else {
      console.log(`   Charging slots full (${currentCharging}/${MAX_CHARGING})`);
    }

    // === PHASE 3: Send high-battery bots to scavenge ===
    console.log("\n── Phase 3: Send high-battery bots to scavenge ──");

    const remainingBots = statuses.filter(b => !processed.has(b.tokenIndex));

    for (const bot of remainingBots) {
      const { tokenIndex, name, battery, zone } = bot;
      const displayName = `#${tokenIndex} ${name}`;

      // Only send to ScrapHeaps if battery is 95% or higher
      if (battery >= BATTERY_FULL) {
        if (zone !== "ScrapHeaps") {
          console.log(`⛏️ ${displayName}: Battery ${battery}% → ScrapHeaps`);
          await moveBot(client, tokenIndex, "ScrapHeaps");
          actions.push(`${displayName} → ScrapHeaps`);
        } else {
          console.log(`⛏️ ${displayName}: Already scavenging (${battery}%)`);
        }
      } else {
        // Low battery - move to ChargingStation (even if >5, efficiency just drops)
        if (zone !== "ChargingStation") {
          console.log(`🔌 ${displayName}: Battery ${battery}% → ChargingStation (waiting)`);
          await moveBot(client, tokenIndex, "ChargingStation");
          actions.push(`${displayName} → ChargingStation`);
        } else {
          console.log(`🔌 ${displayName}: Charging... (${battery}%)`);
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

    console.log(`\n✅ Complete - Charging: ${currentCharging}/${MAX_CHARGING}`);
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
