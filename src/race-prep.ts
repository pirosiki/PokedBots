/**
 * Race Prep (T-2h)
 *
 * Daily Sprintの2時間前に実行:
 *   1. イベント取得 → 地形取得（フォールバック付き）
 *   2. 出走体選出（各Tier × 地形ごとの上限で選出）
 *   3. 先に登録 → その後にCond/Batメンテ（Cond>=70後に有料Repair）
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
const TERRAINS_PER_EVENT = 2;
const BOTS_PER_TIER_PER_TERRAIN = 1;
const MIN_CONDITION_BEFORE_PAID_REPAIR = 70;
const EVENT_MIN_MINUTES = 0;
const EVENT_MAX_MINUTES = 180;
const REPAIR_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const FINAL_PHASE_INTERVAL_MS = 2 * 60 * 1000;
const FINAL_PHASE_WINDOW_MINUTES = 30;
const REGISTRATION_BUFFER_MINUTES = 15;
const MAX_REPAIR_BAY = 5;
const MAX_JOLT_PER_BOT = 4; // Heat stacks cap practical consecutive Jolts.
const DEFAULT_JOLT_BATTERY_IDS = [
  47, 19, 105, 53, 104, 78, 122, 124, 123, 127, 129, 131,
];
const JOLT_MIN_STORED_KWH = Number(process.env.JOLT_MIN_STORED_KWH ?? "0");
const JOLT_REQUIRE_OPERATIONAL = process.env.JOLT_REQUIRE_OPERATIONAL === "1";
const JOLT_FIXED_BATTERY_IDS = (() => {
  const raw = (process.env.JOLT_FIXED_BATTERY_IDS || "").trim();
  if (!raw) return DEFAULT_JOLT_BATTERY_IDS;
  const seen = new Set<number>();
  const parsed = raw
    .split(/[,\s]+/)
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0 && !seen.has(v) && seen.add(v));
  return parsed.length > 0 ? parsed : DEFAULT_JOLT_BATTERY_IDS;
})();

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

      if (minUntil > EVENT_MIN_MINUTES && minUntil < EVENT_MAX_MINUTES) {
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

function parseRepairBayTokensFromList(text: string): Set<number> {
  const tokens = new Set<number>();
  const re = /🏎️ PokedBot #(\d+)([\s\S]*?)(?=\n🏎️ PokedBot #|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = parseInt(m[1], 10);
    const block = m[2] || "";
    if (/🔍 SCAVENGING:\s*Active[\s\S]*\bin RepairBay\b/.test(block)) {
      tokens.add(token);
    }
  }
  return tokens;
}

async function getGlobalRepairBayTokens(
  client: PokedRaceMCPClient
): Promise<Set<number>> {
  try {
    const result = await client.callTool("garage_list_my_pokedbots", {});
    const text = result?.content?.[0]?.text || "";
    return parseRepairBayTokensFromList(text);
  } catch {
    return new Set<number>();
  }
}

async function sendToZone(
  client: PokedRaceMCPClient,
  token: number,
  zone: "RepairBay" | "ChargingStation"
): Promise<boolean> {
  try {
    await client.callTool("garage_start_scavenging", {
      token_index: token,
      zone,
    });
    return true;
  } catch (e: any) {
    console.error(`   Failed to send #${token} to ${zone}: ${e.message}`);
    return false;
  }
}

async function moveToZone(
  client: PokedRaceMCPClient,
  token: number,
  details: any,
  zone: "RepairBay" | "ChargingStation"
): Promise<boolean> {
  const currentZone = details?.active_scavenging?.zone;
  const isScavenging = !!details?.active_scavenging?.status?.includes("Active");
  if (isScavenging && currentZone === zone) return true;

  if (isScavenging || currentZone) {
    await recall(client, token);
    await new Promise((r) => setTimeout(r, 300));
  }

  return sendToZone(client, token, zone);
}

async function paidCharge(
  client: PokedRaceMCPClient,
  token: number
): Promise<{ ok: boolean; error?: string }> {
  console.log(`   💰 Charge #${token}`);
  try {
    const res = await client.callTool("garage_recharge_robot", {
      token_index: token,
    });
    if (res?.isError) {
      const err = res?.content?.[0]?.text || "unknown recharge error";
      console.error(`   Charge failed: ${err}`);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e: any) {
    console.error(`   Charge failed: ${e.message}`);
    return { ok: false, error: e.message };
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

async function paidRepair(
  client: PokedRaceMCPClient,
  token: number
): Promise<{ ok: boolean; error?: string }> {
  console.log(`   💰 Repair #${token} (Perfect Tune)`);
  try {
    const res = await client.callTool("garage_repair_robot", {
      token_index: token,
    });
    if (res?.isError) {
      const err = res?.content?.[0]?.text || "unknown repair error";
      console.error(`   Repair failed: ${err}`);
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (e: any) {
    console.error(`   Repair failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function registerBot(
  client: PokedRaceMCPClient,
  eventId: number,
  token: number
): Promise<boolean> {
  console.log(`   📝 Register #${token} for Event #${eventId}`);
  try {
    const res = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: token,
    });
    if (res.isError) {
      console.error(`   Registration failed: ${res.content?.[0]?.text}`);
      return false;
    } else {
      console.log(`   ✅ Registered!`);
      return true;
    }
  } catch (e: any) {
    console.error(`   Registration error: ${e.message}`);
    return false;
  }
}

async function getBatteries(client: PokedRaceMCPClient): Promise<number[]> {
  try {
    const res = await client.callTool("garage_list_batteries", {});
    const text = res.content[0].text;
    const preferredSet = new Set<number>(JOLT_FIXED_BATTERY_IDS);
    let sawBatteryArray = false;

    // JSON parser (supports array/object/nested payloads)
    try {
      const data = JSON.parse(text);

      if (Array.isArray(data?.batteries)) {
        sawBatteryArray = true;
        const byId = new Map<number, { stored: number; isOperational: boolean }>();
        for (const b of data.batteries) {
          const id = Number((b as any)?.id);
          const stored = Number((b as any)?.stored_kwh ?? 0);
          const isOperational = (b as any)?.is_operational === true;
          if (Number.isInteger(id) && id > 0) {
            byId.set(id, { stored, isOperational });
          }
        }

        const ranked: Array<{ id: number; stored: number }> = [];
        for (const id of JOLT_FIXED_BATTERY_IDS) {
          const info = byId.get(id);
          if (!info) continue;
          if (info.stored <= JOLT_MIN_STORED_KWH) continue;
          if (JOLT_REQUIRE_OPERATIONAL && !info.isOperational) continue;
          ranked.push({ id, stored: info.stored });
        }

        if (ranked.length > 0) {
          ranked.sort((a, b) => b.stored - a.stored);
          return ranked.map((b) => b.id);
        }

        const presentPreferred = JOLT_FIXED_BATTERY_IDS.filter((id) =>
          byId.has(id)
        );
        if (presentPreferred.length > 0) return presentPreferred;
      } else {
        const ids = new Set<number>();
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
              if (Number.isInteger(n) && n > 0 && preferredSet.has(n)) ids.add(n);
            }
            if (v && typeof v === "object") stack.push(v);
          }
        }
        if (ids.size > 0) {
          return JOLT_FIXED_BATTERY_IDS.filter((id) => ids.has(id));
        }
      }
    } catch {}

    if (sawBatteryArray) {
      return [];
    }

    // Text fallback for non-JSON responses
    const ids = new Set<number>();
    {
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
          if (Number.isInteger(n) && n > 0 && preferredSet.has(n)) ids.add(n);
        }
      }
    }

    if (ids.size > 0) {
      return JOLT_FIXED_BATTERY_IDS.filter((id) => ids.has(id));
    }
    return [...JOLT_FIXED_BATTERY_IDS];
  } catch {
    return [...JOLT_FIXED_BATTERY_IDS];
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
    console.log(
      `No events in target window (${EVENT_MIN_MINUTES}-${EVENT_MAX_MINUTES}m). Exiting.`
    );
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

  // 3. Select racers (fixed: each tier × each event terrain = 1 bot)
  const selected: BotEntry[] = [];
  const activeTerrains = Array.from(new Set(terrains.filter(isRosterTerrain)));
  const eventTerrains = activeTerrains.slice(0, TERRAINS_PER_EVENT);
  const selectedTokens = new Set<number>();

  if (eventTerrains.length < TERRAINS_PER_EVENT) {
    const fallbackTerrains = predictTerrains(event.startTime).filter(isRosterTerrain);
    for (const t of fallbackTerrains) {
      if (!eventTerrains.includes(t)) eventTerrains.push(t);
      if (eventTerrains.length >= TERRAINS_PER_EVENT) break;
    }
  }

  for (const tier of TIER_ORDER) {
    const tierRoster = ROSTER[tier] || [];
    for (const terrain of eventTerrains) {
      let picked = 0;

      // Primary: exact tier+terrain match.
      const primary = tierRoster.find(
        (b) => b.terrain === terrain && !selectedTokens.has(b.token)
      );
      if (primary) {
        selected.push(primary);
        selectedTokens.add(primary.token);
        picked++;
      }

      // Fallback: keep slot count fixed when exact terrain slot is missing.
      while (picked < BOTS_PER_TIER_PER_TERRAIN) {
        const fallback = tierRoster.find((b) => !selectedTokens.has(b.token));
        if (!fallback) {
          console.log(
            `⚠️ Missing roster slot: ${tier} / ${terrain} (could not fill fixed slot)`
          );
          break;
        }
        selected.push(fallback);
        selectedTokens.add(fallback.token);
        picked++;
      }
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

  // 4. Register first (avoid losing slots while waiting for maintenance)
  const registeredBots: BotEntry[] = [];
  for (const bot of selected) {
    console.log(`\n🤖 Register phase: ${bot.name} (#${bot.token})`);

    const details = await getBotDetails(client, bot.token);
    if (!details) {
      console.log("   Failed to get details, skipping");
      continue;
    }

    const isScavenging = !!details.active_scavenging?.status?.includes("Active");
    if (isScavenging) {
      console.log(`   📥 Recalling before registration...`);
      await recall(client, bot.token);
      await new Promise((r) => setTimeout(r, 400));
    }

    const ok = await registerBot(client, event.id, bot.token);
    if (ok) registeredBots.push(bot);
  }

  if (registeredBots.length === 0) {
    console.log("\nNo bots could be registered. Exiting.");
    await client.close();
    return;
  }

  console.log(
    `\n🧰 Maintenance phase for ${registeredBots.length} registered bots`
  );

  // 5. Battery items for Jolt maintenance
  let batteryIds = await getBatteries(client);
  console.log(`🔋 Parsed usable battery items: ${batteryIds.length}`);
  if (batteryIds.length > 0) {
    console.log(`🔋 Jolt order: ${batteryIds.join(", ")}`);
  }

  async function refillBatteryIds(): Promise<number> {
    const latest = await getBatteries(client);
    let added = 0;
    for (const id of latest) {
      if (!batteryIds.includes(id)) {
        batteryIds.push(id);
        added++;
      }
    }
    return added;
  }

  const deadlineMs =
    event.startTime.getTime() - REGISTRATION_BUFFER_MINUTES * 60 * 1000;
  const prepared = new Set<number>();

  // 6. Maintain registered bots until deadline (RepairBay cap-aware, frequent checks)
  while (Date.now() < deadlineMs) {
    const remaining = registeredBots.filter((b) => !prepared.has(b.token));
    if (remaining.length === 0) break;

    let progressed = false;
    let repairBayTokens = await getGlobalRepairBayTokens(client);
    console.log(
      `\n🔧 RepairBay occupancy: ${repairBayTokens.size}/${MAX_REPAIR_BAY} | Remaining prep: ${remaining.length}`
    );

    for (const bot of remaining) {
      const details = await getBotDetails(client, bot.token);
      if (!details) continue;

      const cond = details.condition?.condition ?? 0;
      const zone = details.active_scavenging?.zone;
      const isScavenging = !!details.active_scavenging?.status?.includes("Active");

      if (cond < MIN_CONDITION_BEFORE_PAID_REPAIR) {
        if (isScavenging && zone === "RepairBay") {
          console.log(
            `⏳ #${bot.token}: Cond ${cond}% < ${MIN_CONDITION_BEFORE_PAID_REPAIR}% (RepairBay waiting)`
          );
          repairBayTokens.add(bot.token);
          continue;
        }

        if (repairBayTokens.size < MAX_REPAIR_BAY) {
          console.log(`🔧 #${bot.token}: Cond ${cond}% → RepairBay`);
          const ok = await moveToZone(client, bot.token, details, "RepairBay");
          if (ok) {
            repairBayTokens.add(bot.token);
            progressed = true;
          }
          continue;
        }

        if (!(isScavenging && zone === "ChargingStation")) {
          console.log(
            `🔌 #${bot.token}: Cond ${cond}% / RepairBay full → ChargingStation`
          );
          const ok = await moveToZone(
            client,
            bot.token,
            details,
            "ChargingStation"
          );
          if (ok) progressed = true;
        } else {
          console.log(
            `⏳ #${bot.token}: Cond ${cond}% / RepairBay full (ChargingStation waiting)`
          );
        }
        continue;
      }

      // Condition is ready: finalize race prep
      if (isScavenging) {
        await recall(client, bot.token);
        await new Promise((r) => setTimeout(r, 300));
      }

      let chargeDetails = await getBotDetails(client, bot.token);
      let currentBattery = chargeDetails?.condition?.battery ?? 0;

      if (currentBattery < 100) {
        const chargeResult = await paidCharge(client, bot.token);
        if (!chargeResult.ok) {
          // Charge can fail (e.g., cooldown/funds). Fall back to Jolt path below.
          chargeDetails = await getBotDetails(client, bot.token);
          currentBattery = chargeDetails?.condition?.battery ?? currentBattery;
          console.log(
            `⚠️ #${bot.token}: paid charge failed (battery ${currentBattery}%), fallback to Jolt`
          );
        } else {
          await new Promise((r) => setTimeout(r, 300));
          chargeDetails = await getBotDetails(client, bot.token);
          currentBattery = chargeDetails?.condition?.battery ?? currentBattery;
        }
      } else {
        console.log(`   ⏭️ #${bot.token}: battery already 100%, skip paid charge`);
      }

      let joltAttempts = 0;
      while (currentBattery < 100 && joltAttempts < MAX_JOLT_PER_BOT) {
        if (batteryIds.length === 0) {
          const added = await refillBatteryIds();
          if (added > 0) {
            console.log(`   🔄 Refreshed battery list (+${added})`);
          } else {
            break;
          }
        }

        const batteryId = batteryIds.shift()!;
        const joltResult = await joltBot(client, bot.token, batteryId);
        joltAttempts++;
        await new Promise((r) => setTimeout(r, 250));

        if (!joltResult.ok) {
          const err = (joltResult.error || "").toLowerCase();
          if (
            err.includes("overheat") ||
            err.includes("overheated") ||
            err.includes("cooldown")
          ) {
            break;
          }
          continue;
        }
        if (typeof joltResult.newBatteryLevel === "number") {
          currentBattery = joltResult.newBatteryLevel;
        } else {
          const afterJolt = await getBotDetails(client, bot.token);
          currentBattery = afterJolt?.condition?.battery ?? currentBattery;
        }
        if (joltResult.overheated) break;
      }

      const beforeFinalize = await getBotDetails(client, bot.token);
      currentBattery = beforeFinalize?.condition?.battery ?? currentBattery;
      if (currentBattery < 100) {
        console.log(
          `⚠️ #${bot.token}: battery ${currentBattery}% < 100, keep in ChargingStation and retry later`
        );
        if (
          !beforeFinalize?.active_scavenging?.status?.includes("Active") ||
          beforeFinalize?.active_scavenging?.zone !== "ChargingStation"
        ) {
          const ok = await moveToZone(
            client,
            bot.token,
            beforeFinalize ?? details,
            "ChargingStation"
          );
          if (ok) progressed = true;
        }
        continue;
      }

      const repairResult = await paidRepair(client, bot.token);
      if (!repairResult.ok) {
        console.log(`⚠️ #${bot.token}: paid repair failed, retry later`);
        continue;
      }
      await new Promise((r) => setTimeout(r, 300));

      prepared.add(bot.token);
      progressed = true;
      repairBayTokens.delete(bot.token);
      console.log(
        `✅ #${bot.token}: prepared (Cond>=${MIN_CONDITION_BEFORE_PAID_REPAIR}, Battery=${currentBattery}%)`
      );
    }

    if (Date.now() >= deadlineMs) break;

    const stillRemaining = registeredBots.filter((b) => !prepared.has(b.token));
    if (stillRemaining.length === 0) break;

    if (!progressed) {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      const intervalMs =
        remainingMs <= FINAL_PHASE_WINDOW_MINUTES * 60 * 1000
          ? FINAL_PHASE_INTERVAL_MS
          : REPAIR_CHECK_INTERVAL_MS;
      const waitMs = Math.min(
        intervalMs,
        remainingMs
      );
      if (waitMs > 0) {
        console.log(`⏳ No progress this pass. Wait ${Math.floor(waitMs / 60000)}m`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  const unprepared = registeredBots.filter((b) => !prepared.has(b.token));
  if (unprepared.length > 0) {
    console.log(
      `\n⚠️ Unprepared before deadline (${unprepared.length}): ${unprepared
        .map((b) => `${b.name}(${b.token})`)
        .join(", ")}`
    );
  }

  console.log("\n✅ Race prep complete");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
