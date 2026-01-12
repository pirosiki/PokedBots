/**
 * Auto-Race-Maintenance (Batch Processing)
 *
 * Prepares bots for races 15 minutes before start time.
 * IMPORTANT: Processing order matters for Perfect Tune buff!
 *
 * Phase 1: Recall from scavenging (parallel)
 * Phase 2: Recharge battery (parallel) → Adds overcharge
 * Phase 3: Repair condition (parallel) → Converts to Perfect Tune!
 *
 * Perfect Tune > Overcharge, so always recharge BEFORE repair.
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// レース15分前に実行するメンテナンス閾値
const BATTERY_THRESHOLD = 100;     // バッテリー100%未満ならリチャージ
const CONDITION_THRESHOLD = 100;   // コンディション100%未満ならリペア
const MINUTES_BEFORE_RACE = 15;    // レース何分前に処理するか

interface BotStatus {
  token_index: number;
  battery: number;
  condition: number;
  scavenging_zone: string | null;
  name?: string;
}

interface RaceInfo {
  race_id: number;
  start_time_utc: string;
  participant_bots: number[];
}

async function getUpcomingRaces(client: PokedRaceMCPClient): Promise<RaceInfo[]> {
  try {
    const result = await client.callTool("racing_list_races", {
      status: "Upcoming",
      sort_by: "start_time"
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const data = JSON.parse(result.content[0].text);
    const races = data.races || [];

    const raceInfos: RaceInfo[] = [];
    for (const race of races) {
      // レース詳細を取得して参加者を確認
      const detailResult = await client.callTool("racing_get_race_details", {
        race_id: race.race_id
      });

      if (detailResult && detailResult.content && detailResult.content[0] && detailResult.content[0].text) {
        const detailData = JSON.parse(detailResult.content[0].text);
        const entries = detailData.entries || [];
        const participantBots = entries.map((entry: any) => parseInt(entry.nft_id));

        raceInfos.push({
          race_id: race.race_id,
          start_time_utc: race.start_time_utc,
          participant_bots: participantBots
        });
      }

      // API負荷軽減
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return raceInfos;
  } catch (error) {
    console.error(`  ✗ Failed to get upcoming races:`, error);
    return [];
  }
}

async function getBotStatus(client: PokedRaceMCPClient, tokenIndex: number): Promise<BotStatus | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.warn(`  ⚠️  Empty response for bot #${tokenIndex}, skipping...`);
      return null;
    }

    const text = result.content[0].text;
    const data = JSON.parse(text);

    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;

    let scavenging_zone: string | null = null;
    if (data.active_scavenging && data.active_scavenging.status !== "None") {
      scavenging_zone = data.active_scavenging.zone || null;
    }

    const name = data.name || undefined;

    return {
      token_index: tokenIndex,
      battery,
      condition,
      scavenging_zone,
      name,
    };
  } catch (error) {
    console.error(`Failed to get status for bot #${tokenIndex}:`, error);
    return null;
  }
}

async function completeScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.error(`  ✗ Failed to complete scavenging for bot #${tokenIndex}: ${errorMsg}`);
      return false;
    }
    console.log(`  ✓ Recalled bot #${tokenIndex} from scavenging`);
    return true;
  } catch (error: any) {
    console.error(`  ✗ Exception during scavenging completion for bot #${tokenIndex}:`, error.message);
    return false;
  }
}

async function rechargeBot(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    console.log(`  → Recharging bot #${tokenIndex}... (Cost: 0.1 ICP + fee)`);
    const result = await client.callTool("garage_recharge_robot", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.error(`  ✗ Failed to recharge bot #${tokenIndex}: ${errorMsg}`);
      return false;
    }
    console.log(`  ✓ Recharged bot #${tokenIndex}`);
    return true;
  } catch (error: any) {
    console.error(`  ✗ Exception during recharge for bot #${tokenIndex}:`, error.message);
    return false;
  }
}

async function repairBot(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    console.log(`  → Repairing bot #${tokenIndex}... (Cost: 0.05 ICP + fee)`);
    const result = await client.callTool("garage_repair_robot", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      console.error(`  ✗ Failed to repair bot #${tokenIndex}: ${errorMsg}`);
      return false;
    }
    console.log(`  ✓ Repaired bot #${tokenIndex}`);
    return true;
  } catch (error: any) {
    console.error(`  ✗ Exception during repair for bot #${tokenIndex}:`, error.message);
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    console.log(`\n🏁 Auto Race Maintenance (15 min before race)`);
    console.log(`📅 ${new Date().toISOString()}\n`);

    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    // 現在時刻
    const now = new Date();
    const targetTime = new Date(now.getTime() + MINUTES_BEFORE_RACE * 60 * 1000);

    console.log(`Current time: ${now.toISOString()}`);
    console.log(`Target race start time: ${targetTime.toISOString()} (${MINUTES_BEFORE_RACE} min from now)\n`);

    // 全レース情報を取得
    console.log(`Fetching upcoming races...`);
    const races = await getUpcomingRaces(client);
    console.log(`Found ${races.length} upcoming races\n`);

    if (races.length === 0) {
      console.log(`No upcoming races found. Exiting.`);
      await client.close();
      return;
    }

    // レース開始15分前のレースを特定
    const targetRaces: RaceInfo[] = [];
    for (const race of races) {
      const raceStartTime = new Date(race.start_time_utc);
      const minutesUntilRace = (raceStartTime.getTime() - now.getTime()) / (60 * 1000);

      // 10分〜20分の範囲（余裕を持たせる）
      if (minutesUntilRace >= 10 && minutesUntilRace <= 20) {
        targetRaces.push(race);
        console.log(`🎯 Target race #${race.race_id}: starts at ${race.start_time_utc} (${Math.round(minutesUntilRace)} min)`);
      }
    }

    if (targetRaces.length === 0) {
      console.log(`\nNo races starting in 10-20 minutes. Exiting.`);
      await client.close();
      return;
    }

    // レースに参加する自分のボットを特定
    const allOwnedBots = [...botManager.getRacingBots(), ...botManager.getScavengingBots()];
    const botsToMaintain = new Set<number>();

    for (const race of targetRaces) {
      for (const botId of race.participant_bots) {
        if (allOwnedBots.includes(botId)) {
          botsToMaintain.add(botId);
        }
      }
    }

    console.log(`\n🤖 Found ${botsToMaintain.size} bot(s) needing maintenance before races\n`);

    if (botsToMaintain.size === 0) {
      console.log(`No owned bots in upcoming races. Exiting.`);
      await client.close();
      return;
    }

    // ============================================================
    // PHASE 0: Get all bot statuses
    // ============================================================
    console.log(`\n📊 Phase 0: Fetching bot statuses...`);
    const botStatuses = new Map<number, BotStatus>();

    for (const tokenIndex of Array.from(botsToMaintain)) {
      const status = await getBotStatus(client, tokenIndex);
      if (status) {
        botStatuses.set(tokenIndex, status);
        const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
        console.log(`  ✓ ${displayName}: Battery ${status.battery}%, Condition ${status.condition}%, Zone: ${status.scavenging_zone || "None"}`);
      } else {
        console.log(`  ✗ Bot #${tokenIndex}: Could not get status`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\n✅ Phase 0 complete: ${botStatuses.size}/${botsToMaintain.size} bots ready`);

    // ============================================================
    // PHASE 1: Recall all bots from scavenging (PARALLEL)
    // ============================================================
    const scavengingBots = Array.from(botStatuses.entries())
      .filter(([_, status]) => status.scavenging_zone !== null)
      .map(([tokenIndex, _]) => tokenIndex);

    if (scavengingBots.length > 0) {
      console.log(`\n📥 Phase 1: Recalling ${scavengingBots.length} bot(s) from scavenging...`);

      const recallPromises = scavengingBots.map(async (tokenIndex) => {
        const status = botStatuses.get(tokenIndex)!;
        const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
        console.log(`  → ${displayName} from ${status.scavenging_zone}`);
        return completeScavenging(client, tokenIndex);
      });

      await Promise.all(recallPromises);
      console.log(`\n✅ Phase 1 complete: All bots recalled`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for recalls to settle
    } else {
      console.log(`\n✓ Phase 1 skipped: No bots in scavenging zones`);
    }

    // ============================================================
    // PHASE 2: Recharge all bots < 100% battery (PARALLEL)
    // ============================================================
    const rechargeNeeded = Array.from(botStatuses.entries())
      .filter(([_, status]) => status.battery < BATTERY_THRESHOLD)
      .map(([tokenIndex, _]) => tokenIndex);

    let rechargeCount = 0;
    if (rechargeNeeded.length > 0) {
      console.log(`\n🔋 Phase 2: Recharging ${rechargeNeeded.length} bot(s)...`);

      const rechargePromises = rechargeNeeded.map(async (tokenIndex) => {
        const status = botStatuses.get(tokenIndex)!;
        const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
        console.log(`  → ${displayName} (${status.battery}%)`);
        const success = await rechargeBot(client, tokenIndex);
        if (success) rechargeCount++;
        return success;
      });

      await Promise.all(rechargePromises);
      console.log(`\n✅ Phase 2 complete: ${rechargeCount}/${rechargeNeeded.length} recharged successfully`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for recharges to settle
    } else {
      console.log(`\n✓ Phase 2 skipped: All bots have sufficient battery`);
    }

    // ============================================================
    // PHASE 3: Repair all bots < 100% condition (PARALLEL)
    // → This triggers PERFECT TUNE when done after recharge!
    // ============================================================
    const repairNeeded = Array.from(botStatuses.entries())
      .filter(([_, status]) => status.condition < CONDITION_THRESHOLD)
      .map(([tokenIndex, _]) => tokenIndex);

    let repairCount = 0;
    if (repairNeeded.length > 0) {
      console.log(`\n🔧 Phase 3: Repairing ${repairNeeded.length} bot(s) (→ Perfect Tune)...`);

      const repairPromises = repairNeeded.map(async (tokenIndex) => {
        const status = botStatuses.get(tokenIndex)!;
        const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
        console.log(`  → ${displayName} (${status.condition}%)`);
        const success = await repairBot(client, tokenIndex);
        if (success) repairCount++;
        return success;
      });

      await Promise.all(repairPromises);
      console.log(`\n✅ Phase 3 complete: ${repairCount}/${repairNeeded.length} repaired successfully`);
      console.log(`   🌟 Perfect Tune buff applied to repaired bots!`);
    } else {
      console.log(`\n✓ Phase 3 skipped: All bots have sufficient condition`);
    }

    // ============================================================
    // Summary
    // ============================================================
    const totalCost = (rechargeCount * 0.1) + (repairCount * 0.05);

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`\n✅ Maintenance completed`);
    console.log(`   Bots processed: ${botStatuses.size}/${botsToMaintain.size}`);
    console.log(`   Recalled: ${scavengingBots.length}`);
    console.log(`   Recharged: ${rechargeCount}/${rechargeNeeded.length}`);
    console.log(`   Repaired: ${repairCount}/${repairNeeded.length}`);
    console.log(`   Total cost: ${totalCost.toFixed(2)} ICP (+ transfer fees)`);

    await client.close();
  } catch (error) {
    console.error("Error in auto-race-maintenance:", error);
    process.exit(1);
  }
}

main();
