import type { Services } from '@/src/core/services';

export type AppBindings = Record<string, string | undefined>;

export interface AppVariables {
  services: Services;
  actor: string;
  authMode: 'owner' | 'dev-bypass' | 'dev-token';
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables };
