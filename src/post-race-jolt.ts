/**
 * Post-Race Jolt (Daily Sprint +15m)
 *
 * Purpose:
 * - Run shortly after Daily Sprint finishes and top up roster bots with Jolt.
 * - Keep this separate from routine-manager so pre-race overcharge planning is not disturbed.
 */

import dotenv from "dotenv";
import { PokedRaceMCPClient } from "./mcp-client.js";
import { ALL_TOKENS } from "./roster.js";

dotenv.config();

const SERVER_URL =
  process.env.MCP_SERVER_URL ||
  "https://p6nop-vyaaa-aaaai-q4djq-cai.icp0.io/mcp";
const API_KEY = process.env.MCP_API_KEY;

const DAILY_SPRINT_UTC_HOURS = [0, 6, 12, 18];
const POST_RACE_TARGET_MINUTES = 15;
const POST_RACE_WINDOW_MINUTES = Number(
  process.env.POST_RACE_WINDOW_MINUTES ?? "20"
);
const JOLT_TARGET_BATTERY = 80;
const MAX_JOLT_PER_BOT = 4;

const DEFAULT_JOLT_BATTERY_IDS = [
  47, 19, 105, 53, 104, 78, 122, 124, 123, 127, 129, 131,
];
const JOLT_MIN_STORED_KWH = Number(process.env.JOLT_MIN_STORED_KWH ?? "0");
const JOLT_REQUIRE_OPERATIONAL = process.env.JOLT_REQUIRE_OPERATIONAL === "1";
const JOLT_FIXED_BATTERY_IDS = (() => {
  const raw = (process.env.JOLT_FIXED_BATTERY_IDS || "").trim();
  if (!raw) return DEFAULT_JOLT_BATTERY_IDS;
  const seen = new Set<number>();
  const parsed = raw
    .split(/[,\s]+/)
    .map((v) => parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0 && !seen.has(v) && seen.add(v));
  return parsed.length > 0 ? parsed : DEFAULT_JOLT_BATTERY_IDS;
})();

interface BotStatus {
  token: number;
  name: string;
  battery: number;
}

function getMinutesSinceLastDailySprint(now: Date = new Date()): number {
  let minMs = Number.POSITIVE_INFINITY;

  for (const hour of DAILY_SPRINT_UTC_HOURS) {
    const candidate = new Date(now);
    candidate.setUTCHours(hour, 0, 0, 0);
    if (candidate.getTime() > now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    const delta = now.getTime() - candidate.getTime();
    if (delta < minMs) minMs = delta;
  }

  return Math.floor(minMs / 60000);
}

function isPostRaceWindow(now: Date = new Date()): boolean {
  const since = getMinutesSinceLastDailySprint(now);
  return (
    since >= POST_RACE_TARGET_MINUTES &&
    since < POST_RACE_TARGET_MINUTES + POST_RACE_WINDOW_MINUTES
  );
}

function parseRegisteredFromPayload(
  payload: string,
  candidateSet: Set<number>
): Set<number> {
  const tokens = new Set<number>();

  try {
    const data = JSON.parse(payload);
    const stack: unknown[] = [data];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        for (const item of cur) stack.push(item);
        continue;
      }
      const obj = cur as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (
          /^(token|token_index|tokenIndex|bot_token|botToken)$/i.test(k) &&
          (typeof v === "number" || typeof v === "string")
        ) {
          const n = typeof v === "number" ? v : parseInt(v, 10);
          if (Number.isInteger(n) && candidateSet.has(n)) tokens.add(n);
        }
        if (typeof v === "number" && candidateSet.has(v)) {
          tokens.add(v);
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
  } catch {}

  for (const m of payload.matchAll(/\b\d+\b/g)) {
    const n = parseInt(m[0], 10);
    if (candidateSet.has(n)) tokens.add(n);
  }

  return tokens;
}

async function getRegisteredBots(
  client: PokedRaceMCPClient,
  tokens: number[]
): Promise<Set<number>> {
  try {
    const res = await client.callTool("racing_get_my_registrations", {});
    const text = res?.content?.[0]?.text || "";
    return parseRegisteredFromPayload(text, new Set<number>(tokens));
  } catch {
    return new Set<number>();
  }
}

async function getBotStatus(
  client: PokedRaceMCPClient,
  token: number
): Promise<BotStatus | null> {
  try {
    const res = await client.callTool("garage_get_robot_details", {
      token_index: token,
    });
    const data = JSON.parse(res?.content?.[0]?.text || "{}");
    return {
      token,
      name: data?.name || `#${token}`,
      battery: data?.condition?.battery ?? 0,
    };
  } catch {
    return null;
  }
}

async function getBatteries(client: PokedRaceMCPClient): Promise<number[]> {
  try {
    const res = await client.callTool("garage_list_batteries", {});
    const text = res?.content?.[0]?.text || "";
    const preferredSet = new Set<number>(JOLT_FIXED_BATTERY_IDS);
    let sawBatteryArray = false;

    try {
      const data = JSON.parse(text);

      if (Array.isArray(data?.batteries)) {
        sawBatteryArray = true;
        const byId = new Map<number, { stored: number; isOperational: boolean }>();
        for (const b of data.batteries) {
          const id = Number((b as any)?.id);
          const stored = Number((b as any)?.stored_kwh ?? 0);
          const isOperational = (b as any)?.is_operational === true;
          if (Number.isInteger(id) && id > 0) {
            byId.set(id, { stored, isOperational });
          }
        }

        const ranked: Array<{ id: number; stored: number }> = [];
        for (const id of JOLT_FIXED_BATTERY_IDS) {
          const info = byId.get(id);
          if (!info) continue;
          if (info.stored <= JOLT_MIN_STORED_KWH) continue;
          if (JOLT_REQUIRE_OPERATIONAL && !info.isOperational) continue;
          ranked.push({ id, stored: info.stored });
        }

        if (ranked.length > 0) {
          ranked.sort((a, b) => b.stored - a.stored);
          return ranked.map((b) => b.id);
        }

        const presentPreferred = JOLT_FIXED_BATTERY_IDS.filter((id) =>
          byId.has(id)
        );
        if (presentPreferred.length > 0) {
          return presentPreferred;
        }
      } else {
        const ids = new Set<number>();
        const stack: unknown[] = [data];
        while (stack.length > 0) {
          const cur = stack.pop();
          if (!cur || typeof cur !== "object") continue;
          if (Array.isArray(cur)) {
            for (const item of cur) stack.push(item);
            continue;
          }
          const obj = cur as Record<string, unknown>;
          for (const [k, v] of Object.entries(obj)) {
            if (
              /^(id|battery[_-]?id|item[_-]?id)$/i.test(k) &&
              (typeof v === "number" || typeof v === "string")
            ) {
              const n = typeof v === "number" ? v : parseInt(v, 10);
              if (Number.isInteger(n) && n > 0 && preferredSet.has(n)) ids.add(n);
            }
            if (v && typeof v === "object") stack.push(v);
          }
        }
        if (ids.size > 0) {
          return JOLT_FIXED_BATTERY_IDS.filter((id) => ids.has(id));
        }
      }
    } catch {}

    if (sawBatteryArray) return [];

    const ids = new Set<number>();
    for (const m of text.matchAll(/#(\d+)/g)) {
      const n = parseInt(m[1], 10);
      if (Number.isInteger(n) && n > 0 && preferredSet.has(n)) ids.add(n);
    }
    if (ids.size > 0) {
      return JOLT_FIXED_BATTERY_IDS.filter((id) => ids.has(id));
    }
    return [...JOLT_FIXED_BATTERY_IDS];
  } catch {
    return [...JOLT_FIXED_BATTERY_IDS];
  }
}

async function joltBot(
  client: PokedRaceMCPClient,
  token: number,
  batteryId: number
): Promise<{
  ok: boolean;
  newBatteryLevel?: number;
  overheated?: boolean;
  error?: string;
}> {
  try {
    const res = await client.callTool("garage_jolt_bot", {
      token_index: token,
      battery_id: batteryId,
    });
    if (res?.isError) {
      return { ok: false, error: res?.content?.[0]?.text || "jolt failed" };
    }

    const text = res?.content?.[0]?.text;
    let newBatteryLevel: number | undefined;
    let overheated = false;
    if (typeof text === "string") {
      try {
        const data = JSON.parse(text);
        if (typeof data?.bot?.new_battery_level === "number") {
          newBatteryLevel = data.bot.new_battery_level;
        }
        overheated = !!data?.bot?.is_overheated;
      } catch {}
    }

    return { ok: true, newBatteryLevel, overheated };
  } catch (e: any) {
    return { ok: false, error: e?.message || "jolt error" };
  }
}

async function main() {
  const client = new PokedRaceMCPClient();
  await client.connect(SERVER_URL, API_KEY);

  const sinceRace = getMinutesSinceLastDailySprint();
  console.log("⚡ POST-RACE JOLT");
  console.log(`⏱️ Minutes since last Daily Sprint: ${sinceRace}m`);

  if (!isPostRaceWindow()) {
    console.log(
      `Skip: outside post-race window (${POST_RACE_TARGET_MINUTES}-${POST_RACE_TARGET_MINUTES + POST_RACE_WINDOW_MINUTES}m).`
    );
    await client.close();
    return;
  }

  const registered = await getRegisteredBots(client, ALL_TOKENS);
  console.log(
    `🏁 Registered now: ${registered.size > 0 ? [...registered].join(", ") : "none"}`
  );

  let batteryIds = await getBatteries(client);
  const triedBatteryIds = new Set<number>();
  console.log(`🔋 Jolt batteries parsed: ${batteryIds.length}`);
  if (batteryIds.length > 0) {
    console.log(`🔋 Jolt order: ${batteryIds.join(", ")}`);
  }

  const refillBatteryIds = async (): Promise<number> => {
    const latest = await getBatteries(client);
    let added = 0;
    for (const id of latest) {
      if (!triedBatteryIds.has(id) && !batteryIds.includes(id)) {
        batteryIds.push(id);
        added++;
      }
    }
    return added;
  };

  let joltedBots = 0;
  let skippedRegistered = 0;
  let alreadyReady = 0;

  for (const token of ALL_TOKENS) {
    if (registered.has(token)) {
      skippedRegistered++;
      console.log(`🏁 #${token}: registered, skip`);
      continue;
    }

    const st = await getBotStatus(client, token);
    if (!st) continue;

    let battery = st.battery;
    if (battery >= JOLT_TARGET_BATTERY) {
      alreadyReady++;
      console.log(`✅ #${st.token} ${st.name}: battery ${battery}% (ready)`);
      continue;
    }

    let attempts = 0;
    while (battery < JOLT_TARGET_BATTERY && attempts < MAX_JOLT_PER_BOT) {
      if (batteryIds.length === 0) {
        const added = await refillBatteryIds();
        if (added === 0) break;
        console.log(`🔄 #${st.token} ${st.name}: battery list refreshed (+${added})`);
      }

      const batteryId = batteryIds.shift()!;
      triedBatteryIds.add(batteryId);
      const j = await joltBot(client, st.token, batteryId);
      attempts++;

      if (!j.ok) {
        const err = (j.error || "").toLowerCase();
        if (
          err.includes("overheat") ||
          err.includes("overheated") ||
          err.includes("cooldown")
        ) {
          break;
        }
        continue;
      }

      if (typeof j.newBatteryLevel === "number") {
        battery = j.newBatteryLevel;
      } else {
        const refreshed = await getBotStatus(client, st.token);
        if (refreshed) battery = refreshed.battery;
      }
      if (j.overheated) break;
    }

    const after = await getBotStatus(client, st.token);
    const finalBattery = after?.battery ?? battery;
    const finalName = after?.name || st.name;
    console.log(
      `⚡ #${st.token} ${finalName}: ${st.battery}% -> ${finalBattery}% (attempts=${attempts})`
    );
    if (attempts > 0) joltedBots++;
  }

  console.log("\n=== Summary ===");
  console.log(`Targets: ${ALL_TOKENS.length}`);
  console.log(`Jolted bots: ${joltedBots}`);
  console.log(`Already ready: ${alreadyReady}`);
  console.log(`Skipped registered: ${skippedRegistered}`);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

