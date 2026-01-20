/**
 * Team Daily Maintenance Batch
 *
 * Runs every 15 minutes to manage both Team A and Team B for Daily Sprint races.
 *
 * Team A: Races at 0:00, 12:00 UTC (9:00, 21:00 JST)
 * Team B: Races at 6:00, 18:00 UTC (15:00, 3:00 JST)
 *
 * Phases for each team:
 * - POST_RACE (0-1hr after race): RepairBay → ChargingStation
 * - SCAVENGING (1hr after ~ 1hr before next race): Scavenge with maintenance cycles
 * - PRE_RACE (1hr before race): Stop scavenging, maintain 100%/70%+, register
 *
 * Thresholds:
 * - RECOVERY_COMPLETE: Battery ≥95% AND Condition ≥95% → Start scavenging
 * - NEED_MAINTENANCE: Battery ≤80% OR Condition ≤70% → RepairBay → ChargingStation
 * - PRE_RACE: Battery = 100%, Condition ≥70%
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";
dotenv.config();

// Team definitions
const TEAM_A = {
  name: "Team A",
  raceHoursUTC: [0, 12], // 9:00, 21:00 JST
  bots: [433, 5143, 5136, 1315, 9943, 1203, 2630, 7098, 7486, 8313, 708, 1170, 1209, 8895, 9567, 5028, 2475, 7522, 1003, 3406, 8636, 8868, 9755]
};

const TEAM_B = {
  name: "Team B",
  raceHoursUTC: [6, 18], // 15:00, 3:00 JST
  bots: [2669, 5677, 8288, 6152, 820, 2441, 2632, 1866, 5414, 9888, 2985, 758, 3535, 9035, 9048, 7680, 8626, 5943, 7432, 406, 5400, 631, 2934]
};

// Thresholds
const BATTERY_FULL = 95;
const BATTERY_LOW = 80;
const CONDITION_FULL = 95;
const CONDITION_LOW = 70;

// Scavenging zone for earning parts
const SCAVENGE_ZONE = "ScrapHeaps";

type Phase = "POST_RACE" | "SCAVENGING" | "PRE_RACE";

interface BotStatus {
  id: number;
  name: string;
  battery: number;
  condition: number;
  location: string; // "ChargingStation", "RepairBay", "ScrapHeaps", etc.
  isScavenging: boolean;
}

function getPhaseForTeam(team: typeof TEAM_A, nowUTC: Date): { phase: Phase; nextRaceHour: number } {
  const currentHour = nowUTC.getUTCHours();
  const currentMinute = nowUTC.getUTCMinutes();
  const currentTimeInHours = currentHour + currentMinute / 60;

  // Find the next race hour
  let nextRaceHour = team.raceHoursUTC.find(h => h > currentTimeInHours);
  if (nextRaceHour === undefined) {
    // Wrap around to next day
    nextRaceHour = team.raceHoursUTC[0];
  }

  // Calculate hours until next race (accounting for day wrap)
  let hoursUntilRace = nextRaceHour - currentTimeInHours;
  if (hoursUntilRace < 0) {
    hoursUntilRace += 24;
  }

  // Find the previous race hour
  const sortedRaces = [...team.raceHoursUTC].sort((a, b) => a - b);
  let prevRaceHour = sortedRaces.filter(h => h <= currentTimeInHours).pop();
  if (prevRaceHour === undefined) {
    prevRaceHour = sortedRaces[sortedRaces.length - 1]; // Last race yesterday
  }

  // Calculate hours since last race
  let hoursSinceRace = currentTimeInHours - prevRaceHour;
  if (hoursSinceRace < 0) {
    hoursSinceRace += 24;
  }

  // Determine phase
  let phase: Phase;
  if (hoursSinceRace < 1) {
    phase = "POST_RACE";
  } else if (hoursUntilRace <= 1) {
    phase = "PRE_RACE";
  } else {
    phase = "SCAVENGING";
  }

  return { phase, nextRaceHour };
}

async function getBotStatus(client: PokedRaceMCPClient, botId: number): Promise<BotStatus | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: botId });
    const data = JSON.parse(result.content[0].text);

    let location = "Idle";
    let isScavenging = false;

    if (data.active_scavenging?.zone) {
      location = data.active_scavenging.zone;
      isScavenging = true;
    }

    return {
      id: botId,
      name: data.name || `Bot #${botId}`,
      battery: data.condition?.battery || 0,
      condition: data.condition?.condition || 0,
      location,
      isScavenging
    };
  } catch (e) {
    console.error(`Failed to get status for bot ${botId}:`, e);
    return null;
  }
}

async function retrieveBot(client: PokedRaceMCPClient, botId: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: botId });
    console.log(`  Retrieved bot ${botId}`);
    return true;
  } catch (e) {
    console.error(`  Failed to retrieve bot ${botId}:`, e);
    return false;
  }
}

async function sendToZone(client: PokedRaceMCPClient, botId: number, zone: string): Promise<boolean> {
  try {
    const result = await client.callTool("garage_start_scavenging", {
      token_index: botId,
      zone: zone
    });
    console.log(`  Sent bot ${botId} to ${zone}`);
    return true;
  } catch (e) {
    console.error(`  Failed to send bot ${botId} to ${zone}:`, e);
    return false;
  }
}

async function registerForRace(client: PokedRaceMCPClient, botId: number, raceHourUTC: number): Promise<boolean> {
  try {
    // Find the next Daily Sprint race at the specified hour
    const eventsResult = await client.callTool("racing_list_upcoming_events", {});
    const eventsData = JSON.parse(eventsResult.content[0].text);

    // Find Daily Sprint at the correct hour
    const targetRace = eventsData.events?.find((e: any) => {
      if (!e.event_type?.includes("DailySprint")) return false;
      const raceTime = new Date(e.start_time_utc);
      return raceTime.getUTCHours() === raceHourUTC;
    });

    if (!targetRace) {
      console.log(`  No Daily Sprint found at ${raceHourUTC}:00 UTC for bot ${botId}`);
      return false;
    }

    // Check if already registered
    const myRegsResult = await client.callTool("racing_get_my_registrations", {});
    const myRegsText = myRegsResult.content[0].text;

    if (myRegsText.includes(`#${botId}`) && myRegsText.includes(targetRace.event_id)) {
      console.log(`  Bot ${botId} already registered for race ${targetRace.event_id}`);
      return true;
    }

    // Register
    const regResult = await client.callTool("racing_register_for_event", {
      event_id: targetRace.event_id,
      token_index: botId
    });
    console.log(`  Registered bot ${botId} for Daily Sprint at ${raceHourUTC}:00 UTC`);
    return true;
  } catch (e) {
    console.error(`  Failed to register bot ${botId}:`, e);
    return false;
  }
}

async function processTeam(
  client: PokedRaceMCPClient,
  team: typeof TEAM_A,
  phase: Phase,
  nextRaceHour: number
): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Processing ${team.name} - Phase: ${phase}`);
  console.log(`Next race at ${nextRaceHour}:00 UTC`);
  console.log(`${"=".repeat(60)}`);

  for (const botId of team.bots) {
    const status = await getBotStatus(client, botId);
    if (!status) continue;

    console.log(`\n[${status.name} #${botId}] Battery: ${status.battery}%, Condition: ${status.condition}%, Location: ${status.location}`);

    switch (phase) {
      case "POST_RACE":
        // Priority: RepairBay first, then ChargingStation when condition OK
        if (status.condition < CONDITION_FULL) {
          if (status.location !== "RepairBay") {
            if (status.isScavenging) await retrieveBot(client, botId);
            await sendToZone(client, botId, "RepairBay");
          } else {
            console.log(`  Staying in RepairBay (condition ${status.condition}% < ${CONDITION_FULL}%)`);
          }
        } else if (status.battery < BATTERY_FULL) {
          if (status.location !== "ChargingStation") {
            if (status.isScavenging) await retrieveBot(client, botId);
            await sendToZone(client, botId, "ChargingStation");
          } else {
            console.log(`  Staying in ChargingStation (battery ${status.battery}% < ${BATTERY_FULL}%)`);
          }
        } else {
          // Both OK, ready for scavenging but still in POST_RACE phase
          console.log(`  Recovery complete, waiting for SCAVENGING phase`);
        }
        break;

      case "SCAVENGING":
        // Check if needs maintenance
        if (status.condition < CONDITION_LOW) {
          // Need repair first
          if (status.location !== "RepairBay") {
            if (status.isScavenging) await retrieveBot(client, botId);
            await sendToZone(client, botId, "RepairBay");
          } else {
            console.log(`  In RepairBay, waiting for condition to recover`);
          }
        } else if (status.battery <= BATTERY_LOW) {
          // Need charge
          if (status.location !== "ChargingStation") {
            if (status.isScavenging) await retrieveBot(client, botId);
            await sendToZone(client, botId, "ChargingStation");
          } else {
            console.log(`  In ChargingStation, waiting for battery to recover`);
          }
        } else if (status.battery >= BATTERY_FULL && status.condition >= CONDITION_FULL) {
          // Ready to scavenge
          if (status.location !== SCAVENGE_ZONE) {
            if (status.isScavenging && status.location !== SCAVENGE_ZONE) {
              await retrieveBot(client, botId);
            }
            if (!status.isScavenging || status.location !== SCAVENGE_ZONE) {
              await sendToZone(client, botId, SCAVENGE_ZONE);
            }
          } else {
            console.log(`  Scavenging in ${SCAVENGE_ZONE}`);
          }
        } else if (status.location === "RepairBay" && status.condition >= CONDITION_FULL) {
          // Repair done, move to charging
          await retrieveBot(client, botId);
          await sendToZone(client, botId, "ChargingStation");
        } else if (status.location === "ChargingStation" && status.battery >= BATTERY_FULL) {
          // Charge done, go scavenge
          await retrieveBot(client, botId);
          await sendToZone(client, botId, SCAVENGE_ZONE);
        } else {
          // In transition, keep current state
          console.log(`  Continuing current activity (battery ${status.battery}%, condition ${status.condition}%)`);
        }
        break;

      case "PRE_RACE":
        // Stop scavenging, ensure battery 100%, condition 70%+
        // Also register for race

        if (status.isScavenging && status.location !== "ChargingStation") {
          await retrieveBot(client, botId);
        }

        if (status.battery < 100) {
          if (status.location !== "ChargingStation") {
            await sendToZone(client, botId, "ChargingStation");
          } else {
            console.log(`  Charging to 100% (currently ${status.battery}%)`);
          }
        } else if (status.condition < CONDITION_LOW) {
          // Condition critically low, need repair
          if (status.location !== "RepairBay") {
            if (status.isScavenging) await retrieveBot(client, botId);
            await sendToZone(client, botId, "RepairBay");
          }
        } else {
          // Ready for race (will get paid repair at 10min before)
          console.log(`  Ready for race (battery ${status.battery}%, condition ${status.condition}%)`);

          // Register for race if battery is 100%
          if (status.battery >= 100) {
            await registerForRace(client, botId, nextRaceHour);
          }
        }
        break;
    }
  }
}

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(process.env.MCP_SERVER_URL!, process.env.MCP_API_KEY);

  const now = new Date();
  console.log(`\n${"#".repeat(70)}`);
  console.log(`Team Daily Maintenance - ${now.toISOString()}`);
  console.log(`${"#".repeat(70)}`);

  // Process Team A
  const teamAPhase = getPhaseForTeam(TEAM_A, now);
  await processTeam(client, TEAM_A, teamAPhase.phase, teamAPhase.nextRaceHour);

  // Process Team B
  const teamBPhase = getPhaseForTeam(TEAM_B, now);
  await processTeam(client, TEAM_B, teamBPhase.phase, teamBPhase.nextRaceHour);

  console.log(`\n${"#".repeat(70)}`);
  console.log(`Maintenance complete`);
  console.log(`${"#".repeat(70)}`);

  await client.close();
}

main().catch(console.error);
