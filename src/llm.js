'use strict';
// LLM adapter (server side only; keys never reach the browser).
// Providers: Groq (OpenAI compatible API) or Anthropic. Chosen by LLM_PROVIDER, else by which key is set.
// Sends: system prompt + a compacted per turn SERVER_CONTEXT JSON + the last few turns.
// Token budget matters on hosted free tiers (Groq on_demand: tokens per minute). So:
//   * the runtime prompt is the compact version (prompt/sonic_system_prompt_compact.md); SONIC_PROMPT=full uses the full one
//   * empty context fields are dropped, history is capped, max_tokens is small (it counts toward the TPM estimate)
//   * a 429 that asks to wait a few seconds is retried once

const fs = require('fs');
const path = require('path');

const FULL_PATH = path.join(__dirname, '..', 'prompt', 'sonic_system_prompt.md');
const COMPACT_PATH = path.join(__dirname, '..', 'prompt', 'sonic_system_prompt_compact.md');
const GROQ_URL = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1') + '/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile'; // override with GROQ_MODEL; check GET /openai/v1/models for what is live
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
const MAX_HISTORY = Number(process.env.SONIC_MAX_HISTORY || 10);
const MAX_OUT = Number(process.env.SONIC_MAX_TOKENS || 300);

function stripHeader(raw) {
  const i = raw.indexOf('\n---\n');
  return i >= 0 ? raw.slice(i + 5).trim() : raw;
}
function loadSystemPrompt() {
  const useFull = process.env.SONIC_PROMPT === 'full' || !fs.existsSync(COMPACT_PATH);
  return stripHeader(fs.readFileSync(useFull ? FULL_PATH : COMPACT_PATH, 'utf8'));
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

// Drop null, empty and false values so the context costs fewer tokens.
function compactContext(ctx) {
  const drop = ['mock_notice', 'calendar_available'];
  return JSON.stringify(ctx, (k, v) => {
    if (drop.includes(k)) return undefined;
    if (v === null || v === false || v === '' || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) return undefined;
    return v;
  });
}

function buildMessages(call, context, callerText) {
  const msgs = [];
  const turns = call.turns.slice(0, -1); // the latest caller turn goes in the final message
  for (const t of turns.slice(-MAX_HISTORY)) msgs.push({ role: t.role === 'sonic' ? 'assistant' : 'user', content: t.text });
  if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: '[Call connected]' });
  msgs.push({ role: 'user', content: 'SERVER_CONTEXT: ' + compactContext(context) + '\nCALLER SAYS: ' + callerText + '\nReturn only the JSON object.' });
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

let usedModel = null;
function lastUsedModel() { return usedModel; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Please try again in 2.5s" or "in 350ms" -> milliseconds, or null
function retryWaitMs(text, headerVal) {
  if (headerVal && !isNaN(Number(headerVal))) return Number(headerVal) * 1000;
  const m = String(text).match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)\s*(ms|s)\b/i);
  if (!m) return null;
  const n = Number(m[2]);
  return m[3].toLowerCase() === 'ms' ? n + (m[1] ? Number(m[1]) * 60000 : 0) : n * 1000 + (m[1] ? Number(m[1]) * 60000 : 0);
}

// Tries the configured model first. On a 400 about JSON mode it retries without JSON mode. On 400/404/503 it tries the
// next model (GROQ_FALLBACK_MODELS, comma separated). A short 429 wait is retried once. Auth and network errors stop at once.
async function callGroq(system, messages) {
  const extra = (process.env.GROQ_FALLBACK_MODELS || 'llama-3.1-8b-instant,openai/gpt-oss-20b').split(',').map((s) => s.trim()).filter(Boolean);
  const models = [...new Set([modelName(), ...extra])];
  const attempts = [];
  for (const m of models) attempts.push({ model: m, json: true }, { model: m, json: false });
  let lastErr; let waited = false; let i = 0;
  while (i < attempts.length) {
    const a = attempts[i];
    const payload = { model: a.model, temperature: 0.2, max_tokens: MAX_OUT, messages: [{ role: 'system', content: system }, ...messages] };
    if (a.json) payload.response_format = { type: 'json_object' };
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.GROQ_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data = await res.json();
      usedModel = a.model;
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    }
    const body = (await res.text()).replace(/\s+/g, ' ').slice(0, 260);
    lastErr = new Error(`Groq ${res.status} on ${a.model}${a.json ? '' : ' (no JSON mode)'}: ${body}`);
    if (res.status === 429) {
      const wait = retryWaitMs(body, res.headers.get('retry-after'));
      if (!waited && wait !== null && wait <= 15000) { waited = true; await sleep(wait + 300); continue; } // one short wait per request
      throw lastErr; // the limit is a token budget, another model will not help
    }
    if (res.status === 401 || res.status === 403) throw lastErr;
    if (res.status === 400 && a.json && /json/i.test(body)) { i++; continue; } // same model, without JSON mode
    while (i < attempts.length && attempts[i].model === a.model) i++; // anything else: next model
  }
  throw lastErr;
}

async function callAnthropic(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelName(), max_tokens: 500, temperature: 0.2, system, messages }),
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
  let parsed;
  try { parsed = extractJson(text); } catch (e) { throw new Error('Model did not return JSON: ' + String(text).slice(0, 120)); }
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) throw new Error('Model JSON had no reply: ' + String(text).slice(0, 120));
  if (!parsed.call_state || typeof parsed.call_state !== 'object') parsed.call_state = {}; // lenient: keep the reply, skip state merge
  return parsed;
}

module.exports = { callLLM, available, provider, modelName, lastUsedModel, loadSystemPrompt, buildMessages, compactContext };
