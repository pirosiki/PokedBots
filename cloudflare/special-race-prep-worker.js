// Cloudflare Worker: Special Race Prep Scheduler
//
// 15分ごとにGitHub Actionsを呼び出し、レース開始後は自動停止
// レース終了後は pokedbots-scheduler の Cron を自動復活
//
// 環境変数（Cloudflare Dashboardで設定）:
// - GITHUB_TOKEN: GitHub Personal Access Token (workflow権限必要)
// - RACE_START_TIME: レース開始時刻 (ISO形式、例: "2026-01-25T12:00:00Z")
// - CF_API_TOKEN: Cloudflare API Token (Workers編集権限必要)
// - CF_ACCOUNT_ID: Cloudflare Account ID
//
// Cron設定: 毎時 0, 15, 30, 45分に実行

const GITHUB_OWNER = "pirosiki";
const GITHUB_REPO = "PokedBots";
const WORKFLOW_FILE = "special-race-prep.yml";

// pokedbots-scheduler の元の Cron スケジュール
const SCHEDULER_CRONS = [
  { cron: "*/15 * * * *" },
  { cron: "30 5,11,17,23 * * *" },
  { cron: "45 5,11,17,23 * * *" },
  { cron: "5-59/15 * * * *" }
];

async function restoreSchedulerCrons(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    console.log("CF_ACCOUNT_ID or CF_API_TOKEN not set, cannot restore scheduler");
    return false;
  }

  try {
    // pokedbots-scheduler の Cron を復活
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/pokedbots-scheduler/schedules`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(SCHEDULER_CRONS)
      }
    );

    if (response.ok) {
      console.log("Successfully restored pokedbots-scheduler crons");
      return true;
    } else {
      const errorText = await response.text();
      console.error(`Failed to restore scheduler: ${response.status} - ${errorText}`);
      return false;
    }
  } catch (error) {
    console.error(`Error restoring scheduler: ${error.message}`);
    return false;
  }
}

async function disableOwnCron(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    return false;
  }

  try {
    // special-race-prep の Cron を削除（自分自身）
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/special-race-prep/schedules`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify([])
      }
    );

    if (response.ok) {
      console.log("Successfully disabled own cron");
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Error disabling own cron: ${error.message}`);
    return false;
  }
}

export default {
  async scheduled(event, env, ctx) {
    console.log(`[${new Date().toISOString()}] Special Race Prep Worker triggered`);

    // レース開始時刻をチェック
    const raceStartTime = env.RACE_START_TIME ? new Date(env.RACE_START_TIME) : null;

    if (raceStartTime) {
      const now = new Date();
      const minutesUntilRace = (raceStartTime.getTime() - now.getTime()) / 60000;

      console.log(`Race starts at: ${raceStartTime.toISOString()}`);
      console.log(`Minutes until race: ${minutesUntilRace.toFixed(1)}`);

      // レース開始後: scheduler復活 & 自分のcron停止
      if (minutesUntilRace < 0) {
        console.log("Race already started, restoring scheduler and stopping...");
        await restoreSchedulerCrons(env);
        await disableOwnCron(env);
        return new Response("Race finished, scheduler restored", { status: 200 });
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

    // ステータス確認用
    const raceStartTime = env.RACE_START_TIME ? new Date(env.RACE_START_TIME) : null;
    const now = new Date();
    const minutesUntilRace = raceStartTime ? (raceStartTime.getTime() - now.getTime()) / 60000 : null;

    return new Response(JSON.stringify({
      worker: "special-race-prep",
      raceStartTime: raceStartTime ? raceStartTime.toISOString() : "not set",
      minutesUntilRace: minutesUntilRace ? minutesUntilRace.toFixed(1) : "N/A",
      now: now.toISOString()
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
};
