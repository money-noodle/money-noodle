'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Bot, BrainCircuit, Check, Loader2, Power, Save, Send, Settings2, Sparkles, Trash2, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProviderInfo, ResearchResponse } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHAT_STORAGE_KEY = 'money-noodle-research-chat-v1';
const LEGACY_CHAT_STORAGE_KEY = 'signal-desk-research-chat-v1';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider?: string;
  model?: string;
  attemptedProviders?: string[];
  createdAt: string;
}

export function ResearchDialog() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerId, setProviderId] = useState('auto');
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoaded, setChatLoaded] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [savingId, setSavingId] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  async function loadProviders() {
    try {
      const response = await fetch('/api/providers', { cache: 'no-store' });
      const items = await response.json() as ProviderInfo[] & { error?: string };
      if (!response.ok) throw new Error(items.error || 'Could not load the provider registry.');
      setProviders(items);
      if (providerId !== 'auto' && !items.some((item) => item.id === providerId && item.enabled)) setProviderId('auto');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load the provider registry.'); }
  }

  useEffect(() => {
    void loadProviders();
    try {
      const current = window.localStorage.getItem(CHAT_STORAGE_KEY);
      const legacy = current === null ? window.localStorage.getItem(LEGACY_CHAT_STORAGE_KEY) : null;
      const stored = JSON.parse(current ?? legacy ?? '[]') as ChatMessage[];
      if (Array.isArray(stored)) {
        const retained = stored.filter((message) => message?.role === 'user' || message?.role === 'assistant').slice(-16);
        setMessages(retained);
        if (legacy !== null) {
          window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(retained));
          window.localStorage.removeItem(LEGACY_CHAT_STORAGE_KEY);
        }
      }
    } catch { /* Invalid local chat history starts clean. */ }
    setChatLoaded(true);
    return () => requestRef.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (chatLoaded) window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-16)));
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, chatLoaded]);

  async function updateProvider(provider: ProviderInfo, change: { enabled?: boolean; current?: boolean; model?: string }) {
    setSavingId(provider.id); setError('');
    try {
      const response = await fetch('/api/providers', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: provider.id, ...change }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Provider update failed');
      setProviders(body);
      if (change.enabled === false && providerId === provider.id) setProviderId('auto');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Provider update failed'); }
    finally { setSavingId(''); }
  }

  async function ask() {
    const content = query.trim();
    if (!content || loading) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content, createdAt: new Date().toISOString() };
    const requestMessages = [...messages, userMessage].slice(-15);
    setMessages(requestMessages); setQuery(''); setError(''); setLoading(true); setElapsedSeconds(0);
    const startedAt = Date.now();
    const ticker = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    const timeout = window.setTimeout(() => controller.abort(), 50_000);
    try {
      const response = await fetch('/api/research', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ providerId, messages: requestMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })) }),
      });
      const body = await response.json() as ResearchResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Research failed');
      setMessages((current) => [...current, {
        id: crypto.randomUUID(), role: 'assistant' as const, content: body.answer, provider: body.provider, model: body.model,
        attemptedProviders: body.attemptedProviders, createdAt: body.generatedAt,
      }].slice(-16));
    } catch (reason) {
      setError(reason instanceof DOMException && reason.name === 'AbortError' ? 'Research was cancelled or exceeded the 50-second client deadline.' : reason instanceof Error ? reason.message : 'Research failed');
    } finally {
      window.clearInterval(ticker); window.clearTimeout(timeout);
      if (requestRef.current === controller) requestRef.current = null;
      setLoading(false);
    }
  }

  function cancel() { requestRef.current?.abort(); }
  function clearChat() { requestRef.current?.abort(); setMessages([]); setQuery(''); setError(''); }

  const configured = providers.filter((provider) => provider.configured);
  const enabled = providers.filter((provider) => provider.enabled);
  const current = providers.find((provider) => provider.current);
  return <Dialog onOpenChange={(open) => { if (open) void loadProviders(); }}>
    <DialogTrigger asChild><Button variant="ghost" size="sm"><BookOpen/><span className="hidden min-[501px]:inline">Research</span>{enabled.length > 0 && <span className="size-1.5 rounded-full bg-data"/>}</Button></DialogTrigger>
    <DialogContent className="max-w-3xl p-0">
      <DialogHeader className="border-b p-5 pr-12">
        <div className="flex items-start justify-between gap-4"><div><DialogTitle className="flex items-center gap-2"><BrainCircuit className="size-4 text-primary"/> Research chat</DialogTitle><DialogDescription className="mt-1">Continue a grounded conversation about the latest Money Noodle snapshot.</DialogDescription></div>{messages.length > 0 && <Button variant="ghost" size="sm" onClick={clearChat} disabled={loading}><Trash2/>Clear chat</Button>}</div>
      </DialogHeader>
      <div className="max-h-[82vh] overflow-y-auto p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-background/40 p-3">
          <Badge variant="outline">{configured.length} configured</Badge><Badge variant="outline" className={enabled.length ? 'border-data/20 text-data' : ''}>{enabled.length} enabled</Badge>
          <span className="text-[10px] text-muted-foreground">Current: <strong className="text-foreground">{current ? `${current.name} · ${current.model}` : 'none'}</strong></span>
        </div>

        <div className="min-h-64 rounded-xl border bg-background/30">
          {!messages.length ? <div className="grid min-h-64 place-items-center p-6 text-center"><div><Bot className="mx-auto size-6 text-muted-foreground"/><p className="mt-2 text-xs font-medium">Start a research conversation</p><p className="mt-1 text-[10px] text-muted-foreground">Follow-up questions retain this chat’s recent context while each answer receives a fresh dashboard snapshot.</p><div className="mt-4 flex flex-wrap justify-center gap-2">{['Where does the model most disagree with the market?', 'Summarize the strongest BTC risks.', 'Which buy signals have the best factor agreement?'].map((suggestion) => <button key={suggestion} onClick={() => setQuery(suggestion)} className="rounded-full border px-2.5 py-1 text-[10px] text-muted-foreground transition hover:border-input hover:text-foreground">{suggestion}</button>)}</div></div></div>
            : <div className="max-h-[42vh] space-y-4 overflow-y-auto p-4">{messages.map((message) => <div key={message.id} className={cn('flex gap-2.5', message.role === 'user' && 'justify-end')}>
              {message.role === 'assistant' && <div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Bot className="size-3.5"/></div>}
              <div className={cn('max-w-[86%] rounded-xl px-3.5 py-3', message.role === 'user' ? 'bg-primary text-primary-foreground' : 'border bg-card')}>
                <div className="whitespace-pre-wrap text-xs leading-5">{message.content}</div>
                <div className={cn('mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2 font-mono text-[8px]', message.role === 'user' ? 'border-primary-foreground/20 text-primary-foreground/70' : 'text-muted-foreground')}><span>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{message.provider && <><span>·</span><span>{message.provider}</span><span>·</span><span>{message.model}</span></>}{message.attemptedProviders && message.attemptedProviders.length > 1 && <span>· fallback {message.attemptedProviders.join(' → ')}</span>}</div>
              </div>
              {message.role === 'user' && <div className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground"><User className="size-3.5"/></div>}
            </div>)}{loading && <div className="flex gap-2.5"><div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Bot className="size-3.5"/></div><div className="rounded-xl border bg-card px-3.5 py-3 text-[10px] text-muted-foreground"><span className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-primary"/>Researching fresh data · {elapsedSeconds}s{providerId === 'auto' ? ' · fallback enabled' : ''}</span></div></div>}<div ref={chatEndRef}/></div>}
        </div>

        {error && <div className="mt-3 rounded-lg border border-loss/20 bg-loss/5 p-3 text-xs text-loss">{error}</div>}
        <div className="mt-3 rounded-xl border bg-background p-3">
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(); } }} maxLength={4000} placeholder={messages.length ? 'Ask a follow-up…' : 'Ask about an asset, buy signal, catalyst, or conflicting factor…'} className="min-h-20 w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"/>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            <Select value={providerId} onValueChange={setProviderId} disabled={loading}><SelectTrigger className="w-64"><SelectValue placeholder="Choose provider"/></SelectTrigger><SelectContent><SelectItem value="auto">Automatic · current with fallback</SelectItem>{enabled.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name} · {provider.model}</SelectItem>)}</SelectContent></Select>
            <div className="flex gap-2">{loading && <Button variant="outline" onClick={cancel}>Cancel</Button>}<Button onClick={() => void ask()} disabled={!query.trim() || !enabled.length || loading}>{loading ? <Loader2 className="animate-spin"/> : <Send/>}{loading ? `${elapsedSeconds}s` : 'Send'}</Button></div>
          </div>
        </div>
        <p className="mt-1.5 text-[9px] text-muted-foreground">Enter sends · Shift+Enter adds a line · automatic mode allows 18 seconds per provider and 45 seconds overall · recent chat is stored only in this browser.</p>

        <details className="mt-5 rounded-xl border" open={!configured.length}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-medium [&::-webkit-details-marker]:hidden"><span className="flex items-center gap-2"><Settings2 className="size-3.5"/>Manage providers</span><span className="text-[9px] font-normal text-muted-foreground">Direct keys and Pi auth remain server-side</span></summary>
          <div className="space-y-2 border-t p-3">{providers.map((provider) => <div key={provider.id} className={cn('rounded-lg border p-3', provider.enabled && 'border-data/20 bg-data/[.025]', !provider.configured && 'opacity-60')}>
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="text-xs font-semibold">{provider.name}</span><Badge variant="outline" className={provider.configured ? 'border-data/20 text-data' : 'text-muted-foreground'}>{provider.configured ? 'configured' : 'not configured'}</Badge>{provider.source === 'pi' && <Badge variant="outline" className="border-data/20 text-data">Pi auth</Badge>}{provider.current && <Badge className="gap-1 border-data/20 bg-data/10 text-data"><Check/>current</Badge>}</div><div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={!provider.configured || !provider.enabled || provider.current || savingId === provider.id} onClick={() => void updateProvider(provider, { current: true })}>Use current</Button><Button variant={provider.enabled ? 'secondary' : 'outline'} size="sm" disabled={!provider.configured || savingId === provider.id} onClick={() => void updateProvider(provider, { enabled: !provider.enabled })}>{savingId === provider.id ? <Loader2 className="animate-spin"/> : <Power/>}{provider.enabled ? 'Disable' : 'Enable'}</Button></div></div>
            <div className="mt-2 flex items-center gap-2"><input value={provider.model} disabled={!provider.configured} onChange={(event) => setProviders((items) => items.map((item) => item.id === provider.id ? { ...item, model: event.target.value } : item))} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2.5 font-mono text-[10px] outline-none disabled:cursor-not-allowed"/><Button variant="ghost" size="sm" title="Save model" disabled={!provider.configured || !provider.model.trim()} onClick={() => void updateProvider(provider, { model: provider.model })}><Save/>Save model</Button></div>
            {!provider.configured && <p className="mt-1.5 text-[9px] text-muted-foreground">Add this direct provider’s key or local endpoint to <code className="font-mono">.env.local</code>, then restart the server.</p>}
          </div>)}</div>
        </details>
        {!configured.length && <div className="mt-4 rounded-lg border border-warn/15 bg-warn/5 p-3 text-[11px] leading-relaxed text-warn/75">Configure a direct provider in <code className="font-mono">.env.local</code> or authenticate a compatible provider in Pi.</div>}
      </div>
    </DialogContent>
  </Dialog>;
}
