/**
 * Auto Event Registration (Terrain-Aware)
 *
 * 1軍ロスター16体をレースの地形に応じて選出・回復・登録する。
 *
 * フロー:
 * 1. MCP接続 → 全ボット取得（現在クラス確認）
 * 2. 次のイベント取得 → race IDsからterrain取得
 * 3. 各クラス: terrain一致のボットを選出（BH枠はWB優先、推し枠あり）
 * 4. 回復処理: スカベンジ呼び戻し → リチャージ → リペア（Perfect Tune狙い）
 * 5. 登録実行
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// ── 1軍ロスター定義 ──

interface RosterEntry {
  tokenIndex: number;
  name: string;
  terrain: string; // "MetalRoads" | "ScrapHeaps" | "WastelandSand"
  role: "regular" | "bh_backup" | "oshi";
}

const ROSTER: Record<string, RosterEntry[]> = {
  Elite: [
    { tokenIndex: 9943, name: "Ged",         terrain: "MetalRoads",    role: "regular" },
    { tokenIndex: 7486, name: "Ryo",         terrain: "MetalRoads",    role: "bh_backup" },
    { tokenIndex: 5677, name: "Usagi",       terrain: "MetalRoads",    role: "oshi" },
    { tokenIndex: 2669, name: "Bach",        terrain: "ScrapHeaps",    role: "regular" },
    { tokenIndex: 1315, name: "StraySheep",  terrain: "WastelandSand", role: "regular" },
    { tokenIndex: 5136, name: "うさぎ",       terrain: "WastelandSand", role: "oshi" },
  ],
  Raider: [
    { tokenIndex: 8313, name: "Bot8313",     terrain: "MetalRoads",    role: "regular" },
    { tokenIndex: 820,  name: "Nadia",       terrain: "MetalRoads",    role: "bh_backup" },
    { tokenIndex: 5028, name: "東西線",       terrain: "ScrapHeaps",    role: "regular" },
    { tokenIndex: 8895, name: "Papuwa",      terrain: "WastelandSand", role: "regular" },
  ],
  Junker: [
    { tokenIndex: 3535, name: "G-Max",       terrain: "MetalRoads",    role: "regular" },
    { tokenIndex: 1722, name: "Bot1722",     terrain: "ScrapHeaps",    role: "regular" },
    { tokenIndex: 3674, name: "Bot3674",     terrain: "WastelandSand", role: "regular" },
  ],
  Scrap: [
    { tokenIndex: 3406, name: "Chiikawa",    terrain: "MetalRoads",    role: "regular" },
    { tokenIndex: 631,  name: "厚切り牛タン",  terrain: "ScrapHeaps",    role: "regular" },
    { tokenIndex: 406,  name: "Noir",        terrain: "WastelandSand", role: "regular" },
  ],
};

// ── Terrain正規化 ──

function normalizeTerrain(apiTerrain: string): string {
  // API: "Metal Roads" → "MetalRoads", "Scrap Heaps" → "ScrapHeaps", "Wasteland Sand" → "WastelandSand"
  return apiTerrain.replace(/\s+/g, "");
}

// ── 型定義 ──

interface EventInfo {
  eventId: number;
  eventName: string;
  startTime: Date;
  minutesUntilStart: number;
  raceIds: number[];
}

// ── API呼び出し関数 ──

async function getAllBotClasses(client: PokedRaceMCPClient): Promise<Map<number, string>> {
  console.log("📋 Fetching all bots (for current class info)...");

  const result = await client.callTool("garage_list_my_pokedbots", { only_racers: true });

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get bot list");
  }

  const responseText = result.content[0].text;
  const classMap = new Map<number, string>();

  const botBlocks = responseText.split(/(?=🏎️ PokedBot #)/g).filter((b: string) => b.includes('PokedBot #'));

  for (const block of botBlocks) {
    const tokenMatch = block.match(/🏎️ PokedBot #(\d+)/);
    const classMatch = block.match(/🏆 Class:[^a-zA-Z]*(Scrap|Junker|Raider|Elite|SilentKlan)/);

    if (tokenMatch && classMatch) {
      classMap.set(parseInt(tokenMatch[1]), classMatch[1]);
    }
  }

  console.log(`✅ Found ${classMap.size} bots`);
  return classMap;
}

async function getUpcomingEvents(client: PokedRaceMCPClient): Promise<EventInfo[]> {
  console.log("📅 Fetching upcoming events...");

  const result = await client.callTool("racing_list_events", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get event list");
  }

  const responseText = result.content[0].text;
  const eventBlocks = responseText.split('---').filter(block => block.includes('**Event #'));

  const now = new Date();
  const allFutureEvents: EventInfo[] = [];

  for (const block of eventBlocks) {
    const eventIdMatch = block.match(/\*\*Event #(\d+)\*\*:\s*([^\n]+)/);
    const startTimeMatch = block.match(/📅 Start:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
    // Parse race IDs: "🏁 Races: #123, 124" or "🏁 Races: #123"
    const racesMatch = block.match(/🏁 Races:\s*#([\d,\s]+)/);

    if (!eventIdMatch || !startTimeMatch) continue;

    const eventId = parseInt(eventIdMatch[1]);
    const eventName = eventIdMatch[2].trim();
    const startTime = new Date(startTimeMatch[1]);
    const minutesUntilStart = Math.floor((startTime.getTime() - now.getTime()) / 60000);

    const registrationDeadline = 15;

    if (minutesUntilStart > registrationDeadline) {
      const raceIds = racesMatch
        ? racesMatch[1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
        : [];

      allFutureEvents.push({
        eventId,
        eventName,
        startTime,
        minutesUntilStart,
        raceIds,
      });
    }
  }

  allFutureEvents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  if (allFutureEvents.length > 0) {
    const nextEventTime = allFutureEvents[0].startTime.getTime();
    const nextEvents = allFutureEvents.filter(e => e.startTime.getTime() === nextEventTime);

    console.log(`✅ Found ${nextEvents.length} upcoming events (next in ${nextEvents[0].minutesUntilStart} min)`);
    return nextEvents;
  }

  console.log(`⚠️  No upcoming events found`);
  return [];
}

async function getRaceTerrains(client: PokedRaceMCPClient, raceIds: number[]): Promise<string[]> {
  const terrains: string[] = [];

  for (const raceId of raceIds) {
    try {
      const result = await client.callTool("racing_get_race_details", { race_id: raceId });
      if (!result || !result.content || !result.content[0] || !result.content[0].text) continue;

      const data = JSON.parse(result.content[0].text);
      if (data.terrain) {
        const normalized = normalizeTerrain(data.terrain);
        if (!terrains.includes(normalized)) {
          terrains.push(normalized);
        }
      }
    } catch (error) {
      console.warn(`  ⚠️  Failed to get terrain for race #${raceId}: ${error}`);
    }
  }

  return terrains;
}

async function getExistingRegistrations(client: PokedRaceMCPClient): Promise<Map<number, number[]>> {
  console.log("🔍 Checking existing registrations...");

  const result = await client.callTool("racing_get_my_registrations", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    return new Map();
  }

  const responseText = result.content[0].text;
  const registrationMap = new Map<number, number[]>();

  const regMatches = responseText.matchAll(
    /\*\*Event #(\d+)\*\*:[^\n]*\n🤖 Bot: #(\d+)/g
  );

  for (const match of regMatches) {
    const eventId = parseInt(match[1]);
    const botId = parseInt(match[2]);

    if (!registrationMap.has(eventId)) {
      registrationMap.set(eventId, []);
    }
    registrationMap.get(eventId)!.push(botId);
  }

  return registrationMap;
}

async function checkWorldBuff(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    if (!result || !result.content || !result.content[0] || !result.content[0].text) return false;

    const data = JSON.parse(result.content[0].text);
    return data.condition?.world_buff?.active === true;
  } catch {
    return false;
  }
}

interface BotCondition {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
}

async function getBotCondition(client: PokedRaceMCPClient, tokenIndex: number, name: string): Promise<BotCondition | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    if (!result || !result.content || !result.content[0] || !result.content[0].text) return null;

    const data = JSON.parse(result.content[0].text);
    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;

    let zone: string | null = null;
    if (data.active_scavenging &&
        data.active_scavenging.status &&
        typeof data.active_scavenging.status === "string" &&
        data.active_scavenging.status.includes("Active")) {
      zone = data.active_scavenging.zone || null;
    }

    return { tokenIndex, name, battery, condition, zone };
  } catch {
    return null;
  }
}

async function completeScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      if (errorMsg.includes("No active mission")) return true;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function rechargeBot(client: PokedRaceMCPClient, tokenIndex: number, name: string): Promise<boolean> {
  try {
    console.log(`   🔋 ${name}: Recharging... (0.1 ICP)`);
    const result = await client.callTool("garage_recharge_robot", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.log(`   ⚠️  ${name}: Recharge skipped - ${errorMsg}`);
      return false;
    }
    console.log(`   ✅ ${name}: Recharged (Overcharge!)`);
    return true;
  } catch (error) {
    console.log(`   ⚠️  ${name}: Recharge error - ${error}`);
    return false;
  }
}

async function repairBot(client: PokedRaceMCPClient, tokenIndex: number, name: string): Promise<boolean> {
  try {
    console.log(`   🔧 ${name}: Repairing... (0.05 ICP)`);
    const result = await client.callTool("garage_repair_robot", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.log(`   ⚠️  ${name}: Repair skipped - ${errorMsg}`);
      return false;
    }
    console.log(`   ✅ ${name}: Repaired → Perfect Tune!`);
    return true;
  } catch (error) {
    console.log(`   ⚠️  ${name}: Repair error - ${error}`);
    return false;
  }
}

async function registerForEvent(
  client: PokedRaceMCPClient,
  eventId: number,
  tokenIndex: number,
  botName: string
): Promise<boolean> {
  try {
    console.log(`   📝 Registering #${tokenIndex} (${botName}) for Event #${eventId}...`);

    const result = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: tokenIndex,
    });

    if (result.isError) {
      console.log(`   ❌ Registration failed: ${result.content?.[0]?.text || "Unknown error"}`);
      return false;
    }

    console.log(`   ✅ Registered #${tokenIndex}`);
    return true;
  } catch (error) {
    console.log(`   ❌ Error: ${error}`);
    return false;
  }
}

// ── ボット選出ロジック ──

async function selectBotsForEvent(
  client: PokedRaceMCPClient,
  rosterClass: string,
  terrains: string[],
  alreadyRegistered: number[],
  currentClassMap: Map<number, string>,
): Promise<RosterEntry[]> {
  const roster = ROSTER[rosterClass];
  if (!roster) return [];

  // terrain一致 & 未登録 & 現在のクラスが一致するボットを選出
  const candidates = roster.filter(entry => {
    if (alreadyRegistered.includes(entry.tokenIndex)) return false;
    if (!terrains.includes(entry.terrain)) return false;
    // 現在のクラスで判定（育成途中対応）
    const currentClass = currentClassMap.get(entry.tokenIndex);
    if (currentClass && currentClass !== rosterClass) return false;
    return true;
  });

  // BH枠: bh_backup のWBチェック → WB持ちを優先
  const bhCandidates = candidates.filter(e => e.role === "bh_backup");
  const regularCandidates = candidates.filter(e => e.role === "regular");
  const oshiCandidates = candidates.filter(e => e.role === "oshi");

  const selected: RosterEntry[] = [...regularCandidates];

  // BH控え: WBチェック → WB持ちなら追加
  for (const bh of bhCandidates) {
    const hasWB = await checkWorldBuff(client, bh.tokenIndex);
    if (hasWB) {
      console.log(`      🌍 ${bh.name} (#${bh.tokenIndex}): World Buff active → selected as BH`);
      selected.push(bh);
    } else {
      console.log(`      ⚪ ${bh.name} (#${bh.tokenIndex}): No World Buff → skipped BH slot`);
    }
  }

  // 推し枠: terrain一致なら追加
  for (const oshi of oshiCandidates) {
    console.log(`      💖 ${oshi.name} (#${oshi.tokenIndex}): Oshi slot → selected`);
    selected.push(oshi);
  }

  return selected;
}

// ── メイン処理 ──

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🤖 ========================================");
    console.log("🤖  AUTO EVENT REGISTRATION (Terrain-Aware)");
    console.log("🤖 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}\n`);

    // Step 1: 全ボットの現在クラスを取得
    const currentClassMap = await getAllBotClasses(client);

    // Step 2: 次のイベント取得
    const upcomingEvents = await getUpcomingEvents(client);
    if (upcomingEvents.length === 0) {
      await client.close();
      return;
    }

    // Step 3: 既存登録チェック
    const existingRegistrations = await getExistingRegistrations(client);

    let totalRegistered = 0;
    let totalRecharges = 0;
    let totalRepairs = 0;

    // Step 4: 各イベント処理
    for (const event of upcomingEvents) {
      console.log(`\n📍 Event #${event.eventId}: ${event.eventName}`);
      console.log(`   Starts in ${event.minutesUntilStart} min | Races: ${event.raceIds.map(id => `#${id}`).join(', ')}`);

      const alreadyRegistered = existingRegistrations.get(event.eventId) || [];
      if (alreadyRegistered.length > 0) {
        console.log(`   Already registered: ${alreadyRegistered.map(id => `#${id}`).join(', ')}`);
      }

      // Step 4a: レースのterrain取得
      if (event.raceIds.length === 0) {
        console.log(`   ⚠️  No race IDs found, skipping event`);
        continue;
      }

      const terrains = await getRaceTerrains(client, event.raceIds);
      console.log(`   🌍 Terrains: ${terrains.join(', ')}`);

      if (terrains.length === 0) {
        console.log(`   ⚠️  No terrains found, skipping event`);
        continue;
      }

      // Step 4b: 各クラスのボット選出
      const allSelected: RosterEntry[] = [];

      for (const rosterClass of Object.keys(ROSTER)) {
        console.log(`\n   📊 ${rosterClass} Class:`);

        const selected = await selectBotsForEvent(
          client,
          rosterClass,
          terrains,
          alreadyRegistered,
          currentClassMap,
        );

        if (selected.length === 0) {
          console.log(`      (no terrain-matching bots)`);
        } else {
          for (const bot of selected) {
            console.log(`      ✓ ${bot.name} (#${bot.tokenIndex}) [${bot.terrain}] ${bot.role !== "regular" ? `(${bot.role})` : ""}`);
          }
          allSelected.push(...selected);
        }
      }

      if (allSelected.length === 0) {
        console.log(`\n   ⚠️  No bots to register for this event`);
        continue;
      }

      console.log(`\n   📋 Total selected: ${allSelected.length} bots`);

      // Step 4c: 回復処理
      console.log(`\n   🔄 Recovery Phase:`);

      for (const entry of allSelected) {
        const botCond = await getBotCondition(client, entry.tokenIndex, entry.name);
        if (!botCond) {
          console.log(`   ⚠️  ${entry.name}: Failed to get condition, skipping recovery`);
          continue;
        }

        // スカベンジング中 → 呼び戻し
        if (botCond.zone !== null) {
          console.log(`   📥 ${entry.name}: Recalling from ${botCond.zone}`);
          await completeScavenging(client, entry.tokenIndex);
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // リチャージ → リペア の順（Perfect Tune狙い）
        if (botCond.battery < 100) {
          const success = await rechargeBot(client, entry.tokenIndex, entry.name);
          if (success) totalRecharges++;
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (botCond.condition < 100) {
          const success = await repairBot(client, entry.tokenIndex, entry.name);
          if (success) totalRepairs++;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Step 4d: 登録実行
      console.log(`\n   🏁 Registration Phase:`);

      for (const entry of allSelected) {
        const success = await registerForEvent(client, event.eventId, entry.tokenIndex, entry.name);
        if (success) totalRegistered++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Summary
    const totalCost = (totalRecharges * 0.1) + (totalRepairs * 0.05);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Summary:");
    console.log(`   Registered: ${totalRegistered} bots`);
    console.log(`   Recharged: ${totalRecharges} (${(totalRecharges * 0.1).toFixed(2)} ICP)`);
    console.log(`   Repaired: ${totalRepairs} (${(totalRepairs * 0.05).toFixed(2)} ICP)`);
    console.log(`   Recovery cost: ${totalCost.toFixed(2)} ICP`);
    if (totalRepairs > 0) {
      console.log(`   🌟 Perfect Tune attempted on ${totalRepairs} bot(s)`);
    }

    console.log("\n✅ Auto-registration complete");
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
