/**
 * Race Manager (Single Team)
 *
 * 全ボットが6時間ごとのレースに参加（15分ごと実行）
 * レース時刻: 3:00, 9:00, 15:00, 21:00 JST (18:00, 0:00, 6:00, 12:00 UTC)
 *
 * 運用フロー（2フェーズ）:
 *
 * フェーズ1: バッテリー消費（レース後〜3時間前）
 *   - ScrapHeapsでバッテリーを消費
 *   - Cond < 10% → 待機
 *   - Bat < 5% → 待機
 *
 * フェーズ2: プリレースリペア（3時間前〜レース）
 *   - ワールドバフ持ちを優先でRepairBay
 *   - Cond >= 70% になったら待機
 *   - バッテリーはほぼ空の状態でレースへ
 *
 * レース直前は手動で有料リチャージ → オーバーチャージ獲得
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// 全レースボット
const ALL_BOTS = [
  // 旧Team A
  433, 2669, 5136, 6152, 9943, 2632, 758, 1170, 3535, 631, 406, 8868,
  // 旧Team B
  5677, 8288, 5143, 820, 1315, 2630, 1209, 8895, 9035, 3406, 5441, 5400
];

// レース時刻 (UTC時) - 6時間ごと
const RACE_HOURS = [0, 6, 12, 18];  // 9:00, 15:00, 21:00, 3:00 JST

// フェーズ閾値（分）
const PRERACE_START = 3 * 60;  // 3時間前からプリレースリペア

// 安全閾値
const MIN_BATTERY = 5;     // これ以下で待機
const MIN_CONDITION = 10;  // これ以下で待機

// プリレースリペア
const REPAIR_TARGET = 70;  // この%以上でリペア完了
const MAX_REPAIR_BAY = 4;  // RepairBay最大数

type Phase = "drain" | "prerace";

interface BotStatus {
  tokenIndex: number;
  name: string;
  battery: number;
  condition: number;
  zone: string | null;
  hasWorldBuff: boolean;
  worldBuffExpires: number | null;  // hours remaining
}

/**
 * 次のレースまでの分数を取得
 */
function getMinutesToNextRace(): number {
  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();
  const currentTotalMinutes = currentHour * 60 + currentMinute;

  let minMinutes = Infinity;

  for (const raceHour of RACE_HOURS) {
    const raceTotalMinutes = raceHour * 60;
    let diff = raceTotalMinutes - currentTotalMinutes;
    if (diff <= 0) {
      diff += 24 * 60;
    }
    if (diff < minMinutes) {
      minMinutes = diff;
    }
  }

  return minMinutes;
}

/**
 * 現在のフェーズを判定
 */
function getCurrentPhase(minutesToRace: number): Phase {
  if (minutesToRace <= PRERACE_START) {
    return "prerace";
  }
  return "drain";
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

    // ワールドバフ情報
    const hasWorldBuff = data.condition?.world_buff?.active === true;
    const worldBuffExpires = hasWorldBuff ? (data.condition?.world_buff?.expires_in_hours || null) : null;

    return { tokenIndex, name, battery, condition, zone, hasWorldBuff, worldBuffExpires };
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
  action: "scrapheaps" | "repair" | "standby" | "none";
  reason: string;
}

/**
 * ドレインフェーズのアクション計画
 */
function planDrainAction(bot: BotStatus): BotTask {
  const { battery, condition, zone } = bot;

  // 安全閾値以下なら待機
  if (battery < MIN_BATTERY || condition < MIN_CONDITION) {
    if (zone !== null) {
      return { bot, action: "standby", reason: `critical (Bat ${battery}%, Cond ${condition}%)` };
    }
    return { bot, action: "none", reason: `standby (Bat ${battery}%, Cond ${condition}%)` };
  }

  // ScrapHeapsでバッテリー消費
  if (zone === "ScrapHeaps") {
    return { bot, action: "none", reason: `draining (Bat ${battery}%)` };
  }
  return { bot, action: "scrapheaps", reason: "drain battery" };
}

/**
 * プリレースフェーズのアクション計画（ワールドバフ優先）
 */
function planPreraceActions(statuses: BotStatus[]): BotTask[] {
  const tasks: BotTask[] = [];

  // ワールドバフ持ちを優先でソート（バフあり → コンディション低い順）
  const sorted = [...statuses].sort((a, b) => {
    // ワールドバフ持ちが先
    if (a.hasWorldBuff && !b.hasWorldBuff) return -1;
    if (!a.hasWorldBuff && b.hasWorldBuff) return 1;
    // 同じ場合はコンディション低い順（リペア必要度高い）
    return a.condition - b.condition;
  });

  // 現在RepairBayにいるボットをカウント
  let repairBayCount = statuses.filter(s => s.zone === "RepairBay").length;

  for (const bot of sorted) {
    const { battery, condition, zone, hasWorldBuff } = bot;

    // コンディション足りてる → 待機
    if (condition >= REPAIR_TARGET) {
      if (zone !== null) {
        tasks.push({ bot, action: "standby", reason: `ready (Cond ${condition}%)${hasWorldBuff ? " 🌟" : ""}` });
      } else {
        tasks.push({ bot, action: "none", reason: `ready (Cond ${condition}%)${hasWorldBuff ? " 🌟" : ""}` });
      }
      continue;
    }

    // RepairBay中 → 継続
    if (zone === "RepairBay") {
      tasks.push({ bot, action: "none", reason: `repairing (Cond ${condition}%)${hasWorldBuff ? " 🌟" : ""}` });
      continue;
    }

    // RepairBay空きあり → リペア
    if (repairBayCount < MAX_REPAIR_BAY) {
      tasks.push({ bot, action: "repair", reason: `need repair (Cond ${condition}%)${hasWorldBuff ? " 🌟 PRIORITY" : ""}` });
      repairBayCount++;
      continue;
    }

    // RepairBay満杯 → 待機
    if (zone !== null) {
      tasks.push({ bot, action: "standby", reason: `waiting for RepairBay (Cond ${condition}%)${hasWorldBuff ? " 🌟" : ""}` });
    } else {
      tasks.push({ bot, action: "none", reason: `waiting for RepairBay (Cond ${condition}%)${hasWorldBuff ? " 🌟" : ""}` });
    }
  }

  return tasks;
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  RACE MANAGER");
    console.log("🏁 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 ${ALL_BOTS.length} bots (races every 6h)`);

    const minutesToRace = getMinutesToNextRace();
    const phase = getCurrentPhase(minutesToRace);
    const phaseLabel = phase === "drain" ? "DRAIN" : "PRERACE";

    console.log(`\n⏰ Next race in ${minutesToRace} minutes (${(minutesToRace / 60).toFixed(1)}h)`);
    console.log(`📋 Phase: ${phaseLabel}`);

    // ステータス取得（並列）
    console.log(`\n📡 Fetching bot statuses...`);
    const statusPromises = ALL_BOTS.map(tokenIndex => getBotStatus(client, tokenIndex));
    const results = await Promise.allSettled(statusPromises);
    const statuses: BotStatus[] = results
      .filter((r): r is PromiseFulfilledResult<BotStatus | null> => r.status === "fulfilled" && r.value !== null)
      .map(r => r.value!);

    console.log(`   Got ${statuses.length}/${ALL_BOTS.length} bot statuses`);

    // ワールドバフ持ちをカウント
    const withBuff = statuses.filter(s => s.hasWorldBuff);
    if (withBuff.length > 0) {
      console.log(`   🌟 World Buff: ${withBuff.length} bots (${withBuff.map(s => `#${s.tokenIndex}`).join(", ")})`);
    }

    // タスク計画
    let tasks: BotTask[];
    if (phase === "drain") {
      tasks = statuses.map(bot => planDrainAction(bot));
    } else {
      tasks = planPreraceActions(statuses);
    }

    // ステータス表示
    console.log(`\n📊 Status:`);
    for (const task of tasks) {
      const { bot, action, reason } = task;
      const icon = bot.zone === "ScrapHeaps" ? "⛏️" :
                   bot.zone === "RepairBay" ? "🔧" :
                   bot.zone === "ChargingStation" ? "🔌" : "💤";
      const buffIcon = bot.hasWorldBuff ? "🌟" : "  ";
      const actionIcon = action === "none" ? "" : ` → ${action}`;
      console.log(`   ${buffIcon}${icon} #${bot.tokenIndex} ${bot.name}: Bat=${bot.battery}%, Cond=${bot.condition}% (${reason})${actionIcon}`);
    }

    // サマリー
    const avgBattery = statuses.length > 0
      ? Math.round(statuses.reduce((sum, s) => sum + s.battery, 0) / statuses.length)
      : 0;
    const avgCondition = statuses.length > 0
      ? Math.round(statuses.reduce((sum, s) => sum + s.condition, 0) / statuses.length)
      : 0;
    const draining = statuses.filter(s => s.zone === "ScrapHeaps").length;
    const repairing = statuses.filter(s => s.zone === "RepairBay").length;
    const standby = statuses.filter(s => s.zone === null).length;

    console.log(`\n📈 Summary: Avg Bat=${avgBattery}%, Avg Cond=${avgCondition}%`);
    console.log(`   Draining: ${draining}, Repairing: ${repairing}, Standby: ${standby}`);

    // アクション実行（並列）
    const activeTasks = tasks.filter(t => t.action !== "none");
    if (activeTasks.length === 0) {
      console.log(`\n✅ No actions needed`);
      await client.close();
      return;
    }

    console.log(`\n⚙️ Executing ${activeTasks.length} actions...`);

    const actionPromises = activeTasks.map(async (task): Promise<{ task: BotTask; success: boolean }> => {
      try {
        if (task.action === "standby") {
          await completeScavenging(client, task.bot.tokenIndex);
        } else if (task.action === "scrapheaps") {
          await moveBot(client, task.bot.tokenIndex, "ScrapHeaps");
        } else if (task.action === "repair") {
          await moveBot(client, task.bot.tokenIndex, "RepairBay");
        }
        return { task, success: true };
      } catch {
        return { task, success: false };
      }
    });

    const actionResults = await Promise.allSettled(actionPromises);
    let successCount = 0;

    for (const result of actionResults) {
      if (result.status === "fulfilled" && result.value.success) {
        successCount++;
        const t = result.value.task;
        console.log(`   ✅ #${t.bot.tokenIndex} ${t.bot.name} → ${t.action}`);
      }
    }

    console.log(`\n✅ Complete: ${successCount}/${activeTasks.length}`);
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
