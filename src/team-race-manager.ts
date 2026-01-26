/**
 * Team Race Manager
 *
 * 2チーム制のレースボット運用バッチ
 * - Aチーム: 9:00, 21:00 JST (0:00, 12:00 UTC)
 * - Bチーム: 3:00, 15:00 JST (18:00, 6:00 UTC)
 *
 * 運用フロー:
 * 1. レース後〜レース1時間前: スカベンジングモード
 *    - Bat≥50% & Cond≥70% → ScrapHeaps
 *    - Bat≤30% or Cond<70% → RepairBay(空きあれば)/Charging
 *    - 回復したら再度ScrapHeaps
 *
 * 2. レース1時間前〜レース開始: 回復モード
 *    - Bat≥30% & Cond≥70% まで回復して待機
 *    - 条件満たしたら無駄なリチャージ/リペアしない
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// Aチーム: 9:00, 21:00 JST (0:00, 12:00 UTC)
const TEAM_A = [
  433, 2669, 5136, 6152, 9943, 2632, 2441, 9888, 7098,
  758, 1170, 3535, 9048, 2475, 3406, 406, 8868, 631
];

// Bチーム: 3:00, 15:00 JST (18:00, 6:00 UTC)
const TEAM_B = [
  5677, 8288, 5143, 1203, 820, 1315, 2630, 1866, 7486,
  1209, 8895, 9035, 9567, 5028, 7680, 8636, 5400, 5441
];

// スカベンジ専用ボット（レースには参加しない）
const SCAVENGE_ONLY = [
  9381, 5357, 389, 2957, 2740, 879, 2985, 1038, 8626, 2542, 9716
];

// レース時刻 (UTC時)
const TEAM_A_RACE_HOURS = [0, 12];  // 9:00, 21:00 JST
const TEAM_B_RACE_HOURS = [6, 18];  // 3:00, 15:00 JST

// 閾値
const MAX_REPAIR_BAY = 4;
const SCAVENGE_BATTERY_MIN = 50;     // スカベンジ継続に必要
const SCAVENGE_CONDITION_MIN = 70;   // スカベンジ継続に必要
const SCAVENGE_BATTERY_STOP = 30;    // これ以下でスカベンジ停止
const RACE_BATTERY_MIN = 30;         // レース前に必要
const RACE_CONDITION_MIN = 70;       // レース前に必要
const PRE_RACE_HOURS = 1;            // レース何時間前から回復モード

interface BotStatus {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
}

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

function isPreRaceMode(raceHours: number[]): boolean {
  const minutesToRace = getMinutesToNextRace(raceHours);
  return minutesToRace <= PRE_RACE_HOURS * 60;
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

// PRE-RACEモード時にRepairBayを優先確保するため、他のボットを追い出す
async function evictNonPriorityFromRepairBay(
  client: PokedRaceMCPClient,
  priorityTeam: number[],
  neededSlots: number
): Promise<number> {
  // 追い出し対象: スカベンジ専用ボット + 他チーム
  const otherTeam = priorityTeam === TEAM_A ? TEAM_B : TEAM_A;
  const evictCandidates = [...SCAVENGE_ONLY, ...otherTeam];

  // 対象ボットのステータスを並列取得
  const statusPromises = evictCandidates.map(tokenIndex => getBotStatus(client, tokenIndex));
  const results = await Promise.allSettled(statusPromises);
  const statuses = results
    .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);

  // RepairBayにいるボットを抽出
  const inRepairBay = statuses.filter(s => s.zone === "RepairBay");

  if (inRepairBay.length === 0) {
    return 0;
  }

  // 必要なスロット数だけ追い出す
  const toEvict = inRepairBay.slice(0, neededSlots);
  let evictedCount = 0;

  console.log(`\n🚨 Evicting ${toEvict.length} bot(s) from RepairBay for priority team...`);

  for (const bot of toEvict) {
    try {
      // バッテリー100%なら待機、それ以外はChargingStation
      if (bot.battery >= 100) {
        await completeScavenging(client, bot.tokenIndex);
        console.log(`   ➡️ #${bot.tokenIndex} ${bot.name} → Standby (evicted, battery full)`);
      } else {
        await moveBot(client, bot.tokenIndex, "ChargingStation");
        console.log(`   ➡️ #${bot.tokenIndex} ${bot.name} → ChargingStation (evicted)`);
      }
      evictedCount++;
    } catch (e) {
      console.log(`   ❌ #${bot.tokenIndex} ${bot.name} eviction failed: ${e}`);
    }
  }

  return evictedCount;
}

interface BotTask {
  bot: BotStatus;
  action: "scrapheaps" | "repair" | "charging" | "standby" | "none";
  reason: string;
}

function planScavengeMode(bot: BotStatus, repairBayCount: number): { task: BotTask; newRepairCount: number } {
  const { battery, condition, zone } = bot;

  // 既にScrapHeapsで条件OK → 継続
  if (zone === "ScrapHeaps" && battery > SCAVENGE_BATTERY_STOP && condition >= SCAVENGE_CONDITION_MIN) {
    return { task: { bot, action: "none", reason: "scavenging OK" }, newRepairCount: repairBayCount };
  }

  // ScrapHeapsだがバッテリーorコンディション不足 → 停止
  if (zone === "ScrapHeaps" && (battery <= SCAVENGE_BATTERY_STOP || condition < SCAVENGE_CONDITION_MIN)) {
    if (condition < SCAVENGE_CONDITION_MIN && repairBayCount < MAX_REPAIR_BAY) {
      return { task: { bot, action: "repair", reason: `Cond ${condition}%` }, newRepairCount: repairBayCount + 1 };
    }
    // バッテリー100%なら待機（電気もったいない）
    if (battery >= 100) {
      return { task: { bot, action: "standby", reason: "waiting for RepairBay (bat full)" }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "charging", reason: `Bat ${battery}%` }, newRepairCount: repairBayCount };
  }

  // RepairBay中 → 継続 or 次へ
  if (zone === "RepairBay") {
    if (condition >= SCAVENGE_CONDITION_MIN && battery >= SCAVENGE_BATTERY_MIN) {
      return { task: { bot, action: "scrapheaps", reason: "repaired, ready" }, newRepairCount: repairBayCount };
    }
    if (condition >= SCAVENGE_CONDITION_MIN && battery < SCAVENGE_BATTERY_MIN) {
      return { task: { bot, action: "charging", reason: "repaired, need charge" }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "none", reason: `repairing (${condition}%)` }, newRepairCount: repairBayCount };
  }

  // ChargingStation中 → 継続 or 次へ
  if (zone === "ChargingStation") {
    if (battery >= SCAVENGE_BATTERY_MIN && condition >= SCAVENGE_CONDITION_MIN) {
      return { task: { bot, action: "scrapheaps", reason: "charged, ready" }, newRepairCount: repairBayCount };
    }
    if (battery >= SCAVENGE_BATTERY_MIN && condition < SCAVENGE_CONDITION_MIN) {
      if (repairBayCount < MAX_REPAIR_BAY) {
        return { task: { bot, action: "repair", reason: `Cond ${condition}%` }, newRepairCount: repairBayCount + 1 };
      }
      return { task: { bot, action: "none", reason: "waiting for RepairBay" }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "none", reason: `charging (${battery}%)` }, newRepairCount: repairBayCount };
  }

  // アイドル状態 → 状態に応じて送る
  if (battery >= SCAVENGE_BATTERY_MIN && condition >= SCAVENGE_CONDITION_MIN) {
    return { task: { bot, action: "scrapheaps", reason: "ready" }, newRepairCount: repairBayCount };
  }
  if (condition < SCAVENGE_CONDITION_MIN && repairBayCount < MAX_REPAIR_BAY) {
    return { task: { bot, action: "repair", reason: `Cond ${condition}%` }, newRepairCount: repairBayCount + 1 };
  }
  // バッテリー100%なら待機（電気もったいない）
  if (battery >= 100) {
    return { task: { bot, action: "none", reason: "waiting for RepairBay (bat full)" }, newRepairCount: repairBayCount };
  }
  return { task: { bot, action: "charging", reason: "need charge" }, newRepairCount: repairBayCount };
}

function planPreRaceMode(bot: BotStatus, repairBayCount: number): { task: BotTask; newRepairCount: number } {
  const { battery, condition, zone } = bot;

  // 目標達成 → 待機
  if (battery >= RACE_BATTERY_MIN && condition >= RACE_CONDITION_MIN) {
    if (zone === null) {
      return { task: { bot, action: "none", reason: "ready for race" }, newRepairCount: repairBayCount };
    }
    // アクティブなら停止して待機
    return { task: { bot, action: "standby", reason: "ready for race" }, newRepairCount: repairBayCount };
  }

  // コンディション不足 → リペア優先
  if (condition < RACE_CONDITION_MIN) {
    if (zone === "RepairBay") {
      return { task: { bot, action: "none", reason: `repairing (${condition}%)` }, newRepairCount: repairBayCount };
    }
    if (repairBayCount < MAX_REPAIR_BAY) {
      return { task: { bot, action: "repair", reason: `Cond ${condition}%` }, newRepairCount: repairBayCount + 1 };
    }
    // RepairBay満 → 待機（バッテリーが足りてればチャージしない）
    if (battery >= RACE_BATTERY_MIN) {
      if (zone === "ChargingStation") {
        return { task: { bot, action: "standby", reason: "waiting for RepairBay" }, newRepairCount: repairBayCount };
      }
      return { task: { bot, action: "none", reason: "waiting for RepairBay" }, newRepairCount: repairBayCount };
    }
    // バッテリーも不足 → チャージ
    if (zone === "ChargingStation") {
      return { task: { bot, action: "none", reason: `charging (${battery}%)` }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "charging", reason: `Bat ${battery}%` }, newRepairCount: repairBayCount };
  }

  // バッテリー不足のみ → チャージ
  if (battery < RACE_BATTERY_MIN) {
    if (zone === "ChargingStation") {
      return { task: { bot, action: "none", reason: `charging (${battery}%)` }, newRepairCount: repairBayCount };
    }
    return { task: { bot, action: "charging", reason: `Bat ${battery}%` }, newRepairCount: repairBayCount };
  }

  return { task: { bot, action: "none", reason: "unknown" }, newRepairCount: repairBayCount };
}

async function processTeam(
  client: PokedRaceMCPClient,
  teamName: string,
  teamBots: number[],
  raceHours: number[]
): Promise<void> {
  const minutesToRace = getMinutesToNextRace(raceHours);
  const isPreRace = isPreRaceMode(raceHours);
  const modeLabel = isPreRace ? "PRE-RACE" : "SCAVENGE";

  console.log(`\n📋 ${teamName} (${modeLabel} mode)`);
  console.log(`   Next race in ${minutesToRace} minutes`);

  // ステータス取得（並列）
  const statusPromises = teamBots.map(tokenIndex => getBotStatus(client, tokenIndex));
  const results = await Promise.allSettled(statusPromises);
  const statuses: BotStatus[] = results
    .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value!);

  console.log(`   Got ${statuses.length}/${teamBots.length} bot statuses`);

  // PRE-RACEモード時: RepairBayが必要なボット数を確認し、必要なら他のボットを追い出す
  if (isPreRace) {
    const needRepair = statuses.filter(s => s.condition < RACE_CONDITION_MIN && s.zone !== "RepairBay");
    const currentInRepairBay = statuses.filter(s => s.zone === "RepairBay").length;
    const neededSlots = Math.max(0, needRepair.length - (MAX_REPAIR_BAY - currentInRepairBay));

    if (neededSlots > 0) {
      await evictNonPriorityFromRepairBay(client, teamBots, neededSlots);
    }
  }

  // RepairBay使用数をカウント（このチームのボットのみ）
  let repairBayCount = statuses.filter(s => s.zone === "RepairBay").length;

  // タスク計画
  const tasks: BotTask[] = [];
  for (const bot of statuses) {
    const planner = isPreRace ? planPreRaceMode : planScavengeMode;
    const { task, newRepairCount } = planner(bot, repairBayCount);
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
    return;
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

    // 両チーム処理
    await processTeam(client, "Team A", TEAM_A, TEAM_A_RACE_HOURS);
    await processTeam(client, "Team B", TEAM_B, TEAM_B_RACE_HOURS);

    console.log("\n✅ Complete");
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
