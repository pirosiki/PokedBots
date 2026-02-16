
/**
 * Auto Race Prep & Registration (T-2h)
 *
 * Runs 2 hours before race.
 * 1. Selects 8 racers (2 per class) based on Terrain/WB.
 * 2. Manages RepairBay queue (5 slots) for these 8 bots.
 * 3. EXECUTES PERFECT TUNE SEQUENCE:
 *    a. Paid Charge (to 100%)
 *    b. Jolt (Overcharge > 100%) - Requires Battery Item
 *    c. Paid Repair (Perfect Tune if within resonance)
 * 4. Registers bot once ready.
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// ── ROSTER (Hardcoded for 1st Army) ──
interface RosterEntry {
  tokenIndex: number;
  name: string;
  terrain: string; // "MetalRoads", "ScrapHeaps", "WastelandSand"
  role: "regular" | "bh_backup" | "oshi";
}

const ROSTER: Record<string, RosterEntry[]> = {
  Elite: [
    { tokenIndex: 9943, name: "Ged", terrain: "MetalRoads", role: "regular" },
    { tokenIndex: 7486, name: "Ryo", terrain: "MetalRoads", role: "bh_backup" },
    { tokenIndex: 5677, name: "Usagi", terrain: "MetalRoads", role: "oshi" },
    { tokenIndex: 2669, name: "Bach", terrain: "ScrapHeaps", role: "regular" },
    { tokenIndex: 1315, name: "StraySheep", terrain: "WastelandSand", role: "regular" },
    { tokenIndex: 5136, name: "うさぎ", terrain: "WastelandSand", role: "oshi" },
  ],
  Raider: [
    { tokenIndex: 8313, name: "Bot8313", terrain: "MetalRoads", role: "regular" },
    { tokenIndex: 820, name: "Nadia", terrain: "MetalRoads", role: "bh_backup" },
    { tokenIndex: 5028, name: "東西線", terrain: "ScrapHeaps", role: "regular" },
    { tokenIndex: 8895, name: "Papuwa", terrain: "WastelandSand", role: "regular" },
  ],
  Junker: [
    { tokenIndex: 3535, name: "G-Max", terrain: "MetalRoads", role: "regular" },
    { tokenIndex: 1722, name: "Bot1722", terrain: "ScrapHeaps", role: "regular" },
    { tokenIndex: 3674, name: "Bot3674", terrain: "WastelandSand", role: "regular" },
  ],
  Scrap: [
    { tokenIndex: 3406, name: "Chiikawa", terrain: "MetalRoads", role: "regular" },
    { tokenIndex: 631, name: "厚切り牛タン", terrain: "ScrapHeaps", role: "regular" },
    { tokenIndex: 406, name: "Noir", terrain: "WastelandSand", role: "regular" },
  ],
};

const MAX_REPAIR_BAY = 5;

// ── UTILS ──

function normalizeTerrain(apiTerrain: string): string {
  return apiTerrain.replace(/\s+/g, "");
}

async function getUpcomingEvents(client: PokedRaceMCPClient) {
  const result = await client.callTool("racing_list_events", {});
  if (!result || !result.content || !result.content[0]) return [];

  const text = result.content[0].text;
  const events = [];

  // Regex parsing for text output:
  // **Event #123**: Name
  // 📅 Start: 2024-...
  // 🏁 Races: #111, 112

  const blocks = text.split('---');
  const now = new Date();

  for (const block of blocks) {
    const idMatch = block.match(/\*\*Event #(\d+)\*\*/);
    const startMatch = block.match(/📅 Start:\s*([\d\-:TZ]+)/);
    const raceMatch = block.match(/🏁 Races:\s*#([\d,\s]+)/);

    if (idMatch && startMatch) {
      const id = parseInt(idMatch[1]);
      const startTime = new Date(startMatch[1]);
      const minUntil = (startTime.getTime() - now.getTime()) / 60000;

      // Filter: Only events starting in 10-180 mins (3h window to be safe)
      if (minUntil > 10 && minUntil < 180) {
        const raceIds = raceMatch ? raceMatch[1].split(',').map(s => parseInt(s.trim())) : [];
        events.push({ id, startTime, minUntil, raceIds });
      }
    }
  }
  return events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

async function getRaceTerrains(client: PokedRaceMCPClient, raceIds: number[]) {
  const terrains = new Set<string>();
  for (const rid of raceIds) {
    try {
      const res = await client.callTool("racing_get_race_details", { race_id: rid });
      const data = JSON.parse(res.content[0].text);
      if (data.terrain) terrains.add(normalizeTerrain(data.terrain));
    } catch (e) { }
  }
  return Array.from(terrains);
}

async function getBotDetails(client: PokedRaceMCPClient, tokenIndex: number) {
  try {
    const res = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    return JSON.parse(res.content[0].text);
  } catch { return null; }
}

async function getBatteries(client: PokedRaceMCPClient) {
  try {
    const res = await client.callTool("garage_list_batteries", {});
    const text = res.content[0].text;
    // Text format often includes headers. Fallback to extracting ID if JSON fails.
    // Assuming JSON array structure if valid.
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return data;
    } catch (e) { }

    // Regex fallback
    const matches = [...text.matchAll(/#(\d+)/g)]; // Battery #123?
    return matches.map(m => ({ id: parseInt(m[1]), charge: 100 })); // Dummy charge
  } catch { return []; }
}

// ── ACTIONS ──

async function recallBot(client: PokedRaceMCPClient, index: number) {
  console.log(`   📥 Recalling #${index}...`);
  await client.callTool("garage_complete_scavenging", { token_index: index });
}

async function sendToRepairBay(client: PokedRaceMCPClient, index: number) {
  console.log(`   🔧 Sending #${index} to RepairBay...`);
  const res = await client.callTool("garage_start_scavenging", { token_index: index, zone: "RepairBay" });
  if (res.isError) console.log(`      Failed: ${res.content[0].text}`);
}

async function sendToIdle(client: PokedRaceMCPClient, index: number) {
  console.log(`   🏃 Freeing slot (Idle) #${index}...`);
  await client.callTool("garage_complete_scavenging", { token_index: index });
}

async function paidCharge(client: PokedRaceMCPClient, index: number) {
  console.log(`   💰 Charging #${index} (Paid)...`);
  const res = await client.callTool("garage_recharge_robot", { token_index: index });
  if (res.isError) console.log(`      Error: ${res.content[0].text}`);
  return !res.isError;
}

async function paidRepair(client: PokedRaceMCPClient, index: number) {
  console.log(`   💰 Repairing #${index} (Paid - Perfect Tune)...`);
  const res = await client.callTool("garage_repair_robot", { token_index: index });
  if (res.isError) console.log(`      Error: ${res.content[0].text}`);
  return !res.isError;
}

async function joltBot(client: PokedRaceMCPClient, index: number, batteryId: number) {
  console.log(`   ⚡ Jolting #${index} with Bat #${batteryId}...`);
  const res = await client.callTool("garage_jolt_bot", { token_index: index, battery_id: batteryId });
  if (res.isError) console.log(`      Error: ${res.content[0].text}`);
  return !res.isError;
}

async function registerBot(client: PokedRaceMCPClient, eventId: number, index: number) {
  console.log(`   📝 Registering #${index}...`);
  const res = await client.callTool("racing_register_for_event", { event_id: eventId, token_index: index });
  if (res.isError) console.log(`      Error: ${res.content[0].text}`);
  else console.log(`      ✅ Success!`);
  return !res.isError;
}

// ── MAIN LOGIC ──

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  console.log("🏁 AUTO RACE PREP (T-2h)");

  // 1. Find Events
  const events = await getUpcomingEvents(client);
  if (events.length === 0) {
    console.log("No events in target window (10-180m).");
    await client.close();
    return;
  }

  // Pick first event
  const targetEvent = events[0];
  console.log(`🎯 Target Event #${targetEvent.id} (Starts in ${Math.floor(targetEvent.minUntil)}m)`);

  const terrains = await getRaceTerrains(client, targetEvent.raceIds);
  console.log(`   Terrains: ${terrains.join(', ')}`);

  // 2. Select Racers (2 per class for efficiency logic)
  const selectedRacers: RosterEntry[] = [];
  const classes = ["Elite", "Raider", "Junker", "Scrap"];

  for (const cls of classes) {
    const roster = ROSTER[cls] || [];
    // Filter by terrain
    const candidates = roster.filter(b => terrains.includes(b.terrain));
    // Add up to 2
    selectedRacers.push(...candidates.slice(0, 2));
  }

  console.log(`📋 Selected ${selectedRacers.length} Racers: ${selectedRacers.map(r => r.name).join(', ')}`);

  if (selectedRacers.length === 0) {
    console.log("No racers match terrain.");
    await client.close();
    return;
  }

  // 3. Process each racer
  const batteries = await getBatteries(client);
  const batteryId = batteries.length > 0 ? batteries[0].id : null;
  if (!batteryId) console.log("⚠️ No batteries found for Jolt!");

  for (const racer of selectedRacers) {
    console.log(`\n🤖 Processing #${racer.tokenIndex} (${racer.name})...`);

    const details = await getBotDetails(client, racer.tokenIndex);
    if (!details) {
      console.log("   Failed to get details.");
      continue;
    }

    const bat = details.condition?.battery || 0;
    const cond = details.condition?.condition || 0;
    const zone = details.active_scavenging?.zone;

    console.log(`   Status: Bat=${bat}% Cond=${cond}% Zone=${zone || "Idle"}`);

    // Step A: Recall if Scavenging elsewhere
    if (zone && zone !== "RepairBay" && zone !== "ChargingStation") {
      await recallBot(client, racer.tokenIndex);
      // Wait a bit
      await new Promise(r => setTimeout(r, 1000));
      // Need to re-fetch details? Assuming recall worked.
    }

    // Step B: RepairBay Wait (cond < 70)
    if (cond < 70) {
      if (zone !== "RepairBay") {
        await sendToRepairBay(client, racer.tokenIndex);
        // If fails (full), we should eject someone?
        // TODO: Implement Eject logic if needed. For now log error.
      } else {
        console.log("   Waiting in RepairBay (Passive)...");
      }
      // Do not proceed to expensive steps if condition is low
      continue;
    }

    // Step C: Paid Charge (to 100%)
    if (bat < 100) {
      await paidCharge(client, racer.tokenIndex);
      // Update local state assumption: Bat = 100+
      // Re-fetch to be sure?
      const d2 = await getBotDetails(client, racer.tokenIndex);
      if (d2.condition.battery < 100) {
        console.log("   Charge failed or insufficient? Retrying/Ignoring...");
      }
    }

    // Step D: Jolt (Overcharge)
    // Check again if bat >= 100
    const afterCharge = await getBotDetails(client, racer.tokenIndex);
    const currentBat = afterCharge.condition.battery;

    if (currentBat >= 100 && batteryId) {
      // Check if already overcharged? Assuming 100 exactly means "Full but not overcharged" 
      // or user wants to PUSH it.
      // User said: "Paid Charge -> Jolt -> Paid Repair".
      // We Jolt now.
      await joltBot(client, racer.tokenIndex, batteryId);
    }

    // Step E: Paid Repair (Perfect Tune)
    // Trigger regardless of condition? 
    // User: "Paid Repair -> Perfect Tune".
    // Perfect Tune removes penalties.
    await paidRepair(client, racer.tokenIndex);

    // Step F: Register
    await registerBot(client, targetEvent.id, racer.tokenIndex);

    // Step G: Free Slot (if in RepairBay)
    // If everything done, move to Idle?
    if (zone === "RepairBay") {
      await sendToIdle(client, racer.tokenIndex);
    }
  }

  await client.close();
}

main();
