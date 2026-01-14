import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

interface BotStats {
  tokenIndex: number;
  name: string;
  rating: number;
  currentRating: number;
  at100Rating: number;
  raceClass: string;
  stats: {
    speed: number;
    powerCore: number;
    acceleration: number;
    stability: number;
  };
  battery: number;
  condition: number;
  faction: string;
  alreadyRegistered: boolean;
}

interface EventInfo {
  eventId: number;
  eventName: string;
  startTime: Date;
  minutesUntilStart: number;
  registeredBots: number[];
}

// Rating thresholds for race classes
const CLASS_THRESHOLDS = {
  Scrap: { min: 0, max: 29, registrations: 3 },
  Junker: { min: 30, max: 49, registrations: 3 },
  Raider: { min: 50, max: 69, registrations: 3 },
  Elite: { min: 70, max: 89, registrations: 4 }, // Elite gets 4 bots
  SilentKlan: { min: 90, max: 100, registrations: 3 },
};

async function getAllBots(client: PokedRaceMCPClient): Promise<BotStats[]> {
  console.log("📋 Fetching all bots...");

  const result = await client.callTool("garage_list_my_pokedbots", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get bot list");
  }

  const responseText = result.content[0].text;
  const bots: BotStats[] = [];

  // Parse bot data from text response
  const botMatches = responseText.matchAll(
    /🏎️ PokedBot #(\d+)(?: "([^"]+)")?\s+⚡ Rating[^:]*:\s*(\d+)\/(\d+)\s*\|\s*⚡\s*(\w+)\s+📊 Stats[^:]*:\s*SPD\s+(\d+)\/(\d+)\s*\|\s*PWR\s+(\d+)\/(\d+)\s*\|\s*ACC\s+(\d+)\/(\d+)\s*\|\s*STB\s+(\d+)\/(\d+)\s+📈 Total Current: (\d+) \| Total at 100: (\d+)[^\n]*\n\s+🔋 Battery: (\d+)% \| 🔧 Condition: (\d+)%/g
  );

  for (const match of botMatches) {
    const tokenIndex = parseInt(match[1]);
    const name = match[2] || `Bot #${tokenIndex}`;
    const currentRating = parseInt(match[3]);
    const at100Rating = parseInt(match[4]);
    const faction = match[5];

    const currentSpeed = parseInt(match[6]);
    const currentPower = parseInt(match[8]);
    const currentAccel = parseInt(match[10]);
    const currentStability = parseInt(match[12]);

    const battery = parseInt(match[15]);
    const condition = parseInt(match[16]);

    // Determine race class based on current rating
    let raceClass = "Junker";
    for (const [className, threshold] of Object.entries(CLASS_THRESHOLDS)) {
      if (currentRating >= threshold.min && currentRating <= threshold.max) {
        raceClass = className;
        break;
      }
    }

    bots.push({
      tokenIndex,
      name,
      rating: currentRating,
      currentRating,
      at100Rating,
      raceClass,
      stats: {
        speed: currentSpeed,
        powerCore: currentPower,
        acceleration: currentAccel,
        stability: currentStability,
      },
      battery,
      condition,
      faction,
      alreadyRegistered: false,
    });
  }

  console.log(`✅ Found ${bots.length} bots`);
  return bots;
}

async function getUpcomingEvents(client: PokedRaceMCPClient): Promise<EventInfo[]> {
  console.log("📅 Fetching upcoming events...");

  const result = await client.callTool("racing_list_events", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get event list");
  }

  const responseText = result.content[0].text;
  const events: EventInfo[] = [];

  // Split by event separators
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

    // Only consider events that start in 25-35 minutes (30 min target with buffer)
    if (minutesUntilStart >= 25 && minutesUntilStart <= 35) {
      events.push({
        eventId,
        eventName,
        startTime,
        minutesUntilStart,
        registeredBots: [],
      });
    }
  }

  console.log(`✅ Found ${events.length} events starting in ~30 minutes`);
  return events;
}

async function getExistingRegistrations(client: PokedRaceMCPClient): Promise<Map<number, number[]>> {
  console.log("🔍 Checking existing registrations...");

  const result = await client.callTool("racing_get_my_registrations", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    return new Map();
  }

  const responseText = result.content[0].text;
  const registrationMap = new Map<number, number[]>();

  // Parse existing registrations
  const regMatches = responseText.matchAll(
    /\*\*Event #(\d+)\*\*:[^\n]*\n🤖 Bot: #(\d+)/g
  );

  for (const match of regMatches) {
    const eventId = parseInt(match[1]);
    const botId = parseInt(match[2]);

    if (!registrationMap.has(eventId)) {
      registrationMap.set(eventId, []);
    }
    registrationMap.get(eventId)!.push(botId);
  }

  return registrationMap;
}

async function registerForEvent(
  client: PokedRaceMCPClient,
  eventId: number,
  tokenIndex: number,
  botName: string
): Promise<boolean> {
  try {
    console.log(`  📝 Registering Bot #${tokenIndex} (${botName}) for Event #${eventId}...`);

    const result = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: tokenIndex,
    });

    if (result.isError) {
      console.log(`  ❌ Registration failed: ${result.content?.[0]?.text || "Unknown error"}`);
      return false;
    }

    console.log(`  ✅ Successfully registered Bot #${tokenIndex}`);
    return true;
  } catch (error) {
    console.log(`  ❌ Error registering bot: ${error}`);
    return false;
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🤖 ========================================");
    console.log("🤖  AUTO EVENT REGISTRATION");
    console.log("🤖 ========================================\n");

    // Get all bots and their current stats
    const allBots = await getAllBots(client);

    if (allBots.length === 0) {
      console.log("⚠️  No bots found");
      await client.close();
      return;
    }

    // Get events starting in ~30 minutes
    const upcomingEvents = await getUpcomingEvents(client);

    if (upcomingEvents.length === 0) {
      console.log("⚠️  No events starting in 30 minutes");
      await client.close();
      return;
    }

    // Get existing registrations
    const existingRegistrations = await getExistingRegistrations(client);

    // Process each event
    for (const event of upcomingEvents) {
      console.log(`\n📍 Event #${event.eventId}: ${event.eventName}`);
      console.log(`   Starts in ${event.minutesUntilStart} minutes`);

      const alreadyRegistered = existingRegistrations.get(event.eventId) || [];

      if (alreadyRegistered.length > 0) {
        console.log(`   Already registered: ${alreadyRegistered.length} bots`);
      }

      // Group bots by race class
      const botsByClass = new Map<string, BotStats[]>();

      for (const bot of allBots) {
        // Skip if already registered for this event
        if (alreadyRegistered.includes(bot.tokenIndex)) {
          continue;
        }

        if (!botsByClass.has(bot.raceClass)) {
          botsByClass.set(bot.raceClass, []);
        }
        botsByClass.get(bot.raceClass)!.push(bot);
      }

      // Register top N bots per class
      for (const [raceClass, bots] of botsByClass.entries()) {
        const classConfig = CLASS_THRESHOLDS[raceClass as keyof typeof CLASS_THRESHOLDS];
        const numToRegister = classConfig.registrations;

        if (bots.length === 0) {
          continue;
        }

        // Sort by current rating (descending)
        bots.sort((a, b) => b.currentRating - a.currentRating);

        const toRegister = bots.slice(0, numToRegister);

        console.log(`\n   📊 ${raceClass} Class (registering top ${numToRegister}):`);

        for (const bot of toRegister) {
          console.log(`      #${bot.tokenIndex} ${bot.name} - Rating: ${bot.currentRating} (Battery: ${bot.battery}%, Condition: ${bot.condition}%)`);

          await registerForEvent(client, event.eventId, bot.tokenIndex, bot.name);

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    console.log("\n✅ Auto-registration complete");
    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
