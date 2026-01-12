import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();
  
  try {
    await client.connect(SERVER_URL, API_KEY);
    
    const result = await client.callTool("garage_get_robot_details", { token_index: 5143 });
    const data = JSON.parse(result.content[0].text);
    
    const name = data.name || `Bot #5143`;
    const battery = data.condition?.battery || 0;
    const condition = data.condition?.condition || 0;
    const zone = data.active_scavenging?.zone || null;
    const status = data.active_scavenging?.status || "None";
    
    console.log(`\n🔍 Bot #5143 "${name}":`);
    console.log(`  Battery: ${battery}%`);
    console.log(`  Condition: ${condition}%`);
    console.log(`  Zone: ${zone || "None"}`);
    console.log(`  Status: ${status}`);
    
    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
