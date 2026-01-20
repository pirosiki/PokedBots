/**
 * Team Daily Pre-Race Batch
 *
 * Runs 10 minutes before each Daily Sprint race.
 * Performs PAID REPAIR to get condition to 100% for Perfect Tune.
 *
 * Race times (UTC):
 * - 0:00 (Team A) → runs at 23:50
 * - 6:00 (Team B) → runs at 5:50
 * - 12:00 (Team A) → runs at 11:50
 * - 18:00 (Team B) → runs at 17:50
 *
 * Cron: 50 5,11,17,23 * * *
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";
dotenv.config();

// Team definitions
const TEAM_A = {
  name: "Team A",
  raceHoursUTC: [0, 12],
  bots: [433, 5143, 5136, 1315, 9943, 1203, 2630, 7098, 7486, 8313, 708, 1170, 1209, 8895, 9567, 5028, 2475, 7522, 1003, 3406, 8636, 8868, 9755]
};

const TEAM_B = {
  name: "Team B",
  raceHoursUTC: [6, 18],
  bots: [2669, 5677, 8288, 6152, 820, 2441, 2632, 1866, 5414, 9888, 2985, 758, 3535, 9035, 9048, 7680, 8626, 5943, 7432, 406, 5400, 631, 2934]
};

function getTargetTeam(nowUTC: Date): typeof TEAM_A | null {
  const currentHour = nowUTC.getUTCHours();
  const currentMinute = nowUTC.getUTCMinutes();

  // This runs at X:50, so the race is at (X+1):00
  // But handle the 23:50 → 0:00 case
  const nextRaceHour = (currentHour + 1) % 24;

  if (TEAM_A.raceHoursUTC.includes(nextRaceHour)) {
    return TEAM_A;
  } else if (TEAM_B.raceHoursUTC.includes(nextRaceHour)) {
    return TEAM_B;
  }

  return null;
}

async function getBotStatus(client: PokedRaceMCPClient, botId: number): Promise<{ battery: number; condition: number; name: string; isScavenging: boolean } | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: botId });
    const data = JSON.parse(result.content[0].text);

    return {
      name: data.name || `Bot #${botId}`,
      battery: data.condition?.battery || 0,
      condition: data.condition?.condition || 0,
      isScavenging: !!data.active_scavenging?.zone
    };
  } catch (e) {
    console.error(`Failed to get status for bot ${botId}:`, e);
    return null;
  }
}

async function retrieveBot(client: PokedRaceMCPClient, botId: number): Promise<boolean> {
  try {
    await client.callTool("garage_complete_scavenging", { token_index: botId });
    console.log(`  Retrieved bot ${botId}`);
    return true;
  } catch (e) {
    return false;
  }
}

async function paidRecharge(client: PokedRaceMCPClient, botId: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_recharge_robot", { token_index: botId });
    console.log(`  Paid recharge for bot ${botId}`);
    return true;
  } catch (e) {
    console.error(`  Failed paid recharge for bot ${botId}:`, e);
    return false;
  }
}

async function paidRepair(client: PokedRaceMCPClient, botId: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_repair_robot", { token_index: botId });
    console.log(`  Paid repair for bot ${botId} (Perfect Tune!)`);
    return true;
  } catch (e) {
    console.error(`  Failed paid repair for bot ${botId}:`, e);
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(process.env.MCP_SERVER_URL!, process.env.MCP_API_KEY);

  const now = new Date();
  console.log(`\n${"#".repeat(70)}`);
  console.log(`Team Daily Pre-Race (Paid Repair) - ${now.toISOString()}`);
  console.log(`${"#".repeat(70)}`);

  const targetTeam = getTargetTeam(now);

  if (!targetTeam) {
    console.log("No team racing in 10 minutes. Exiting.");
    await client.close();
    return;
  }

  const nextRaceHour = (now.getUTCHours() + 1) % 24;
  console.log(`\nTarget: ${targetTeam.name}`);
  console.log(`Race at ${nextRaceHour}:00 UTC`);
  console.log(`Bots: ${targetTeam.bots.length}`);

  let rechargeCount = 0;
  let repairCount = 0;
  let alreadyReadyCount = 0;

  for (const botId of targetTeam.bots) {
    const status = await getBotStatus(client, botId);
    if (!status) continue;

    console.log(`\n[${status.name} #${botId}] Battery: ${status.battery}%, Condition: ${status.condition}%`);

    // Phase 0: Retrieve if scavenging
    if (status.isScavenging) {
      await retrieveBot(client, botId);
    }

    // Phase 1: Paid recharge if battery < 100% (fallback, should already be 100%)
    if (status.battery < 100) {
      console.log(`  WARNING: Battery not 100% (${status.battery}%), doing paid recharge`);
      await paidRecharge(client, botId);
      rechargeCount++;
    }

    // Phase 2: Paid repair if condition < 100%
    // This is the main purpose - Perfect Tune
    if (status.condition < 100) {
      await paidRepair(client, botId);
      repairCount++;
    } else {
      console.log(`  Already at 100% condition, skipping paid repair`);
      alreadyReadyCount++;
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Summary:`);
  console.log(`  Paid recharges: ${rechargeCount}`);
  console.log(`  Paid repairs: ${repairCount}`);
  console.log(`  Already ready: ${alreadyReadyCount}`);
  console.log(`${"=".repeat(70)}`);

  await client.close();
}

main().catch(console.error);
