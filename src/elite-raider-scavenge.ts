/**
 * Elite/Raider Scavenge Batch
 *
 * Purpose:
 * - Send all owned Elite/Raider bots EXCEPT current race roster members
 *   into a maintenance/scavenge loop:
 *   1) While scavenging in target zone, keep running until battery < 80
 *   2) If recalled and condition < 30 -> RepairBay
 *   3) If condition >= 30 -> ChargingStation
 *   4) When battery >= 95 -> redeploy to target scavenging zone
 * - Skip bots that are currently registered for races.
 *
 * Usage:
 *   npm run elite-raider-scavenge
 *
 * Optional env:
 *   SCAVENGE_ZONE=ScrapHeaps|WastelandSand|MetalRoads|ChargingStation|RepairBay
 *   DRY_RUN=1
 */

import dotenv from "dotenv";
import { PokedRaceMCPClient } from "./mcp-client.js";
import { ROSTER } from "./roster.js";

dotenv.config();

const SERVER_URL =
  process.env.MCP_SERVER_URL ||
  "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;
const TARGET_ZONE = process.env.SCAVENGE_ZONE || "ScrapHeaps";
const DRY_RUN = process.env.DRY_RUN === "1";

type Tier = "Elite" | "Raider" | "Junker" | "Scrap" | "Unknown";

interface ListedBot {
  token: number;
  tier: Tier;
}

interface BotDetails {
  name?: string;
  condition?: {
    battery?: number;
    condition?: number;
  };
  active_scavenging?: {
    zone?: string;
    status?: string;
  };
}

const RECALL_BATTERY_THRESHOLD = 80;
const REPAIR_CONDITION_THRESHOLD = 30;
const redeployThresholdRaw = Number(process.env.REDEPLOY_BATTERY_THRESHOLD);
const REDEPLOY_BATTERY_THRESHOLD =
  Number.isFinite(redeployThresholdRaw) && redeployThresholdRaw >= 0
    ? Math.min(100, redeployThresholdRaw)
    : 100;
const MAX_REPAIR_BAY = 5;
const CHARGING_ZONE = "ChargingStation";
const REPAIR_ZONE = "RepairBay";

function parseTier(text: string): Tier {
  if (/\bElite\b/.test(text)) return "Elite";
  if (/\bRaider\b/.test(text)) return "Raider";
  if (/\bJunker\b/.test(text)) return "Junker";
  if (/\bScrap\b/.test(text)) return "Scrap";
  return "Unknown";
}

function parseOwnedBotsFromList(text: string): ListedBot[] {
  const out: ListedBot[] = [];
  const re = /🏎️ PokedBot #(\d+)([\s\S]*?)(?=\n🏎️ PokedBot #|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = parseInt(m[1], 10);
    const block = m[2] || "";
    const classLine = (block.match(/🏆 Class:\s*([^\n]+)/) || [])[1] || "";
    const tier = parseTier(classLine);
    out.push({ token, tier });
  }
  return out;
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

function isActiveScavenging(details: BotDetails | null): boolean {
  return !!details?.active_scavenging?.status?.includes("Active");
}

function getBattery(details: BotDetails | null): number {
  return details?.condition?.battery ?? 0;
}

function getCondition(details: BotDetails | null): number {
  return details?.condition?.condition ?? 0;
}

function getZone(details: BotDetails | null): string {
  return details?.active_scavenging?.zone || "Idle";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getRegisteredBots(
  client: PokedRaceMCPClient
): Promise<Set<number>> {
  try {
    const result = await client.callTool("racing_get_my_registrations", {});
    const text = result?.content?.[0]?.text || "";
    const ids = new Set<number>();
    for (const match of text.matchAll(/🤖 Bot: #(\d+)/g)) {
      ids.add(parseInt(match[1], 10));
    }
    return ids;
  } catch {
    return new Set();
  }
}

async function getOwnedBots(client: PokedRaceMCPClient): Promise<ListedBot[]> {
  const result = await client.callTool("garage_list_my_pokedbots", {});
  const text = result?.content?.[0]?.text || "";
  return parseOwnedBotsFromList(text);
}

async function getRepairBayTokens(
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

async function getBotDetails(
  client: PokedRaceMCPClient,
  token: number
): Promise<BotDetails | null> {
  try {
    const res = await client.callTool("garage_get_robot_details", {
      token_index: token,
    });
    return JSON.parse(res.content[0].text);
  } catch {
    return null;
  }
}

async function recall(client: PokedRaceMCPClient, token: number): Promise<void> {
  try {
    await client.callTool("garage_complete_scavenging", {
      token_index: token,
    });
  } catch {}
}

async function sendToZone(
  client: PokedRaceMCPClient,
  token: number,
  zone: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.callTool("garage_start_scavenging", {
      token_index: token,
      zone,
    });
    return { ok: true };
  } catch (e: any) {
    const msg = e?.message || "unknown error";
    console.error(`   Failed start_scavenging #${token}: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function moveToZone(
  client: PokedRaceMCPClient,
  token: number,
  active: boolean,
  currentZone: string,
  desiredZone: string
): Promise<{ ok: boolean; error?: string }> {
  if (active && currentZone === desiredZone) {
    return { ok: true };
  }

  if (DRY_RUN) {
    console.log(`   -> dry-run: would move to ${desiredZone}`);
    return { ok: true };
  }

  if (active) {
    await recall(client, token);
    await sleep(300);
  }

  const result = await sendToZone(client, token, desiredZone);
  await sleep(300);
  return result;
}

async function moveWithFallback(
  client: PokedRaceMCPClient,
  token: number,
  active: boolean,
  currentZone: string,
  desiredZone: string,
  repairBayTokens: Set<number>
): Promise<{ ok: boolean; finalZone: string; fallbackUsed: boolean }> {
  const primary = await moveToZone(client, token, active, currentZone, desiredZone);
  if (primary.ok) {
    return { ok: true, finalZone: desiredZone, fallbackUsed: false };
  }

  // Re-read status once: API can fail even when move succeeded server-side.
  let latest = await getBotDetails(client, token);
  let latestZone = getZone(latest);
  let latestActive = isActiveScavenging(latest);
  let latestCondition = getCondition(latest);
  if (latestActive && latestZone === desiredZone) {
    return { ok: true, finalZone: desiredZone, fallbackUsed: false };
  }

  const fallbackCandidates: string[] = [];
  if (latestCondition < REPAIR_CONDITION_THRESHOLD) {
    fallbackCandidates.push(REPAIR_ZONE);
  }
  fallbackCandidates.push(CHARGING_ZONE);

  const seen = new Set<string>();
  const orderedFallbacks = fallbackCandidates.filter((z) => {
    if (z === desiredZone) return false;
    if (seen.has(z)) return false;
    seen.add(z);
    return true;
  });

  for (const zone of orderedFallbacks) {
    if (
      zone === REPAIR_ZONE &&
      !(latestActive && latestZone === REPAIR_ZONE) &&
      repairBayTokens.size >= MAX_REPAIR_BAY
    ) {
      continue;
    }

    console.log(`   -> fallback move to ${zone}`);
    const fb = await moveToZone(client, token, latestActive, latestZone, zone);
    if (fb.ok) {
      return { ok: true, finalZone: zone, fallbackUsed: true };
    }

    latest = await getBotDetails(client, token);
    latestZone = getZone(latest);
    latestActive = isActiveScavenging(latest);
    latestCondition = getCondition(latest);
    if (latestActive && latestZone === zone) {
      return { ok: true, finalZone: zone, fallbackUsed: true };
    }
  }

  return { ok: false, finalZone: latestZone, fallbackUsed: true };
}

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  const keepTokens = new Set<number>([
    ...ROSTER.Elite.map((b) => b.token),
    ...ROSTER.Raider.map((b) => b.token),
  ]);

  console.log("=== Elite/Raider Scavenge Batch ===");
  console.log(`Target zone: ${TARGET_ZONE}`);
  console.log(`Dry run: ${DRY_RUN ? "ON" : "OFF"}`);
  console.log(`Keep (Elite+Raider roster): ${[...keepTokens].join(", ")}\n`);

  const [owned, registered] = await Promise.all([
    getOwnedBots(client),
    getRegisteredBots(client),
  ]);
  let repairBayTokens = await getRepairBayTokens(client);

  const targets = owned.filter(
    (b) => (b.tier === "Elite" || b.tier === "Raider") && !keepTokens.has(b.token)
  );

  console.log(`Owned bots: ${owned.length}`);
  console.log(`Target Elite/Raider (excluding keep): ${targets.length}`);
  console.log(`RepairBay occupancy: ${repairBayTokens.size}/${MAX_REPAIR_BAY}`);
  console.log(
    `Registered (skip): ${
      registered.size > 0 ? [...registered].join(", ") : "none"
    }\n`
  );

  let moved = 0;
  let keepScavenging = 0;
  let skippedRegistered = 0;
  let maintenanceMove = 0;
  let lowBatteryRecall = 0;
  let fallbackMove = 0;
  let failed = 0;

  for (const t of targets) {
    if (registered.has(t.token)) {
      console.log(`#${t.token}: registered -> skip`);
      skippedRegistered++;
      continue;
    }

    const details = await getBotDetails(client, t.token);
    const name = details?.name ? `${details.name}` : `#${t.token}`;
    let zone = getZone(details);
    let active = isActiveScavenging(details);
    let battery = getBattery(details);
    let condition = getCondition(details);

    console.log(
      `#${t.token} ${name} [${t.tier}] bat=${battery}% cond=${condition}% zone=${zone} active=${active}`
    );

    // Rule 1: keep scavenging in target zone until battery drops below threshold
    if (active && zone === TARGET_ZONE && battery >= RECALL_BATTERY_THRESHOLD) {
      console.log("   -> scavenging continue (battery >= 80)");
      keepScavenging++;
      continue;
    }

    // Rule 2 trigger: scavenging bot under recall threshold gets recalled first
    if (active && zone === TARGET_ZONE && battery < RECALL_BATTERY_THRESHOLD) {
      lowBatteryRecall++;
      console.log("   -> battery < 80 while scavenging, recall");
      if (!DRY_RUN) {
        await recall(client, t.token);
        await sleep(300);
        const refreshed = await getBotDetails(client, t.token);
        zone = getZone(refreshed);
        active = isActiveScavenging(refreshed);
        battery = getBattery(refreshed);
        condition = getCondition(refreshed);
      }
    }

    // Rules 2-4: decide desired zone after recall/idle
    let desiredZone: string;
    if (battery >= REDEPLOY_BATTERY_THRESHOLD) {
      desiredZone = TARGET_ZONE;
      console.log("   -> battery >= 95, redeploy to scavenging");
    } else if (condition < REPAIR_CONDITION_THRESHOLD) {
      if (!(active && zone === REPAIR_ZONE) && repairBayTokens.size >= MAX_REPAIR_BAY) {
        desiredZone = CHARGING_ZONE;
        console.log("   -> condition < 30 but RepairBay full, send to ChargingStation");
      } else {
        desiredZone = REPAIR_ZONE;
        console.log("   -> condition < 30, send to RepairBay");
      }
    } else {
      desiredZone = CHARGING_ZONE;
      console.log(
        `   -> condition >= 30 and battery < ${REDEPLOY_BATTERY_THRESHOLD}, send to ChargingStation`
      );
    }

    const moveResult = await moveWithFallback(
      client,
      t.token,
      active,
      zone,
      desiredZone,
      repairBayTokens
    );
    if (!moveResult.ok) {
      failed++;
      continue;
    }

    if (moveResult.fallbackUsed) {
      fallbackMove++;
    }

    if (active && zone === REPAIR_ZONE && moveResult.finalZone !== REPAIR_ZONE) {
      repairBayTokens.delete(t.token);
    }
    if (moveResult.finalZone === REPAIR_ZONE) {
      repairBayTokens.add(t.token);
    } else {
      repairBayTokens.delete(t.token);
    }

    if (moveResult.finalZone === TARGET_ZONE) moved++;
    else maintenanceMove++;
  }

  console.log("\n=== Summary ===");
  console.log(`Moved to target scavenging zone: ${moved}`);
  console.log(`Kept scavenging (battery >= 80): ${keepScavenging}`);
  console.log(`Low-battery recalls (<80): ${lowBatteryRecall}`);
  console.log(`Moved to maintenance zones (Repair/Charge): ${maintenanceMove}`);
  console.log(`Moved by fallback recovery: ${fallbackMove}`);
  console.log(`Skipped (registered): ${skippedRegistered}`);
  console.log(`Failed: ${failed}`);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
