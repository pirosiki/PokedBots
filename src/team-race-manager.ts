/**
 * Team Race Manager
 *
 * 2チーム制のレースボット運用バッチ（15分ごと実行）
 * - Aチーム: 9:00, 21:00 JST (0:00, 12:00 UTC)
 * - Bチーム: 3:00, 15:00 JST (18:00, 6:00 UTC)
 *
 * 運用フロー:
 * 1. レース後15分〜1時間15分 → ChargingStation（チャージ期間）
 * 2. チャージ期間外 → ScrapHeaps
 * 3. Bat or Cond < 10% → RepairBay（Cond 70%まで）→ 待機
 *    - 次のレースが近いチームを優先、他チームを押し出す
 *
 * レース15分前は別バッチ（daily-sprint-pre-race）で:
 * - 有料リチャージ → Jolt → 有料リペア → Perfect Tune
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

// 閾値
const MAX_REPAIR_BAY = 4;
const CRITICAL_THRESHOLD = 10;    // これ以下で撤退
const REPAIR_TARGET = 70;         // 撤退後のリペア目標
const CHARGE_DURATION_MINUTES = 60; // レース後のチャージ時間（分）

interface BotStatus {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
}

/**
 * 次のレースまでの分数を取得
 */
function getMinutesToNextRace(raceHours: number[]): number {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  let minMinutes = Infinity;

  for (const raceHour of raceHours) {
    const raceTotalMinutes = raceHour * 60;
    let diff = raceTotalMinutes - currentTotalMinutes;
    if (diff <= 0) {
      diff += 24 * 60; // 次の日
    }
    if (diff < minMinutes) {
      minMinutes = diff;
    }
  }

  return minMinutes;
}

/**
 * 現在時刻がチャージ期間内かどうかを判定
 * チャージ期間: レース終了後15分〜1時間15分
 */
function isChargePeriod(raceHours: number[]): boolean {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  for (const raceHour of raceHours) {
    // チャージ開始: レース後15分
    const chargeStart = (raceHour * 60 + 15) % (24 * 60);
    // チャージ終了: レース後1時間15分
    const chargeEnd = (raceHour * 60 + 15 + CHARGE_DURATION_MINUTES) % (24 * 60);

    // 日をまたぐ場合の処理
    if (chargeStart < chargeEnd) {
      if (currentTotalMinutes >= chargeStart && currentTotalMinutes < chargeEnd) {
        return true;
      }
    } else {
      // 日をまたぐ（例: 23:15 - 0:15）
      if (currentTotalMinutes >= chargeStart || currentTotalMinutes < chargeEnd) {
        return true;
      }
    }
  }

  return false;
}

async function getBotStatus(client: PokedRaceMCPClient, tokenIndex: number): Promise<BotStatus | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return null;
    }

    const data = JSON.parse(result.content[0].text);
    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;
    const name = data.name || `Bot #${tokenIndex}`;

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

async function startScavenging(client: PokedRaceMCPClient, tokenIndex: number, zone: string): Promise<boolean> {
  try {
    const result = await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone });
    if (result.isError) {
      const errorMsg = result.content?.[0]?.text || "Unknown error";
      if (errorMsg.includes("already on a scavenging mission")) {
        return true;
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function moveBot(client: PokedRaceMCPClient, tokenIndex: number, targetZone: string): Promise<boolean> {
  await completeScavenging(client, tokenIndex);
  await new Promise(resolve => setTimeout(resolve, 300));
  return startScavenging(client, tokenIndex, targetZone);
}

interface BotTask {
  bot: BotStatus;
  action: "scrapheaps" | "repair" | "charging" | "standby" | "none";
  reason: string;
}

/**
 * 優先チームのためにRepairBayから他チームのボットを押し出す
 */
async function evictFromRepairBay(
  client: PokedRaceMCPClient,
  otherTeamStatuses: BotStatus[],
  neededSlots: number
): Promise<number> {
  // RepairBayにいる他チームのボットを抽出
  const inRepairBay = otherTeamStatuses.filter(s => s.zone === "RepairBay");

  if (inRepairBay.length === 0 || neededSlots <= 0) {
    return 0;
  }

  const toEvict = inRepairBay.slice(0, neededSlots);
  let evictedCount = 0;

  console.log(`\n🚨 Evicting ${toEvict.length} bot(s) from RepairBay for priority team...`);

  for (const bot of toEvict) {
    try {
      await completeScavenging(client, bot.tokenIndex);
      console.log(`   ➡️ #${bot.tokenIndex} ${bot.name} → Standby (evicted)`);
      evictedCount++;
    } catch (e) {
      console.log(`   ❌ #${bot.tokenIndex} ${bot.name} eviction failed: ${e}`);
    }
  }

  return evictedCount;
}

function planBotAction(bot: BotStatus, repairBayCount: number, isCharging: boolean): { task: BotTask; newRepairCount: number } {
  const { battery, condition, zone } = bot;

  // 優先1: バッテリー or コンディションが10%を切った → 撤退モード
  if (battery < CRITICAL_THRESHOLD || condition < CRITICAL_THRESHOLD) {
    // コンディション70%未満 → RepairBay
    if (condition < REPAIR_TARGET) {
      if (zone === "RepairBay") {
        return { task: { bot, action: "none", reason: `critical repair (${condition}%)` }, newRepairCount: repairBayCount };
      }
      if (repairBayCount < MAX_REPAIR_BAY) {
        return { task: { bot, action: "repair", reason: `Bat ${battery}% or Cond ${condition}% < ${CRITICAL_THRESHOLD}%` }, newRepairCount: repairBayCount + 1 };
      }
      // RepairBay満員 → 待機（何もしない）
      if (zone !== null) {
        return { task: { bot, action: "standby", reason: "waiting for RepairBay" }, newRepairCount: repairBayCount };
      }
      return { task: { bot, action: "none", reason: "waiting for RepairBay" }, newRepairCount: repairBayCount };
    }
    // コンディション70%以上 → 待機
    if (zone !== null) {
      return { task: { bot, action: "standby", reason: `critical standby (Bat ${battery}%)` }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "none", reason: `standby (Bat ${battery}%, Cond ${condition}%)` }, newRepairCount: repairBayCount };
  }

  // 優先2: チャージ期間中 → ChargingStation
  if (isCharging) {
    if (zone === "ChargingStation") {
      return { task: { bot, action: "none", reason: `charging period (${battery}%)` }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "charging", reason: "charge period" }, newRepairCount: repairBayCount };
  }

  // 優先3: チャージ期間外 → ScrapHeaps
  if (zone === "ScrapHeaps") {
    return { task: { bot, action: "none", reason: "scavenging OK" }, newRepairCount: repairBayCount };
  }
  return { task: { bot, action: "scrapheaps", reason: "ready to scavenge" }, newRepairCount: repairBayCount };
}

async function processTeam(
  client: PokedRaceMCPClient,
  teamName: string,
  teamBots: number[],
  raceHours: number[],
  isPriority: boolean,
  otherTeamStatuses: BotStatus[]
): Promise<{ statuses: BotStatus[] }> {
  const isCharging = isChargePeriod(raceHours);
  const minutesToRace = getMinutesToNextRace(raceHours);
  const modeLabel = isCharging ? "CHARGE" : "SCAVENGE";
  const priorityLabel = isPriority ? " ★PRIORITY" : "";

  console.log(`\n📋 ${teamName} (${modeLabel} mode)${priorityLabel}`);
  console.log(`   Next race in ${minutesToRace} minutes`);

  // ステータス取得（並列）
  const statusPromises = teamBots.map(tokenIndex => getBotStatus(client, tokenIndex));
  const results = await Promise.allSettled(statusPromises);
  const statuses: BotStatus[] = results
    .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);

  console.log(`   Got ${statuses.length}/${teamBots.length} bot statuses`);

  // 優先チームの場合、RepairBayが必要なボットをカウントし、必要なら他チームを押し出す
  if (isPriority) {
    const needRepair = statuses.filter(s =>
      (s.battery < CRITICAL_THRESHOLD || s.condition < CRITICAL_THRESHOLD) &&
      s.condition < REPAIR_TARGET &&
      s.zone !== "RepairBay"
    );
    const currentInRepairBay = statuses.filter(s => s.zone === "RepairBay").length;
    const availableSlots = MAX_REPAIR_BAY - currentInRepairBay;
    const neededSlots = needRepair.length - availableSlots;

    if (neededSlots > 0) {
      await evictFromRepairBay(client, otherTeamStatuses, neededSlots);
    }
  }

  // RepairBay使用数をカウント（このチームのボットのみ）
  let repairBayCount = statuses.filter(s => s.zone === "RepairBay").length;

  // タスク計画
  const tasks: BotTask[] = [];
  for (const bot of statuses) {
    const { task, newRepairCount } = planBotAction(bot, repairBayCount, isCharging);
    tasks.push(task);
    repairBayCount = newRepairCount;
  }

  // ステータス表示
  for (const task of tasks) {
    const { bot, action, reason } = task;
    const icon = bot.zone === "ScrapHeaps" ? "⛏️" :
                 bot.zone === "RepairBay" ? "🔧" :
                 bot.zone === "ChargingStation" ? "🔌" : "💤";
    const actionIcon = action === "none" ? "" : ` → ${action}`;
    console.log(`   ${icon} #${bot.tokenIndex} ${bot.name}: Bat=${bot.battery}%, Cond=${bot.condition}% (${reason})${actionIcon}`);
  }

  // アクション実行（並列）
  const activeTasks = tasks.filter(t => t.action !== "none");
  if (activeTasks.length === 0) {
    console.log(`   No actions needed`);
    return { statuses };
  }

  console.log(`\n   Executing ${activeTasks.length} actions...`);

  const actionPromises = activeTasks.map(async (task): Promise<{ task: BotTask; success: boolean }> => {
    const targetZone = task.action === "scrapheaps" ? "ScrapHeaps" :
                       task.action === "repair" ? "RepairBay" :
                       task.action === "charging" ? "ChargingStation" : null;
    try {
      if (task.action === "standby") {
        await completeScavenging(client, task.bot.tokenIndex);
      } else if (targetZone) {
        await moveBot(client, task.bot.tokenIndex, targetZone);
      }
      return { task, success: true };
    } catch {
      return { task, success: false };
    }
  });

  const actionResults = await Promise.allSettled(actionPromises);
  let successCount = 0;
  let failedTasks: BotTask[] = [];

  for (const result of actionResults) {
    if (result.status === "fulfilled") {
      if (result.value.success) {
        successCount++;
        const t = result.value.task;
        console.log(`   ✅ #${t.bot.tokenIndex} ${t.bot.name} → ${t.action}`);
      } else {
        failedTasks.push(result.value.task);
      }
    }
  }

  // 失敗リトライ
  if (failedTasks.length > 0) {
    console.log(`   Retrying ${failedTasks.length} failed...`);
    for (const task of failedTasks) {
      const targetZone = task.action === "scrapheaps" ? "ScrapHeaps" :
                         task.action === "repair" ? "RepairBay" :
                         task.action === "charging" ? "ChargingStation" : null;
      try {
        if (task.action === "standby") {
          await completeScavenging(client, task.bot.tokenIndex);
        } else if (targetZone) {
          await moveBot(client, task.bot.tokenIndex, targetZone);
        }
        console.log(`   ✅ #${task.bot.tokenIndex} ${task.bot.name} → ${task.action} (retry)`);
        successCount++;
      } catch (e) {
        console.log(`   ❌ #${task.bot.tokenIndex} ${task.bot.name} failed: ${e}`);
      }
    }
  }

  console.log(`   Completed: ${successCount}/${activeTasks.length}`);
  return { statuses };
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  TEAM RACE MANAGER");
    console.log("🏁 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🅰️  Team A: ${TEAM_A.length} bots (races at 9:00, 21:00 JST)`);
    console.log(`🅱️  Team B: ${TEAM_B.length} bots (races at 3:00, 15:00 JST)`);

    // どちらのチームが次のレースに近いか判定
    const minutesToA = getMinutesToNextRace(TEAM_A_RACE_HOURS);
    const minutesToB = getMinutesToNextRace(TEAM_B_RACE_HOURS);
    const teamAFirst = minutesToA <= minutesToB;

    console.log(`\n⏰ Team A: ${minutesToA}min to race, Team B: ${minutesToB}min to race`);
    console.log(`   Priority: ${teamAFirst ? "Team A" : "Team B"}`);

    // 優先チームを先に処理
    if (teamAFirst) {
      // Team Bのステータスを先に取得（押し出し判定用）
      const teamBStatusPromises = TEAM_B.map(tokenIndex => getBotStatus(client, tokenIndex));
      const teamBResults = await Promise.allSettled(teamBStatusPromises);
      const teamBStatuses: BotStatus[] = teamBResults
        .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
        .map(r => r.value!);

      await processTeam(client, "Team A", TEAM_A, TEAM_A_RACE_HOURS, true, teamBStatuses);
      await processTeam(client, "Team B", TEAM_B, TEAM_B_RACE_HOURS, false, []);
    } else {
      // Team Aのステータスを先に取得（押し出し判定用）
      const teamAStatusPromises = TEAM_A.map(tokenIndex => getBotStatus(client, tokenIndex));
      const teamAResults = await Promise.allSettled(teamAStatusPromises);
      const teamAStatuses: BotStatus[] = teamAResults
        .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
        .map(r => r.value!);

      await processTeam(client, "Team B", TEAM_B, TEAM_B_RACE_HOURS, true, teamAStatuses);
      await processTeam(client, "Team A", TEAM_A, TEAM_A_RACE_HOURS, false, []);
    }

    console.log("\n✅ Complete");
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
