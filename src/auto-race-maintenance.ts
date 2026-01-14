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

interface EventInfo {
  event_id: number;
  event_name: string;
  start_time_utc: string;
  participant_bots: number[];
}

async function getAllOwnedBots(client: PokedRaceMCPClient): Promise<number[]> {
  try {
    const result = await client.callTool("garage_list_my_pokedbots");

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const responseText = result.content[0].text;
    const botMatches = responseText.matchAll(/🏎️ PokedBot #(\d+)/g);
    const botIndices: number[] = [];
    for (const match of botMatches) {
      botIndices.push(parseInt(match[1]));
    }
    return botIndices;
  } catch (error) {
    console.error(`  ✗ Failed to get owned bots:`, error);
    return [];
  }
}

async function getUpcomingEvents(client: PokedRaceMCPClient): Promise<EventInfo[]> {
  try {
    const result = await client.callTool("racing_get_my_registrations", {});

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const responseText = result.content[0].text;

    // Parse the text response to extract event registrations
    // Format: **Event #191**: Daily Sprint Challenge
    //         🤖 Bot: #5136 | Class: Elite
    //         ⏰ Starts: 1h 53m | 2026-01-14T00:00:00Z

    const eventMap = new Map<number, EventInfo>();

    const eventMatches = responseText.matchAll(/\*\*Event #(\d+)\*\*:\s*([^\n]+)\n🤖 Bot: #(\d+)[^\n]*\n[^\n]*\n⏰ Starts:[^\|]*\|\s*([^\n]+)/g);

    for (const match of eventMatches) {
      const eventId = parseInt(match[1]);
      const eventName = match[2].trim();
      const botId = parseInt(match[3]);
      const startTime = match[4].trim();

      if (!eventMap.has(eventId)) {
        eventMap.set(eventId, {
          event_id: eventId,
          event_name: eventName,
          start_time_utc: startTime,
          participant_bots: []
        });
      }

      eventMap.get(eventId)!.participant_bots.push(botId);
    }

    return Array.from(eventMap.values());
  } catch (error) {
    console.error(`  ✗ Failed to get event registrations:`, error);
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

  try {
    console.log(`\n🏁 Auto Race Maintenance (15 min before race)`);
    console.log(`📅 ${new Date().toISOString()}\n`);

    await client.connect(SERVER_URL, API_KEY);

    // 現在時刻
    const now = new Date();
    const targetTime = new Date(now.getTime() + MINUTES_BEFORE_RACE * 60 * 1000);

    console.log(`Current time: ${now.toISOString()}`);
    console.log(`Target race start time: ${targetTime.toISOString()} (${MINUTES_BEFORE_RACE} min from now)\n`);

    // 全イベント登録情報を取得
    console.log(`Fetching event registrations...`);
    const events = await getUpcomingEvents(client);
    console.log(`Found ${events.length} registered events\n`);

    if (events.length === 0) {
      console.log(`No event registrations found. Exiting.`);
      await client.close();
      return;
    }

    // イベント開始15分前のイベントを特定
    const targetEvents: EventInfo[] = [];
    for (const event of events) {
      const eventStartTime = new Date(event.start_time_utc);
      const minutesUntilEvent = (eventStartTime.getTime() - now.getTime()) / (60 * 1000);

      // 10分〜20分の範囲（余裕を持たせる）
      if (minutesUntilEvent >= 10 && minutesUntilEvent <= 20) {
        targetEvents.push(event);
        console.log(`🎯 Target event #${event.event_id} "${event.event_name}": starts at ${event.start_time_utc} (${Math.round(minutesUntilEvent)} min)`);
      }
    }

    if (targetEvents.length === 0) {
      console.log(`\nNo events starting in 10-20 minutes. Exiting.`);
      await client.close();
      return;
    }

    // イベントに参加する自分のボットを特定
    // NOTE: excluded_bots は無視！イベント参加ボットは全て処理する
    console.log(`Fetching all owned bots from API...`);
    const allOwnedBots = await getAllOwnedBots(client);
    console.log(`Found ${allOwnedBots.length} owned bots\n`);

    const botsToMaintain = new Set<number>();

    for (const event of targetEvents) {
      console.log(`Event #${event.event_id} "${event.event_name}": ${event.participant_bots.length} registered bots`);
      for (const botId of event.participant_bots) {
        if (allOwnedBots.includes(botId)) {
          botsToMaintain.add(botId);
        }
      }
    }

    console.log(`\n🤖 Found ${botsToMaintain.size} bot(s) needing maintenance before events\n`);

    if (botsToMaintain.size === 0) {
      console.log(`No owned bots in upcoming events. Exiting.`);
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
