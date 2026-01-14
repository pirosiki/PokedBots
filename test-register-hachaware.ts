import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Finding Hachaware ===\n");

    // Get all bots
    const result = await client.callTool("garage_list_my_pokedbots", {});

    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      console.error("Failed to get bot list");
      process.exit(1);
    }

    const responseText = result.content[0].text;

    // Search for Hachaware (case-insensitive)
    const lines = responseText.split('\n');
    let hachiwareTokenIndex: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().includes('hachaware') || line.toLowerCase().includes('hachiware')) {
        // Look for token index in previous or current line
        const tokenMatch = responseText.slice(Math.max(0, i - 2), i + 2).match(/PokedBot #(\d+)/);
        if (tokenMatch) {
          hachiwareTokenIndex = parseInt(tokenMatch[1]);
          console.log(`Found Hachaware: #${hachiwareTokenIndex}`);
          console.log(`Context: ${lines.slice(Math.max(0, i - 1), i + 2).join('\n')}`);
          break;
        }
      }
    }

    if (hachiwareTokenIndex === null) {
      console.error("\n❌ Hachaware not found in bot list");
      console.log("\nSearching for any bot with 'hachi' in name...");

      const hachiMatch = responseText.match(/PokedBot #(\d+)[^\n]*hachi/i);
      if (hachiMatch) {
        console.log(`Found similar: ${hachiMatch[0]}`);
      } else {
        console.log("No bots found with 'hachi' in name");
      }

      process.exit(1);
    }

    console.log(`\n=== Registering Hachaware #${hachiwareTokenIndex} for Event #192 ===\n`);

    // Check if already registered
    console.log("Checking existing registrations...");
    const registrationsResult = await client.callTool("racing_get_my_registrations", {});

    if (registrationsResult.content && registrationsResult.content[0]) {
      const regText = registrationsResult.content[0].text;
      const alreadyRegistered = regText.includes(`Event #192`) && regText.includes(`Bot: #${hachiwareTokenIndex}`);

      if (alreadyRegistered) {
        console.log(`⚠️  Hachaware #${hachiwareTokenIndex} is already registered for Event #192`);
        console.log("\nCurrent registrations:");
        console.log(regText);
        await client.close();
        return;
      }
    }

    console.log("Not registered yet. Proceeding with registration...\n");

    // Register for event
    console.log(`Calling racing_register_for_event...`);
    console.log(`  event_id: 192`);
    console.log(`  token_index: ${hachiwareTokenIndex}\n`);

    const registerResult = await client.callTool("racing_register_for_event", {
      event_id: 192,
      token_index: hachiwareTokenIndex
    });

    console.log("\n=== Registration Response ===\n");

    if (registerResult.isError) {
      console.error("❌ Registration failed!");
      console.error("\nError details:");
      console.error(registerResult.content[0].text);
    } else {
      console.log("✅ Registration successful!\n");
      if (registerResult.content && registerResult.content[0] && registerResult.content[0].text) {
        console.log(registerResult.content[0].text);
      }
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
