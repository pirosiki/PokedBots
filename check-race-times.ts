import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n📅 Checking race start times...\n");

    const result = await client.callTool("racing_list_races", {
      status: "Upcoming",
      sort_by: "start_time"
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.log("No race data found");
      await client.close();
      return;
    }

    const data = JSON.parse(result.content[0].text);
    const races = data.races || [];

    console.log(`Found ${races.length} upcoming races:\n`);

    for (const race of races) {
      const startTime = new Date(race.start_time_utc);
      const hour = startTime.getUTCHours();
      const minute = startTime.getUTCMinutes();

      console.log(`Race #${race.race_id}:`);
      console.log(`  Start time (UTC): ${race.start_time_utc}`);
      console.log(`  Hour: ${hour}, Minute: ${minute}`);
      console.log(`  Full: ${startTime.toISOString()}`);
      console.log();
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
