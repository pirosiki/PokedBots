import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();
  
  try {
    await client.connect(SERVER_URL, API_KEY);
    
    console.log("\n📤 Calling garage_start_scavenging for bot #5143...");
    const result = await client.callTool("garage_start_scavenging", { 
      token_index: 5143, 
      zone: "ChargingStation" 
    });
    
    console.log("\n📥 Response:");
    console.log(JSON.stringify(result, null, 2));
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log("\n🔍 Checking bot status after 2 seconds...");
    const statusResult = await client.callTool("garage_get_robot_details", { token_index: 5143 });
    const data = JSON.parse(statusResult.content[0].text);
    
    const zone = data.active_scavenging && data.active_scavenging.zone || "None";
    const status = data.active_scavenging && data.active_scavenging.status || "None";
    
    console.log(`Zone: ${zone}`);
    console.log(`Status: ${status}`);
    
    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
