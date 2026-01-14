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
    const eventId = 190; // Next event: JST 翌3:00 (18h後)

    console.log(`\n=== Registering Hachi #${hachiTokenIndex} for Event #${eventId} ===\n`);

    // Check current event details
    console.log("Fetching event details...");
    const eventsResult = await client.callTool("racing_list_events", {});

    if (eventsResult.content && eventsResult.content[0]) {
      const eventsText = eventsResult.content[0].text;
      const eventMatch = eventsText.match(new RegExp(`\\*\\*Event #${eventId}\\*\\*:[^]*?(?=\\n---|\$)`, 's'));

      if (eventMatch) {
        console.log("\nEvent details:");
        console.log(eventMatch[0]);
        console.log();
      }
    }

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
    console.log(`📝 Calling racing_register_for_event...`);
    console.log(`   Event: #${eventId}`);
    console.log(`   Bot: #${hachiTokenIndex} (Hachi)\n`);

    const registerResult = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: hachiTokenIndex
    });

    console.log("=== Registration Response ===\n");

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
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main();
