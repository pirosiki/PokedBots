import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    // List all available tools
    const result = await client.listTools();
    const tools = result.tools || [];

    console.log("\n=== All Available Tools ===\n");
    console.log(`Total tools: ${tools.length}\n`);

    // Filter for stats-related tools
    const statsTools = tools.filter((t: any) =>
      t.name.toLowerCase().includes('stat') ||
      t.name.toLowerCase().includes('terrain') ||
      t.name.toLowerCase().includes('garage')
    );

    console.log("Stats/Terrain/Garage Related Tools:");
    for (const tool of statsTools) {
      console.log(`\n📋 ${tool.name}`);
      if (tool.description) {
        const desc = tool.description.substring(0, 200);
        console.log(`   ${desc}...`);
      }
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
