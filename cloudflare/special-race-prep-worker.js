/**
 * Cloudflare Worker: Special Race Prep Scheduler
 *
 * 15分ごとにGitHub Actionsを呼び出し、レース開始後は自動停止
 *
 * 環境変数（Cloudflare Dashboardで設定）:
 * - GITHUB_TOKEN: GitHub Personal Access Token (workflow権限必要)
 * - RACE_START_TIME: レース開始時刻 (ISO形式、例: "2026-01-25T12:00:00Z")
 *
 * Cron設定: */15 * * * * (15分ごと)
 */

export default {
  async scheduled(event, env, ctx) {
    const GITHUB_OWNER = "pirosiki";
    const GITHUB_REPO = "PokedBots";
    const WORKFLOW_FILE = "special-race-prep.yml";

    console.log(`[${new Date().toISOString()}] Special Race Prep Worker triggered`);

    // レース開始時刻をチェック
    const raceStartTime = env.RACE_START_TIME ? new Date(env.RACE_START_TIME) : null;

    if (raceStartTime) {
      const now = new Date();
      const minutesUntilRace = (raceStartTime.getTime() - now.getTime()) / 60000;

      console.log(`Race starts at: ${raceStartTime.toISOString()}`);
      console.log(`Minutes until race: ${minutesUntilRace.toFixed(1)}`);

      // レース開始後はスキップ
      if (minutesUntilRace < 0) {
        console.log("Race already started, skipping");
        return new Response("Skipped: Race already started", { status: 200 });
      }
    } else {
      console.log("RACE_START_TIME not set, proceeding anyway");
    }

    // GitHub Actions workflow_dispatch を呼び出し
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Cloudflare-Worker"
        },
        body: JSON.stringify({
          ref: "main"
        })
      });

      if (response.status === 204) {
        console.log("Successfully triggered GitHub Actions");
        return new Response("Triggered", { status: 200 });
      } else {
        const errorText = await response.text();
        console.error(`GitHub API error: ${response.status} - ${errorText}`);
        return new Response(`Error: ${response.status}`, { status: 500 });
      }
    } catch (error) {
      console.error(`Fetch error: ${error.message}`);
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },

  // HTTP リクエストでも手動実行可能
  async fetch(request, env, ctx) {
    // 手動トリガー用（デバッグ）
    if (request.method === "POST") {
      return this.scheduled({}, env, ctx);
    }

    return new Response("Special Race Prep Worker. POST to trigger manually.", { status: 200 });
  }
};
