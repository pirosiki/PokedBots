import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;
const CONFIG_PATH = path.join(process.cwd(), "bots-config.json");

interface GroupAssignment {
  excluded_bots: number[];
  racing_bots: number[];
  scavenging_bots: number[];
}

async function getUpcomingRaces(client: PokedRaceMCPClient): Promise<number[]> {
  try {
    // Get upcoming races sorted by start time
    const result = await client.callTool("racing_list_races", {
      sort_by: "start_time"
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const data = JSON.parse(result.content[0].text);
    const races = data.races || [];

    if (races.length === 0) {
      return [];
    }

    // Get only races with the same start_time as the first race (immediate next race event)
    const nextStartTime = races[0].start_time;
    const nextRaces = races.filter((race: any) => race.start_time === nextStartTime);

    return nextRaces.map((race: any) => race.race_id);
  } catch (error) {
    console.error(`  ✗ Failed to get upcoming races:`, error);
    return [];
  }
}

async function getRaceParticipants(client: PokedRaceMCPClient, raceId: number): Promise<number[]> {
  try {
    const result = await client.callTool("racing_get_race_details", {
      race_id: raceId
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return [];
    }

    const data = JSON.parse(result.content[0].text);
    const entries = data.entries || [];
    return entries.map((entry: any) => parseInt(entry.nft_id));
  } catch (error) {
    console.error(`  ✗ Failed to get participants for race #${raceId}:`, error);
    return [];
  }
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

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    console.log(`\n🔄 Dynamic Bot Group Assignment`);
    console.log(`📅 ${new Date().toISOString()}\n`);

    // Connect to MCP server
    await client.connect(SERVER_URL, API_KEY);

    // Get ALL owned bots dynamically from API (not from config)
    console.log(`Fetching all owned bots...`);
    const allBots = await getAllOwnedBots(client);
    console.log(`🤖 Total bots: ${allBots.length}\n`);

    // Get all upcoming races
    console.log(`Fetching upcoming races...`);
    const upcomingRaceIds = await getUpcomingRaces(client);
    console.log(`Found ${upcomingRaceIds.length} upcoming races\n`);

    // Get participants from all races
    const racingBotsSet = new Set<number>();
    for (const raceId of upcomingRaceIds) {
      const participants = await getRaceParticipants(client, raceId);
      participants.forEach(tokenIndex => racingBotsSet.add(tokenIndex));
      console.log(`Race #${raceId}: ${participants.length} participants`);

      // Small delay between API calls
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Split into racing and scavenging groups
    // Racing: bots participating in upcoming races
    // Scavenging: all other bots
    const racingGroup = Array.from(racingBotsSet).filter(bot => allBots.includes(bot)).sort((a, b) => a - b);
    const scavengingGroup = allBots.filter(bot => !racingBotsSet.has(bot)).sort((a, b) => a - b);

    console.log(`\n📊 Group Assignment Results:`);
    console.log(`  🏁 Racing group: ${racingGroup.length} bots`);
    console.log(`  ⛏️  Scavenging group: ${scavengingGroup.length} bots\n`);

    // Save updated configuration (excluded_bots reset to empty array, keeping the field)
    const newConfig: GroupAssignment = {
      excluded_bots: [],  // Always keep the field, reset to empty
      racing_bots: racingGroup,
      scavenging_bots: scavengingGroup
    };

    await fs.writeFile(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
    console.log(`✅ Configuration updated: ${CONFIG_PATH}`);

    await client.close();
  } catch (error) {
    console.error("Error in group assignment:", error);
    process.exit(1);
  }
}

main();
