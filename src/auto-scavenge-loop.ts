import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const BATTERY_THRESHOLD = 40;
const CONDITION_THRESHOLD_HIGH = 90; // ScrapHeapsに入る条件
const CONDITION_THRESHOLD_LOW = 40;  // ScrapHeapsから出る条件

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

    // Check for empty or malformed responses
    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.warn(`  ⚠️  Empty response for bot #${tokenIndex}, skipping...`);
      return null;
    }

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

// Helper function to split array into chunks
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

async function main() {
  const client = new PokedRaceMCPClient();
  const botManager = new BotManager();

  try {
    await botManager.loadConfig();
    await client.connect(SERVER_URL, API_KEY);

    const scavengingBots = botManager.getScavengingBots();
    console.log(`\n🔍 Auto-Scavenge Loop Started (PARALLEL MODE)`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Managing ${scavengingBots.length} scavenging bots\n`);
    console.log(`⚙️  Thresholds: Battery < ${BATTERY_THRESHOLD}%, Condition < ${CONDITION_THRESHOLD_LOW}% (ScrapHeaps exit) / >= ${CONDITION_THRESHOLD_HIGH}% (ScrapHeaps entry)`);
    console.log(`⚡ Processing 2 bots at a time\n`);

    // Process bots in parallel (2 at a time)
    let remainingBots = [...scavengingBots];
    let processedCount = 0;
    let retryCount = 0;
    const maxRetries = 5;

    while (remainingBots.length > 0 && retryCount < maxRetries) {
      const chunks = chunkArray(remainingBots, 2);
      const failedBots: number[] = [];

      console.log(`\n🔄 ${retryCount > 0 ? `Retry ${retryCount}: ` : ''}Processing ${remainingBots.length} bots in ${chunks.length} chunks...`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`\n📦 Processing chunk ${i + 1}/${chunks.length} (${chunk.length} bots)...`);

        // Process all bots in this chunk in parallel
        const results = await Promise.all(
          chunk.map(async (tokenIndex) => {
            const status = await getBotStatus(client, tokenIndex);
            if (status === null) {
              return { tokenIndex, success: false };
            }

            const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
            console.log(`\n🤖 Bot ${displayName}: Battery=${status.battery}%, Condition=${status.condition}%, Zone=${status.scavenging_zone || "None"}`);

            // Decision logic - Battery 100% required for ScrapHeaps
            if (status.scavenging_zone) {
              if (status.scavenging_zone === "ChargingStation") {
                // ChargingStation: 100%になるまで絶対に外に出さない
                if (status.battery >= 100) {
                  if (status.condition < CONDITION_THRESHOLD_HIGH) {
                    console.log(`  → Battery 100%! But condition low (${status.condition}%). Moving to RepairBay...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await executeAction(client, tokenIndex, "start", "RepairBay");
                  } else {
                    console.log(`  → Battery 100% and condition ${status.condition}%! Moving to ScrapHeaps...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await executeAction(client, tokenIndex, "start", "ScrapHeaps");
                  }
                } else {
                  console.log(`  → Charging... (${status.battery}%)`);
                }
              } else if (status.scavenging_zone === "RepairBay") {
                // RepairBay: バッテリー優先でチェック
                if (status.battery < BATTERY_THRESHOLD) {
                  console.log(`  → Battery critical (${status.battery}%) during repair! Moving to ChargingStation...`);
                  await executeAction(client, tokenIndex, "complete");
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  await executeAction(client, tokenIndex, "start", "ChargingStation");
                } else if (status.condition >= CONDITION_THRESHOLD_HIGH) {
                  // 修理完了したがバッテリーチェック
                  if (status.battery < 100) {
                    console.log(`  → Condition restored (${status.condition}%), but battery not full (${status.battery}%). Moving to ChargingStation...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await executeAction(client, tokenIndex, "start", "ChargingStation");
                  } else {
                    console.log(`  → Condition restored and battery 100%! Moving to ScrapHeaps...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await executeAction(client, tokenIndex, "start", "ScrapHeaps");
                  }
                } else {
                  console.log(`  → Repairing... (Condition: ${status.condition}%, Battery: ${status.battery}%)`);
                }
              } else {
                // ScrapHeaps等: どちらかが30%切ったらChargingStationへ
                if (status.battery < BATTERY_THRESHOLD || status.condition < CONDITION_THRESHOLD_LOW) {
                  const reason = status.battery < BATTERY_THRESHOLD
                    ? `Battery low (${status.battery}%)`
                    : `Condition low (${status.condition}%)`;
                  console.log(`  → ${reason}! Moving to ChargingStation...`);
                  await executeAction(client, tokenIndex, "complete");
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  await executeAction(client, tokenIndex, "start", "ChargingStation");
                } else {
                  console.log(`  → Scavenging... (Battery: ${status.battery}%, Condition: ${status.condition}%)`);
                }
              }
            } else {
              // 未稼働: Battery 100% & Condition 90%+ でないとScrapHeapsに行かない
              if (status.battery < 100) {
                console.log(`  → Not scavenging. Battery not full (${status.battery}%). Starting in ChargingStation...`);
                await executeAction(client, tokenIndex, "start", "ChargingStation");
              } else if (status.condition < CONDITION_THRESHOLD_HIGH) {
                console.log(`  → Not scavenging. Battery 100% but condition low (${status.condition}%). Starting in RepairBay...`);
                await executeAction(client, tokenIndex, "start", "RepairBay");
              } else {
                console.log(`  → Not scavenging. Battery 100% and condition ${status.condition}%! Starting in ScrapHeaps...`);
                await executeAction(client, tokenIndex, "start", "ScrapHeaps");
              }
            }

            return { tokenIndex, success: true };
          })
        );

        // Track failed bots
        for (const result of results) {
          if (result.success) {
            processedCount++;
          } else {
            failedBots.push(result.tokenIndex);
          }
        }

        console.log(`✓ Chunk ${i + 1} complete (${processedCount}/${scavengingBots.length} total, ${failedBots.length} failed)`);

        // Small delay between chunks
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Update remaining bots for retry
      remainingBots = failedBots;
      if (remainingBots.length > 0) {
        retryCount++;
        console.log(`\n⚠️  ${remainingBots.length} bots failed, will retry...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (remainingBots.length > 0) {
      console.log(`\n⚠️  Warning: ${remainingBots.length} bots could not be processed after ${maxRetries} retries`);
      console.log(`Failed bots: ${remainingBots.join(', ')}`);
    }

    console.log(`\n✅ Loop completed - processed ${processedCount}/${scavengingBots.length} bots`);
    await client.close();
  } catch (error) {
    console.error("Error in auto-scavenge loop:", error);
    process.exit(1);
  }
}

main();
