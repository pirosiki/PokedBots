import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const BATTERY_THRESHOLD = 30;
const CONDITION_THRESHOLD = 30;

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
    const text = result.content[0].text;

    // Extract battery percentage
    const batteryMatch = text.match(/🔋 Battery: (\d+)%/);
    const battery = batteryMatch ? parseInt(batteryMatch[1]) : 100;

    // Extract condition percentage
    const conditionMatch = text.match(/🔧 Condition: (\d+)%/);
    const condition = conditionMatch ? parseInt(conditionMatch[1]) : 100;

    // Extract scavenging status
    let scavenging_zone: string | null = null;
    const scavengingMatch = text.match(/🔍 SCAVENGING: Active.*in (ScrapHeaps|AbandonedSettlements|DeadMachineFields|RepairBay|ChargingStation)/);
    if (scavengingMatch) {
      scavenging_zone = scavengingMatch[1];
    }

    // Extract name if exists
    const nameMatch = text.match(/PokedBot #\d+ "([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : undefined;

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

async function executeAction(client: PokedRaceMCPClient, tokenIndex: number, action: string, zone?: string): Promise<void> {
  try {
    if (action === "complete") {
      await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
      console.log(`  ✓ Completed scavenging for bot #${tokenIndex}`);
    } else if (action === "start" && zone) {
      await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone });
      console.log(`  ✓ Started scavenging in ${zone} for bot #${tokenIndex}`);
    }
  } catch (error: any) {
    console.error(`  ✗ Failed to ${action} for bot #${tokenIndex}:`, error.message);
  }
}

async function manageBotScavenging(client: PokedRaceMCPClient, tokenIndex: number): Promise<void> {
  const status = await getBotStatus(client, tokenIndex);
  if (!status) {
    return;
  }

  const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
  console.log(`\n🤖 Bot ${displayName}: Battery=${status.battery}%, Condition=${status.condition}%, Zone=${status.scavenging_zone || "None"}`);

  // Decision logic
  if (status.scavenging_zone) {
    // Bot is currently scavenging
    if (status.scavenging_zone === "RepairBay") {
      // In RepairBay - check if condition is restored
      if (status.condition >= 100) {
        console.log(`  → Condition restored! Moving to ChargingStation...`);
        await executeAction(client, tokenIndex, "complete");
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        await executeAction(client, tokenIndex, "start", "ChargingStation");
      } else {
        console.log(`  → Still repairing... (${status.condition}%)`);
      }
    } else if (status.scavenging_zone === "ChargingStation") {
      // In ChargingStation - check if battery is restored
      if (status.battery >= 100) {
        console.log(`  → Battery full! Moving to ScrapHeaps...`);
        await executeAction(client, tokenIndex, "complete");
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        await executeAction(client, tokenIndex, "start", "ScrapHeaps");
      } else {
        console.log(`  → Still charging... (${status.battery}%)`);
      }
    } else {
      // In active scavenging zone (ScrapHeaps, etc.)
      if (status.battery <= BATTERY_THRESHOLD || status.condition <= CONDITION_THRESHOLD) {
        console.log(`  → Low resources! Moving to RepairBay...`);
        await executeAction(client, tokenIndex, "complete");
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        await executeAction(client, tokenIndex, "start", "RepairBay");
      } else {
        console.log(`  → Scavenging in progress...`);
      }
    }
  } else {
    // Bot is not scavenging - start in ScrapHeaps
    console.log(`  → Not scavenging. Starting in ScrapHeaps...`);
    await executeAction(client, tokenIndex, "start", "ScrapHeaps");
  }
}

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    const scavengingBots = botManager.getScavengingBots();
    console.log(`\n🔍 Auto-Scavenge Loop Started`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Managing ${scavengingBots.length} scavenging bots\n`);
    console.log(`⚙️  Thresholds: Battery ≤ ${BATTERY_THRESHOLD}%, Condition ≤ ${CONDITION_THRESHOLD}%\n`);

    // Process bots one by one to avoid rate limiting
    for (const tokenIndex of scavengingBots) {
      await manageBotScavenging(client, tokenIndex);
      // Small delay between bots to be nice to the server
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n✅ Loop completed successfully`);
    await client.close();
  } catch (error) {
    console.error("Error in auto-scavenge loop:", error);
    process.exit(1);
  }
}

main();
