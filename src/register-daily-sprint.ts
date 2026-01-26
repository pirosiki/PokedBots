/**
 * Register Daily Sprint Challenge (Team System)
 *
 * 2チーム制でDaily sprint challengeに登録
 * - Aチーム: 9:00, 21:00 JST (0:00, 12:00 UTC) のレースに登録
 * - Bチーム: 3:00, 15:00 JST (18:00, 6:00 UTC) のレースに登録
 *
 * 各チームのレース30分前に実行される
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

// レース時刻 (UTC時)
const TEAM_A_RACE_HOURS = [0, 12];  // 9:00, 21:00 JST
const TEAM_B_RACE_HOURS = [6, 18];  // 3:00, 15:00 JST

interface EventInfo {
  eventId: number;
  eventName: string;
  startTime: Date;
  minutesUntilStart: number;
}

function getCurrentTeam(): { name: string; bots: number[]; raceHours: number[] } {
  const now = new Date();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // 各チームのレースまでの時間を計算
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

  // 直近のレースがあるチームを選択
  if (minutesToA <= minutesToB) {
    return { name: "Team A", bots: TEAM_A, raceHours: TEAM_A_RACE_HOURS };
  } else {
    return { name: "Team B", bots: TEAM_B, raceHours: TEAM_B_RACE_HOURS };
  }
}

async function getNextDailySprint(client: PokedRaceMCPClient, raceHours: number[]): Promise<EventInfo | null> {
  console.log("📅 Looking for next Daily sprint challenge...");

  const result = await client.callTool("racing_list_events", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get event list");
  }

  const responseText = result.content[0].text;
  const eventBlocks = responseText.split('---').filter(block => block.includes('**Event #'));

  const now = new Date();

  for (const block of eventBlocks) {
    const eventIdMatch = block.match(/\*\*Event #(\d+)\*\*:\s*([^\n]+)/);
    const startTimeMatch = block.match(/📅 Start:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);

    if (!eventIdMatch || !startTimeMatch) continue;

    const eventId = parseInt(eventIdMatch[1]);
    const eventName = eventIdMatch[2].trim();
    const startTime = new Date(startTimeMatch[1]);
    const minutesUntilStart = Math.floor((startTime.getTime() - now.getTime()) / 60000);
    const eventHour = startTime.getUTCHours();

    // Daily sprint challengeで、このチームのレース時刻に一致するもの
    if (eventName.toLowerCase().includes("daily sprint challenge") &&
        raceHours.includes(eventHour) &&
        minutesUntilStart > 15 && minutesUntilStart <= 60) {
      console.log(`✅ Found: Event #${eventId} - ${eventName}`);
      console.log(`   Starts at ${startTime.toISOString()} (in ${minutesUntilStart} minutes)`);
      return { eventId, eventName, startTime, minutesUntilStart };
    }
  }

  return null;
}

async function getExistingRegistrations(client: PokedRaceMCPClient, eventId: number): Promise<number[]> {
  const result = await client.callTool("racing_get_my_registrations", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    return [];
  }

  const responseText = result.content[0].text;
  const registered: number[] = [];

  const regMatches = responseText.matchAll(
    /\*\*Event #(\d+)\*\*:[^\n]*\n🤖 Bot: #(\d+)/g
  );

  for (const match of regMatches) {
    if (parseInt(match[1]) === eventId) {
      registered.push(parseInt(match[2]));
    }
  }

  return registered;
}

async function registerBot(
  client: PokedRaceMCPClient,
  eventId: number,
  tokenIndex: number
): Promise<boolean> {
  try {
    const result = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: tokenIndex,
    });

    if (result.isError) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  REGISTER DAILY SPRINT (TEAM SYSTEM)");
    console.log("🏁 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);

    // 現在のチームを判定
    const team = getCurrentTeam();
    console.log(`\n🎯 ${team.name}: ${team.bots.length} bots`);
    console.log(`   Race hours (UTC): ${team.raceHours.join(", ")}`);

    // 次のDaily sprint challengeを探す
    const event = await getNextDailySprint(client, team.raceHours);

    if (!event) {
      console.log("\n⚠️  No upcoming Daily sprint challenge found for this team");
      await client.close();
      return;
    }

    // 既存の登録をチェック
    const alreadyRegistered = await getExistingRegistrations(client, event.eventId);
    console.log(`\n📝 Already registered: ${alreadyRegistered.length} bots`);

    // 未登録のボットを登録
    const toRegister = team.bots.filter(tokenIndex => !alreadyRegistered.includes(tokenIndex));

    if (toRegister.length === 0) {
      console.log("\n✅ All team bots already registered!");
      await client.close();
      return;
    }

    console.log(`\n📝 Registering ${toRegister.length} bots for Event #${event.eventId}...`);

    // 並列実行
    const registerPromises = toRegister.map(async (tokenIndex) => {
      try {
        const result = await client.callTool("racing_register_for_event", {
          event_id: event.eventId,
          token_index: tokenIndex,
        });
        if (result.isError) {
          return { tokenIndex, success: false, error: result.content?.[0]?.text };
        }
        return { tokenIndex, success: true };
      } catch (e) {
        return { tokenIndex, success: false, error: String(e) };
      }
    });

    const results = await Promise.allSettled(registerPromises);

    const succeeded: number[] = [];
    const failed: { tokenIndex: number; error?: string }[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          succeeded.push(result.value.tokenIndex);
        } else {
          failed.push({ tokenIndex: result.value.tokenIndex, error: result.value.error });
        }
      }
    }

    // 成功をログ
    for (const tokenIndex of succeeded) {
      console.log(`   ✅ #${tokenIndex}`);
    }

    // 失敗したボットを個別リトライ
    let retrySuccess = 0;
    if (failed.length > 0) {
      console.log(`\n⚠️ ${failed.length} failed, retrying sequentially...`);
      for (const { tokenIndex } of failed) {
        const ok = await registerBot(client, event.eventId, tokenIndex);
        if (ok) {
          console.log(`   ✅ #${tokenIndex} (retry)`);
          retrySuccess++;
        } else {
          console.log(`   ❌ #${tokenIndex}`);
        }
      }
    }

    const totalSuccess = succeeded.length + retrySuccess;
    const totalFailed = failed.length - retrySuccess;

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Registered: ${totalSuccess}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`📊 Total in event: ${alreadyRegistered.length + totalSuccess}`);

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
