import { PokedRaceMCPClient } from "./src/mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL = process.env.MCP_SERVER_URL || "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

async function main() {
  const client = new PokedRaceMCPClient();

  try {
    await client.connect(SERVER_URL, API_KEY);

    console.log("\n=== Searching for repository information ===\n");

    // Check compendium
    const result = await client.callTool("help_get_compendium", { section: "all" });
    const text = result.content[0].text;

    // Search for git/github/repo keywords
    const keywords = ['git', 'github', 'repository', 'repo', 'source code', 'https://'];

    for (const keyword of keywords) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          console.log(`Found "${keyword}":`);
          console.log(lines.slice(start, end).join('\n'));
          console.log('---\n');
        }
      }
    }

    await client.close();
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
