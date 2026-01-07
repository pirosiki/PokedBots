import fs from "fs/promises";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "bots-config.json");

export interface BotsConfig {
  racing_bots: number[];
  scavenging_bots: number[];
}

export class BotManager {
  private config: BotsConfig = {
    racing_bots: [],
    scavenging_bots: [],
  };

  async loadConfig(): Promise<void> {
    try {
      const data = await fs.readFile(CONFIG_PATH, "utf-8");
      this.config = JSON.parse(data);
      console.log("Bots configuration loaded");
    } catch (error) {
      console.log("No existing config found, using empty config");
    }
  }

  async saveConfig(): Promise<void> {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(this.config, null, 2));
    console.log("Bots configuration saved");
  }

  addRacingBot(tokenIndex: number): void {
    if (!this.config.racing_bots.includes(tokenIndex)) {
      this.config.racing_bots.push(tokenIndex);
      // Remove from scavenging if exists
      this.config.scavenging_bots = this.config.scavenging_bots.filter(
        (idx) => idx !== tokenIndex
      );
    }
  }

  addScavengingBot(tokenIndex: number): void {
    if (!this.config.scavenging_bots.includes(tokenIndex)) {
      this.config.scavenging_bots.push(tokenIndex);
      // Remove from racing if exists
      this.config.racing_bots = this.config.racing_bots.filter(
        (idx) => idx !== tokenIndex
      );
    }
  }

  removeBot(tokenIndex: number): void {
    this.config.racing_bots = this.config.racing_bots.filter(
      (idx) => idx !== tokenIndex
    );
    this.config.scavenging_bots = this.config.scavenging_bots.filter(
      (idx) => idx !== tokenIndex
    );
  }

  getRacingBots(): number[] {
    return [...this.config.racing_bots];
  }

  getScavengingBots(): number[] {
    return [...this.config.scavenging_bots];
  }

  getBotGroup(tokenIndex: number): "racing" | "scavenging" | "none" {
    if (this.config.racing_bots.includes(tokenIndex)) {
      return "racing";
    }
    if (this.config.scavenging_bots.includes(tokenIndex)) {
      return "scavenging";
    }
    return "none";
  }

  getConfig(): BotsConfig {
    return { ...this.config };
  }
}
