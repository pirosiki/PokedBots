// PokedBots Scheduler Worker
//
// Cron設定:
// - */15 * * * * : 15分ごと → auto-scavenge
// - 30 5,11,17,23 * * * : レース30分前 → pre-race
// - 45 5,11,17,23 * * * : レース15分後 → post-race
// - 5-59/15 * * * * : 15分ごと(5分オフセット) → auto-racing

const GITHUB_OWNER = "pirosiki";
const GITHUB_REPO = "PokedBots";

// Cron → ワークフローのマッピング
// レース時刻: 6:00, 12:00, 18:00, 0:00 UTC (15:00, 21:00, 3:00, 9:00 JST)
const CRON_WORKFLOWS = {
  "*/15 * * * *": "auto-scavenge.yml",
  "30 5,11,17,23 * * *": "daily-sprint-pre-race.yml",   // 30分前
  "15 6,12,18,0 * * *": "daily-sprint-post-race.yml"    // 15分後
  // "5-59/15 * * * *": "auto-event-registration.yml"   // 停止中
};

async function triggerWorkflow(env, workflowFile) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Cloudflare-Worker-PokedBots-Scheduler"
    },
    body: JSON.stringify({ ref: "main" })
  });

  return {
    success: response.status === 204,
    status: response.status,
    workflow: workflowFile
  };
}

export default {
  // Cron トリガー
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] Cron triggered: ${cron}`);

    // Cronに対応するワークフローを取得
    const workflowFile = CRON_WORKFLOWS[cron];

    if (!workflowFile) {
      console.log(`Unknown cron: ${cron}`);
      return;
    }

    console.log(`Triggering workflow: ${workflowFile}`);

    const result = await triggerWorkflow(env, workflowFile);

    if (result.success) {
      console.log(`Successfully triggered ${workflowFile}`);
    } else {
      console.error(`Failed to trigger ${workflowFile}: status ${result.status}`);
    }
  },

  // HTTP トリガー（手動実行用）
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workflow = url.searchParams.get("workflow");

    // ステータス確認
    if (!workflow) {
      return new Response(JSON.stringify({
        status: "ok",
        worker: "pokedbots-scheduler",
        usage: "?workflow=auto-scavenge.yml",
        availableWorkflows: Object.values(CRON_WORKFLOWS),
        cronMappings: CRON_WORKFLOWS,
        timestamp: new Date().toISOString()
      }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 手動ワークフロートリガー
    const result = await triggerWorkflow(env, workflow);

    return new Response(JSON.stringify({
      ...result,
      timestamp: new Date().toISOString()
    }, null, 2), {
      status: result.success ? 200 : 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
