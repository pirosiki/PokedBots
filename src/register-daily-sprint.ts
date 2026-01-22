/**
 * Register Daily Sprint Challenge
 *
 * 固定メンバーを次のDaily sprint challengeに登録する
 * 手動実行: npm run register-daily-sprint
 *
 * 高速化: 並列実行 + 失敗時は個別リトライ
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// 固定メンバー（25体）
const TARGET_NAMES = [
  "Hachiware", "Usagi", "らっこ", "うさぎ", "TAGGR",
  "Nora", "SonicBlue", "Ged", "Wasabi", "Bot #7486",
  "Motoko", "ちいかわ", "G-Max", "Char", "Papuwa",
  "Matai", "StraySheep", "Kafka", "クラムボン", "Guevara",
  "Noir", "Chiikawa", "仙台牛タン", "ねじまき鳥", "厚切り牛タン"
];

interface BotInfo {
  tokenIndex: number;
  name: string;
}

interface EventInfo {
  eventId: number;
  eventName: string;
  startTime: Date;
  minutesUntilStart: number;
}

async function getAllBots(client: PokedRaceMCPClient): Promise<BotInfo[]> {
  console.log("📋 Fetching all bots...");

  const result = await client.callTool("garage_list_my_pokedbots", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get bot list");
  }

  const responseText = result.content[0].text;
  const bots: BotInfo[] = [];

  const botBlocks = responseText.split(/(?=🏎️ PokedBot #)/g).filter((b: string) => b.includes('PokedBot #'));

  for (const block of botBlocks) {
    const tokenMatch = block.match(/🏎️ PokedBot #(\d+)(?: "([^"]+)")?/);
    if (!tokenMatch) continue;

    const tokenIndex = parseInt(tokenMatch[1]);
    const name = tokenMatch[2] || `Bot #${tokenIndex}`;

    bots.push({ tokenIndex, name });
  }

  console.log(`✅ Found ${bots.length} total bots`);
  return bots;
}

async function getNextDailySprint(client: PokedRaceMCPClient): Promise<EventInfo | null> {
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

    // Daily sprint challengeを探す（登録締切15分前まで）
    if (eventName.toLowerCase().includes("daily sprint challenge") && minutesUntilStart > 15) {
      console.log(`✅ Found: Event #${eventId} - ${eventName}`);
      console.log(`   Starts in ${minutesUntilStart} minutes`);
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
  tokenIndex: number,
  botName: string
): Promise<boolean> {
  try {
    const result = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: tokenIndex,
    });

    if (result.isError) {
      console.log(`   ❌ ${botName}: ${result.content?.[0]?.text || "Failed"}`);
      return false;
    }

    console.log(`   ✅ ${botName}`);
    return true;
  } catch (error) {
    console.log(`   ❌ ${botName}: ${error}`);
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  REGISTER DAILY SPRINT CHALLENGE");
    console.log("🏁 ========================================\n");

    // 全ボット取得
    const allBots = await getAllBots(client);

    // 対象ボットをフィルタ
    const targetBots = allBots.filter(bot =>
      TARGET_NAMES.some(name =>
        bot.name.toLowerCase() === name.toLowerCase() ||
        bot.name.includes(name) ||
        name.includes(bot.name)
      )
    );

    console.log(`\n🎯 Target bots: ${targetBots.length}/${TARGET_NAMES.length}`);

    // マッチしなかったボットを表示
    const matchedNames = targetBots.map(b => b.name.toLowerCase());
    const notFound = TARGET_NAMES.filter(name =>
      !targetBots.some(bot =>
        bot.name.toLowerCase() === name.toLowerCase() ||
        bot.name.includes(name) ||
        name.includes(bot.name)
      )
    );
    if (notFound.length > 0) {
      console.log(`⚠️  Not found: ${notFound.join(", ")}`);
    }

    // 次のDaily sprint challengeを探す
    const event = await getNextDailySprint(client);

    if (!event) {
      console.log("\n⚠️  No upcoming Daily sprint challenge found");
      await client.close();
      return;
    }

    // 既存の登録をチェック
    const alreadyRegistered = await getExistingRegistrations(client, event.eventId);
    console.log(`\n📝 Already registered: ${alreadyRegistered.length} bots`);

    // 未登録のボットを登録
    const toRegister = targetBots.filter(bot => !alreadyRegistered.includes(bot.tokenIndex));

    if (toRegister.length === 0) {
      console.log("\n✅ All target bots already registered!");
      await client.close();
      return;
    }

    console.log(`\n📝 Registering ${toRegister.length} bots for Event #${event.eventId} in parallel...`);

    // 並列実行
    const registerPromises = toRegister.map(async (bot) => {
      try {
        const result = await client.callTool("racing_register_for_event", {
          event_id: event.eventId,
          token_index: bot.tokenIndex,
        });
        if (result.isError) {
          return { bot, success: false, error: result.content?.[0]?.text };
        }
        return { bot, success: true };
      } catch (e) {
        return { bot, success: false, error: String(e) };
      }
    });

    const results = await Promise.allSettled(registerPromises);

    const succeeded: BotInfo[] = [];
    const failed: { bot: BotInfo; error?: string }[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          succeeded.push(result.value.bot);
        } else {
          failed.push({ bot: result.value.bot, error: result.value.error });
        }
      }
    }

    // 成功をログ
    for (const bot of succeeded) {
      console.log(`   ✅ ${bot.name}`);
    }

    // 失敗したボットを個別リトライ
    let retrySuccess = 0;
    if (failed.length > 0) {
      console.log(`\n⚠️ ${failed.length} failed, retrying sequentially...`);
      for (const { bot } of failed) {
        const ok = await registerBot(client, event.eventId, bot.tokenIndex, bot.name);
        if (ok) retrySuccess++;
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
