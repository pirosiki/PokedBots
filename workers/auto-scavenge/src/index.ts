/**
 * Cloudflare Workers - Auto Scavenge Loop
 * Runs every 15 minutes via Cron Triggers
 */

interface Env {
  MCP_SERVER_URL: string;
  MCP_API_KEY: string;
}

interface BotStatus {
  token_index: number;
  battery: number;
  condition: number;
  scavenging_zone: string | null;
  name?: string;
}

const BATTERY_THRESHOLD = 40;
const CONDITION_THRESHOLD_HIGH = 90;
const CONDITION_THRESHOLD_LOW = 40;

// Bot configuration - matches bots-config.json
const SCAVENGING_BOTS = [
  3406, 8636, 3913, 4410, 2630, 1866, 9943, 2632, 2669, 5143,
  59, 359, 631, 820, 879, 946, 1203, 1209, 2115, 2542,
  2639, 2934, 2957, 2985, 3241, 3282, 3444, 3450, 3535, 3606,
  4156, 4263, 4467, 3674, 4693, 4756, 4933, 4935, 5357, 5441,
  6372, 6404, 6613, 6695, 6722, 7003, 7068, 7098, 7486, 7522,
  7814, 8080, 8603, 8623, 8626, 8760, 8881, 8895, 8911, 8934,
  9467, 9381, 8696, 7432, 7113, 6988, 6790, 5597, 5252, 4968,
  3586, 2740, 9035, 9043, 9081, 9170, 9420, 9567, 9587, 9672,
  9690, 1339, 1038, 1003, 836, 608, 9888, 9836, 9755, 9716,
  9048, 8868, 2287, 1560, 1722
];

async function callMCP(env: Env, method: string, params: any): Promise<any> {
  const response = await fetch(env.MCP_SERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.MCP_API_KEY}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: method,
        arguments: params
      }
    })
  });

  const data = await response.json();
  return data.result;
}

async function getBotStatus(env: Env, tokenIndex: number): Promise<BotStatus | null> {
  try {
    const result = await callMCP(env, 'garage_get_robot_details', { token_index: tokenIndex });

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      return null;
    }

    const data = JSON.parse(result.content[0].text);
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

async function executeAction(env: Env, tokenIndex: number, action: string, zone?: string): Promise<boolean> {
  try {
    let result;
    if (action === "complete") {
      result = await callMCP(env, 'garage_complete_scavenging', { token_index: tokenIndex });
      if (result.isError) {
        const errorMsg = result.content?.[0]?.text || "Unknown error";
        console.error(`✗ Failed to complete for bot #${tokenIndex}: ${errorMsg}`);
        return false;
      }
      console.log(`✓ Completed scavenging for bot #${tokenIndex}`);
    } else if (action === "start" && zone) {
      result = await callMCP(env, 'garage_start_scavenging', { token_index: tokenIndex, zone });
      if (result.isError) {
        const errorMsg = result.content?.[0]?.text || "Unknown error";
        console.error(`✗ Failed to start for bot #${tokenIndex}: ${errorMsg}`);
        return false;
      }
      console.log(`✓ Started scavenging in ${zone} for bot #${tokenIndex}`);
    }
    return true;
  } catch (error: any) {
    console.error(`✗ Exception during ${action} for bot #${tokenIndex}:`, error.message);
    return false;
  }
}

async function processBots(env: Env): Promise<{ processed: number; failed: number }> {
  let processedCount = 0;
  let failedCount = 0;

  console.log(`🔍 Processing ${SCAVENGING_BOTS.length} scavenging bots (2 at a time)...`);

  // Process in chunks of 2
  for (let i = 0; i < SCAVENGING_BOTS.length; i += 2) {
    const chunk = SCAVENGING_BOTS.slice(i, i + 2);

    const results = await Promise.all(
      chunk.map(async (tokenIndex) => {
        const status = await getBotStatus(env, tokenIndex);
        if (status === null) {
          return { tokenIndex, success: false };
        }

        const displayName = status.name ? `#${tokenIndex} "${status.name}"` : `#${tokenIndex}`;
        console.log(`🤖 Bot ${displayName}: Battery=${status.battery}%, Condition=${status.condition}%, Zone=${status.scavenging_zone || "None"}`);

        // Decision logic
        if (status.scavenging_zone) {
          if (status.scavenging_zone === "ChargingStation") {
            if (status.battery >= 100) {
              if (status.condition < CONDITION_THRESHOLD_HIGH) {
                console.log(`  → Battery 100%! But condition low (${status.condition}%). Moving to RepairBay...`);
                await executeAction(env, tokenIndex, "complete");
                await new Promise(resolve => setTimeout(resolve, 300));
                await executeAction(env, tokenIndex, "start", "RepairBay");
              } else {
                console.log(`  → Battery 100% and condition ${status.condition}%! Moving to ScrapHeaps...`);
                await executeAction(env, tokenIndex, "complete");
                await new Promise(resolve => setTimeout(resolve, 300));
                await executeAction(env, tokenIndex, "start", "ScrapHeaps");
              }
            } else {
              console.log(`  → Charging... (${status.battery}%)`);
            }
          } else if (status.scavenging_zone === "RepairBay") {
            if (status.battery < BATTERY_THRESHOLD) {
              console.log(`  → Battery critical (${status.battery}%) during repair! Moving to ChargingStation...`);
              await executeAction(env, tokenIndex, "complete");
              await new Promise(resolve => setTimeout(resolve, 300));
              await executeAction(env, tokenIndex, "start", "ChargingStation");
            } else if (status.condition >= CONDITION_THRESHOLD_HIGH) {
              if (status.battery < 100) {
                console.log(`  → Condition restored (${status.condition}%), but battery not full (${status.battery}%). Moving to ChargingStation...`);
                await executeAction(env, tokenIndex, "complete");
                await new Promise(resolve => setTimeout(resolve, 300));
                await executeAction(env, tokenIndex, "start", "ChargingStation");
              } else {
                console.log(`  → Condition restored and battery 100%! Moving to ScrapHeaps...`);
                await executeAction(env, tokenIndex, "complete");
                await new Promise(resolve => setTimeout(resolve, 300));
                await executeAction(env, tokenIndex, "start", "ScrapHeaps");
              }
            } else {
              console.log(`  → Repairing... (Condition: ${status.condition}%, Battery: ${status.battery}%)`);
            }
          } else {
            // ScrapHeaps等
            if (status.battery < BATTERY_THRESHOLD || status.condition < CONDITION_THRESHOLD_LOW) {
              const reason = status.battery < BATTERY_THRESHOLD
                ? `Battery low (${status.battery}%)`
                : `Condition low (${status.condition}%)`;
              console.log(`  → ${reason}! Moving to ChargingStation...`);
              await executeAction(env, tokenIndex, "complete");
              await new Promise(resolve => setTimeout(resolve, 300));
              await executeAction(env, tokenIndex, "start", "ChargingStation");
            } else {
              console.log(`  → Scavenging... (Battery: ${status.battery}%, Condition: ${status.condition}%)`);
            }
          }
        } else {
          // 未稼働
          if (status.battery < 100) {
            console.log(`  → Not scavenging. Battery not full (${status.battery}%). Starting in ChargingStation...`);
            await executeAction(env, tokenIndex, "start", "ChargingStation");
          } else if (status.condition < CONDITION_THRESHOLD_HIGH) {
            console.log(`  → Not scavenging. Battery 100% but condition low (${status.condition}%). Starting in RepairBay...`);
            await executeAction(env, tokenIndex, "start", "RepairBay");
          } else {
            console.log(`  → Not scavenging. Battery 100% and condition ${status.condition}%! Starting in ScrapHeaps...`);
            await executeAction(env, tokenIndex, "start", "ScrapHeaps");
          }
        }

        return { tokenIndex, success: true };
      })
    );

    for (const result of results) {
      if (result.success) {
        processedCount++;
      } else {
        failedCount++;
      }
    }

    // Small delay between chunks
    if (i + 2 < SCAVENGING_BOTS.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return { processed: processedCount, failed: failedCount };
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`🔍 Auto-Scavenge Loop Started (Cloudflare Workers)`);
    console.log(`📅 ${new Date().toISOString()}`);

    const result = await processBots(env);

    console.log(`✅ Loop completed - processed ${result.processed}/${SCAVENGING_BOTS.length} bots (${result.failed} failed)`);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Manual trigger via HTTP request
    console.log(`🔍 Auto-Scavenge Loop Started (Manual Trigger)`);
    console.log(`📅 ${new Date().toISOString()}`);

    const result = await processBots(env);

    return new Response(
      JSON.stringify({
        success: true,
        processed: result.processed,
        failed: result.failed,
        total: SCAVENGING_BOTS.length,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};
