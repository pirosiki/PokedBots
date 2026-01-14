import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Testing garage_list_my_pokedbots Stats ===\n");

    const result = await client.callTool("garage_list_my_pokedbots", {});

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.error("Failed to get bot list");
      process.exit(1);
    }

    const responseText = result.content[0].text;

    // Find Hachi #433 in the response
    const lines = responseText.split('\n');
    let inHachi = false;
    let hachiData: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.includes('PokedBot #433') || line.includes('Hachiware')) {
        inHachi = true;
      }

      if (inHachi) {
        hachiData.push(line);

        // Stop after we've collected enough data (next bot or separator)
        if (i > 0 && line.startsWith('---') && hachiData.length > 5) {
          break;
        }
        if (line.match(/PokedBot #\d{3}/) && !line.includes('#433')) {
          hachiData.pop(); // Remove the next bot's line
          break;
        }
      }
    }

    console.log("=== Hachi #433 Data from garage_list_my_pokedbots ===\n");
    console.log(hachiData.join('\n'));

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
