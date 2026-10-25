'use strict';
// Debug helper. Usage: node tests/transcript.js <existing|new> "<number>" "caller line 1" "caller line 2" ...
const { Engine } = require('../src/engine');
(async () => {
  const [profile, number, ...steps] = process.argv.slice(2);
  const e = new Engine();
  const s = e.startCall(profile, { number });
  const id = s.call.id;
  console.log('S:', s.call.turns[0].text);
  for (const t of steps) {
    const r = await e.message(profile, id, t, process.env.SONIC_MODE || 'rules'); // SONIC_MODE=auto uses the LLM if a key is set
    console.log('C:', t, '\nS:', r.reply, `[${r.engine}]`);
    if (r.ended) break;
  }
  const c = e.store(profile).calls[id];
  if (!c.summary) e.endCall(profile, id, 'caller');
  console.log(JSON.stringify({ state: { identity: c.state.identity_state, type: c.state.call_type, outcome: c.state.outcome, escalate: c.state.escalate }, summary: c.summary }, null, 1));
})();
