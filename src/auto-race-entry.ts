import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// 除外するボット名
const EXCLUDED_BOT_NAMES = ["Bach", "ハチワレ"];

interface BotInfo {
  token_index: number;
  name?: string;
}

async function getBotName(client: PokedRaceMCPClient, tokenIndex: number): Promise<string | undefined> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return undefined;
    }
    const data = JSON.parse(result.content[0].text);
    return data.name || undefined;
  } catch (error) {
    console.error(`Failed to get name for bot #${tokenIndex}:`, error);
    return undefined;
  }
}

async function getEnteredRaces(client: PokedRaceMCPClient, tokenIndex: number): Promise<number[]> {
  try {
    const result = await client.callTool("racing_get_bot_races", {
      token_index: tokenIndex,
      category: "upcoming" // upcomingとin_progressを取得
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const data = JSON.parse(result.content[0].text);
    const races = data.races || [];
    return races.map((race: any) => race.race_id);
  } catch (error) {
    console.error(`  ✗ Failed to get entered races for bot #${tokenIndex}:`, error);
    return [];
  }
}

async function getAvailableRaces(client: PokedRaceMCPClient, tokenIndex: number): Promise<any[]> {
  try {
    const result = await client.callTool("racing_list_races", {
      token_index: tokenIndex,
      has_spots: true
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const data = JSON.parse(result.content[0].text);
    return data.races || [];
  } catch (error) {
    console.error(`  ✗ Failed to get available races for bot #${tokenIndex}:`, error);
    return [];
  }
}

async function enterRace(client: PokedRaceMCPClient, tokenIndex: number, raceId: number, raceName: string): Promise<boolean> {
  try {
    const result = await client.callTool("racing_enter_race", {
      race_id: raceId,
      token_index: tokenIndex
    });

    // Check for error response
    if (result.isError) {
      const errorText = result.content?.[0]?.text || "Unknown error";

      // Check if it's a "same event" error (acceptable limitation)
      if (errorText.includes("already entered in another race in this event")) {
        console.log(`    ⊘ Race #${raceId}: Already in another race from this event (expected limitation)`);
      } else {
        console.error(`    ✗ Race #${raceId}: ${errorText}`);
      }
      return false;
    }

    // Success
    if (result && result.content && result.content[0] && result.content[0].text) {
      const response = result.content[0].text;
      console.log(`    ✓ Entered race #${raceId} (${raceName})`);
      return true;
    } else {
      console.log(`    ⚠️  Empty response for race #${raceId}`);
      return false;
    }
  } catch (error: any) {
    console.error(`    ✗ Failed to enter race #${raceId}:`, error.message || error);
    return false;
  }
}

async function processBot(client: PokedRaceMCPClient, tokenIndex: number, name: string): Promise<void> {
  console.log(`\n🏁 Bot #${tokenIndex} "${name}"`);

  // Get already entered races
  const enteredRaceIds = await getEnteredRaces(client, tokenIndex);
  if (enteredRaceIds.length > 0) {
    console.log(`  → Already entered ${enteredRaceIds.length} race(s): ${enteredRaceIds.join(', ')}`);
  }

  // Get available races
  const availableRaces = await getAvailableRaces(client, tokenIndex);
  console.log(`  → Found ${availableRaces.length} available race(s)`);

  if (availableRaces.length === 0) {
    console.log(`  → No races available`);
    return;
  }

  // Filter out already entered races
  const newRaces = availableRaces.filter((race: any) => !enteredRaceIds.includes(race.race_id));
  console.log(`  → ${newRaces.length} new race(s) to enter`);

  if (newRaces.length === 0) {
    console.log(`  → Already entered all available races`);
    return;
  }

  // Enter all new races
  let successCount = 0;
  for (const race of newRaces) {
    const raceInfo = `${race.race_class || 'Unknown'} - ${race.terrain || 'Unknown'} - ${race.distance || '?'}km`;
    const success = await enterRace(client, tokenIndex, race.race_id, raceInfo);
    if (success) {
      successCount++;
    }
    // Small delay between entries
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  console.log(`  ✅ Entered ${successCount}/${newRaces.length} races`);
}

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    const racingBots = botManager.getRacingBots();
    console.log(`\n🏁 Auto Race Entry Started`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Total racing bots: ${racingBots.length}\n`);

    // Get bot names and filter out excluded bots
    const eligibleBots: BotInfo[] = [];
    for (const tokenIndex of racingBots) {
      const name = await getBotName(client, tokenIndex);
      if (name && !EXCLUDED_BOT_NAMES.includes(name)) {
        eligibleBots.push({ token_index: tokenIndex, name });
      } else if (name) {
        console.log(`⊘ Excluding bot #${tokenIndex} "${name}"`);
      }
    }

    console.log(`\n✓ ${eligibleBots.length} eligible bots (excluded: ${EXCLUDED_BOT_NAMES.join(', ')})\n`);

    let totalEntered = 0;

    // Process each eligible bot
    for (let i = 0; i < eligibleBots.length; i++) {
      const bot = eligibleBots[i];
      console.log(`\n[${i + 1}/${eligibleBots.length}]`);
      await processBot(client, bot.token_index, bot.name!);

      // Delay between bots
      if (i < eligibleBots.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`\n✅ Auto race entry completed`);
    await client.close();
  } catch (error) {
    console.error("Error in auto race entry:", error);
    process.exit(1);
  }
}

main();
