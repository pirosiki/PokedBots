import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Fetching All Events (with pagination) ===\n");

    let allEvents: any[] = [];
    let afterEventId: number | null = null;
    let pageCount = 0;

    while (pageCount < 10) { // Max 10 pages to prevent infinite loop
      pageCount++;
      console.log(`\nFetching page ${pageCount}${afterEventId ? ` (after event #${afterEventId})` : ''}...`);

      const params: any = {};
      if (afterEventId !== null) {
        params.after_event_id = afterEventId;
      }

      const result = await client.callTool("racing_list_events", params);

      if (!result || !result.content || !result.content[0] || !result.content[0].text) {
        console.log("No more events");
        break;
      }

      const responseText = result.content[0].text;

      // Extract event IDs and info
      const eventMatches = Array.from(responseText.matchAll(/\*\*Event #(\d+)\*\*:\s*([^\n]+)\n.*?📅 Start:\s*([^\n]+)/gs));

      if (eventMatches.length === 0) {
        console.log("No events found in this page");
        break;
      }

      for (const match of eventMatches) {
        const eventId = parseInt(match[1]);
        const eventName = match[2].trim();
        const startTime = match[3].trim();

        allEvents.push({
          id: eventId,
          name: eventName,
          start: startTime
        });
      }

      console.log(`Found ${eventMatches.length} events on this page`);

      // Check if there's a next page
      if (responseText.includes("More events available")) {
        const afterMatch = responseText.match(/after_event_id:\s*(\d+)/);
        if (afterMatch) {
          afterEventId = parseInt(afterMatch[1]);
        } else {
          break;
        }
      } else {
        console.log("No more pages");
        break;
      }

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`\n=== Total Events: ${allEvents.length} ===\n`);

    // Sort by ID to see gaps
    allEvents.sort((a, b) => a.id - b.id);

    // Display all events
    console.log("Event ID | Event Name                  | Start Time");
    console.log("-".repeat(75));

    let previousId = null;
    for (const event of allEvents) {
      // Check for gaps
      if (previousId !== null && event.id !== previousId + 1) {
        const gap = event.id - previousId - 1;
        console.log(`         | >>> GAP: ${gap} event(s) missing <<<`);
      }

      console.log(`#${String(event.id).padStart(3)} | ${event.name.padEnd(28)} | ${event.start}`);
      previousId = event.id;
    }

    // Analyze Daily Sprint pattern
    console.log("\n=== Daily Sprint Analysis ===\n");

    const dailySprints = allEvents.filter(e => e.name.includes("Daily Sprint"));
    console.log(`Total Daily Sprint events: ${dailySprints.length}`);

    if (dailySprints.length > 0) {
      console.log("\nDaily Sprint Event IDs:");
      console.log(dailySprints.map(e => e.id).join(", "));

      console.log("\nMissing Event IDs in sequence:");
      const ids = dailySprints.map(e => e.id).sort((a, b) => a - b);
      const min = Math.min(...ids);
      const max = Math.max(...ids);

      const missing = [];
      for (let i = min; i <= max; i++) {
        if (!ids.includes(i)) {
          missing.push(i);
        }
      }

      if (missing.length > 0) {
        console.log(`Missing: ${missing.join(", ")} (${missing.length} total)`);
      } else {
        console.log("No missing IDs (complete sequence)");
      }
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
