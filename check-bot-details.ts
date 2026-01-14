import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    // Check bot #59 (scavenger) and #433 (racer)
    for (const botId of [59, 433]) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🤖 Bot #${botId}`);
      console.log('='.repeat(60));

      const result = await client.callTool("garage_get_robot_details", { token_index: botId });

      if (result && result.content && result.content[0] && result.content[0].text) {
        const data = JSON.parse(result.content[0].text);

        // Look for any field that might indicate scavenger/racer
        console.log('\n📋 Full Response:');
        console.log(JSON.stringify(data, null, 2));
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
