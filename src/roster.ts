export interface BotEntry {
  token: number;
  name: string;
  terrain: "MetalRoads" | "WastelandSand" | "ScrapHeaps";
}

export const ROSTER: Record<string, BotEntry[]> = {
  Elite: [
    { token: 9943, name: "Ged", terrain: "MetalRoads" },
    { token: 5136, name: "うさぎ", terrain: "WastelandSand" },
    { token: 433, name: "Hachiware", terrain: "ScrapHeaps" },
  ],
  Raider: [
    { token: 7486, name: "Ryo", terrain: "MetalRoads" },
    { token: 1315, name: "StraySheep", terrain: "WastelandSand" },
    { token: 2441, name: "neopirosiki", terrain: "ScrapHeaps" },
  ],
  Junker: [
    { token: 3535, name: "G-Max", terrain: "MetalRoads" },
    { token: 3606, name: "#3606", terrain: "WastelandSand" },
    { token: 1722, name: "Rei", terrain: "ScrapHeaps" },
  ],
  Scrap: [
    { token: 3406, name: "Chiikawa", terrain: "MetalRoads" },
    { token: 6613, name: "#6613", terrain: "WastelandSand" },
    { token: 8881, name: "#8881", terrain: "ScrapHeaps" },
  ],
};

export const ALL_TOKENS = Object.values(ROSTER).flat().map((b) => b.token);
