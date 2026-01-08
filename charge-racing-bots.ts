import { PokedRaceMCPClient } from "./src/mcp-client.js";
import { BotManager } from "./src/bot-manager.js";
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

    const racingBots = botManager.getRacingBots();
    console.log(`\n🔋 Moving Condition 100% Racing Bots to ChargingStation`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Checking ${racingBots.length} racing bots\n`);

    let movedCount = 0;

    for (let i = 0; i < racingBots.length; i++) {
      const tokenIndex = racingBots[i];
      console.log(`\n[${i + 1}/${racingBots.length}]`);

      const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });
      const data = JSON.parse(result.content[0].text);

      const name = data.name || `Bot #${tokenIndex}`;
      const condition = data.condition?.condition || 0;
      const battery = data.condition?.battery || 0;
      const zone = data.active_scavenging?.zone || null;

      console.log(`🤖 Bot ${name}: Condition=${condition}%, Battery=${battery}%, Zone=${zone || "None"}`);

      if (condition >= 100) {
        if (zone === "ChargingStation") {
          console.log(`  → Already in ChargingStation, skipping`);
        } else if (zone === "RepairBay") {
          console.log(`  → Condition 100%! Moving to ChargingStation...`);
          await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
          await new Promise(resolve => setTimeout(resolve, 300));
          await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone: "ChargingStation" });
          console.log(`  ✓ Sent to ChargingStation successfully!`);
          movedCount++;
        } else if (!zone) {
          console.log(`  → Not active. Starting in ChargingStation...`);
          await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone: "ChargingStation" });
          console.log(`  ✓ Sent to ChargingStation successfully!`);
          movedCount++;
        } else {
          console.log(`  ⚠️  In unexpected zone "${zone}", skipping`);
        }
      } else {
        console.log(`  → Condition not 100% yet, skipping`);
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`\n✅ Moved ${movedCount} bots to ChargingStation!`);
    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
