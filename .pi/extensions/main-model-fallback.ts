import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type FallbackLoader = () => Promise<{ default: (pi: ExtensionAPI) => void }>;

// The package is installed with automatic extension loading disabled. All native
// Claude/GPT children run asynchronously; pi-subagents marks their host process
// before ambient extensions load. Foreground children do not load ambient ones.
export async function registerMainModelFallback(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
  load: FallbackLoader = () => import('../npm/node_modules/pi-model-fallback/extensions/index.ts'),
): Promise<void> {
  // Any marker value is a reason not to install parent model-changing hooks.
  if (env.PI_SUBAGENT_CHILD !== undefined) return;
  const extension = await load();
  extension.default(pi);
}

export default function mainModelFallback(pi: ExtensionAPI): Promise<void> {
  return registerMainModelFallback(pi);
}
