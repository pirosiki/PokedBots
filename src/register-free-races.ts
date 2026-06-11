import { PokedRaceMCPClient } from "./mcp-client.js";
import dotenv from "dotenv";

dotenv.config();

const SERVER_URL =
  process.env.MCP_SERVER_URL ||
  "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;
const REGISTER_DELAY_MS = Number(process.env.FREE_RACE_REGISTER_DELAY_MS || "500");
const MAX_RUNTIME_MS = Number(process.env.FREE_RACE_MAX_RUNTIME_MS || "900000");

type RaceClass = "Scrap" | "Junker" | "Raider" | "Elite" | "SilentKlan";

type Bot = {
  tokenIndex: number;
  name: string;
  raceClass: RaceClass | "Unknown";
  battery: number;
  condition: number;
};

type FreeRace = {
  eventId: number;
  eventName: string;
  divisions: RaceClass[];
  startTime: Date;
  registeredCount: number;
  maxEntrants: number;
};

function parseRaceClass(text: string | undefined): RaceClass | "Unknown" {
  const match = (text || "").match(/Silent\s*Klan|SilentKlan|Scrap|Junker|Raider|Elite/i);
  if (!match) return "Unknown";
  const normalized = match[0].replace(/\s+/g, "").toLowerCase();
  if (normalized === "scrap") return "Scrap";
  if (normalized === "junker") return "Junker";
  if (normalized === "raider") return "Raider";
  if (normalized === "elite") return "Elite";
  if (normalized === "silentklan") return "SilentKlan";
  return "Unknown";
}

function parseDivisions(text: string | undefined): RaceClass[] {
  const divisions = new Set<RaceClass>();
  for (const match of (text || "").matchAll(/Silent\s*Klan|SilentKlan|Scrap|Junker|Raider|Elite/gi)) {
    const raceClass = parseRaceClass(match[0]);
    if (raceClass !== "Unknown") divisions.add(raceClass);
  }
  return [...divisions];
}

function isFreeEventText(block: string): boolean {
  if (/Daily Sprint/i.test(block)) return false;
  if (/Free Sprint|Free Race|Entry Fee:\s*(?:FREE|0(?:\.0+)?\s*ICP)/i.test(block)) return true;
  return false;
}

async function getAllBots(client: PokedRaceMCPClient): Promise<Bot[]> {
  const result = await client.callTool("garage_list_my_pokedbots", {});
  const responseText = result.content?.[0]?.text || "";
  const bots: Bot[] = [];

  try {
    const data = JSON.parse(responseText);
    if (Array.isArray(data.bots)) {
      for (const bot of data.bots) {
        bots.push({
          tokenIndex: Number(bot.token_index),
          name: bot.name || `Bot #${bot.token_index}`,
          raceClass: parseRaceClass(bot.race_class),
          battery: Number(bot.battery || 0),
          condition: Number(bot.condition || 0),
        });
      }
    }
  } catch {
    const blocks = responseText
      .split(/(?=🏎️ PokedBot #)/g)
      .filter((block: string) => block.includes("PokedBot #"));

    for (const block of blocks) {
      const tokenMatch = block.match(/🏎️ PokedBot #(\d+)(?: "([^"]+)")?/);
      if (!tokenMatch) continue;
      const classMatch = block.match(/Class:\s*([^\n]+)/);
      const batteryMatch = block.match(/Battery:\s*(\d+)%/);
      const conditionMatch = block.match(/Condition:\s*(\d+)%/);
      const tokenIndex = Number(tokenMatch[1]);

      bots.push({
        tokenIndex,
        name: tokenMatch[2] || `Bot #${tokenIndex}`,
        raceClass: parseRaceClass(classMatch?.[1]),
        battery: Number(batteryMatch?.[1] || 0),
        condition: Number(conditionMatch?.[1] || 0),
      });
    }
  }

  return bots.filter((bot) => Number.isInteger(bot.tokenIndex));
}

async function getUpcomingFreeRaces(client: PokedRaceMCPClient): Promise<FreeRace[]> {
  const result = await client.callTool("racing_list_events", {});
  const responseText = result.content?.[0]?.text || "";
  const races: FreeRace[] = [];
  const now = new Date();

  try {
    const data = JSON.parse(responseText);
    if (Array.isArray(data.events)) {
      for (const event of data.events) {
        const eventName = String(event.event_type || event.name || "Free Race");
        const feeText = String(event.entry_fee || event.entryFee || "");
        if (/DailySprint|Daily Sprint/i.test(eventName)) continue;
        if (!/Free|^0$|0\.0+\s*ICP/i.test(`${eventName} ${feeText}`)) continue;

        const startTime = new Date(event.start_time_utc || event.startTime);
        if (Number.isNaN(startTime.getTime()) || startTime <= now) continue;

        races.push({
          eventId: Number(event.event_id),
          eventName,
          divisions: parseDivisions(String(event.race_class || event.divisions || "Scrap Junker Raider Elite")),
          startTime,
          registeredCount: Number(event.registered_count || 0),
          maxEntrants: Number(event.max_entrants || 100),
        });
      }
    }
  } catch {
    const blocks = responseText
      .split("---")
      .filter((block: string) => /Event #\d+/.test(block));

    for (const block of blocks) {
      if (!isFreeEventText(block)) continue;

      const eventIdMatch = block.match(/Event #(\d+)/);
      const divisionsMatch = block.match(/Divisions:\s*([^\n]+)/);
      const startMatch = block.match(/📅 Start:\s*([\d\-:TZ]+)/);
      const registeredMatch = block.match(/Registered:\s*(\d+)\/(\d+)/);
      if (!eventIdMatch || !startMatch) continue;

      const startTime = new Date(startMatch[1]);
      if (Number.isNaN(startTime.getTime()) || startTime <= now) continue;

      races.push({
        eventId: Number(eventIdMatch[1]),
        eventName: block.match(/Free Sprint|Free Race/i)?.[0] || "Free Race",
        divisions: parseDivisions(divisionsMatch?.[1] || "Scrap Junker Raider Elite"),
        startTime,
        registeredCount: Number(registeredMatch?.[1] || 0),
        maxEntrants: Number(registeredMatch?.[2] || 100),
      });
    }
  }

  return races.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

async function getMyRegistrations(
  client: PokedRaceMCPClient,
  ownedTokens: Set<number>
): Promise<Set<string>> {
  const result = await client.callTool("racing_get_my_registrations", {});
  const responseText = result.content?.[0]?.text || "";
  const registered = new Set<string>();

  try {
    const data = JSON.parse(responseText);
    const stack: unknown[] = [data];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current !== "object") continue;
      if (Array.isArray(current)) {
        stack.push(...current);
        continue;
      }

      const obj = current as Record<string, unknown>;
      let token: number | null = null;
      let eventId: number | null = null;
      for (const [key, value] of Object.entries(obj)) {
        const normalizedKey = key.replace(/[_\s-]/g, "").toLowerCase();
        if (/^(token|tokenindex|bot|botid|bottoken)$/.test(normalizedKey)) {
          const parsed = Number(value);
          if (ownedTokens.has(parsed)) token = parsed;
        }
        if (/^(event|eventid)$/.test(normalizedKey)) {
          const parsed = Number(value);
          if (Number.isInteger(parsed)) eventId = parsed;
        }
        if (value && typeof value === "object") stack.push(value);
      }
      if (token !== null && eventId !== null) {
        registered.add(`${token}-${eventId}`);
      }
    }
  } catch {}

  for (const match of responseText.matchAll(/(?:Bot\s*)?#(\d+)[\s\S]{0,220}?Event #(\d+)/gi)) {
    const token = Number(match[1]);
    const eventId = Number(match[2]);
    if (ownedTokens.has(token)) registered.add(`${token}-${eventId}`);
  }
  for (const match of responseText.matchAll(/Event #(\d+)[\s\S]{0,220}?(?:Bot\s*)?#(\d+)/gi)) {
    const eventId = Number(match[1]);
    const token = Number(match[2]);
    if (ownedTokens.has(token)) registered.add(`${token}-${eventId}`);
  }
  return registered;
}

function canEnter(bot: Bot, race: FreeRace): boolean {
  if (bot.raceClass === "Unknown") return true;
  if (race.divisions.length === 0) return true;
  return race.divisions.includes(bot.raceClass);
}

function botPriority(bot: Bot): number {
  const classWeight: Record<string, number> = {
    Elite: 500,
    Raider: 400,
    Junker: 300,
    Scrap: 200,
    SilentKlan: 600,
    Unknown: 100,
  };
  const readiness = Math.min(bot.battery, 100) + Math.min(bot.condition, 100);
  return (classWeight[bot.raceClass] || 0) + readiness;
}

async function registerForRace(
  client: PokedRaceMCPClient,
  tokenIndex: number,
  eventId: number
): Promise<"registered" | "failed" | "race-blocked"> {
  try {
    console.log(`   → #${tokenIndex} → Event #${eventId}`);
    const result = await client.callTool("racing_register_for_event", {
      event_id: eventId,
      token_index: tokenIndex,
    });
    const text = result.content?.[0]?.text || "";
    if (result.isError || /error|failed/i.test(text)) {
      console.log(`   ✗ #${tokenIndex} → Event #${eventId}: ${text.slice(0, 140)}`);
      if (/Payment failed|full|max entrants|no slots|registration closed/i.test(text)) {
        return "race-blocked";
      }
      return "failed";
    }
    console.log(`   ✅ #${tokenIndex} → Event #${eventId}`);
    return "registered";
  } catch (error) {
    console.log(`   ✗ #${tokenIndex} → Event #${eventId}: ${String(error).slice(0, 180)}`);
    return "failed";
  }
}

async function main() {
  const startedAt = Date.now();
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  console.log("\n🏁 REGISTER FREE RACES");
  console.log(`📅 ${new Date().toISOString()}\n`);

  const bots = (await getAllBots(client)).sort((a, b) => botPriority(b) - botPriority(a));
  const ownedTokens = new Set(bots.map((bot) => bot.tokenIndex));
  const freeRaces = await getUpcomingFreeRaces(client);
  const registered = await getMyRegistrations(client, ownedTokens);

  console.log(`Bots: ${bots.length}`);
  console.log(`Free events: ${freeRaces.length}`);
  for (const race of freeRaces) {
    console.log(
      `   Event #${race.eventId}: ${race.eventName} ${race.divisions.join(",") || "All"} @ ${race.startTime.toISOString()} (${race.registeredCount}/${race.maxEntrants})`
    );
  }

  const registeredCounts = new Map(freeRaces.map((race) => [race.eventId, race.registeredCount]));
  const blockedRaces = new Set<number>();
  const candidateBots = bots.filter((bot) =>
    freeRaces.some((race) => canEnter(bot, race) && !registered.has(`${bot.tokenIndex}-${race.eventId}`))
  );

  console.log(`\nCandidate bots: ${candidateBots.length}`);
  let success = 0;
  let failed = 0;
  for (const bot of candidateBots) {
    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      console.log(`\nStopping after ${Math.round(MAX_RUNTIME_MS / 1000)}s runtime limit. Remaining bots will be retried next run.`);
      break;
    }

    for (const race of freeRaces) {
      if (blockedRaces.has(race.eventId)) continue;
      if (!canEnter(bot, race)) continue;
      if (registered.has(`${bot.tokenIndex}-${race.eventId}`)) continue;
      if ((registeredCounts.get(race.eventId) || 0) >= race.maxEntrants) continue;

      const result = await registerForRace(client, bot.tokenIndex, race.eventId);
      if (result === "registered") {
        success += 1;
        registered.add(`${bot.tokenIndex}-${race.eventId}`);
        registeredCounts.set(race.eventId, (registeredCounts.get(race.eventId) || 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, REGISTER_DELAY_MS));
        break;
      }

      failed += 1;
      if (result === "race-blocked") {
        blockedRaces.add(race.eventId);
      }
      await new Promise((resolve) => setTimeout(resolve, REGISTER_DELAY_MS));
    }
  }

  console.log("\nSummary");
  console.log(`   Registered: ${success}`);
  console.log(`   Failed: ${failed}`);
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
