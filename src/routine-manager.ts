/**
 * Routine Manager (15分間隔)
 *
 * ロースター対象の日常管理:
 *   - レース登録済みはスキップ
 *   - 未登録はできるだけ ScrapHeaps 継続
 *   - Joltは実行しない（post-race-joltでのみ実行）
 *   - Cond < 15 は RepairBay 優先
 *   - 無料リペアは Cond >= 70 で打ち止め
 *   - Bat >= 90 かつ Cond >= 70 で ScrapHeaps へ復帰
 *   - レース登録済み → スキップ
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import { ALL_TOKENS } from "./roster.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL =
  process.env.MCP_SERVER_URL ||
  "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const SCAVENGE_MIN_BATTERY = 10;
const SCAVENGE_MIN_CONDITION = 15;
const REDEPLOY_BATTERY_TARGET = 90;
const REDEPLOY_CONDITION_TARGET = 70;
const MAX_REPAIR_BAY = 5;
const DAILY_SPRINT_UTC_HOURS = [0, 6, 12, 18];
const PREP_WINDOW_MINUTES = 120;
const PRIORITY_TOKENS = new Set<number>(ALL_TOKENS);

interface BotStatus {
  token: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
  isScavenging: boolean;
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

async function getBotStatus(
  client: PokedRaceMCPClient,
  token: number
): Promise<BotStatus | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", {
      token_index: token,
    });
    const data = JSON.parse(result.content[0].text);
    const battery = data.condition?.battery ?? 0;
    const condition = data.condition?.condition ?? 0;
    const name = data.name || `#${token}`;
    const isScavenging = !!data.active_scavenging?.status?.includes("Active");
    const zone = isScavenging ? data.active_scavenging.zone : null;
    return { token, name, battery, condition, zone, isScavenging };
  } catch (e: any) {
    console.error(`Failed to get status for #${token}: ${e.message}`);
    return null;
  }
}

function getMinutesUntilNextDailySprint(now: Date = new Date()): number {
  let minMs = Number.POSITIVE_INFINITY;

  for (const hour of DAILY_SPRINT_UTC_HOURS) {
    const candidate = new Date(now);
    candidate.setUTCHours(hour, 0, 0, 0);
    if (candidate.getTime() < now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    const delta = candidate.getTime() - now.getTime();
    if (delta < minMs) minMs = delta;
  }

  return Math.floor(minMs / 60000);
}

function isInPrepWindow(now: Date = new Date()): boolean {
  return getMinutesUntilNextDailySprint(now) <= PREP_WINDOW_MINUTES;
}

function parseRegisteredFromPayload(
  payload: string,
  candidateSet: Set<number>
): Set<number> {
  const tokens = new Set<number>();

  try {
    const data = JSON.parse(payload);
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
          /^(token|token_index|tokenIndex|bot_token|botToken)$/i.test(k) &&
          (typeof v === "number" || typeof v === "string")
        ) {
          const n = typeof v === "number" ? v : parseInt(v, 10);
          if (Number.isInteger(n) && candidateSet.has(n)) tokens.add(n);
        }
        if (typeof v === "number" && candidateSet.has(v)) {
          tokens.add(v);
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
  } catch {}

  for (const m of payload.matchAll(/\b\d+\b/g)) {
    const n = parseInt(m[0], 10);
    if (candidateSet.has(n)) tokens.add(n);
  }

  return tokens;
}

async function getRegisteredBotsOnce(
  client: PokedRaceMCPClient,
  tokens: number[]
): Promise<Set<number>> {
  try {
    const res = await client.callTool("racing_get_my_registrations", {});
    const text = res?.content?.[0]?.text || "";
    return parseRegisteredFromPayload(text, new Set<number>(tokens));
  } catch {
    return new Set<number>();
  }
}

async function recall(
  client: PokedRaceMCPClient,
  token: number
): Promise<void> {
  try {
    await client.callTool("garage_complete_scavenging", {
      token_index: token,
    });
  } catch {}
}

async function sendTo(
  client: PokedRaceMCPClient,
  token: number,
  zone: string
): Promise<boolean> {
  await recall(client, token);
  await new Promise((r) => setTimeout(r, 300));
  try {
    await client.callTool("garage_start_scavenging", {
      token_index: token,
      zone,
    });
    return true;
  } catch (e: any) {
    console.error(`  Failed to send #${token} to ${zone}: ${e.message}`);
    return false;
  }
}

async function evictOneNonPriorityFromRepairBay(
  client: PokedRaceMCPClient,
  repairBayTokens: Set<number>,
  registered: Set<number>
): Promise<number | null> {
  for (const token of repairBayTokens) {
    if (PRIORITY_TOKENS.has(token)) continue;
    if (registered.has(token)) continue;

    console.log(`♻️ Evict non-priority from RepairBay: #${token}`);
    const ok = await sendTo(client, token, "ChargingStation");
    await new Promise((r) => setTimeout(r, 300));
    if (ok) return token;
  }
  return null;
}

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  console.log("🔄 ROUTINE MANAGER");
  console.log(`🎯 Managing ${ALL_TOKENS.length} bots\n`);

  // 1. Fetch all statuses in parallel
  const statuses = (
    await Promise.all(ALL_TOKENS.map((t) => getBotStatus(client, t)))
  ).filter((s): s is BotStatus => s !== null);

  // 2. Get registered bots only in T-2h prep window
  const minutesToRace = getMinutesUntilNextDailySprint();
  const inPrepWindow = isInPrepWindow();
  const registered = inPrepWindow
    ? await getRegisteredBotsOnce(client, ALL_TOKENS)
    : new Set<number>();
  console.log(
    `⏱️ Next daily sprint in ${minutesToRace}m (prep-window=${inPrepWindow ? "ON" : "OFF"})`
  );
  console.log(
    `🏁 Registered: ${registered.size > 0 ? [...registered].join(", ") : "none"}\n`
  );

  // 3. Global RepairBay usage across all owned bots
  let globalRepairBayTokens = await getGlobalRepairBayTokens(client);
  console.log(`🔧 RepairBay occupancy: ${globalRepairBayTokens.size}/${MAX_REPAIR_BAY}\n`);

  for (const bot of statuses) {
    let battery = bot.battery;
    let condition = bot.condition;
    let zone = bot.zone || "Idle";
    let isScavenging = bot.isScavenging;

    const tag = () =>
      `#${bot.token} ${bot.name} (Bat:${battery}% Cond:${condition}% Zone:${zone})`;

    // Skip registered bots
    if (registered.has(bot.token)) {
      console.log(`🏁 ${tag()}: registered, skip`);
      continue;
    }

    // --- Case 1: keep scavenging unless hard thresholds are hit ---
    if (zone === "ScrapHeaps") {
      if (battery < SCAVENGE_MIN_BATTERY || condition < SCAVENGE_MIN_CONDITION) {
        console.log(`🔌 ${tag()}: threshold hit → recall & recover`);
        await recall(client, bot.token);
        await new Promise((r) => setTimeout(r, 300));
        zone = "Idle";
        isScavenging = false;
      } else {
        console.log(`⛏️ ${tag()}: scavenging OK`);
        continue;
      }
    }

    // --- Case 2: condition recovery first ---
    if (condition < SCAVENGE_MIN_CONDITION) {
      if (zone === "RepairBay") {
        console.log(`🔧 ${tag()}: repairing`);
        globalRepairBayTokens.add(bot.token);
        continue;
      }
      if (globalRepairBayTokens.size < MAX_REPAIR_BAY) {
        console.log(`🔧 ${tag()}: → RepairBay`);
        const ok = await sendTo(client, bot.token, "RepairBay");
        if (ok) globalRepairBayTokens.add(bot.token);
        continue;
      }

      const evicted = await evictOneNonPriorityFromRepairBay(
        client,
        globalRepairBayTokens,
        registered
      );
      if (evicted !== null) {
        globalRepairBayTokens = await getGlobalRepairBayTokens(client);
        if (globalRepairBayTokens.size < MAX_REPAIR_BAY) {
          console.log(`🔧 ${tag()}: priority slot secured → RepairBay`);
          const ok = await sendTo(client, bot.token, "RepairBay");
          if (ok) globalRepairBayTokens.add(bot.token);
          continue;
        }
      }

      if (zone !== "ChargingStation") {
        console.log(`⏳ ${tag()}: RepairBay full → ChargingStation`);
        await sendTo(client, bot.token, "ChargingStation");
        globalRepairBayTokens.delete(bot.token);
      } else {
        console.log(`⏳ ${tag()}: waiting for RepairBay`);
      }
      continue;
    }

    // --- Case 3: battery not ready yet ---
    if (battery < REDEPLOY_BATTERY_TARGET) {
      if (zone === "ChargingStation") {
        console.log(`🔌 ${tag()}: charging`);
      } else {
        console.log(`🔌 ${tag()}: → ChargingStation`);
        await sendTo(client, bot.token, "ChargingStation");
        globalRepairBayTokens.delete(bot.token);
      }
      continue;
    }

    // --- Case 4: ready enough to re-enter scavenging ---
    if (battery >= REDEPLOY_BATTERY_TARGET && condition >= REDEPLOY_CONDITION_TARGET) {
      if (zone !== "ScrapHeaps" || !isScavenging) {
        console.log(`⛏️ ${tag()}: recovered → ScrapHeaps`);
        await sendTo(client, bot.token, "ScrapHeaps");
        globalRepairBayTokens.delete(bot.token);
      } else {
        console.log(`⛏️ ${tag()}: scavenging OK`);
      }
      continue;
    }

    // Mid condition range (15-69): recover condition in RepairBay, but stop at >= 70
    if (condition < REDEPLOY_CONDITION_TARGET) {
      if (zone === "RepairBay") {
        console.log(`🔧 ${tag()}: topping condition in RepairBay`);
        globalRepairBayTokens.add(bot.token);
      } else if (globalRepairBayTokens.size < MAX_REPAIR_BAY) {
        console.log(`🔧 ${tag()}: mid condition → RepairBay`);
        const ok = await sendTo(client, bot.token, "RepairBay");
        if (ok) globalRepairBayTokens.add(bot.token);
      } else if (zone !== "ChargingStation") {
        console.log(`🔌 ${tag()}: cond mid, RepairBay full → ChargingStation`);
        await sendTo(client, bot.token, "ChargingStation");
      } else {
        console.log(`🔌 ${tag()}: waiting (RepairBay full)`);
      }
      continue;
    }

    console.log(`❓ ${tag()}: unhandled state`);
  }

  console.log("\n✅ Routine complete");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
