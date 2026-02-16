/**
 * Upgrade Ged (#9943) - PWR+15, ACC+12, STB+12 (parts payment)
 */

import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const TOKEN_INDEX = 9943;

// Target stats (at full power)
const TARGET_STATS = {
  PWR: 36 + 15, // 51
  ACC: 43 + 12, // 55
  STB: 30 + 12, // 42
};

// upgrade_type mapping
const STAT_TO_UPGRADE: Record<string, string> = {
  PWR: "PowerCore",
  ACC: "Thruster",
  STB: "Gyro",
};

interface Stats {
  SPD: number;
  PWR: number;
  ACC: number;
  STB: number;
}

async function getCurrentStats(client: PokedRaceMCPClient): Promise<Stats> {
  const result = await client.callTool("garage_get_robot_details", { token_index: TOKEN_INDEX });
  if (!result || !result.content || !result.content[0] || !result.content[0].text) {
    throw new Error("Failed to get robot details");
  }
  const text = result.content[0].text;

  // Try JSON parse first
  try {
    const data = JSON.parse(text);
    return {
      SPD: data.stats?.speed?.at_full_power ?? data.stats?.speed ?? 0,
      PWR: data.stats?.power_core?.at_full_power ?? data.stats?.power_core ?? 0,
      ACC: data.stats?.acceleration?.at_full_power ?? data.stats?.acceleration ?? 0,
      STB: data.stats?.stability?.at_full_power ?? data.stats?.stability ?? 0,
    };
  } catch {
    // Fallback: parse text format "SPD 50/50 | PWR 36/51 | ACC 43/55 | STB 30/42"
    const statsMatch = text.match(/SPD\s+\d+\/(\d+)\s*\|\s*PWR\s+\d+\/(\d+)\s*\|\s*ACC\s+\d+\/(\d+)\s*\|\s*STB\s+\d+\/(\d+)/);
    if (statsMatch) {
      return {
        SPD: parseInt(statsMatch[1]),
        PWR: parseInt(statsMatch[2]),
        ACC: parseInt(statsMatch[3]),
        STB: parseInt(statsMatch[4]),
      };
    }
    console.log("⚠️  Could not parse stats. Raw response (first 500 chars):");
    console.log(text.slice(0, 500));
    throw new Error("Failed to parse stats");
  }
}

async function doUpgrade(client: PokedRaceMCPClient, upgradeType: string): Promise<{ success: boolean; points: number; message: string }> {
  try {
    const result = await client.callTool("garage_upgrade_robot", {
      token_index: TOKEN_INDEX,
      upgrade_type: upgradeType,
      payment_method: "parts",
    });

    const text = result.content?.[0]?.text || "";

    if (result.isError) {
      return { success: false, points: 0, message: text.slice(0, 200) };
    }

    // Parse JSON response for reliable success check
    try {
      const data = JSON.parse(text);
      if (data.success === true) {
        return { success: true, points: data.points_awarded || 1, message: text.slice(0, 200) };
      } else {
        return { success: false, points: 0, message: text.slice(0, 200) };
      }
    } catch {
      // If not JSON, check text
      return { success: false, points: 0, message: text.slice(0, 200) };
    }
  } catch (error) {
    return { success: false, points: 0, message: `Exception: ${error}` };
  }
}

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n⬆️  ========================================");
    console.log("⬆️   UPGRADE GED (#9943)");
    console.log("⬆️  ========================================\n");
    console.log(`📅 ${new Date().toISOString()}`);
    console.log(`🎯 Targets: PWR=${TARGET_STATS.PWR} ACC=${TARGET_STATS.ACC} STB=${TARGET_STATS.STB}\n`);

    // Check current stats
    const initial = await getCurrentStats(client);
    console.log(`📊 Current: SPD=${initial.SPD} PWR=${initial.PWR} ACC=${initial.ACC} STB=${initial.STB}`);

    const remaining = {
      PWR: Math.max(0, TARGET_STATS.PWR - initial.PWR),
      ACC: Math.max(0, TARGET_STATS.ACC - initial.ACC),
      STB: Math.max(0, TARGET_STATS.STB - initial.STB),
    };

    console.log(`📋 Remaining: PWR+${remaining.PWR} ACC+${remaining.ACC} STB+${remaining.STB}\n`);

    const totalNeeded = remaining.PWR + remaining.ACC + remaining.STB;
    if (totalNeeded === 0) {
      console.log("✅ Already at target stats!");
      await client.close();
      return;
    }

    let totalSuccesses = 0;
    let totalFailures = 0;

    for (const [stat, needed] of Object.entries(remaining)) {
      if (needed === 0) {
        console.log(`━━━ ${stat}: already at target ━━━`);
        continue;
      }

      const upgradeType = STAT_TO_UPGRADE[stat];
      console.log(`\n━━━ ${stat} (${upgradeType}) need +${needed} ━━━`);

      let gained = 0;
      let successes = 0;
      let failures = 0;
      const maxAttempts = needed * 15; // Safety limit

      while (gained < needed && (successes + failures) < maxAttempts) {
        const { success, points, message } = await doUpgrade(client, upgradeType);

        if (success) {
          successes++;
          gained += points;
          console.log(`   ✅ [+${gained}/${needed}] pts=${points} ${message.slice(0, 120)}`);
        } else {
          failures++;
          if (message.includes("Not enough") || message.includes("insufficient") || message.includes("Inventory")) {
            console.log(`   ❌ INSUFFICIENT PARTS: ${message}`);
            break;
          }
          console.log(`   ❌ [fail #${failures}] ${message.slice(0, 120)}`);
        }

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      totalSuccesses += successes;
      totalFailures += failures;

      if (gained >= needed) {
        console.log(`   🎉 ${stat} done! +${gained} (${successes} wins / ${failures} fails)`);
      } else {
        console.log(`   ⚠️  ${stat} stopped at +${gained}/${needed} (${successes} wins / ${failures} fails)`);
      }
    }

    // Final check
    const final_ = await getCurrentStats(client);
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`📊 Final: SPD=${final_.SPD} PWR=${final_.PWR} ACC=${final_.ACC} STB=${final_.STB}`);
    console.log(`   Δ SPD+${final_.SPD - initial.SPD} PWR+${final_.PWR - initial.PWR} ACC+${final_.ACC - initial.ACC} STB+${final_.STB - initial.STB}`);
    console.log(`   Total: ${totalSuccesses} wins / ${totalFailures} fails (${totalSuccesses + totalFailures} attempts)`);

    const hitTarget =
      final_.PWR >= TARGET_STATS.PWR &&
      final_.ACC >= TARGET_STATS.ACC &&
      final_.STB >= TARGET_STATS.STB;
    console.log(hitTarget ? "\n✅ All targets reached!" : "\n⚠️  Some targets not reached");

    await client.close();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
