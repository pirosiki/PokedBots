import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    const hachiTokenIndex = 433;

    console.log(`\n=== Getting Stats for Hachi #${hachiTokenIndex} ===\n`);

    const result = await client.callTool("garage_get_robot_details", {
      token_index: hachiTokenIndex
    });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.error("Failed to get bot details");
      process.exit(1);
    }

    const data = JSON.parse(result.content[0].text);

    console.log("=== Available Fields ===");
    console.log(Object.keys(data).join(", "));
    console.log();

    // Check for stats-related fields
    if (data.current_stats) {
      console.log("✅ current_stats (現在の統計):");
      console.log(JSON.stringify(data.current_stats, null, 2));
    }

    if (data.stats_at_100) {
      console.log("\n✅ stats_at_100 (100%時の統計):");
      console.log(JSON.stringify(data.stats_at_100, null, 2));
    }

    if (data.base_stats) {
      console.log("\nbase_stats (ベース統計):");
      console.log(JSON.stringify(data.base_stats, null, 2));
    }

    if (data.condition) {
      console.log("\ncondition (現在の状態):");
      console.log(`  Battery: ${data.condition.battery}%`);
      console.log(`  Condition: ${data.condition.condition}%`);
      console.log(`  Overcharge: ${data.condition.overcharge || 0}%`);
    }

    if (data.world_buff) {
      console.log("\nworld_buff:");
      console.log(JSON.stringify(data.world_buff, null, 2));
    }

    if (data.upgrades) {
      console.log("\nupgrades:");
      console.log(JSON.stringify(data.upgrades, null, 2));
    }

    console.log("\n=== Full Response ===");
    console.log(JSON.stringify(data, null, 2));

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
