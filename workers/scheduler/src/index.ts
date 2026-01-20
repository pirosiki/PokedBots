// Cloudflare Workers - GitHub Actions Scheduler
// Triggers GitHub Actions workflows on a reliable schedule
//
// Team Daily Racing System:
// - Team A: Races at 0:00, 12:00 UTC (9:00, 21:00 JST)
// - Team B: Races at 6:00, 18:00 UTC (15:00, 3:00 JST)
//
// Crons:
// - every 15 min       : Team Daily Maintenance
// - 50 5,11,17,23      : Team Daily Pre-Race (10 min before races)

interface Env {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
}

async function triggerWorkflow(env: Env, workflowFileName: string): Promise<boolean> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflowFileName}/dispatches`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Cloudflare-Workers-Scheduler'
      },
      body: JSON.stringify({
        ref: 'main'
      })
    });

    if (response.status === 204) {
      console.log(`✓ Successfully triggered workflow: ${workflowFileName}`);
      return true;
    } else {
      const text = await response.text();
      console.error(`✗ Failed to trigger ${workflowFileName}: ${response.status} ${text}`);
      return false;
    }
  } catch (error: any) {
    console.error(`✗ Exception triggering ${workflowFileName}:`, error.message);
    return false;
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`⏰ Scheduler triggered at ${new Date().toISOString()}`);
    console.log(`   Cron: ${event.cron}`);

    let workflowFile = '';

    if (event.cron === '*/15 * * * *') {
      // Team Daily Maintenance - runs every 15 minutes
      // Handles: post-race recovery, scavenging, maintenance cycles, pre-race prep, registration
      workflowFile = 'team-daily-maintenance.yml';
    } else if (event.cron === '50 5,11,17,23 * * *') {
      // Team Daily Pre-Race - 10 minutes before each race
      // Handles: paid repair for Perfect Tune
      workflowFile = 'team-daily-pre-race.yml';
    }

    if (workflowFile) {
      const success = await triggerWorkflow(env, workflowFile);
      if (success) {
        console.log(`✅ Workflow ${workflowFile} triggered successfully`);
      } else {
        console.log(`❌ Failed to trigger workflow ${workflowFile}`);
      }
    } else {
      console.log(`⚠️ Unknown cron pattern: ${event.cron}`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const workflow = url.searchParams.get('workflow');

    if (!workflow) {
      return new Response(
        JSON.stringify({
          error: 'Missing workflow parameter',
          usage: '?workflow=team-daily-maintenance.yml or ?workflow=team-daily-pre-race.yml',
          crons: {
            '*/15 * * * *': 'team-daily-maintenance.yml',
            '50 5,11,17,23 * * *': 'team-daily-pre-race.yml'
          }
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    console.log(`📞 Manual trigger request for: ${workflow}`);
    const success = await triggerWorkflow(env, workflow);

    return new Response(
      JSON.stringify({
        success,
        workflow,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};
