/**
 * Register Free Races
 *
 * デイリースプリントとスカベンジング以外のボットをフリーレースに登録する
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

// 除外するボット（デイリースプリント: 名前ベース）
const DAILY_SPRINT_NAMES = [
  "Hachiware", "Usagi", "らっこ", "うさぎ", "TAGGR",
  "Nora", "SonicBlue", "Ged", "Wasabi", "Bot #7486",
  "Motoko", "ちいかわ", "G-Max", "Char", "Papuwa",
  "Matai", "StraySheep", "Kafka", "クラムボン", "Guevara",
  "Noir", "Chiikawa", "仙台牛タン", "ねじまき鳥", "厚切り牛タン"
];

// 除外するボット（スカベンジング: IDベース）
const SCAVENGING_BOTS = [2669, 5143, 2630, 2441, 9381, 5357, 389, 2957, 2740, 9616];

interface BotInfo {
  tokenIndex: number;
  name: string;
  raceClass: string;
  battery: number;
  condition: number;
  canRace: boolean;
}

interface FreeRaceInfo {
  eventId: number;
  eventName: string;
  raceClass: string;
  terrain: string;
  distance: string;
  startTime: Date;
  entryFee: string;
  registeredCount: number;
  maxEntrants: number;
}

async function getAllBots(client: PokedRaceMCPClient): Promise<BotInfo[]> {
  console.log("📋 Fetching all bots...");

  const result = await client.callTool("garage_list_my_pokedbots", {});
  const responseText = result.content[0].text;
  const bots: BotInfo[] = [];

  // Parse JSON if available, otherwise parse text
  try {
    const data = JSON.parse(responseText);
    if (data.bots) {
      for (const bot of data.bots) {
        bots.push({
          tokenIndex: bot.token_index,
          name: bot.name || `Bot #${bot.token_index}`,
          raceClass: bot.race_class?.split(" ")[0] || "Unknown",
          battery: bot.battery || 0,
          condition: bot.condition || 0,
          canRace: bot.can_race || false
        });
      }
    }
  } catch {
    // Parse text format
    const botBlocks = responseText.split(/(?=🏎️ PokedBot #)/g).filter((b: string) => b.includes('PokedBot #'));

    for (const block of botBlocks) {
      const tokenMatch = block.match(/🏎️ PokedBot #(\d+)(?: "([^"]+)")?/);
      if (!tokenMatch) continue;

      const tokenIndex = parseInt(tokenMatch[1]);
      const name = tokenMatch[2] || `Bot #${tokenIndex}`;

      const classMatch = block.match(/Class:\s*([^\s]+)/);
      const batteryMatch = block.match(/Battery:\s*(\d+)%/);
      const conditionMatch = block.match(/Condition:\s*(\d+)%/);

      bots.push({
        tokenIndex,
        name,
        raceClass: classMatch?.[1] || "Unknown",
        battery: parseInt(batteryMatch?.[1] || "0"),
        condition: parseInt(conditionMatch?.[1] || "0"),
        canRace: true // Assume true, will check later
      });
    }
  }

  console.log(`✅ Found ${bots.length} total bots`);
  return bots;
}

async function getUpcomingFreeRaces(client: PokedRaceMCPClient): Promise<FreeRaceInfo[]> {
  console.log("📅 Looking for upcoming free races...");

  const result = await client.callTool("racing_list_events", {});
  const responseText = result.content[0].text;

  const races: FreeRaceInfo[] = [];
  const now = new Date();

  // Try to parse as JSON first
  try {
    const data = JSON.parse(responseText);
    if (data.events) {
      for (const event of data.events) {
        // Only free races (not Daily Sprint)
        if (event.event_type?.includes("DailySprint")) continue;

        const startTime = new Date(event.start_time_utc);
        if (isNaN(startTime.getTime()) || startTime <= now) continue; // Skip invalid or past races

        races.push({
          eventId: event.event_id,
          eventName: event.event_type || "Free Race",
          raceClass: event.race_class || "Unknown",
          terrain: event.terrain || "Unknown",
          distance: event.distance || "Unknown",
          startTime,
          entryFee: event.entry_fee || "0",
          registeredCount: event.registered_count || 0,
          maxEntrants: event.max_entrants || 25
        });
      }
    }
  } catch {
    // Parse text format
    const eventBlocks = responseText.split('---').filter(block => block.includes('Event #'));

    for (const block of eventBlocks) {
      // Skip Daily Sprint (check for "Daily Sprint" with capital S)
      if (block.includes('Daily Sprint')) continue;

      const eventIdMatch = block.match(/Event #(\d+)/);
      const classMatch = block.match(/Divisions:\s*([^\n]+)/);
      const terrainMatch = block.match(/Terrain:\s*([^\n]+)/);
      const distanceMatch = block.match(/Distance:\s*([^\n]+)/);
      // Match ISO date format: 📅 Start: 2026-01-21T09:00:00Z
      const timeMatch = block.match(/📅 Start: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
      const registeredMatch = block.match(/Registered:\s*(\d+)\/(\d+)/);

      if (!eventIdMatch) continue;

      let startTime: Date | null = null;
      if (timeMatch) {
        const parsed = new Date(timeMatch[1].trim());
        if (!isNaN(parsed.getTime())) {
          startTime = parsed;
        }
      }

      // Skip if no valid start time or already past
      if (!startTime || startTime <= now) continue;

      races.push({
        eventId: parseInt(eventIdMatch[1]),
        eventName: "Free Race",
        raceClass: classMatch?.[1]?.trim() || "Unknown",
        terrain: terrainMatch?.[1]?.trim() || "Unknown",
        distance: distanceMatch?.[1]?.trim() || "Unknown",
        startTime,
        entryFee: "0",
        registeredCount: parseInt(registeredMatch?.[1] || "0"),
        maxEntrants: parseInt(registeredMatch?.[2] || "25")
      });
    }
  }

  // Sort by start time
  races.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  console.log(`✅ Found ${races.length} upcoming free races`);
  return races;
}

async function getMyRegistrations(client: PokedRaceMCPClient): Promise<Set<string>> {
  console.log("📝 Checking current registrations...");

  const result = await client.callTool("racing_get_my_registrations", {});
  const responseText = result.content[0].text;

  const registered = new Set<string>();

  // Extract "Bot #XXXX registered for Event #YYYY" patterns
  const matches = responseText.matchAll(/#(\d+).*Event #(\d+)/g);
  for (const match of matches) {
    registered.add(`${match[1]}-${match[2]}`);
  }

  console.log(`✅ Found ${registered.size} existing registrations`);
  return registered;
}

async function registerForRace(client: PokedRaceMCPClient, tokenIndex: number, eventId: number): Promise<boolean> {
  try {
    const result = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: tokenIndex
    });

    const text = result.content[0].text;
    if (text.includes("Error") || text.includes("error") || text.includes("failed")) {
      console.log(`  ⚠️ ${text.substring(0, 100)}`);
      return false;
    }

    return true;
  } catch (e: any) {
    console.log(`  ✗ Failed: ${e.message}`);
    return false;
  }
}

function classMatches(botClass: string, raceClass: string): boolean {
  // Normalize class names
  const normalize = (c: string) => c.toLowerCase().replace(/[^a-z]/g, '');
  const bot = normalize(botClass);
  const race = normalize(raceClass);

  // Map common class names
  const classMap: { [key: string]: string[] } = {
    "scrap": ["scrap"],
    "junker": ["junker"],
    "raider": ["raider"],
    "elite": ["elite"],
    "silent": ["silent", "silentklan"],
    "silentklan": ["silent", "silentklan"]
  };

  const botClasses = classMap[bot] || [bot];
  const raceClasses = classMap[race] || [race];

  return botClasses.some(b => raceClasses.includes(b));
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🏁 ========================================");
    console.log("🏁  REGISTER FREE RACES");
    console.log("🏁 ========================================\n");
    console.log(`📅 ${new Date().toISOString()}\n`);

    // Get all bots
    const allBots = await getAllBots(client);

    // Filter out daily sprint and scavenging bots
    const eligibleBots = allBots.filter(bot => {
      // Exclude by name (daily sprint)
      if (DAILY_SPRINT_NAMES.includes(bot.name)) return false;
      // Exclude by ID (scavenging)
      if (SCAVENGING_BOTS.includes(bot.tokenIndex)) return false;
      return true;
    });

    console.log(`\n🎯 Eligible bots for free races: ${eligibleBots.length}`);
    console.log(`   (Excluded: ${DAILY_SPRINT_NAMES.length} daily sprint + ${SCAVENGING_BOTS.length} scavenging)\n`);

    if (eligibleBots.length === 0) {
      console.log("⚠️ No eligible bots for free races");
      await client.close();
      return;
    }

    // Get upcoming free races
    const freeRaces = await getUpcomingFreeRaces(client);

    if (freeRaces.length === 0) {
      console.log("⚠️ No upcoming free races found");
      await client.close();
      return;
    }

    // Get current registrations
    const registered = await getMyRegistrations(client);

    // Display eligible bots
    console.log("\n📋 Eligible Bots:");
    for (const bot of eligibleBots) {
      console.log(`   #${bot.tokenIndex} ${bot.name} (${bot.raceClass})`);
    }

    // Display upcoming races
    console.log("\n🏁 Upcoming Free Races:");
    for (const race of freeRaces.slice(0, 10)) {
      const timeStr = race.startTime.toISOString().replace('T', ' ').substring(0, 16);
      console.log(`   Event #${race.eventId}: ${race.raceClass} / ${race.terrain} @ ${timeStr} (${race.registeredCount}/${race.maxEntrants})`);
    }

    // Register bots for races
    console.log("\n── Registering bots ──");

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const bot of eligibleBots) {
      // Find a suitable race for this bot
      for (const race of freeRaces) {
        // Check if already registered
        const regKey = `${bot.tokenIndex}-${race.eventId}`;
        if (registered.has(regKey)) {
          continue;
        }

        // Check if race is full
        if (race.registeredCount >= race.maxEntrants) {
          continue;
        }

        // Check class compatibility (simplified - may need adjustment)
        // For now, try to register and let the API validate

        console.log(`\n🏎️ #${bot.tokenIndex} ${bot.name} → Event #${race.eventId} (${race.raceClass})`);

        const success = await registerForRace(client, bot.tokenIndex, race.eventId);

        if (success) {
          console.log(`   ✅ Registered!`);
          successCount++;
          race.registeredCount++; // Update local count
          break; // Move to next bot
        } else {
          failCount++;
          // Try next race
        }
      }
    }

    // Summary
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📋 Summary:");
    console.log(`   ✅ Registered: ${successCount}`);
    console.log(`   ⏭️ Skipped: ${skipCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
