/**
 * Auto-Scavenge Loop (Unified Bot Management)
 *
 * Manages ALL bots (both racing and scavenging groups) with the same logic:
 * - Entry: Battery 95% & Condition 95%
 * - Exit: Battery < 80% OR Condition < 80%
 * - Zones: ScrapHeaps for parts, ChargingStation/RepairBay for maintenance
 *
 * Racing bots are maintained at 100%/100% by auto-race-maintenance before races.
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const BATTERY_THRESHOLD = 80;        // ScrapHeapsから出るバッテリー条件
const BATTERY_THRESHOLD_HIGH = 95;   // ScrapHeapsに入るバッテリー条件
const CONDITION_THRESHOLD_HIGH = 95;  // ScrapHeapsに入るコンディション条件
const CONDITION_THRESHOLD_LOW = 80;   // ScrapHeapsから出るコンディション条件

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
    // Check if status contains "Active" (e.g., "Active - collect anytime")
    let scavenging_zone: string | null = null;
    if (data.active_scavenging &&
        data.active_scavenging.status &&
        typeof data.active_scavenging.status === "string" &&
        data.active_scavenging.status.includes("Active")) {
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

interface ActionResult {
  success: boolean;
  errorType?: "no_active_mission" | "already_on_mission" | "other";
}

async function executeAction(client: PokedRaceMCPClient, tokenIndex: number, action: string, zone?: string): Promise<ActionResult> {
  try {
    let result;
    if (action === "complete") {
      result = await client.callTool("garage_complete_scavenging", { token_index: tokenIndex });
      if (result.isError) {
        const errorMsg = result.content?.[0]?.text || "Unknown error";
        if (errorMsg.includes("No active mission")) {
          console.log(`  ⚠️  Bot #${tokenIndex}: No active mission to complete (may already be in target zone)`);
          return { success: false, errorType: "no_active_mission" };
        }
        console.error(`  ✗ Failed to complete for bot #${tokenIndex}: ${errorMsg}`);
        return { success: false, errorType: "other" };
      }
      console.log(`  ✓ Completed scavenging for bot #${tokenIndex}`);
    } else if (action === "start" && zone) {
      result = await client.callTool("garage_start_scavenging", { token_index: tokenIndex, zone });
      if (result.isError) {
        const errorMsg = result.content?.[0]?.text || "Unknown error";
        if (errorMsg.includes("already on a scavenging mission")) {
          console.log(`  ⚠️  Bot #${tokenIndex}: Already on mission (OK - bot is working)`);
          return { success: true, errorType: "already_on_mission" };  // Treat as success
        }
        console.error(`  ✗ Failed to start for bot #${tokenIndex}: ${errorMsg}`);
        return { success: false, errorType: "other" };
      }
      console.log(`  ✓ Started scavenging in ${zone} for bot #${tokenIndex}`);
    }
    return { success: true };
  } catch (error: any) {
    console.error(`  ✗ Exception during ${action} for bot #${tokenIndex}:`, error.message);
    return { success: false, errorType: "other" };
  }
}

// Helper to move a bot from one zone to another
async function moveBot(client: PokedRaceMCPClient, tokenIndex: number, targetZone: string): Promise<boolean> {
  const completeResult = await executeAction(client, tokenIndex, "complete");

  // If no active mission, the bot might already be where we want it or in an idle state
  // Skip start in this case as the server state is uncertain
  if (completeResult.errorType === "no_active_mission") {
    // Try to start anyway - if the bot is truly idle, this will work
    // If it's already on a mission somewhere, we'll get "already on mission" which is OK
    await new Promise(resolve => setTimeout(resolve, 300));
    const startResult = await executeAction(client, tokenIndex, "start", targetZone);
    return startResult.success;
  }

  if (!completeResult.success) {
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, 300));
  const startResult = await executeAction(client, tokenIndex, "start", targetZone);
  return startResult.success;
}

// Helper function to split array into chunks
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

async function getAllOwnedBots(client: PokedRaceMCPClient): Promise<number[]> {
  const result = await client.callTool("garage_list_my_pokedbots", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    return [];
  }

  const responseText = result.content[0].text;
  const botMatches = responseText.matchAll(/🏎️ PokedBot #(\d+)/g);
  const botIndices: number[] = [];

  for (const match of botMatches) {
    botIndices.push(parseInt(match[1]));
  }

  return botIndices;
}

async function getEventRegisteredBots(client: PokedRaceMCPClient): Promise<Set<number>> {
  const result = await client.callTool("racing_get_my_registrations", {});

  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    return new Set();
  }

  const responseText = result.content[0].text;
  const registeredBots = new Set<number>();

  // Parse: "🤖 Bot: #1234"
  const botMatches = responseText.matchAll(/🤖 Bot: #(\d+)/g);
  for (const match of botMatches) {
    registeredBots.add(parseInt(match[1]));
  }

  return registeredBots;
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    // Get all owned bots directly from the API
    console.log(`\n📋 Fetching all owned bots...`);
    const allBots = await getAllOwnedBots(client);

    // Get bots registered for upcoming events (skip them)
    console.log(`🏁 Checking event registrations...`);
    const eventRegisteredBots = await getEventRegisteredBots(client);
    const botsToProcess = allBots.filter(bot => !eventRegisteredBots.has(bot));

    console.log(`\n🔍 Auto-Scavenge Loop Started (PARALLEL MODE)`);
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🤖 Total bots: ${allBots.length}, Event registered: ${eventRegisteredBots.size}, Processing: ${botsToProcess.length}\n`);
    console.log(`⚙️  Thresholds: Battery 95% & Condition 95% (ScrapHeaps entry) / Battery < 80% or Condition < 80% (ScrapHeaps exit)`);
    console.log(`⚡ Processing 2 bots at a time\n`);

    // Process bots in parallel (2 at a time)
    let remainingBots = [...botsToProcess];
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
                // ChargingStation: 95%以上になるまで外に出さない
                if (status.battery >= BATTERY_THRESHOLD_HIGH) {
                  if (status.condition < CONDITION_THRESHOLD_HIGH) {
                    console.log(`  → Battery ${status.battery}%! But condition low (${status.condition}%). Moving to RepairBay...`);
                    await moveBot(client, tokenIndex, "RepairBay");
                  } else {
                    console.log(`  → Battery ${status.battery}% and condition ${status.condition}%! Moving to ScrapHeaps...`);
                    await moveBot(client, tokenIndex, "ScrapHeaps");
                  }
                } else {
                  console.log(`  → Charging... (${status.battery}%)`);
                }
              } else if (status.scavenging_zone === "RepairBay") {
                // RepairBay: バッテリー優先でチェック
                if (status.battery < BATTERY_THRESHOLD) {
                  console.log(`  → Battery critical (${status.battery}%) during repair! Moving to ChargingStation...`);
                  await moveBot(client, tokenIndex, "ChargingStation");
                } else if (status.condition >= CONDITION_THRESHOLD_HIGH) {
                  // 修理完了したがバッテリーチェック
                  if (status.battery < BATTERY_THRESHOLD_HIGH) {
                    console.log(`  → Condition restored (${status.condition}%), but battery low (${status.battery}%). Moving to ChargingStation...`);
                    await moveBot(client, tokenIndex, "ChargingStation");
                  } else {
                    console.log(`  → Condition restored (${status.condition}%) and battery ${status.battery}%! Moving to ScrapHeaps...`);
                    await moveBot(client, tokenIndex, "ScrapHeaps");
                  }
                } else {
                  console.log(`  → Repairing... (Condition: ${status.condition}%, Battery: ${status.battery}%)`);
                }
              } else {
                // ScrapHeaps等: どちらかが80%切ったらChargingStationへ
                if (status.battery < BATTERY_THRESHOLD || status.condition < CONDITION_THRESHOLD_LOW) {
                  const reason = status.battery < BATTERY_THRESHOLD
                    ? `Battery low (${status.battery}%)`
                    : `Condition low (${status.condition}%)`;
                  console.log(`  → ${reason}! Moving to ChargingStation...`);
                  await moveBot(client, tokenIndex, "ChargingStation");
                } else {
                  console.log(`  → Scavenging... (Battery: ${status.battery}%, Condition: ${status.condition}%)`);
                }
              }
            } else {
              // 未稼働: Battery 95%+ & Condition 95%+ でないとScrapHeapsに行かない
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

        console.log(`✓ Chunk ${i + 1} complete (${processedCount}/${botsToProcess.length} total, ${failedBots.length} failed)`);

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

    console.log(`\n✅ Loop completed - processed ${processedCount}/${botsToProcess.length} bots (${eventRegisteredBots.size} skipped for events)`);
    await client.close();
  } catch (error) {
    console.error("Error in auto-scavenge loop:", error);
    process.exit(1);
  }
}

main();
