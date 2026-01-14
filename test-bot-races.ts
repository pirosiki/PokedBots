import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Testing racing_get_bot_races ===\n");

    // Test with bot #433 (racing bot)
    console.log("Bot #433 - Upcoming races:");
    const result = await client.callTool("racing_get_bot_races", {
      token_index: 433,
      category: "upcoming"
    });

    console.log("\nRaw response:");
    console.log(JSON.stringify(result, null, 2));

    if (result.content && result.content[0] && result.content[0].text) {
      console.log("\nText content:");
      console.log(result.content[0].text);
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
