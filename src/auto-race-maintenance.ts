import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// レース15分前に実行するメンテナンス閾値
const BATTERY_THRESHOLD = 90;      // バッテリー90%未満ならリチャージ
const CONDITION_THRESHOLD = 80;    // コンディション80%未満ならリペア
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

    let totalCost = 0;
    let successCount = 0;

    // 各ボットのメンテナンス
    for (const tokenIndex of Array.from(botsToMaintain)) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      const status = await getBotStatus(client, tokenIndex);
      if (!status) {
        console.log(`⚠️  Could not get status for bot #${tokenIndex}, skipping...`);
        continue;
      }

      const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
      console.log(`🤖 Bot ${displayName}`);
      console.log(`   Battery: ${status.battery}%, Condition: ${status.condition}%`);
      console.log(`   Zone: ${status.scavenging_zone || "None"}`);

      // Step 1: スカベンジング中なら呼び戻し
      if (status.scavenging_zone) {
        console.log(`\n📥 Recalling from scavenging zone: ${status.scavenging_zone}`);
        await completeScavenging(client, tokenIndex);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Step 2: バッテリーチェック & リチャージ
      if (status.battery < BATTERY_THRESHOLD) {
        console.log(`\n🔋 Battery ${status.battery}% < ${BATTERY_THRESHOLD}%, recharging...`);
        const recharged = await rechargeBot(client, tokenIndex);
        if (recharged) {
          totalCost += 0.1;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log(`\n✓ Battery ${status.battery}% is sufficient (>= ${BATTERY_THRESHOLD}%)`);
      }

      // Step 3: コンディションチェック & リペア
      if (status.condition < CONDITION_THRESHOLD) {
        console.log(`\n🔧 Condition ${status.condition}% < ${CONDITION_THRESHOLD}%, repairing...`);
        const repaired = await repairBot(client, tokenIndex);
        if (repaired) {
          totalCost += 0.05;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        console.log(`\n✓ Condition ${status.condition}% is sufficient (>= ${CONDITION_THRESHOLD}%)`);
      }

      successCount++;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`\n✅ Maintenance completed`);
    console.log(`   Processed: ${successCount}/${botsToMaintain.size} bots`);
    console.log(`   Estimated cost: ${totalCost.toFixed(2)} ICP (+ transfer fees)`);

    await client.close();
  } catch (error) {
    console.error("Error in auto-race-maintenance:", error);
    process.exit(1);
  }
}

main();
