// Cloudflare Workers - GitHub Actions Scheduler
// Triggers GitHub Actions workflows on a reliable schedule

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

    // Determine which workflows to trigger based on cron schedule
    let workflowFiles: string[] = [];

    if (event.cron === '*/15 * * * *') {
      workflowFiles = ['routine-manager.yml', 'elite-raider-scavenge.yml'];
    } else if (event.cron === '0 4,10,16,22 * * *') {
      workflowFiles = ['race-prep.yml'];
    }

    if (workflowFiles.length > 0) {
      const results = await Promise.all(
        workflowFiles.map((workflowFile) => triggerWorkflow(env, workflowFile))
      );
      const successCount = results.filter(Boolean).length;
      console.log(`✅ Triggered ${successCount}/${workflowFiles.length} workflows`);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const workflow = url.searchParams.get('workflow');

    if (!workflow) {
      return new Response(
        JSON.stringify({
          error: 'Missing workflow parameter',
          usage: '?workflow=auto-scavenge.yml or ?workflow=auto-racing.yml'
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
