/**
 * Daily Sprint Pre-Race Maintenance (Team System)
 *
 * 各チームのレース30分前に実行:
 * 1. バッテリー < 100% → 有料リチャージ (0.1 ICP)
 * 2. リチャージ後もバッテリー < 100% → Jolt (バッテリー放電)
 * 3. コンディション < 100% → 有料リペア (0.05 ICP)
 *
 * 順番: リチャージ → Jolt → リペア = Perfect Tune獲得
 *
 * - Aチーム: 9:00, 21:00 JST (0:00, 12:00 UTC)
 * - Bチーム: 3:00, 15:00 JST (18:00, 6:00 UTC)
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// Aチーム: 9:00, 21:00 JST (0:00, 12:00 UTC)
const TEAM_A = [
  433, 2669, 5136, 6152, 9943, 2632, 2441, 9888, 7098,
  758, 1170, 3535, 9048, 2475, 3406, 406, 8868, 631, 7522
];

// Bチーム: 3:00, 15:00 JST (18:00, 6:00 UTC)
const TEAM_B = [
  5677, 8288, 5143, 1203, 820, 1315, 2630, 1866, 7486,
  1209, 8895, 9035, 9567, 5028, 7680, 8636, 5400, 5441
];

// レース時刻 (UTC時)
const TEAM_A_RACE_HOURS = [0, 12];  // 9:00, 21:00 JST
const TEAM_B_RACE_HOURS = [6, 18];  // 3:00, 15:00 JST

interface BotInfo {
  tokenIndex: number;
  battery: number;
  condition: number;
  zone: string | null;
}

function getCurrentTeam(): { name: string; bots: number[]; raceHours: number[] } {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  function getMinutesToRace(raceHours: number[]): number {
    const currentTotalMinutes = hour * 60 + minute;
    let minMinutes = Infinity;
    for (const raceHour of raceHours) {
      const raceTotalMinutes = raceHour * 60;
      let diff = raceTotalMinutes - currentTotalMinutes;
      if (diff <= 0) diff += 24 * 60;
      if (diff < minMinutes) minMinutes = diff;
    }
    return minMinutes;
  }

  const minutesToA = getMinutesToRace(TEAM_A_RACE_HOURS);
  const minutesToB = getMinutesToRace(TEAM_B_RACE_HOURS);

  if (minutesToA <= minutesToB) {
    return { name: "Team A", bots: TEAM_A, raceHours: TEAM_A_RACE_HOURS };
  } else {
    return { name: "Team B", bots: TEAM_B, raceHours: TEAM_B_RACE_HOURS };
  }
}

async function getBotStatus(client: PokedRaceMCPClient, tokenIndex: number): Promise<BotInfo | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return null;
    }

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

    return { tokenIndex, battery, condition, zone };
  } catch {
    return null;
  }
}

async function completeScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<boolean> {
  try {
    const result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      if (errorMsg.includes("No active mission")) {
        return true;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

interface BatteryInfo {
  id: number;
  stored_kwh: number;
  is_operational: boolean;
}

async function getUsableBatteries(client: PokedRaceMCPClient): Promise<BatteryInfo[]> {
  try {
    const result = await client.callTool("garage_list_batteries", {});
    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const data = JSON.parse(result.content[0].text);
    if (!data.batteries) return [];

    // stored_kwhが多い順にソート。Joltには20 kWh必要だが、
    // 足りなくなったら次のバッテリーに切り替える
    return data.batteries
      .filter((b: any) => b.stored_kwh > 0)
      .sort((a: any, b: any) => b.stored_kwh - a.stored_kwh) // 容量が多い順
      .map((b: any) => ({
        id: b.id,
        stored_kwh: b.stored_kwh,
        is_operational: b.is_operational,
      }));
  } catch {
    return [];
  }
}

interface JoltResult {
  success: boolean;
  error?: string;
  isBatteryExhausted?: boolean;
}

async function joltBot(client: PokedRaceMCPClient, tokenIndex: number, batteryId: number): Promise<JoltResult> {
  try {
    const result = await client.callTool("garage_jolt_bot", {
      token_index: tokenIndex,
      battery_id: batteryId,
    });
    if (result.isError) {
      const errorText = result.content?.[0]?.text || "";
      const isBatteryExhausted = errorText.includes("insufficient") || errorText.includes("not enough");
      return { success: false, error: errorText, isBatteryExhausted };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  PRE-RACE MAINTENANCE (TEAM SYSTEM)");
    console.log("🏁 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);

    // 現在のチームを判定
    const team = getCurrentTeam();
    console.log(`\n🎯 ${team.name}: ${team.bots.length} bots`);
    console.log(`   Race hours (UTC): ${team.raceHours.join(", ")}`);

    // ステータス取得（並列）
    console.log("\n📡 Fetching bot statuses...");
    const statusPromises = team.bots.map(tokenIndex => getBotStatus(client, tokenIndex));
    const results = await Promise.allSettled(statusPromises);
    const bots: BotInfo[] = results
      .filter((r): r is PromiseFulfilledResult<BotInfo | null> => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value!);

    console.log(`✅ Got ${bots.length}/${team.bots.length} bot statuses`);

    if (bots.length === 0) {
      console.log("⚠️  No bots found");
      await client.close();
      return;
    }

    // Phase 0: 全ボットのスカベンジングを完了させる（念のため全員）
    console.log(`\n📥 Phase 0: Recalling all ${bots.length} bot(s) from any activity...`);
    const recallPromises = bots.map(async (bot) => {
      try {
        await completeScavenging(client, bot.tokenIndex);
        return { bot, success: true };
      } catch {
        return { bot, success: false };
      }
    });
    await Promise.allSettled(recallPromises);
    // 少し待機してスカベンジング完了を確実に
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(`   ✅ Recalled`);

    // 状態表示
    console.log("\n📊 Current Status:");
    for (const bot of bots) {
      const batteryIcon = bot.battery < 100 ? "⚠️" : "✓";
      const condIcon = bot.condition < 100 ? "⚠️" : "✓";
      console.log(`   ${batteryIcon}${condIcon} #${bot.tokenIndex}: Battery=${bot.battery}%, Condition=${bot.condition}%`);
    }

    let rechargeCount = 0;
    let joltCount = 0;
    let repairCount = 0;

    // Phase 1: バッテリー < 100% → 有料リチャージ
    const needRecharge = bots.filter(b => b.battery < 100);
    if (needRecharge.length > 0) {
      console.log(`\n🔋 Phase 1: Recharging ${needRecharge.length} bot(s)...`);

      const rechargePromises = needRecharge.map(async (bot) => {
        try {
          const result = await client.callTool("garage_recharge_robot", { token_index: bot.tokenIndex });
          if (result.isError) {
            return { bot, success: false, error: result.content?.[0]?.text };
          }
          return { bot, success: true };
        } catch (e) {
          return { bot, success: false, error: String(e) };
        }
      });

      const rechargeResults = await Promise.allSettled(rechargePromises);

      for (const result of rechargeResults) {
        if (result.status === "fulfilled" && result.value.success) {
          console.log(`   ✅ #${result.value.bot.tokenIndex}: Recharged`);
          rechargeCount++;
        } else if (result.status === "fulfilled") {
          console.log(`   ❌ #${result.value.bot.tokenIndex}: ${result.value.error}`);
        }
      }
    } else {
      console.log("\n✓ Phase 1: All bots have 100% battery");
    }

    // Phase 1.5: リチャージ後もバッテリー < 100% → Jolt
    // 再度ステータスを取得
    console.log("\n📡 Re-checking battery levels...");
    const recheckPromises = team.bots.map(tokenIndex => getBotStatus(client, tokenIndex));
    const recheckResults = await Promise.allSettled(recheckPromises);
    const recheckBots: BotInfo[] = recheckResults
      .filter((r): r is PromiseFulfilledResult<BotInfo | null> => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value!);

    console.log(`   Got ${recheckBots.length}/${team.bots.length} bot statuses`);
    for (const bot of recheckBots) {
      const icon = bot.battery < 100 ? "⚠️" : "✓";
      console.log(`   ${icon} #${bot.tokenIndex}: ${bot.battery}%`);
    }

    const stillNeedCharge = recheckBots.filter(b => b.battery < 100);
    if (stillNeedCharge.length > 0) {
      console.log(`\n⚡ Phase 1.5: Jolting ${stillNeedCharge.length} bot(s) still under 100%...`);

      // 使用可能なバッテリーを取得
      let batteries = await getUsableBatteries(client);
      console.log(`   Available batteries: ${batteries.length}`);

      if (batteries.length > 0) {
        const exhaustedBatteries = new Set<number>(); // 使い果たしたバッテリーを追跡

        for (const bot of stillNeedCharge) {
          let currentBattery = bot.battery;
          let joltAttempts = 0;
          let failureCount = 0;
          const maxJolts = 5; // 安全のため最大5回
          const maxFailures = 3; // 連続失敗の上限

          while (currentBattery < 100 && joltAttempts < maxJolts && failureCount < maxFailures) {
            // バッテリー一覧を再取得（使い果たしたバッテリーを除外）
            batteries = await getUsableBatteries(client);
            batteries = batteries.filter(b => !exhaustedBatteries.has(b.id));

            if (batteries.length === 0) {
              console.log(`   ⚠️  No more batteries available for #${bot.tokenIndex}`);
              break;
            }

            // 現在のバッテリーを試す
            const battery = batteries[0];
            const result = await joltBot(client, bot.tokenIndex, battery.id);

            if (result.success) {
              joltAttempts++;
              joltCount++;
              failureCount = 0; // リセット

              // Jolt後のバッテリーレベルを確認
              const updatedStatus = await getBotStatus(client, bot.tokenIndex);
              currentBattery = updatedStatus?.battery ?? 100;
              console.log(`   ⚡ #${bot.tokenIndex}: Jolted x${joltAttempts} (Battery #${battery.id}) → ${currentBattery}%`);

              if (currentBattery >= 100) {
                console.log(`   ✅ #${bot.tokenIndex}: Fully charged!`);
              }
            } else {
              failureCount++;
              if (result.isBatteryExhausted) {
                console.log(`   ⚠️  Battery #${battery.id} exhausted, trying next...`);
                exhaustedBatteries.add(battery.id);
              } else {
                console.log(`   ❌ #${bot.tokenIndex}: Jolt failed - ${result.error}`);
              }
            }
          }

          if (failureCount >= maxFailures) {
            console.log(`   ❌ #${bot.tokenIndex}: Too many failures, skipping`);
          }
        }
      } else {
        console.log(`   ⚠️  No operational batteries available for jolting`);
      }
    } else {
      console.log("✓ Phase 1.5: All bots now have 100% battery");
    }

    // Phase 2: コンディション < 100% → 有料リペア
    // リペア前に再度呼び戻し（リペアはスカベンジング中不可）
    console.log("\n📥 Recalling all bots before repair...");
    const recallBeforeRepair = team.bots.map(async (tokenIndex) => {
      await completeScavenging(client, tokenIndex);
    });
    await Promise.allSettled(recallBeforeRepair);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const needRepair = bots.filter(b => b.condition < 100);
    if (needRepair.length > 0) {
      console.log(`\n🔧 Phase 2: Repairing ${needRepair.length} bot(s) → Perfect Tune...`);

      const repairPromises = needRepair.map(async (bot) => {
        try {
          const result = await client.callTool("garage_repair_robot", { token_index: bot.tokenIndex });
          if (result.isError) {
            return { bot, success: false, error: result.content?.[0]?.text };
          }
          return { bot, success: true };
        } catch (e) {
          return { bot, success: false, error: String(e) };
        }
      });

      const repairResults = await Promise.allSettled(repairPromises);

      for (const result of repairResults) {
        if (result.status === "fulfilled" && result.value.success) {
          console.log(`   ✅ #${result.value.bot.tokenIndex}: Perfect Tune!`);
          repairCount++;
        } else if (result.status === "fulfilled") {
          console.log(`   ❌ #${result.value.bot.tokenIndex}: ${result.value.error}`);
        }
      }
    } else {
      console.log("\n✓ Phase 2: All bots have 100% condition");
    }

    // Summary
    const totalCost = (rechargeCount * 0.1) + (repairCount * 0.05);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Summary:");
    console.log(`   Recharged: ${rechargeCount}/${needRecharge.length}`);
    if (joltCount > 0) {
      console.log(`   Jolted: ${joltCount}`);
    }
    console.log(`   Repaired: ${repairCount}/${needRepair.length}`);
    console.log(`   Total cost: ${totalCost.toFixed(2)} ICP (+ fees)`);
    if (repairCount > 0) {
      console.log(`   🌟 Perfect Tune applied to ${repairCount} bot(s)!`);
    }

    console.log(`\n✅ ${team.name} pre-race maintenance complete - Ready to race!`);

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
