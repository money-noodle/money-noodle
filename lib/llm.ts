import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DashboardData, ProviderInfo } from './types';

interface ProviderDefinition {
  id: string;
  name: string;
  kind: 'openai' | 'anthropic' | 'gemini' | 'pi';
  source: 'direct' | 'pi';
  piProviderId?: string;
  preferred?: boolean;
  apiKey?: string;
  baseUrl: string;
  defaultModel: string;
  configured: boolean;
}

interface ProviderConfig extends ProviderDefinition {
  enabled: boolean;
  current: boolean;
  model: string;
}

interface StoredLlmControl {
  revision: number;
  enabledProviderIds: string[];
  currentProviderId?: string;
  models: Record<string, string>;
  updatedAt: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONTROL_FILE = path.join(DATA_DIR, 'llm-control.json');
let controlQueue: Promise<void> = Promise.resolve();

function piBridgeDefinitions(): ProviderDefinition[] {
  const configDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), '.pi', 'agent');
  try {
    const auth = JSON.parse(readFileSync(path.join(configDir, 'auth.json'), 'utf8')) as Record<string, { type?: string }>;
    let settings: { defaultProvider?: string; defaultModel?: string } = {};
    try { settings = JSON.parse(readFileSync(path.join(configDir, 'settings.json'), 'utf8')) as typeof settings; } catch { /* Defaults below remain deterministic. */ }
    const defaults: Record<string, { name: string; model: string }> = {
      anthropic: { name: 'Anthropic', model: 'claude-sonnet-4-5' },
      'openai-codex': { name: 'OpenAI Codex', model: 'gpt-5.6-sol' },
      'github-copilot': { name: 'GitHub Copilot', model: 'gpt-5.4-mini' },
      google: { name: 'Google Gemini', model: 'gemini-2.5-flash' },
    };
    return Object.keys(auth).flatMap((providerId) => {
      const fallback = defaults[providerId];
      if (!fallback) return [];
      const preferred = settings.defaultProvider === providerId;
      const defaultModel = preferred && settings.defaultModel ? settings.defaultModel : fallback.model;
      return [{
        id: `pi-${providerId}`, name: `Pi · ${fallback.name}`, kind: 'pi' as const, source: 'pi' as const,
        piProviderId: providerId, preferred, baseUrl: '', defaultModel, configured: true,
      }];
    });
  } catch { return []; }
}

function providerDefinitions(): ProviderDefinition[] {
  const openAiCompatible = [
    ['openai', 'OpenAI', 'OPENAI_API_KEY', 'https://api.openai.com/v1', 'gpt-4.1-mini'],
    ['openrouter', 'OpenRouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', 'openai/gpt-4.1-mini'],
    ['groq', 'Groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
    ['xai', 'xAI', 'XAI_API_KEY', 'https://api.x.ai/v1', 'grok-3-mini'],
    ['mistral', 'Mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1', 'mistral-small-latest'],
    ['deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ] as const;
  const result: ProviderDefinition[] = openAiCompatible.map(([id, name, keyName, defaultUrl, model]) => ({
    id, name, kind: 'openai', source: 'direct', apiKey: process.env[keyName],
    baseUrl: process.env[`${id.toUpperCase()}_BASE_URL`] ?? defaultUrl,
    defaultModel: process.env[`${id.toUpperCase()}_MODEL`] ?? model,
    configured: Boolean(process.env[keyName]),
  }));
  result.push({
    id: 'anthropic', name: 'Anthropic', kind: 'anthropic', source: 'direct', apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: 'https://api.anthropic.com/v1', defaultModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
  result.push({
    id: 'gemini', name: 'Google Gemini', kind: 'gemini', source: 'direct', apiKey: process.env.GEMINI_API_KEY,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    configured: Boolean(process.env.GEMINI_API_KEY),
  });
  result.push({
    id: 'ollama', name: 'Ollama / local', kind: 'openai', source: 'direct', apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1', defaultModel: process.env.OLLAMA_MODEL ?? 'llama3.2',
    configured: Boolean(process.env.OLLAMA_BASE_URL || process.env.OLLAMA_ENABLED === 'true'),
  });
  return [...result, ...piBridgeDefinitions()];
}

function defaultControl(definitions: ProviderDefinition[]): StoredLlmControl {
  const enabledProviderIds = definitions.filter((provider) => provider.configured).map((provider) => provider.id);
  return {
    revision: 0, enabledProviderIds, currentProviderId: definitions.find((provider) => provider.configured && provider.preferred)?.id ?? enabledProviderIds[0], models: {},
    updatedAt: new Date().toISOString(),
  };
}

function normalizeControl(stored: StoredLlmControl, definitions: ProviderDefinition[]): StoredLlmControl {
  const configuredIds = new Set(definitions.filter((provider) => provider.configured).map((provider) => provider.id));
  const enabledProviderIds = [...new Set(stored.enabledProviderIds ?? [])].filter((id) => configuredIds.has(id));
  const models = Object.fromEntries(Object.entries(stored.models ?? {})
    .filter(([id, model]) => definitions.some((provider) => provider.id === id) && typeof model === 'string' && model.trim())
    .map(([id, model]) => [id, model.trim().slice(0, 200)]));
  return {
    revision: Number.isInteger(stored.revision) ? stored.revision : 0,
    enabledProviderIds,
    currentProviderId: stored.currentProviderId && enabledProviderIds.includes(stored.currentProviderId) ? stored.currentProviderId : enabledProviderIds[0],
    models,
    updatedAt: stored.updatedAt || new Date().toISOString(),
  };
}

async function readControl(definitions: ProviderDefinition[]): Promise<StoredLlmControl> {
  try {
    return normalizeControl(JSON.parse(await readFile(CONTROL_FILE, 'utf8')) as StoredLlmControl, definitions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultControl(definitions);
    throw error;
  }
}

async function writeControl(control: StoredLlmControl): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${CONTROL_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(control, null, 2));
  await rename(temporary, CONTROL_FILE);
}

function mergeProviders(definitions: ProviderDefinition[], control: StoredLlmControl): ProviderConfig[] {
  return definitions.map((provider) => ({
    ...provider,
    enabled: provider.configured && control.enabledProviderIds.includes(provider.id),
    current: provider.configured && control.currentProviderId === provider.id,
    model: control.models[provider.id] ?? provider.defaultModel,
  }));
}

async function managedProviders(): Promise<ProviderConfig[]> {
  const definitions = providerDefinitions();
  return mergeProviders(definitions, await readControl(definitions));
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return (await managedProviders()).map(({ id, name, configured, source, enabled, current, defaultModel, model }) => ({ id, name, configured, source, enabled, current, defaultModel, model }));
}

export function updateProvider(input: { providerId: string; enabled?: boolean; current?: boolean; model?: string }): Promise<ProviderInfo[]> {
  const operation = controlQueue.then(async () => {
    const definitions = providerDefinitions();
    const provider = definitions.find((item) => item.id === input.providerId);
    if (!provider) throw new Error('Unknown LLM provider.');
    if ((input.enabled || input.current) && !provider.configured) throw new Error('Configure this provider in .env.local before enabling it.');
    const control = await readControl(definitions);
    const enabled = new Set(control.enabledProviderIds);
    if (input.enabled === true) enabled.add(provider.id);
    if (input.enabled === false) enabled.delete(provider.id);
    if (input.current === true) enabled.add(provider.id);
    if (input.model !== undefined) {
      const model = input.model.trim();
      if (!model || model.length > 200) throw new Error('Enter a model name up to 200 characters.');
      control.models[provider.id] = model;
    }
    control.enabledProviderIds = [...enabled];
    control.currentProviderId = input.current === true ? provider.id
      : control.currentProviderId && enabled.has(control.currentProviderId) ? control.currentProviderId : control.enabledProviderIds[0];
    control.revision += 1;
    control.updatedAt = new Date().toISOString();
    await writeControl(control);
    return mergeProviders(definitions, normalizeControl(control, definitions))
      .map(({ id, name, configured, source, enabled: isEnabled, current, defaultModel, model }) => ({ id, name, configured, source, enabled: isEnabled, current, defaultModel, model }));
  });
  controlQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function researchContext(dashboard: DashboardData): string {
  const markets = dashboard.predictions.map((prediction) => ({
    asset: prediction.symbol,
    spot: prediction.price,
    change24h: prediction.priceChange24h,
    signal: prediction.signal,
    modelUp: Number((prediction.modelProbabilityUp * 100).toFixed(1)),
    polymarketUp: Number((prediction.market.probabilityUp * 100).toFixed(1)),
    kalshiUp: prediction.kalshi ? Number((prediction.kalshi.probabilityUp * 100).toFixed(1)) : null,
    edgeVsPolymarketPoints: Number((prediction.edge * 100).toFixed(1)),
    confidence: Number((prediction.confidence * 100).toFixed(0)),
    factors: prediction.factors.map((factor) => ({ label: factor.label, summary: factor.summary.slice(0, 160), contributionPoints: Number(factor.contribution.toFixed(1)), available: factor.available })),
  }));
  const news = dashboard.news.slice(0, 6).map(({ title, link, sentiment }) => ({ title, link, sentiment }));
  return JSON.stringify({ generatedAt: dashboard.generatedAt, modelVersion: dashboard.modelVersion, markets, news });
}

const SELECTED_PROVIDER_TIMEOUT_MS = 30_000;
const AUTO_PROVIDER_TIMEOUT_MS = 18_000;
const AUTO_RESEARCH_TIMEOUT_MS = 45_000;

function runPiBridge(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ process.env.PI_CLI_PATH ?? 'pi', args, {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    const onAbort = () => { child.kill('SIGKILL'); reject(new Error('Pi bridge aborted')); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Pi bridge timed out')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 32_000) stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); cleanup(); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer); cleanup();
      if (code !== 0) reject(new Error(stderr.trim() || `Pi exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

async function callProvider(provider: ProviderConfig, query: string, model: string, dashboard: DashboardData, timeoutMs: number, requestSignal?: AbortSignal): Promise<{ provider: string; model: string; answer: string }> {
  const system = `You are the research analyst inside Signal Desk. Answer only from the supplied live snapshot and clearly identified general knowledge. Distinguish market price from model forecast. Cite relevant supplied news with markdown links. State uncertainty and missing evidence. Never claim certainty, give personalized financial advice, or suggest that an order was placed. Keep the answer concise and decision-oriented. Snapshot:\n${researchContext(dashboard)}`;
  const signal = requestSignal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), requestSignal]) : AbortSignal.timeout(timeoutMs);

  if (provider.kind === 'pi') {
    try {
      const answer = await runPiBridge([
        '--print', '--no-session', '--provider', provider.piProviderId!, '--model', model, '--thinking', 'low',
        '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
        '--system-prompt', system, query,
      ], timeoutMs, requestSignal);
      if (!answer) throw new Error('Empty Pi response');
      return { provider: provider.name, model, answer };
    } catch {
      throw new Error(`${provider.name} failed through the local Pi bridge. Verify the Pi login and selected model.`);
    }
  }

  if (provider.kind === 'anthropic') {
    const response = await fetch(`${provider.baseUrl}/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1400, system, messages: [{ role: 'user', content: query }] }),
    });
    const body = await response.json() as { content?: Array<{ text?: string }>; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `Anthropic returned ${response.status}`);
    return { provider: provider.name, model, answer: body.content?.map((item) => item.text ?? '').join('\n') ?? '' };
  }

  if (provider.kind === 'gemini') {
    const response = await fetch(`${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(provider.apiKey!)}`, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: query }] }], generationConfig: { maxOutputTokens: 1400 } }),
    });
    const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `Gemini returned ${response.status}`);
    return { provider: provider.name, model, answer: body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('\n') ?? '' };
  }

  const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model, temperature: 0.2, max_tokens: 1400, messages: [{ role: 'system', content: system }, { role: 'user', content: query }] }),
  });
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `${provider.name} returned ${response.status}`);
  return { provider: provider.name, model, answer: body.choices?.[0]?.message?.content ?? '' };
}

export async function runResearch(input: { query: string; providerId?: string; model?: string; signal?: AbortSignal }, dashboard: DashboardData): Promise<{ provider: string; model: string; answer: string; attemptedProviders: string[] }> {
  const all = await managedProviders();
  const enabled = all.filter((provider) => provider.enabled);
  if (!enabled.length) throw new Error('No LLM provider is enabled. Configure and enable one in Research → Providers.');
  const requested = input.providerId && input.providerId !== 'auto' ? all.find((provider) => provider.id === input.providerId) : undefined;
  if (requested && !requested.enabled) throw new Error('The selected LLM provider is disabled.');
  if (input.providerId && input.providerId !== 'auto' && !requested) throw new Error('Unknown LLM provider.');
  const candidates = requested ? [requested] : [...enabled].sort((a, b) => Number(b.current) - Number(a.current));
  const attemptedProviders: string[] = [];
  const deadline = Date.now() + (requested ? SELECTED_PROVIDER_TIMEOUT_MS : AUTO_RESEARCH_TIMEOUT_MS);
  let lastError: unknown;
  for (const provider of candidates) {
    if (input.signal?.aborted) throw new Error('Research request aborted.');
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) break;
    attemptedProviders.push(provider.name);
    try {
      const result = await callProvider(provider, input.query, input.model?.trim() || provider.model, dashboard, Math.min(remainingMs, requested ? SELECTED_PROVIDER_TIMEOUT_MS : AUTO_PROVIDER_TIMEOUT_MS), input.signal);
      return { ...result, attemptedProviders };
    } catch (error) {
      lastError = error;
      if (requested) break;
    }
  }
  const names = attemptedProviders.join(', ') || 'none';
  throw new Error(`No enabled LLM answered within ${requested ? SELECTED_PROVIDER_TIMEOUT_MS / 1_000 : AUTO_RESEARCH_TIMEOUT_MS / 1_000} seconds. Tried: ${names}.${lastError instanceof Error && !/timed out|abort/i.test(lastError.message) ? ` Last error: ${lastError.message}` : ''}`);
}
