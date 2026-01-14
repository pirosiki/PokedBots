import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Querying compendium about events ===\n");

    const result = await client.callTool("help_get_compendium", { section: "all" });
    const text = result.content[0].text;

    // Look for event-related info
    const lines = text.split('\n');
    let foundEvent = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (line.includes('event') || line.includes('registration')) {
        foundEvent = true;
        // Print surrounding context (5 lines before and after)
        const start = Math.max(0, i - 5);
        const end = Math.min(lines.length, i + 15);
        console.log(lines.slice(start, end).join('\n'));
        console.log('\n' + '='.repeat(60) + '\n');
      }
    }

    if (!foundEvent) {
      console.log("No event-related information found in compendium.");
      console.log("\nFull compendium length:", text.length, "characters");
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
