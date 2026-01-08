import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  const tokenIndex = 5136; // うさぎ

  // Get bot details
  const detailsResult = await client.callTool("garage_get_robot_details", {
    token_index: tokenIndex
  });
  const botDetails = JSON.parse(detailsResult.content[0].text);
  const rating = botDetails.overall_rating || 0;
  const raceClass = botDetails.race_class || "Unknown";

  console.log(`\n🐰 Bot #${tokenIndex} "うさぎ"`);
  console.log(`Rating: ${rating}`);
  console.log(`Class: ${raceClass}\n`);

  const racesResult = await client.callTool("racing_get_bot_races", {
    token_index: tokenIndex,
    category: "upcoming"
  });
  const racesData = JSON.parse(racesResult.content[0].text);
  const enteredRaceIds = (racesData.races || []).map((r: any) => r.race_id);

  console.log(`Already entered: ${enteredRaceIds.length > 0 ? enteredRaceIds.join(', ') : 'None'}`);

  // Get all upcoming races
  let allRaces: any[] = [];
  let nextCursor: number | undefined = undefined;

  while (true) {
    const params: any = { status: "open", sort_by: "start_time" };
    if (nextCursor) {
      params.after_race_id = nextCursor;
    }

    const result = await client.callTool("racing_list_races", params);
    const data = JSON.parse(result.content[0].text);

    if (data.races && data.races.length > 0) {
      allRaces = allRaces.concat(data.races);
    }

    if (data.has_more && data.next_cursor) {
      nextCursor = data.next_cursor;
    } else {
      break;
    }
  }

  // Group races by start time
  const racesByTime = new Map<string, any[]>();
  for (const race of allRaces) {
    const time = race.start_time_utc;
    if (!racesByTime.has(time)) {
      racesByTime.set(time, []);
    }
    racesByTime.get(time)!.push(race);
  }

  // Check which time slots bot is already in
  const enteredTimes = new Set<string>();
  for (const raceId of enteredRaceIds) {
    const race = allRaces.find((r: any) => r.race_id === raceId);
    if (race) {
      enteredTimes.add(race.start_time_utc);
    }
  }

  console.log(`Already entered time slots: ${Array.from(enteredTimes).join(', ')}\n`);

  // Extract race class prefix from bot's race_class
  let classPrefix = raceClass.split(' ')[0]; // "Elite" from "Elite (40-49 rating)"

  console.log(`Looking for races in class: ${classPrefix}\n`);

  // Find first race in a time slot not yet entered with appropriate class
  let availableRace = null;
  for (const [time, races] of Array.from(racesByTime.entries()).sort()) {
    if (!enteredTimes.has(time)) {
      // Find race matching bot's class
      const matchingRace = races.find((r: any) => r.class.startsWith(classPrefix));
      if (matchingRace) {
        availableRace = matchingRace;
        break;
      }
    }
  }

  if (!availableRace) {
    console.log("\n❌ No available races to enter");
    await client.close();
    return;
  }

  console.log(`\n📍 Target Race: #${availableRace.race_id} "${availableRace.name}"`);
  console.log(`   Class: ${availableRace.class}`);
  console.log(`   Terrain: ${availableRace.terrain}, Distance: ${availableRace.distance_km}km`);
  console.log(`   Entry Fee: ${availableRace.entry_fee_icp} ICP`);
  console.log(`   Spots: ${availableRace.spots_left}/${availableRace.max_entries} left\n`);

  // Try to enter
  console.log(`🎯 Entering race #${availableRace.race_id}...`);

  const enterResult = await client.callTool("racing_enter_race", {
    race_id: availableRace.race_id,
    token_index: tokenIndex
  });

  if (enterResult.isError) {
    console.log(`\n❌ Failed: ${enterResult.content[0].text}`);
  } else {
    console.log(`\n✅ Successfully entered race #${availableRace.race_id}!`);
    console.log(enterResult.content[0].text);
  }

  await client.close();
}

main();
