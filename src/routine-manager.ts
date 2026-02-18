/**
 * Routine Manager (15分間隔)
 *
 * レース未登録の全12体の日常管理:
 *   - Battery/Condition < 90% → 回復ループ (RepairBay / ChargingStation)
 *   - Battery/Condition >= 90% → ScrapHeaps でスカベンジ
 *   - Battery/Condition <= 10% → recall して回復ループへ
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

const RECOVERY_TARGET = 90;
const RECALL_THRESHOLD = 10;
const MAX_REPAIR_BAY = 5;
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

async function getRegisteredBots(
  client: PokedRaceMCPClient
): Promise<Set<number>> {
  try {
    const result = await client.callTool("racing_get_my_registrations", {});
    const text = result.content[0].text;
    const ids = new Set<number>();
    for (const match of text.matchAll(/🤖 Bot: #(\d+)/g)) {
      ids.add(parseInt(match[1], 10));
    }
    return ids;
  } catch {
    return new Set();
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

  // 2. Get registered bots
  const registered = await getRegisteredBots(client);
  console.log(
    `🏁 Registered: ${registered.size > 0 ? [...registered].join(", ") : "none"}\n`
  );

  // 3. Global RepairBay usage across all owned bots
  let globalRepairBayTokens = await getGlobalRepairBayTokens(client);
  console.log(`🔧 RepairBay occupancy: ${globalRepairBayTokens.size}/${MAX_REPAIR_BAY}\n`);

  for (const bot of statuses) {
    const tag = `#${bot.token} ${bot.name} (Bat:${bot.battery}% Cond:${bot.condition}% Zone:${bot.zone || "Idle"})`;

    // Skip registered bots
    if (registered.has(bot.token)) {
      console.log(`🏁 ${tag}: registered, skip`);
      continue;
    }

    // --- Case 1: Currently scavenging in ScrapHeaps ---
    if (bot.zone === "ScrapHeaps") {
      if (bot.battery <= RECALL_THRESHOLD || bot.condition <= RECALL_THRESHOLD) {
        console.log(`🔌 ${tag}: low stats → recall & recover`);
        await sendTo(client, bot.token, "ChargingStation");
        globalRepairBayTokens.delete(bot.token);
      } else {
        console.log(`⛏️ ${tag}: scavenging OK`);
      }
      continue;
    }

    // --- Case 2: Needs recovery (< 90%) ---
    if (bot.battery < RECOVERY_TARGET || bot.condition < RECOVERY_TARGET) {
      // If scavenging somewhere other than recovery zones, recall first
      if (
        bot.isScavenging &&
        bot.zone !== "RepairBay" &&
        bot.zone !== "ChargingStation"
      ) {
        await recall(client, bot.token);
        await new Promise((r) => setTimeout(r, 300));
      }

      // Condition recovery: RepairBay
      if (bot.condition < RECOVERY_TARGET) {
        if (bot.zone === "RepairBay") {
          console.log(`🔧 ${tag}: repairing`);
          globalRepairBayTokens.add(bot.token);
          continue;
        }
        if (globalRepairBayTokens.size < MAX_REPAIR_BAY) {
          console.log(`🔧 ${tag}: → RepairBay`);
          const ok = await sendTo(client, bot.token, "RepairBay");
          if (ok) globalRepairBayTokens.add(bot.token);
          continue;
        }

        // RepairBay full: evict non-priority bot to reserve slot for routine bots
        const evicted = await evictOneNonPriorityFromRepairBay(
          client,
          globalRepairBayTokens,
          registered
        );
        if (evicted !== null) {
          globalRepairBayTokens = await getGlobalRepairBayTokens(client);
          if (globalRepairBayTokens.size < MAX_REPAIR_BAY) {
            console.log(`🔧 ${tag}: priority slot secured → RepairBay`);
            const ok = await sendTo(client, bot.token, "RepairBay");
            if (ok) globalRepairBayTokens.add(bot.token);
            continue;
          }
        }

        // Still full → wait at ChargingStation (also charges battery)
        if (bot.zone !== "ChargingStation") {
          console.log(`⏳ ${tag}: RepairBay full (no slot) → ChargingStation`);
          await sendTo(client, bot.token, "ChargingStation");
          globalRepairBayTokens.delete(bot.token);
        } else {
          console.log(`⏳ ${tag}: waiting for RepairBay`);
        }
        continue;
      }

      // Battery recovery: ChargingStation
      if (bot.battery < RECOVERY_TARGET) {
        if (bot.zone === "ChargingStation") {
          console.log(`🔌 ${tag}: charging`);
        } else {
          console.log(`🔌 ${tag}: → ChargingStation`);
          await sendTo(client, bot.token, "ChargingStation");
          globalRepairBayTokens.delete(bot.token);
        }
        continue;
      }
    }

    // --- Case 3: Fully recovered → ScrapHeaps ---
    if (bot.battery >= RECOVERY_TARGET && bot.condition >= RECOVERY_TARGET) {
      if (bot.zone !== "ScrapHeaps") {
        console.log(`⛏️ ${tag}: recovered → ScrapHeaps`);
        await sendTo(client, bot.token, "ScrapHeaps");
        globalRepairBayTokens.delete(bot.token);
      } else {
        console.log(`⛏️ ${tag}: scavenging OK`);
      }
      continue;
    }

    console.log(`❓ ${tag}: unhandled state`);
  }

  console.log("\n✅ Routine complete");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
