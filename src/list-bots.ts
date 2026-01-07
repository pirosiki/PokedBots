import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    // Load bot configuration
    await botManager.loadConfig();

    // Connect to MCP server
    await client.connect(SERVER_URL, API_KEY);

    // List all owned bots
    console.log("\n=== Listing Your PokedBots ===\n");
    const result = await client.callTool("garage_list_my_pokedbots");

    if (!result.content || result.content.length === 0) {
      console.log("No bots found in your garage.");
      await client.close();
      return;
    }

    const responseText = result.content[0].text;

    // Display server response
    console.log(responseText);

    // Extract bot token indices from the response
    const botMatches = responseText.matchAll(/🏎️ PokedBot #(\d+)/g);
    const botIndices: number[] = [];
    for (const match of botMatches) {
      botIndices.push(parseInt(match[1]));
    }

    console.log("\n\n=== Group Assignment Summary ===\n");

    // Show bots grouped by assignment
    const config = botManager.getConfig();

    console.log(`📋 Total Bots: ${botIndices.length}\n`);

    if (config.racing_bots.length > 0) {
      console.log(`🏁 RACING GROUP (${config.racing_bots.length} bots):`);
      config.racing_bots.forEach((idx) => {
        console.log(`   #${idx}`);
      });
      console.log();
    }

    if (config.scavenging_bots.length > 0) {
      console.log(`🔍 SCAVENGING GROUP (${config.scavenging_bots.length} bots):`);
      config.scavenging_bots.forEach((idx) => {
        console.log(`   #${idx}`);
      });
      console.log();
    }

    const unassignedBots = botIndices.filter(
      (idx) => !config.racing_bots.includes(idx) && !config.scavenging_bots.includes(idx)
    );

    if (unassignedBots.length > 0) {
      console.log(`❓ UNASSIGNED (${unassignedBots.length} bots):`);
      console.log(`   Use "npm run assign <token_index> racing" or "npm run assign <token_index> scavenging"`);
      console.log(`   Example: npm run assign ${unassignedBots[0]} racing`);
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
