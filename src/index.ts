import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    // Connect to the MCP server
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Investigating Server Capabilities ===\n");

    // List all available tools
    console.log("--- Available Tools ---");
    const tools = await client.listTools();
    console.log(JSON.stringify(tools, null, 2));

    // List all available resources
    console.log("\n--- Available Resources ---");
    const resources = await client.listResources();
    console.log(JSON.stringify(resources, null, 2));

    // List all available prompts (optional, may not be supported)
    console.log("\n--- Available Prompts ---");
    try {
      const prompts = await client.listPrompts();
      console.log(JSON.stringify(prompts, null, 2));
    } catch (error: any) {
      console.log("Prompts not supported on this server:", error.message);
    }

    console.log("\n=== Investigation Complete ===\n");

    // Close the connection
    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
