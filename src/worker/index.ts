import { createApp } from './app';

export interface WorkerEnv {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  [key: string]: string | { fetch: (request: Request) => Promise<Response> } | undefined;
}

const app = createApp();

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env as unknown as Record<string, string>, ctx as never);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Dashboard assets are not configured.', { status: 404 });
  },

  async scheduled(
    event: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const { createServices } = await import('@/src/server/services');
          const { runAutomationTick } = await import('@/src/core/scheduler');
          const services = await createServices(env as unknown as Record<string, string>);
          const result = await runAutomationTick(services, { trigger: 'cron' });
          console.log(
            `[cron] ${event.cron} generation=${result.generation.reason} published=${
              result.publishing.filter((outcome) => outcome.status === 'published').length
            } errors=${result.errors.length}`,
          );
        } catch (error) {
          console.error('[cron] tick failed', error);
        }
      })(),
    );
  },
};
