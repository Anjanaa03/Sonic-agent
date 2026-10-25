'use strict';
// Output guard. Runs on EVERY reply (rules or LLM). Blocks leaks the policy layer did not allow.

const SENSITIVE_TOKENS = [
  'flat 302', 'maple residency', 'green park', 'koramangala', '560034', 'orion business', 'mg road', 'ashok nagar', '560001',
  '6th floor', 'sixth floor', 'jane smith', // full name is not shared with callers
];
const NEVER = ['flat 302', '302', '6th floor', 'sixth floor', 'jane smith'];

function checkReply(reply, R, store) {
  const reasons = [];
  const low = ' ' + reply.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const allowedText = Object.entries(R.internal.allowed).filter(([k]) => k !== 'otp').map(([, v]) => String(v)).join(' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');

  for (const t of SENSITIVE_TOKENS) {
    if (low.includes(' ' + t + ' ') || low.includes(t)) {
      if (NEVER.includes(t) || !allowedText.includes(t)) reasons.push('location_or_identity:' + t);
    }
  }
  if (/\b302\b/.test(low)) reasons.push('location_or_identity:302');

  // schedule / whereabouts
  if (/(usually (at|in) (the )?(office|home)|weekdays|10 ?(am)? to (6|six)|after (7|seven)( pm)?|she('s| is) (at|in) (the )?(office|home|meeting)|jane('s| is) (at|in) (the )?(office|home|meeting)|she will be home|she'll be home)/.test(low)) {
    reasons.push('schedule_or_whereabouts');
  }
  // OTPs
  const allowedOtp = R.internal.allowed.otp;
  for (const m of store.messages) {
    if (m.code && reply.includes(m.code) && m.code !== allowedOtp) reasons.push('otp:' + m.code);
  }
  if (/(otp|code|pin|password|passcode)/i.test(reply)) {
    const digits = reply.match(/\b\d{4,8}\b/g) || [];
    for (const d of digits) if (d !== allowedOtp) reasons.push('otp_like_digits:' + d);
  }
  if (/^\s*(this is|i am|i'm) jane\b/i.test(reply)) reasons.push('impersonation');
  if (/(system prompt|server_context|allowed_to_share|my instructions say)/i.test(reply)) reasons.push('prompt_leak');
  return { ok: reasons.length === 0, reasons };
}

const SAFE_REPLY = "I'm sorry, I can't share that. I can take a message for Jane.";

module.exports = { checkReply, SAFE_REPLY };
