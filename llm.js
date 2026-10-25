'use strict';
// LLM adapter (server side only; keys never reach the browser).
// Providers: Groq (OpenAI compatible API) or Anthropic. Chosen by LLM_PROVIDER, else by which key is set.
// Provides: system prompt file + per turn SERVER_CONTEXT JSON + conversation so far.

const fs = require('fs');
const path = require('path');

const PROMPT_PATH = path.join(__dirname, '..', 'prompt', 'sonic_system_prompt.md');
const GROQ_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1') + '/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'; // override with GROQ_MODEL; check GET /openai/v1/models for what is live
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

function loadSystemPrompt() {
  const raw = fs.readFileSync(PROMPT_PATH, 'utf8');
  const i = raw.indexOf('\n---\n');
  return i >= 0 ? raw.slice(i + 5).trim() : raw;
}

function provider() {
  const p = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (p === 'groq' && process.env.GROQ_API_KEY) return 'groq';
  if (p === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
function available() { return !!provider(); }
function modelName() {
  const p = provider();
  if (p === 'groq') return process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  if (p === 'anthropic') return process.env.SONIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  return null;
}

function buildMessages(call, context, callerText) {
  const msgs = [{ role: 'user', content: '[Call connected. Greet the caller.]' }];
  const turns = call.turns.slice(0, -1); // the latest caller turn goes in the final message
  for (const t of turns) msgs.push({ role: t.role === 'sonic' ? 'assistant' : 'user', content: t.text });
  msgs.push({ role: 'user', content: 'SERVER_CONTEXT:\n' + JSON.stringify(context) + '\n\nCALLER SAYS:\n' + callerText + '\n\nReturn only the JSON object described in the output contract.' });
  const out = []; // merge consecutive same role messages (APIs require alternation)
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n' + m.content;
    else out.push({ ...m });
  }
  return out;
}

function extractJson(text) {
  const t = text.replace(/```json|```/g, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no json');
  return JSON.parse(t.slice(a, b + 1));
}

async function callGroq(system, messages) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: modelName(), temperature: 0.2, max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Groq HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

async function callAnthropic(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelName(), max_tokens: 700, temperature: 0.2, system, messages }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Anthropic HTTP ' + res.status);
  const data = await res.json();
  return (data.content || []).map((c) => c.text || '').join('');
}

async function callLLM(call, context, callerText) {
  const system = loadSystemPrompt();
  const messages = buildMessages(call, context, callerText);
  const text = provider() === 'groq' ? await callGroq(system, messages) : await callAnthropic(system, messages);
  const parsed = extractJson(text);
  if (typeof parsed.reply !== 'string' || !parsed.call_state) throw new Error('bad shape');
  return parsed;
}

module.exports = { callLLM, available, provider, modelName, loadSystemPrompt, buildMessages };
