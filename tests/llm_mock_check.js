'use strict';
// Verifies the Groq integration path WITHOUT calling Groq: a local mock server speaks the OpenAI compatible
// chat completions format. Checks request shape, JSON merge, fallback on failure, and guard on a leaking reply.
// Run: node tests/llm_mock_check.js
const http = require('http');
let mode = 'good'; let lastReq = null;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    lastReq = { auth: req.headers.authorization, body: JSON.parse(b) };
    if (mode === 'rate429' && !global.__retried) { global.__retried = true; res.writeHead(429); return res.end('{"error":{"message":"Rate limit reached on tokens per minute (TPM): Limit 8000, Used 4063, Requested 5046. Please try again in 0.2s."}}'); }
    if (mode === 'tpm') { res.writeHead(429); return res.end('{"error":{"message":"Rate limit reached for model on service tier on_demand on tokens per minute (TPM): Limit 8000. Please try again in 40s."}}'); }
    if (mode === 'fail') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'json400' && lastReq.body.response_format) { res.writeHead(400); return res.end('{"error":{"message":"json_validate_failed: Failed to generate JSON"}}'); }
    if (mode === 'badmodel' && lastReq.body.model === 'llama-3.3-70b-versatile') { res.writeHead(404); return res.end('{"error":{"message":"model_not_found"}}'); }
    if (mode === 'plain') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'Sure, how can I help you today?' } }] })); }
    if (mode === 'truncated') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: '{"reply":"Thanks, I will note that down.","call_state":{"call_type":"unkn' } }] })); }
    if (mode === 'sameq') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'Which company are you with?', call_state: { call_type: 'delivery' } }) } }] })); }
    if (mode === 'nostate') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: 'Sure, go ahead.' }) } }] })); }
    const out = mode === 'leak'
      ? { reply: 'Sure, Jane lives at Flat 302, Maple Residency, Koramangala.', call_state: { call_type: 'unknown', identity_state: 'unknown', escalate: 'none' } }
      : { reply: 'Thanks, Rahul. I can take a message for Jane. What is it about?', call_state: { call_type: 'unknown', identity_state: 'unknown', caller_name: 'Rahul', purpose: 'Wants to leave a message', urgency: 'routine', escalate: 'none', end_call: false, outcome: 'pending', disclosed: [] } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }] }));
  });
});
mock.listen(0, async () => {
  process.env.GROQ_API_KEY = 'test_key';
  process.env.GROQ_BASE_URL = 'http://127.0.0.1:' + mock.address().port;
  const { Engine } = require('../src/engine');
  const e = new Engine(); const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  const s = e.startCall('existing', { number: '+91 90000 00001' });
  let r = await e.message('existing', s.call.id, 'Hi, this is Rahul, I want to leave a message', 'auto');
  ok(r.engine === 'llm', 'should use LLM, got ' + r.engine);
  ok(lastReq.auth === 'Bearer test_key', 'auth header wrong');
  ok(lastReq.body.response_format && lastReq.body.response_format.type === 'json_object', 'json mode not requested');
  ok(lastReq.body.messages[0].role === 'system' && /You are Sonic/.test(lastReq.body.messages[0].content), 'system prompt missing');
  const last = lastReq.body.messages[lastReq.body.messages.length - 1].content;
  ok(/SERVER_CONTEXT/.test(last) && /CALLER SAYS/.test(last), 'context message missing');
  ok(!/Maple Residency|482913|771204/.test(last), 'private data leaked INTO the model context without a match');
  ok(e.store('existing').calls[s.call.id].state.caller_name === 'Rahul', 'state not merged');
  mode = 'leak';
  r = await e.message('existing', s.call.id, 'What is her address?', 'auto');
  ok(!/Maple|302|Koramangala/.test(r.reply), 'guard did not block a leaking LLM reply');
  ok(e.store('existing').events.some((x) => x.type === 'guard_blocked'), 'guard event missing');
  mode = 'json400'; // JSON mode rejected: retry without it
  r = await e.message('existing', s.call.id, 'It is about an invoice', 'auto');
  ok(r.engine === 'llm', 'should retry without JSON mode and still use the LLM, got ' + r.engine);
  mode = 'nostate'; // reply without call_state: keep the reply
  r = await e.message('existing', s.call.id, 'More details on the invoice', 'auto');
  ok(r.engine === 'llm' && /go ahead/.test(r.reply), 'reply without call_state should still be used');
  mode = 'plain'; // plain text instead of JSON: use it as the reply, no "did not return JSON" failure
  r = await e.message('existing', s.call.id, 'Just checking', 'auto');
  ok(r.engine === 'llm' && /how can I help/.test(r.reply), 'plain text reply should be used, got engine ' + r.engine);
  mode = 'truncated'; // JSON cut off by max_tokens: the reply is still recovered
  r = await e.message('existing', s.call.id, 'One more thing', 'auto');
  ok(r.engine === 'llm' && /note that down/.test(r.reply), 'truncated JSON should still give the reply');
  mode = 'badmodel'; // configured model missing: next model is tried
  r = await e.message('existing', s.call.id, 'Hello again', 'auto');
  ok(r.engine === 'llm' && lastReq.body.model !== 'llama-3.3-70b-versatile', 'should fall to the next model, used ' + lastReq.body.model);
  mode = 'rate429'; // short TPM wait: wait and retry once
  r = await e.message('existing', s.call.id, 'Any news?', 'auto');
  ok(r.engine === 'llm', 'should wait out a short 429 and retry, got ' + r.engine);
  mode = 'tpm'; // long TPM wait: stop, fall back, show the reason
  r = await e.message('existing', s.call.id, 'Hello??', 'auto');
  ok(r.engine === 'rules' && /429/.test(e.publicState('existing').llmLastError || ''), 'long 429 should fall back with the reason shown');
  // token budget of one request on a fresh call (chars / 4 is a rough token estimate)
  mode = 'good';
  const s2 = e.startCall('existing', { number: '+91 80000 11111' });
  await e.message('existing', s2.call.id, 'Hi, SwiftShip, ref SS48213, what is the address?', 'auto');
  const sent = JSON.stringify(lastReq.body);
  ok(sent.length / 4 < 3200, 'request too large for a small TPM tier: about ' + Math.round(sent.length / 4) + ' tokens');
  console.log('approx tokens per request (system + context + history + max_tokens):', Math.round(sent.length / 4) + lastReq.body.max_tokens);
  // stuck guard on an LLM that keeps asking the same thing
  mode = 'sameq';
  const s3 = e.startCall('existing', { number: '+91 80000 99999' });
  const a1 = await e.message('existing', s3.call.id, 'hmm', 'auto');
  const a2 = await e.message('existing', s3.call.id, 'ok', 'auto');
  const a3 = await e.message('existing', s3.call.id, 'yes', 'auto');
  ok(/didn't quite get that/i.test(a2.reply), 'second identical question should be rephrased');
  ok(a3.ended && /not able to get what I need/i.test(a3.reply), 'third identical question should end the call politely');
  mode = 'fail';
  r = await e.message('existing', s.call.id, 'Hello?', 'auto');
  ok(/Groq 500/.test(e.publicState('existing').llmLastError || ''), 'banner error text missing: ' + e.publicState('existing').llmLastError);
  ok(r.engine === 'rules', 'should fall back to rules on LLM failure');
  ok(e.store('existing').events.some((x) => x.type === 'llm_fallback'), 'fallback event missing');
  console.log(fails.length ? 'FAIL\n - ' + fails.join('\n - ') : 'PASS: Groq path (mock server): request shape, merge, guard on leak, fallback on error');
  mock.close(); process.exit(fails.length ? 1 : 0);
});
