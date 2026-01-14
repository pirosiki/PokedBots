import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

interface EventInfo {
  event_id: number;
  event_name: string;
  start_time_utc: string;
  participant_bots: number[];
}

async function parseEventRegistrations(client: PokedRaceMCPClient): Promise<EventInfo[]> {
  const result = await client.callTool("racing_get_my_registrations", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    return [];
  }

  const responseText = result.content[0].text;

  const eventMap = new Map<number, EventInfo>();

  const eventMatches = responseText.matchAll(/\*\*Event #(\d+)\*\*:\s*([^\n]+)\n🤖 Bot: #(\d+)[^\n]*\n[^\n]*\n⏰ Starts:[^\|]*\|\s*([^\n]+)/g);

  for (const match of eventMatches) {
    const eventId = parseInt(match[1]);
    const eventName = match[2].trim();
    const botId = parseInt(match[3]);
    const startTime = match[4].trim();

    if (!eventMap.has(eventId)) {
      eventMap.set(eventId, {
        event_id: eventId,
        event_name: eventName,
        start_time_utc: startTime,
        participant_bots: []
      });
    }

    eventMap.get(eventId)!.participant_bots.push(botId);
  }

  return Array.from(eventMap.values());
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Event Registration Parsing Test ===\n");

    const events = await parseEventRegistrations(client);

    console.log(`Parsed ${events.length} events:\n`);

    for (const event of events) {
      const eventTime = new Date(event.start_time_utc);
      const now = new Date();
      const minutesUntil = (eventTime.getTime() - now.getTime()) / (60 * 1000);

      console.log(`Event #${event.event_id}: ${event.event_name}`);
      console.log(`  Start: ${event.start_time_utc} (${Math.round(minutesUntil)} min)`);
      console.log(`  Bots: ${event.participant_bots.join(", ")}`);
      console.log(`  Count: ${event.participant_bots.length}`);
      console.log();
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
