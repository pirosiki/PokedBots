export interface BotEntry {
  token: number;
  name: string;
  terrain: "MetalRoads" | "WastelandSand" | "ScrapHeaps";
}

export const ROSTER: Record<string, BotEntry[]> = {
  Elite: [
    { token: 9943, name: "Ged", terrain: "MetalRoads" },
    { token: 5677, name: "Usagi", terrain: "WastelandSand" },
    { token: 5143, name: "ハチワレ", terrain: "ScrapHeaps" },
  ],
  Raider: [
    { token: 7486, name: "Ryo", terrain: "MetalRoads" },
    { token: 1315, name: "StraySheep", terrain: "WastelandSand" },
    { token: 1170, name: "ちいかわ", terrain: "ScrapHeaps" },
  ],
  Junker: [
    { token: 3535, name: "G-Max", terrain: "MetalRoads" },
    { token: 836, name: "#836", terrain: "WastelandSand" },
    { token: 1722, name: "Rei", terrain: "ScrapHeaps" },
  ],
  Scrap: [
    { token: 8868, name: "WindUpBird", terrain: "MetalRoads" },
    { token: 3406, name: "Chiikawa", terrain: "WastelandSand" },
    { token: 631, name: "厚切り牛タン", terrain: "ScrapHeaps" },
  ],
};

export const ALL_TOKENS = Object.values(ROSTER).flat().map((b) => b.token);
