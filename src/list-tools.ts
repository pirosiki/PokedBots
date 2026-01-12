import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n📋 Available Tools:\n");
    const tools = await client.listTools();

    if (tools && tools.tools) {
      tools.tools.forEach((tool: any) => {
        console.log(`\n🔧 ${tool.name}`);
        if (tool.description) {
          console.log(`   ${tool.description}`);
        }
        if (tool.inputSchema && tool.inputSchema.properties) {
          console.log(`   Parameters:`, Object.keys(tool.inputSchema.properties).join(", "));
        }
      });

      // Look for maintenance-related tools
      console.log("\n\n🔍 Searching for maintenance/repair/charge related tools:");
      const maintenanceTools = tools.tools.filter((tool: any) =>
        tool.name.toLowerCase().includes("maintenance") ||
        tool.name.toLowerCase().includes("repair") ||
        tool.name.toLowerCase().includes("charge") ||
        tool.name.toLowerCase().includes("battery") ||
        tool.name.toLowerCase().includes("condition")
      );

      if (maintenanceTools.length > 0) {
        console.log(`\n✅ Found ${maintenanceTools.length} maintenance-related tools:`);
        maintenanceTools.forEach((tool: any) => {
          console.log(`\n🛠️  ${tool.name}`);
          console.log(`   ${tool.description || "No description"}`);
        });
      } else {
        console.log("\n❌ No maintenance-related tools found");
      }
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
