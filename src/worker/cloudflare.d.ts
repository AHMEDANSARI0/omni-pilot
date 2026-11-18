// Minimal Cloudflare Workers runtime types (avoids a global type clash with DOM lib).
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  readonly noRetry: boolean;
}
