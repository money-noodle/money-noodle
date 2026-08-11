import { NextRequest, NextResponse } from 'next/server';
import { getDashboard } from '@/lib/dashboard';
import { runResearch } from '@/lib/llm';

export const runtime = 'nodejs';

interface IncomingMessage {
  role?: 'user' | 'assistant';
  content?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { query?: string; messages?: IncomingMessage[]; providerId?: string; model?: string };
    const messages = Array.isArray(body.messages)
      ? body.messages.map((message) => ({ role: message.role, content: message.content?.trim() })).filter((message): message is { role: 'user' | 'assistant'; content: string } => (message.role === 'user' || message.role === 'assistant') && Boolean(message.content))
      : body.query?.trim() ? [{ role: 'user' as const, content: body.query.trim() }] : [];
    if (!messages.length || messages[messages.length - 1].role !== 'user') return NextResponse.json({ error: 'Enter a research question.' }, { status: 400 });
    if (messages.length > 16) return NextResponse.json({ error: 'This chat exceeds 16 messages. Clear it or start a new research chat.' }, { status: 400 });
    const totalCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (totalCharacters > 16_000 || messages.some((message) => message.content.length > 4_000)) return NextResponse.json({ error: 'This chat is too long. Clear it or shorten the conversation.' }, { status: 400 });
    const transcript = messages.map((message) => `${message.role === 'user' ? 'USER' : 'ASSISTANT'}: ${message.content}`).join('\n\n');
    const query = `Continue this Signal Desk research chat. Use prior turns as context, answer the latest USER message directly, and correct prior claims if the fresh dashboard snapshot conflicts with them.\n\n${transcript}`;
    const result = await runResearch({ query, providerId: body.providerId, model: body.model, signal: request.signal }, await getDashboard());
    return NextResponse.json({ ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Research request failed:', error);
    const message = error instanceof Error ? error.message : 'Research request failed';
    return NextResponse.json({ error: message }, { status: /within \d+ seconds|timed out|abort/i.test(message) ? 504 : 502 });
  }
}
