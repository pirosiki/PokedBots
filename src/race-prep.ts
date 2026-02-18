/**
 * Race Prep (T-2h)
 *
 * Daily Sprintの2時間前に実行:
 *   1. イベント取得 → 地形取得（フォールバック付き）
 *   2. 出走体選出（各Tier × 地形ごとの上限で選出）
 *   3. recall → RepairBay(Cond>=70まで待機) → 有料Charge → Jolt(100%まで) → 有料Repair → 登録
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import { ROSTER, type BotEntry } from "./roster.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL =
  process.env.MCP_SERVER_URL ||
  "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// --- Terrain fallback ---

const TERRAIN_PAIRS: [string, string][] = [
  ["ScrapHeaps", "WastelandSand"],
  ["WastelandSand", "MetalRoads"],
  ["MetalRoads", "ScrapHeaps"],
];

const TIER_ORDER = ["Elite", "Raider", "Junker", "Scrap"] as const;
const TERRAIN_ORDER: BotEntry["terrain"][] = [
  "MetalRoads",
  "WastelandSand",
  "ScrapHeaps",
];
const BASE_PER_TERRAIN_LIMIT = 1;
const PER_TERRAIN_LIMITS: Record<
  string,
  Partial<Record<BotEntry["terrain"], number>>
> = {
  Elite: { MetalRoads: 2, ScrapHeaps: 2 },
  Raider: { MetalRoads: 2 },
  Junker: { MetalRoads: 2 },
  Scrap: { ScrapHeaps: 2 },
};
const MIN_CONDITION_BEFORE_PAID_REPAIR = 70;
const REPAIR_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const REGISTRATION_BUFFER_MINUTES = 15;

function predictTerrains(raceTimeUTC: Date): string[] {
  const totalSec = Math.floor(raceTimeUTC.getTime() / 1000);
  const secInDay = totalSec % 86400;
  const slot = Math.floor(secInDay / 21600); // 0-3
  const day = Math.floor(totalSec / 86400);
  const pair = (slot + day) % 3;
  return [...TERRAIN_PAIRS[pair]];
}

function normalizeTerrain(t: string): string {
  return t.replace(/\s+/g, "");
}

function isRosterTerrain(terrain: string): terrain is BotEntry["terrain"] {
  return TERRAIN_ORDER.includes(terrain as BotEntry["terrain"]);
}

// --- Event discovery ---

interface EventInfo {
  id: number;
  startTime: Date;
  minUntil: number;
  raceIds: number[];
}

async function getUpcomingEvents(
  client: PokedRaceMCPClient
): Promise<EventInfo[]> {
  const result = await client.callTool("racing_list_events", {});
  if (!result?.content?.[0]?.text) return [];

  const text = result.content[0].text;
  const blocks = text.split("---");
  const now = new Date();
  const events: EventInfo[] = [];

  for (const block of blocks) {
    const idMatch = block.match(/\*\*Event #(\d+)\*\*/);
    const startMatch = block.match(/📅 Start:\s*([\d\-:TZ]+)/);
    const raceMatch = block.match(/🏁 Races:\s*#([\d,\s]+)/);

    if (idMatch && startMatch) {
      const id = parseInt(idMatch[1]);
      const startTime = new Date(startMatch[1]);
      const minUntil = (startTime.getTime() - now.getTime()) / 60000;

      if (minUntil > 10 && minUntil < 180) {
        const raceIds = raceMatch
          ? raceMatch[1].split(",").map((s: string) => parseInt(s.trim()))
          : [];
        events.push({ id, startTime, minUntil, raceIds });
      }
    }
  }

  return events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

async function getRaceTerrains(
  client: PokedRaceMCPClient,
  raceIds: number[]
): Promise<string[]> {
  const terrains = new Set<string>();
  for (const rid of raceIds) {
    try {
      const res = await client.callTool("racing_get_race_details", {
        race_id: rid,
      });
      const data = JSON.parse(res.content[0].text);
      if (data.terrain) terrains.add(normalizeTerrain(data.terrain));
    } catch {}
  }
  return [...terrains];
}

// --- Bot actions ---

async function getBotDetails(client: PokedRaceMCPClient, token: number) {
  try {
    const res = await client.callTool("garage_get_robot_details", {
      token_index: token,
    });
    return JSON.parse(res.content[0].text);
  } catch {
    return null;
  }
}

async function recall(client: PokedRaceMCPClient, token: number) {
  try {
    await client.callTool("garage_complete_scavenging", {
      token_index: token,
    });
  } catch {}
}

async function sendToRepairBay(client: PokedRaceMCPClient, token: number) {
  console.log(`   🔧 → RepairBay #${token}`);
  try {
    await client.callTool("garage_start_scavenging", {
      token_index: token,
      zone: "RepairBay",
    });
  } catch (e: any) {
    console.error(`   Failed: ${e.message}`);
  }
}

async function waitForConditionRecovery(
  client: PokedRaceMCPClient,
  token: number,
  targetCondition: number,
  deadlineMs: number
): Promise<{ reached: boolean; latestCondition: number }> {
  let latestCondition = 0;

  await sendToRepairBay(client, token);
  await new Promise((r) => setTimeout(r, 1000));

  while (Date.now() < deadlineMs) {
    const details = await getBotDetails(client, token);
    latestCondition = details?.condition?.condition ?? latestCondition;
    const zone = details?.active_scavenging?.zone;
    const isScavenging = !!details?.active_scavenging?.status?.includes("Active");

    if (latestCondition >= targetCondition) {
      return { reached: true, latestCondition };
    }

    // Keep bot in RepairBay while waiting for passive recovery.
    if (!(isScavenging && zone === "RepairBay")) {
      await sendToRepairBay(client, token);
      await new Promise((r) => setTimeout(r, 1000));
    }

    const waitMs = Math.min(
      REPAIR_CHECK_INTERVAL_MS,
      Math.max(0, deadlineMs - Date.now())
    );
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  const finalDetails = await getBotDetails(client, token);
  latestCondition = finalDetails?.condition?.condition ?? latestCondition;
  return { reached: latestCondition >= targetCondition, latestCondition };
}

async function paidCharge(client: PokedRaceMCPClient, token: number) {
  console.log(`   💰 Charge #${token}`);
  try {
    await client.callTool("garage_recharge_robot", { token_index: token });
  } catch (e: any) {
    console.error(`   Charge failed: ${e.message}`);
  }
}

async function joltBot(
  client: PokedRaceMCPClient,
  token: number,
  batteryId: number
): Promise<{
  ok: boolean;
  newBatteryLevel?: number;
  overheated?: boolean;
  error?: string;
}> {
  console.log(`   ⚡ Jolt #${token} with Battery #${batteryId}`);
  try {
    const res = await client.callTool("garage_jolt_bot", {
      token_index: token,
      battery_id: batteryId,
    });

    if (res?.isError) {
      const errText = res?.content?.[0]?.text || "unknown jolt error";
      console.error(`   Jolt failed: ${errText}`);
      return { ok: false, error: errText };
    }

    let newBatteryLevel: number | undefined;
    let overheated = false;
    const text = res?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        const data = JSON.parse(text);
        if (typeof data?.bot?.new_battery_level === "number") {
          newBatteryLevel = data.bot.new_battery_level;
        }
        overheated = !!data?.bot?.is_overheated;
      } catch {}
    }

    return { ok: true, newBatteryLevel, overheated };
  } catch (e: any) {
    console.error(`   Jolt failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function paidRepair(client: PokedRaceMCPClient, token: number) {
  console.log(`   💰 Repair #${token} (Perfect Tune)`);
  try {
    await client.callTool("garage_repair_robot", { token_index: token });
  } catch (e: any) {
    console.error(`   Repair failed: ${e.message}`);
  }
}

async function registerBot(
  client: PokedRaceMCPClient,
  eventId: number,
  token: number
) {
  console.log(`   📝 Register #${token} for Event #${eventId}`);
  try {
    const res = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: token,
    });
    if (res.isError) {
      console.error(`   Registration failed: ${res.content?.[0]?.text}`);
    } else {
      console.log(`   ✅ Registered!`);
    }
  } catch (e: any) {
    console.error(`   Registration error: ${e.message}`);
  }
}

async function getBatteries(client: PokedRaceMCPClient): Promise<number[]> {
  try {
    const res = await client.callTool("garage_list_batteries", {});
    const text = res.content[0].text;
    const ids = new Set<number>();

    // JSON parser (supports array/object/nested payloads)
    try {
      const data = JSON.parse(text);
      const stack: unknown[] = [data];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur || typeof cur !== "object") continue;

        if (Array.isArray(cur)) {
          for (const item of cur) stack.push(item);
          continue;
        }

        const obj = cur as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          if (
            /^(id|battery[_-]?id|item[_-]?id)$/i.test(k) &&
            (typeof v === "number" || typeof v === "string")
          ) {
            const n = typeof v === "number" ? v : parseInt(v, 10);
            if (Number.isInteger(n) && n > 0) ids.add(n);
          }
          if (v && typeof v === "object") stack.push(v);
        }
      }
    } catch {}

    // Text fallback for non-JSON responses
    if (ids.size === 0) {
      const patterns = [
        /"id"\s*:\s*(\d+)/g,
        /\bbattery(?:[_\s-]?id)?\s*[:#=]\s*(\d+)/gi,
        /🔋\s*(?:Battery|バッテリー)?\s*#?(\d+)/gi,
        /\bID\s*[:#]\s*(\d+)/gi,
        /#(\d+)/g,
      ];

      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          const n = parseInt(m[1], 10);
          if (Number.isInteger(n) && n > 0) ids.add(n);
        }
      }
    }

    return [...ids];
  } catch {
    return [];
  }
}

// --- Main ---

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  console.log("🏁 RACE PREP (T-2h)\n");

  // 1. Find upcoming events
  const events = await getUpcomingEvents(client);
  if (events.length === 0) {
    console.log("No events in target window (10-180m). Exiting.");
    await client.close();
    return;
  }

  const event = events[0];
  console.log(
    `🎯 Event #${event.id} — starts in ${Math.floor(event.minUntil)}m`
  );

  // 2. Determine terrains (API → fallback)
  let terrains = await getRaceTerrains(client, event.raceIds);
  if (terrains.length === 0) {
    terrains = predictTerrains(event.startTime);
    console.log(`⚠️ Terrain API failed, using fallback: ${terrains.join(", ")}`);
  } else {
    console.log(`🌍 Terrains: ${terrains.join(", ")}`);
  }

  // 3. Select racers (per Tier × per terrain limit)
  const selected: BotEntry[] = [];
  const activeTerrains = terrains.filter(isRosterTerrain);
  for (const tier of TIER_ORDER) {
    const tierRoster = ROSTER[tier] || [];
    for (const terrain of activeTerrains) {
      const perTerrainLimit =
        PER_TERRAIN_LIMITS[tier]?.[terrain] ?? BASE_PER_TERRAIN_LIMIT;
      const candidates = tierRoster.filter((b) => b.terrain === terrain);
      selected.push(...candidates.slice(0, perTerrainLimit));
    }
  }

  console.log(
    `📋 Selected ${selected.length}: ${selected.map((b) => `${b.name}(${b.token})`).join(", ")}\n`
  );

  if (selected.length === 0) {
    console.log("No racers match terrain. Exiting.");
    await client.close();
    return;
  }

  // 4. Get batteries for Jolt
  let batteryIds = await getBatteries(client);
  const triedBatteryIds = new Set<number>();
  if (batteryIds.length === 0) {
    console.log("⚠️ No batteries found for Jolt\n");
  } else {
    console.log(`🔋 Parsed battery items: ${batteryIds.length}`);
  }

  async function refillBatteryIds(): Promise<number> {
    const latest = await getBatteries(client);
    let added = 0;
    for (const id of latest) {
      if (!triedBatteryIds.has(id) && !batteryIds.includes(id)) {
        batteryIds.push(id);
        added++;
      }
    }
    return added;
  }

  // 5. Process each racer
  for (const bot of selected) {
    console.log(`\n🤖 ${bot.name} (#${bot.token})`);

    const details = await getBotDetails(client, bot.token);
    if (!details) {
      console.log("   Failed to get details, skipping");
      continue;
    }

    const bat = details.condition?.battery ?? 0;
    const cond = details.condition?.condition ?? 0;
    const zone = details.active_scavenging?.zone;
    const isScavenging = !!details.active_scavenging?.status?.includes(
      "Active"
    );

    console.log(
      `   Status: Bat=${bat}% Cond=${cond}% Zone=${zone || "Idle"}`
    );

    // a. Recall if scavenging
    if (isScavenging) {
      console.log(`   📥 Recalling...`);
      await recall(client, bot.token);
      await new Promise((r) => setTimeout(r, 500));
    }

    // b. If condition is low, wait in RepairBay until threshold before paid repair.
    if (cond < MIN_CONDITION_BEFORE_PAID_REPAIR) {
      const deadlineMs =
        event.startTime.getTime() - REGISTRATION_BUFFER_MINUTES * 60 * 1000;
      console.log(
        `   ⏳ Condition low (${cond}%), waiting for >= ${MIN_CONDITION_BEFORE_PAID_REPAIR}% in RepairBay`
      );

      const recovery = await waitForConditionRecovery(
        client,
        bot.token,
        MIN_CONDITION_BEFORE_PAID_REPAIR,
        deadlineMs
      );

      await recall(client, bot.token);
      await new Promise((r) => setTimeout(r, 300));

      if (!recovery.reached) {
        console.log(
          `   ❌ Condition stayed below ${MIN_CONDITION_BEFORE_PAID_REPAIR}% (latest ${recovery.latestCondition}%). Skip registration for this bot.`
        );
        continue;
      }

      console.log(
        `   ✅ Condition recovered to ${recovery.latestCondition}% (>= ${MIN_CONDITION_BEFORE_PAID_REPAIR}%)`
      );
    }

    // c. Paid Charge (→ Overcharge via recharge_robot)
    await paidCharge(client, bot.token);
    await new Promise((r) => setTimeout(r, 300));

    // Refresh battery after paid charge
    const afterCharge = await getBotDetails(client, bot.token);
    let currentBattery = afterCharge?.condition?.battery ?? bat;

    // d. Jolt repeatedly until battery reaches 100% (or stop conditions)
    while (currentBattery < 100) {
      if (batteryIds.length === 0) {
        const added = await refillBatteryIds();
        if (added > 0) {
          console.log(`   🔄 Refreshed battery list (+${added})`);
        } else {
          break;
        }
      }

      const batteryId = batteryIds.shift()!;
      triedBatteryIds.add(batteryId);
      const joltResult = await joltBot(client, bot.token, batteryId);
      await new Promise((r) => setTimeout(r, 300));

      if (!joltResult.ok) {
        continue;
      }

      if (typeof joltResult.newBatteryLevel === "number") {
        currentBattery = joltResult.newBatteryLevel;
      } else {
        const afterJolt = await getBotDetails(client, bot.token);
        currentBattery = afterJolt?.condition?.battery ?? currentBattery;
      }

      if (joltResult.overheated) {
        console.log(`   🌡️ Overheated at ${currentBattery}%, stop jolting`);
        break;
      }
    }

    if (currentBattery < 100) {
      if (batteryIds.length === 0) {
        console.log(`   🔋 Battery item exhausted at ${currentBattery}%`);
      } else {
        console.log(`   ⚠️ Jolt ended at ${currentBattery}%`);
      }
    } else {
      console.log(`   ✅ Battery reached 100%`);
    }

    // e. Paid Repair (→ Perfect Tune)
    await paidRepair(client, bot.token);
    await new Promise((r) => setTimeout(r, 300));

    // f. Register
    await registerBot(client, event.id, bot.token);
  }

  console.log("\n✅ Race prep complete");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
