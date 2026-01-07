import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  // Check race details to see participant structure
  const result = await client.callTool("racing_get_race_details", { race_id: 576 });
  console.log(JSON.stringify(JSON.parse(result.content[0].text), null, 2));

  await client.close();
}

main();
