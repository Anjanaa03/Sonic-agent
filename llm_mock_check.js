'use strict';
// Verifies the Groq integration path WITHOUT calling Groq: a local mock server speaks the OpenAI compatible
// chat completions format. Checks request shape, JSON merge, fallback on failure, and guard on a leaking reply.
// Run: node tests/llm_mock_check.js
const http = require('http');
let mode = 'good'; let lastReq = null;
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    lastReq = { auth: req.headers.authorization, body: JSON.parse(b) };
    if (mode === 'fail') { res.writeHead(500); return res.end('boom'); }
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
  mode = 'fail';
  r = await e.message('existing', s.call.id, 'Hello?', 'auto');
  ok(r.engine === 'rules', 'should fall back to rules on LLM failure');
  ok(e.store('existing').events.some((x) => x.type === 'llm_fallback'), 'fallback event missing');
  console.log(fails.length ? 'FAIL\n - ' + fails.join('\n - ') : 'PASS: Groq path (mock server): request shape, merge, guard on leak, fallback on error');
  mock.close(); process.exit(fails.length ? 1 : 0);
});
