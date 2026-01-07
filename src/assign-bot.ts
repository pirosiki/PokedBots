import { BotManager } from "./bot-manager.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: npm run assign <token_index> <racing|scavenging|remove>");
    console.log("\nExamples:");
    console.log("  npm run assign 4079 racing       # Assign bot #4079 to racing group");
    console.log("  npm run assign 2341 scavenging   # Assign bot #2341 to scavenging group");
    console.log("  npm run assign 4079 remove       # Remove bot #4079 from all groups");
    process.exit(1);
  }

  const tokenIndex = parseInt(args[0]);
  const action = args[1].toLowerCase();

  if (isNaN(tokenIndex)) {
    console.error("Error: Token index must be a number");
    process.exit(1);
  }

  const botManager = new BotManager();
  await botManager.loadConfig();

  switch (action) {
    case "racing":
      botManager.addRacingBot(tokenIndex);
      console.log(`✓ Bot #${tokenIndex} assigned to RACING group`);
      break;

    case "scavenging":
      botManager.addScavengingBot(tokenIndex);
      console.log(`✓ Bot #${tokenIndex} assigned to SCAVENGING group`);
      break;

    case "remove":
      botManager.removeBot(tokenIndex);
      console.log(`✓ Bot #${tokenIndex} removed from all groups`);
      break;

    default:
      console.error(`Error: Invalid action '${action}'. Use 'racing', 'scavenging', or 'remove'`);
      process.exit(1);
  }

  await botManager.saveConfig();

  // Show current configuration
  const config = botManager.getConfig();
  console.log("\n=== Current Configuration ===");
  console.log(`Racing Bots: ${config.racing_bots.join(", ") || "none"}`);
  console.log(`Scavenging Bots: ${config.scavenging_bots.join(", ") || "none"}`);
}

main();
