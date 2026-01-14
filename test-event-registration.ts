import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n🧪 Testing Event Registration Logic\n");

    // Test 1: Get upcoming events
    console.log("📅 Fetching upcoming events...");
    const eventsResult = await client.callTool("racing_list_events", {});

    if (!eventsResult || !eventsResult.content || !eventsResult.content[0]) {
      console.error("Failed to get events");
      process.exit(1);
    }

    const eventsText = eventsResult.content[0].text;

    // Split by event separators
    const eventBlocks = eventsText.split('---').filter(block => block.includes('**Event #'));

    const now = new Date();
    console.log(`Current time: ${now.toISOString()}\n`);

    let eventCount = 0;
    for (const block of eventBlocks) {
      if (eventCount >= 5) break; // Show first 5 events

      const eventIdMatch = block.match(/\*\*Event #(\d+)\*\*:\s*([^\n]+)/);
      const startTimeMatch = block.match(/📅 Start:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);

      if (!eventIdMatch || !startTimeMatch) continue;

      const eventId = eventIdMatch[1];
      const eventName = eventIdMatch[2].trim();
      const startTime = new Date(startTimeMatch[1]);
      const minutesUntilStart = Math.floor((startTime.getTime() - now.getTime()) / 60000);

      console.log(`Event #${eventId}: ${eventName}`);
      console.log(`  Start: ${startTime.toISOString()}`);
      console.log(`  Minutes until start: ${minutesUntilStart}`);
      console.log(`  Would register: ${minutesUntilStart >= 25 && minutesUntilStart <= 35 ? "✅ YES" : "❌ NO"}`);
      console.log();

      eventCount++;
    }

    // Test 2: Get bot stats
    console.log("\n📋 Fetching bot stats...");
    const botsResult = await client.callTool("garage_list_my_pokedbots", {});

    if (!botsResult || !botsResult.content || !botsResult.content[0]) {
      console.error("Failed to get bots");
      process.exit(1);
    }

    const botsText = botsResult.content[0].text;

    // Count bots by class
    const classCounts: Record<string, number> = {
      Scrap: 0,
      Junker: 0,
      Raider: 0,
      Elite: 0,
      SilentKlan: 0,
    };

    const botMatches = botsText.matchAll(
      /🏎️ PokedBot #(\d+)[^\n]*\n\s+⚡ Rating[^:]*:\s*(\d+)/g
    );

    for (const match of botMatches) {
      const rating = parseInt(match[2]);

      if (rating < 30) classCounts.Scrap++;
      else if (rating < 50) classCounts.Junker++;
      else if (rating < 70) classCounts.Raider++;
      else if (rating < 90) classCounts.Elite++;
      else classCounts.SilentKlan++;
    }

    console.log("\nBot distribution by class:");
    for (const [className, count] of Object.entries(classCounts)) {
      const registrations = className === "Elite" ? 4 : 3;
      console.log(`  ${className}: ${count} bots (will register top ${registrations})`);
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
