import 'server-only';

/**
 * Vercel functions have an ephemeral, read-only deployment filesystem and no durable worker
 * lifecycle. `MONEY_NOODLE_STATELESS=true` supports equivalent hosted dashboard deployments.
 */
export function isStatelessDeployment(): boolean {
  return process.env.VERCEL === '1' || process.env.MONEY_NOODLE_STATELESS === 'true';
}

export const STATELESS_WORKER_MESSAGE = 'This action is unavailable on the stateless hosted dashboard. Use the persistent Money Noodle worker.';
