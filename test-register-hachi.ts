import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    const hachiTokenIndex = 433;
    const eventId = 192;

    console.log(`\n=== Registering Hachi #${hachiTokenIndex} for Event #${eventId} ===\n`);

    // Check if already registered
    console.log("Checking existing registrations...");
    const registrationsResult = await client.callTool("racing_get_my_registrations", {});

    if (registrationsResult.content && registrationsResult.content[0]) {
      const regText = registrationsResult.content[0].text;
      const alreadyRegistered = regText.includes(`Event #${eventId}`) && regText.includes(`Bot: #${hachiTokenIndex}`);

      if (alreadyRegistered) {
        console.log(`⚠️  Hachi #${hachiTokenIndex} is already registered for Event #${eventId}`);
        await client.close();
        return;
      }
    }

    console.log("Not registered yet. Proceeding with registration...\n");

    // Register for event
    console.log(`Registering...`);
    const registerResult = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: hachiTokenIndex
    });

    console.log("\n=== Registration Response ===\n");

    if (registerResult.isError) {
      console.error("❌ Registration failed!");
      console.error("\nError:");
      if (registerResult.content && registerResult.content[0]) {
        console.error(registerResult.content[0].text);
      }
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
