import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(process.env.MCP_SERVER_URL!, process.env.MCP_API_KEY);

  // Get battery info from compendium
  const result = await client.callTool("help_get_compendium", { section: "battery" });
  console.log("=== Battery Info ===");
  console.log(result.content[0].text);

  // Also check scavenging info
  const scavResult = await client.callTool("help_get_compendium", { section: "scavenging" });
  console.log("\n=== Scavenging Info ===");
  console.log(scavResult.content[0].text);

  await client.close();
}

main();
