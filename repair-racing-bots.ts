import { PokedRaceMCPClient } from "./src/mcp-client.js";
import { BotManager } from "./src/bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function sendToRepair(client: PokedRaceMCPClient, tokenIndex: number): Promise<void> {
  try {
    // Get current status
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.log(`  ⚠️  Bot #${tokenIndex}: Empty response, skipping...`);
      return;
    }

    const data = JSON.parse(result.content[0].text);
    const name = data.name || `#${tokenIndex}`;
    const zone = data.active_scavenging?.zone || null;

    console.log(`🤖 Bot ${name}: Currently in ${zone || "None"}`);

    // If already in RepairBay, skip
    if (zone === "RepairBay") {
      console.log(`  → Already in RepairBay, skipping`);
      return;
    }

    // If in another zone, complete first
    if (zone && zone !== "RepairBay") {
      console.log(`  → Completing ${zone}...`);
      await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Send to RepairBay
    console.log(`  → Sending to RepairBay...`);
    await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone: "RepairBay" });
    console.log(`  ✓ Sent to RepairBay successfully!`);
  } catch (error: any) {
    console.error(`  ✗ Failed for bot #${tokenIndex}:`, error.message);
  }
}

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    const racingBots = botManager.getRacingBots();
    console.log(`\n🏁 Sending Racing Bots to RepairBay`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Managing ${racingBots.length} racing bots\n`);

    // Process bots sequentially to avoid rate limits
    for (let i = 0; i < racingBots.length; i++) {
      const tokenIndex = racingBots[i];
      console.log(`\n[${i + 1}/${racingBots.length}]`);
      await sendToRepair(client, tokenIndex);

      // Small delay between bots
      if (i < racingBots.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`\n✅ All racing bots sent to RepairBay!`);
    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
