import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  const tokenIndex = 433; // Hachiware

  // Get available races
  console.log("Getting available races for Hachiware...");
  const racesResult = await client.callTool("racing_list_races", {
    token_index: tokenIndex,
    has_spots: true
  });

  const racesData = JSON.parse(racesResult.content[0].text);
  console.log(`Found ${racesData.races.length} available races:`);
  racesData.races.forEach((race: any) => {
    console.log(`  - Race #${race.race_id}: ${race.name} (${race.entries}/${race.max_entries})`);
  });

  // Try to enter the first race
  if (racesData.races.length > 0) {
    const raceId = racesData.races[0].race_id;
    console.log(`\nAttempting to enter race #${raceId}...`);

    try {
      const enterResult = await client.callTool("racing_enter_race", {
        race_id: raceId,
        token_index: tokenIndex
      });

      console.log("\nFull response:");
      console.log(JSON.stringify(enterResult, null, 2));

      if (enterResult.content && enterResult.content[0]) {
        console.log("\nResponse text:");
        console.log(enterResult.content[0].text);
      }
    } catch (error) {
      console.error("Error entering race:", error);
    }
  }

  await client.close();
}

main();
