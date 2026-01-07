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
    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Auto-Assigning Bots by Name ===\n");
    console.log("Rule: Named bots → Racing, Unnamed bots → Scavenging\n");

    const result = await client.callTool("garage_list_my_pokedbots");

    if (!result.content || result.content.length === 0) {
      console.log("No bots found.");
      await client.close();
      return;
    }

    const responseText = result.content[0].text;

    // Extract named bots: 🏎️ PokedBot #123 "Name"
    const namedBotMatches = responseText.matchAll(/🏎️ PokedBot #(\d+) "([^"]+)"/g);
    const namedBots: Array<{index: number, name: string}> = [];
    for (const match of namedBotMatches) {
      namedBots.push({
        index: parseInt(match[1]),
        name: match[2]
      });
    }

    // Extract all bots
    const allBotMatches = responseText.matchAll(/🏎️ PokedBot #(\d+)/g);
    const allBotIndices: number[] = [];
    for (const match of allBotMatches) {
      allBotIndices.push(parseInt(match[1]));
    }

    // Unnamed bots = all bots - named bots
    const namedIndices = namedBots.map(b => b.index);
    const unnamedBots = allBotIndices.filter(idx => !namedIndices.includes(idx));

    console.log(`📊 Found ${allBotIndices.length} total bots:`);
    console.log(`   🏁 ${namedBots.length} named bots (will be assigned to RACING)`);
    console.log(`   🔍 ${unnamedBots.length} unnamed bots (will be assigned to SCAVENGING)\n`);

    // Assign named bots to racing
    console.log("🏁 Assigning to RACING group:");
    namedBots.forEach(bot => {
      botManager.addRacingBot(bot.index);
      console.log(`   ✓ #${bot.index} "${bot.name}"`);
    });

    console.log(`\n🔍 Assigning to SCAVENGING group:`);
    unnamedBots.forEach(idx => {
      botManager.addScavengingBot(idx);
      console.log(`   ✓ #${idx}`);
    });

    await botManager.saveConfig();

    console.log("\n✅ Auto-assignment complete!");

    const config = botManager.getConfig();
    console.log(`\n📋 Summary:`);
    console.log(`   Racing Bots: ${config.racing_bots.length}`);
    console.log(`   Scavenging Bots: ${config.scavenging_bots.length}`);

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
