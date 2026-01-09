import { PokedRaceMCPClient } from "./mcp-client.js";
import { BotManager } from "./bot-manager.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const BATTERY_THRESHOLD = 40;
const BATTERY_THRESHOLD_HIGH = 80;   // ScrapHeapsに入るバッテリー条件
const CONDITION_THRESHOLD_HIGH = 80; // ScrapHeapsに入るコンディション条件
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

    // Parse JSON response
    const data = JSON.parse(text);

    // Extract battery and condition from JSON
    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;

    // Extract scavenging status from JSON
    let scavenging_zone: string | null = null;
    if (data.active_scavenging && data.active_scavenging.status !== "None") {
      scavenging_zone = data.active_scavenging.zone || null;
    }

    // Extract name if exists
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
    console.log(`⚙️  Thresholds: Battery >= ${BATTERY_THRESHOLD_HIGH}% & Condition >= ${CONDITION_THRESHOLD_HIGH}% (ScrapHeaps entry) / Battery < ${BATTERY_THRESHOLD}% or Condition < ${CONDITION_THRESHOLD_LOW}% (ScrapHeaps exit)`);
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

            // Decision logic - Battery 80%+ & Condition 80%+ required for ScrapHeaps
            if (status.scavenging_zone) {
              if (status.scavenging_zone === "ChargingStation") {
                // ChargingStation: 80%以上になるまで外に出さない
                if (status.battery >= BATTERY_THRESHOLD_HIGH) {
                  if (status.condition < CONDITION_THRESHOLD_HIGH) {
                    console.log(`  → Battery ${status.battery}%! But condition low (${status.condition}%). Moving to RepairBay...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 300));
                    await executeAction(client, tokenIndex, "start", "RepairBay");
                  } else {
                    console.log(`  → Battery ${status.battery}% and condition ${status.condition}%! Moving to ScrapHeaps...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 300));
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
                  await new Promise(resolve => setTimeout(resolve, 300));
                  await executeAction(client, tokenIndex, "start", "ChargingStation");
                } else if (status.condition >= CONDITION_THRESHOLD_HIGH) {
                  // 修理完了したがバッテリーチェック
                  if (status.battery < BATTERY_THRESHOLD_HIGH) {
                    console.log(`  → Condition restored (${status.condition}%), but battery low (${status.battery}%). Moving to ChargingStation...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 300));
                    await executeAction(client, tokenIndex, "start", "ChargingStation");
                  } else {
                    console.log(`  → Condition restored (${status.condition}%) and battery ${status.battery}%! Moving to ScrapHeaps...`);
                    await executeAction(client, tokenIndex, "complete");
                    await new Promise(resolve => setTimeout(resolve, 300));
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
                  await new Promise(resolve => setTimeout(resolve, 300));
                  await executeAction(client, tokenIndex, "start", "ChargingStation");
                } else {
                  console.log(`  → Scavenging... (Battery: ${status.battery}%, Condition: ${status.condition}%)`);
                }
              }
            } else {
              // 未稼働: Battery 80%+ & Condition 80%+ でないとScrapHeapsに行かない
              if (status.battery < BATTERY_THRESHOLD_HIGH) {
                console.log(`  → Not scavenging. Battery low (${status.battery}%). Starting in ChargingStation...`);
                await executeAction(client, tokenIndex, "start", "ChargingStation");
              } else if (status.condition < CONDITION_THRESHOLD_HIGH) {
                console.log(`  → Not scavenging. Battery ${status.battery}% but condition low (${status.condition}%). Starting in RepairBay...`);
                await executeAction(client, tokenIndex, "start", "RepairBay");
              } else {
                console.log(`  → Not scavenging. Battery ${status.battery}% and condition ${status.condition}%! Starting in ScrapHeaps...`);
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
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // Update remaining bots for retry
      remainingBots = failedBots;
      if (remainingBots.length > 0) {
        retryCount++;
        console.log(`\n⚠️  ${remainingBots.length} bots failed, will retry...`);
        await new Promise(resolve => setTimeout(resolve, 500));
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
