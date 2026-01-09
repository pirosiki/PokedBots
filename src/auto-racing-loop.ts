import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const BATTERY_THRESHOLD_LOW = 40;    // 緊急ライン
const BATTERY_THRESHOLD_START = 50;   // 開始判断ライン

interface BotStatus {
  token_index: number;
  battery: number;
  condition: number;
  scavenging_zone: string | null;
  name?: string;
}

async function getBotStatus(client: PokedRaceMCPClient, tokenIndex: number): Promise<BotStatus | null> {
  try {
    const result = await client.callTool("garage_get_robot_details", { token_index: tokenIndex });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.warn(`  ⚠️  Empty response for bot #${tokenIndex}, skipping...`);
      return null;
    }

    const text = result.content[0].text;
    const data = JSON.parse(text);

    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;

    let scavenging_zone: string | null = null;
    if (data.active_scavenging && data.active_scavenging.status !== "None") {
      scavenging_zone = data.active_scavenging.zone || null;
    }

    const name = data.name || undefined;

    return {
      token_index: tokenIndex,
      battery,
      condition,
      scavenging_zone,
      name,
    };
  } catch (error) {
    console.error(`Failed to get status for bot #${tokenIndex}:`, error);
    return null;
  }
}

async function executeAction(client: PokedRaceMCPClient, tokenIndex: number, action: string, zone?: string): Promise<boolean> {
  try {
    let result;
    if (action === "complete") {
      result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
      if (result.isError) {
        const errorMsg = result.content?.[0]?.text || "Unknown error";
        console.error(`  ✗ Failed to complete for bot #${tokenIndex}: ${errorMsg}`);
        return false;
      }
      console.log(`  ✓ Completed scavenging for bot #${tokenIndex}`);
    } else if (action === "start" && zone) {
      result = await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone });
      if (result.isError) {
        const errorMsg = result.content?.[0]?.text || "Unknown error";
        console.error(`  ✗ Failed to start for bot #${tokenIndex}: ${errorMsg}`);
        return false;
      }
      console.log(`  ✓ Started scavenging in ${zone} for bot #${tokenIndex}`);
    }
    return true;
  } catch (error: any) {
    console.error(`  ✗ Exception during ${action} for bot #${tokenIndex}:`, error.message);
    return false;
  }
}

async function manageRacingBot(client: PokedRaceMCPClient, tokenIndex: number): Promise<{ tokenIndex: number; success: boolean }> {
  const status = await getBotStatus(client, tokenIndex);
  if (status === null) {
    return { tokenIndex, success: false };
  }

  const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
  console.log(`\n🏁 Bot ${displayName}: Battery=${status.battery}%, Condition=${status.condition}%, Zone=${status.scavenging_zone || "None"}`);

  // ゴール判定: Battery 100% & Condition 100%
  const isComplete = status.battery >= 100 && status.condition >= 100;

  if (status.scavenging_zone) {
    if (status.scavenging_zone === "ChargingStation") {
      // ChargingStation中
      if (status.battery >= 100) {
        if (isComplete) {
          console.log(`  → Battery & Condition both 100%! 🎉 GOAL! Completing...`);
          await executeAction(client, tokenIndex, "complete");
        } else {
          console.log(`  → Battery 100%, but condition ${status.condition}%. Moving to RepairBay...`);
          await executeAction(client, tokenIndex, "complete");
          await new Promise(resolve => setTimeout(resolve, 300));
          await executeAction(client, tokenIndex, "start", "RepairBay");
        }
      } else {
        console.log(`  → Charging... (${status.battery}%)`);
      }
    } else if (status.scavenging_zone === "RepairBay") {
      // RepairBay中
      if (status.battery < BATTERY_THRESHOLD_LOW) {
        console.log(`  → Battery critical (${status.battery}%) during repair! Moving to ChargingStation...`);
        await executeAction(client, tokenIndex, "complete");
        await new Promise(resolve => setTimeout(resolve, 300));
        await executeAction(client, tokenIndex, "start", "ChargingStation");
      } else if (status.condition >= 100) {
        console.log(`  → Condition 100%! Moving to ChargingStation...`);
        await executeAction(client, tokenIndex, "complete");
        await new Promise(resolve => setTimeout(resolve, 300));
        await executeAction(client, tokenIndex, "start", "ChargingStation");
      } else {
        console.log(`  → Repairing... (Battery: ${status.battery}%, Condition: ${status.condition}%)`);
      }
    } else {
      // ScrapHeapsなど: Racing botは100%/100%を目指すため、常にChargingStation/RepairBayへ
      console.log(`  ⚠️  Racing bot in "${status.scavenging_zone}". Moving to appropriate zone...`);
      await executeAction(client, tokenIndex, "complete");
      await new Promise(resolve => setTimeout(resolve, 300));

      if (status.condition >= 100) {
        // Conditionが100%の場合は、Batteryを充電
        console.log(`  → Condition 100%, Battery ${status.battery}%. Moving to ChargingStation...`);
        await executeAction(client, tokenIndex, "start", "ChargingStation");
      } else if (status.battery >= BATTERY_THRESHOLD_START) {
        // Conditionが100%未満で、Batteryが十分ある場合はRepair
        console.log(`  → Battery ${status.battery}% >= ${BATTERY_THRESHOLD_START}%. Moving to RepairBay...`);
        await executeAction(client, tokenIndex, "start", "RepairBay");
      } else {
        // Battery不足の場合は先に充電
        console.log(`  → Battery low (${status.battery}%). Moving to ChargingStation...`);
        await executeAction(client, tokenIndex, "start", "ChargingStation");
      }
    }
  } else {
    // 未稼働
    if (isComplete) {
      console.log(`  → Already at 100%/100%! No action needed.`);
    } else if (status.condition >= 100) {
      // Conditionが100%の場合は、Batteryを充電
      console.log(`  → Not active. Condition 100%, Battery ${status.battery}%. Starting in ChargingStation...`);
      await executeAction(client, tokenIndex, "start", "ChargingStation");
    } else if (status.battery >= BATTERY_THRESHOLD_START) {
      // Conditionが100%未満で、Batteryが十分ある場合はRepair
      console.log(`  → Not active. Battery ${status.battery}% >= ${BATTERY_THRESHOLD_START}%. Starting in RepairBay...`);
      await executeAction(client, tokenIndex, "start", "RepairBay");
    } else {
      // Battery不足の場合は先に充電
      console.log(`  → Not active. Battery low (${status.battery}%). Starting in ChargingStation...`);
      await executeAction(client, tokenIndex, "start", "ChargingStation");
    }
  }

  return { tokenIndex, success: true };
}

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    const racingBots = botManager.getRacingBots();
    console.log(`\n🏁 Auto-Racing Loop Started`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Managing ${racingBots.length} racing bots\n`);
    console.log(`⚙️  Thresholds: Battery Emergency < ${BATTERY_THRESHOLD_LOW}%, Start >= ${BATTERY_THRESHOLD_START}%`);
    console.log(`🎯 Goal: Battery 100% & Condition 100%\n`);

    let completedCount = 0;
    let failedBots: number[] = [];

    // Process all racing bots sequentially
    for (let i = 0; i < racingBots.length; i++) {
      const tokenIndex = racingBots[i];
      console.log(`\n[${i + 1}/${racingBots.length}]`);

      const result = await manageRacingBot(client, tokenIndex);

      if (result.success) {
        completedCount++;
      } else {
        failedBots.push(result.tokenIndex);
      }

      // Small delay between bots
      if (i < racingBots.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    if (failedBots.length > 0) {
      console.log(`\n⚠️  Warning: ${failedBots.length} bots could not be processed`);
      console.log(`Failed bots: ${failedBots.join(', ')}`);
    }

    console.log(`\n✅ Loop completed - processed ${completedCount}/${racingBots.length} bots`);
    await client.close();
  } catch (error) {
    console.error("Error in auto-racing loop:", error);
    process.exit(1);
  }
}

main();
