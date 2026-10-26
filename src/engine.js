'use strict';
const { seed, PRESETS } = require('./data');
const { retrieve } = require('./retrieve');
const rules = require('./agent_rules');
const llm = require('./llm');
const { checkReply, SAFE_REPLY } = require('./guard');
const nlu = require('./nlu');

const ORDER = { none: 0, routine: 0, important: 1, urgent: 2 };
const OUTCOME_LABEL = { resolved: 'Resolved', message_captured: 'Message captured', pending: 'Pending', escalated: 'Escalated', no_purpose: 'Purpose not established' };

const STUCK_CLOSE = "I'm sorry, I'm not able to get what I need on this call. I'll let Jane know, and she'll follow up if needed. Thank you, goodbye.";
function lastQuestion(reply) { const m = String(reply).match(/[^.?!]*\?/g); return m ? m[m.length - 1].trim() : null; }
function similar(a, b) {
  const w = (s) => new Set(s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((x) => x.length > 2));
  const A = w(a), B = w(b); if (!A.size || !B.size) return false;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter) >= 0.7;
}

class Engine {
  constructor() {
    this.stores = { new: seed('new'), existing: seed('existing') };
    this.seq = 0;
  }
  // key is 'new', 'existing', or 'new:<visitorId>' / 'existing:<visitorId>' so each hosted visitor gets private memory.
  store(key) {
    const kind = String(key).split(':')[0];
    if (kind !== 'new' && kind !== 'existing') throw new Error('unknown profile ' + key);
    if (!this.stores[key]) {
      const keys = Object.keys(this.stores);
      if (keys.length > 300) delete this.stores[keys.find((k) => k.includes(':'))]; // evict oldest visitor
      this.stores[key] = seed(kind);
    }
    return this.stores[key];
  }
  reset(key) { delete this.stores[key]; return this.store(key); }
  id(p) { return p + (++this.seq).toString(36) + Math.random().toString(36).slice(2, 5); }

  emit(store, callId, type, data = {}) { store.events.push({ t: Date.now(), callId, type, data }); if (store.events.length > 600) store.events.shift(); }

  // ---------------------------------------------------------------- calls
  startCall(profile, { number, label = '', seedRepeats = 0 }) {
    const store = this.store(profile);
    const now = Date.now();
    const flags = store.callerFlags[number] || {};
    for (let i = 0; i < seedRepeats; i++) store.callLog.push({ number, at: now - (45 - i * 8) * 60000, callId: 'seed' + i });
    const call = {
      id: this.id('c'), number, label, startedAt: now, turns: [], state: rules.newState(), flags: rules.newFlags(),
      ended: false, approvals: {}, engineUsed: [], notificationId: null, routed: false,
    };
    store.calls[call.id] = call;
    store.callLog.push({ number, at: now, callId: call.id });
    this.emit(store, call.id, 'call_started', { number, label });
    if (flags.ringThrough) {
      call.routed = true; call.ended = true;
      this.emit(store, call.id, 'routed_to_jane', { number });
      return { call: this.publicCall(call), routedToJane: true };
    }
    call.turns.push({ role: 'sonic', text: rules.OPENING, at: now });
    return { call: this.publicCall(call), routedToJane: false };
  }

  publicCall(call) {
    return { id: call.id, number: call.number, label: call.label, ended: call.ended, routed: call.routed,
      turns: call.turns, state: call.state, startedAt: call.startedAt, summary: call.summary || null };
  }

  async message(profile, callId, text, mode = 'auto') {
    const store = this.store(profile);
    const call = store.calls[callId];
    if (!call) return { lost: true, reply: null }; // server restarted or call expired: the page shows a neutral notice, never an error as Sonic
    if (call.ended) return { call: this.publicCall(call), reply: null };
    text = String(text || '').slice(0, 1200);
    call.turns.push({ role: 'caller', text, at: Date.now() });
    const em = (t, d) => this.emit(store, call.id, t, d);
    rules.absorb(call, text, store); // name, company, needs, so retrieval sees them
    const R = retrieve(store, call, text);

    let reply, usedLLM = false;
    const wantLLM = (mode === 'llm' || mode === 'auto') && llm.available();
    if (wantLLM) {
      try {
        const out = await llm.callLLM(call, R.context, text);
        reply = out.reply; this.mergeLLMState(call, out.call_state, em); usedLLM = true;
        this.lastLlmError = null;
      } catch (e) {
        this.lastLlmError = String(e.message || e).slice(0, 300);
        em('llm_fallback', { error: this.lastLlmError });
      }
    }
    if (!usedLLM) reply = rules.rulesTurn({ call, store, R }, text, em);

    const g = checkReply(reply, R, store);
    if (!g.ok) {
      em('guard_blocked', { reasons: g.reasons, original: usedLLM ? reply : '(rules agent)' });
      call.state.blocked.push('Output guard blocked a reply: ' + g.reasons.join(', '));
      call.guardFired = (call.guardFired || 0) + 1;
      reply = SAFE_REPLY;
    }
    // Stuck guard (both agents): never keep asking the same thing. The second ask is gently rephrased as "didn't get that",
    // the third time Sonic stops, hands the details to Jane and ends the call. Also a hard cap on call length.
    const stt = call.state;
    const callerTurns = call.turns.filter((t) => t.role === 'caller').length;
    const q = lastQuestion(reply);
    if (q && call.lastQ && similar(q, call.lastQ)) call.sameQ = (call.sameQ || 0) + 1; else call.sameQ = 0;
    call.lastQ = q;
    if (!stt.end_call && (call.sameQ >= 2 || callerTurns > 14)) {
      reply = STUCK_CLOSE; stt.end_call = true;
      if (stt.outcome === 'pending' && stt.message_for_jane && !stt.issue) stt.outcome = 'message_captured';
      stt.issue = stt.issue || 'Caller did not give the information Sonic asked for';
      stt.notes_for_jane.push(callerTurns > 14 ? 'Sonic ended a very long call' : 'Sonic stopped after asking the same question without getting an answer');
      em('stuck_call_closed', { turns: callerTurns, question: q });
    } else if (call.sameQ === 1 && !/^sorry/i.test(reply)) {
      reply = "Sorry, I didn't quite get that. " + reply;
    }
    call.engineUsed.push(usedLLM ? 'llm' : 'rules');
    call.turns.push({ role: 'sonic', text: reply, at: Date.now(), engine: usedLLM ? 'llm' : 'rules' });
    this.sync(store, call);
    let summary = null;
    if (call.state.end_call) summary = this.endCall(profile, call.id, 'sonic').summary;
    return { call: this.publicCall(call), reply, ended: call.ended, summary, engine: usedLLM ? 'llm' : 'rules' };
  }

  mergeLLMState(call, cs, em) {
    const st = call.state;
    const pick = (k, ok) => { if (cs[k] !== undefined && cs[k] !== null && (!ok || ok.includes(cs[k]))) st[k] = cs[k]; };
    pick('call_type', ['delivery', 'pickup', 'known', 'unknown', 'unclear']);
    pick('identity_state', ['identified', 'probable', 'unknown', 'suspicious', 'urgent']);
    for (const k of ['caller_name', 'company', 'shipment_ref', 'issue', 'urgency_reason', 'callback_time']) pick(k);
    if (cs.purpose && !st.purpose) { st.purpose = cs.purpose; em('purpose_identified', { purpose: cs.purpose }); }
    pick('urgency', ['routine', 'important', 'urgent']);
    if (cs.message_for_jane) st.message_for_jane = String(cs.message_for_jane).slice(0, 600);
    if (Array.isArray(cs.proposed_slots)) st.proposed_slots = cs.proposed_slots.map(String).slice(0, 5);
    if (Array.isArray(cs.commitments)) st.commitments = cs.commitments.map(String).slice(0, 5);
    if (Array.isArray(cs.disclosed)) for (const d of cs.disclosed) if (!st.disclosed.includes(d)) st.disclosed.push(d);
    if (typeof cs.wants_live_transfer === 'boolean' && cs.wants_live_transfer) { st.wants_live_transfer = true; em('bypass_requested', {}); }
    if (cs.needs_jane_approval) st.needs_jane_approval = String(cs.needs_jane_approval);
    if (['important', 'urgent'].includes(cs.escalate) && ORDER[cs.escalate] > ORDER[st.escalate]) { st.escalate = cs.escalate; em('escalation_triggered', { level: cs.escalate }); }
    if (cs.end_call === true) st.end_call = true;
    pick('outcome', ['resolved', 'message_captured', 'pending', 'escalated', 'no_purpose']);
  }

  // ---------------------------------------------------------------- notifications
  sync(store, call) {
    const st = call.state;
    if (call.ended) return;
    const lvl = st.escalate;
    if (lvl !== 'none' || st.needs_jane_approval) {
      const n = this.upsertNotification(store, call, true);
      call.notificationId = n.id;
    }
  }

  buildSummary(store, call) {
    const st = call.state;
    const contact = store.contacts.find((c) => c.number === call.number);
    const nameMatch = contact && st.caller_name && st.caller_name.toLowerCase() === contact.name.toLowerCase();
    const who = contact && (st.identity_state === 'identified' || nameMatch) ? `${contact.name} (${contact.relationship})`
      : contact && st.identity_state === 'urgent' && !st.caller_name ? `Saved contact ${contact.name} (name not stated)`
      : st.caller_name ? `${st.caller_name}${st.company ? ' from ' + st.company : ''}${contact ? ' (number saved as ' + contact.name + ', not verified)' : ''}` : (st.company ? `Caller from ${st.company}` : 'Unknown caller');
    const details = [];
    if (st.issue) details.push(st.issue);
    if (st.shipment_ref) details.push(`Shipment ${st.shipment_ref}`);
    if (st.message_for_jane && !['delivery', 'pickup'].includes(st.call_type)) details.push('Message: ' + st.message_for_jane);
    if (st.proposed_slots.length) details.push('Proposed time (not approved): ' + st.proposed_slots.join(' | '));
    if (st.callback_time) details.push(st.callback_time);
    if (st.topic) details.push(`Topic: ${st.topic.label} (currently ${st.topic.status})`);
    for (const n of st.notes_for_jane) details.push(n);
    if (['delivery', 'pickup'].includes(st.call_type)) details.push(st.disclosed.includes('otp') ? 'An OTP was shared (matched shipment, your setting allows it).' : 'No OTP was shared.');
    if (st.blocked.length) details.push('Declined: ' + [...new Set(st.blocked)].join('; '));
    const repeats = store.callLog.filter((c) => c.number === call.number && c.at > Date.now() - 3600000).length;
    if (repeats >= 4) details.push(`${repeats} calls from this number in the last hour (pattern only, not assumed urgent or spam)`);

    let next = null;
    if (st.needs_jane_approval) next = 'Approve or deny sharing the OTP (buttons below). The caller is waiting.';
    else if (st.escalate === 'urgent') next = `Call back now${call.number.startsWith('+') ? ' on ' + call.number : ''}.`;
    else if (st.proposed_slots.length) next = 'Confirm or decline the proposed time with the courier.';
    else if (st.issue && ['delivery', 'pickup'].includes(st.call_type)) next = 'Decide the next step for this shipment (reschedule or alternative).';
    else if (st.outcome === 'message_captured' && st.identity_state !== 'suspicious') next = `Reply${st.callback_time ? ' (' + st.callback_time + ')' : ''}.`;
    else if (st.outcome === 'escalated') next = 'Review and decide whether to call back.';
    else if (st.outcome === 'no_purpose') next = 'Optional: call back if you recognise the number.';
    else if (st.identity_state === 'suspicious') next = 'No action needed. Consider blocking this number.';

    const level = st.escalate === 'urgent' || st.urgency === 'urgent' ? 'urgent' : (st.escalate === 'important' || st.urgency === 'important' || st.needs_jane_approval) ? 'important' : 'routine';
    const short = level === 'routine' && !next && !details.filter((d) => !/No OTP/.test(d)).length;
    const needsReview = ['suspicious', 'probable', 'urgent'].includes(st.identity_state) || st.outcome === 'no_purpose' || !!st.needs_jane_approval || st.disclosed.includes('otp') || !!call.guardFired;

    let suggestion = null;
    if (store.kind === 'new' && !contact && st.caller_name && ['message_captured', 'pending', 'resolved'].includes(st.outcome) && st.identity_state !== 'suspicious' && !['delivery', 'pickup'].includes(st.call_type) && call.number.startsWith('+')) {
      suggestion = { text: `Save ${st.caller_name} as a contact so Sonic can recognise this number next time?`, op: { op: 'add_contact', name: st.caller_name, number: call.number, relationship: 'unspecified' } };
    }
    return {
      who, number: call.number, purpose: st.purpose || 'Not established', outcome: st.outcome, outcomeLabel: OUTCOME_LABEL[st.outcome] || st.outcome,
      details, urgency: { level, reason: st.urgency_reason || (level === 'routine' ? 'No time pressure indicated' : '') },
      next, short, needsReview, suggestion, callType: st.call_type, identity: st.identity_state, turns: call.turns.length,
    };
  }

  upsertNotification(store, call, inProgress) {
    const s = this.buildSummary(store, call);
    let n = store.notifications.find((x) => x.callId === call.id);
    const isNew = !n;
    if (!n) { n = { id: this.id('n'), callId: call.id, createdAt: Date.now(), feedback: null, approval: null }; store.notifications.unshift(n); }
    Object.assign(n, { level: s.urgency.level, who: s.who, number: s.number, purpose: s.purpose, outcomeLabel: s.outcomeLabel, details: s.details, urgency: s.urgency,
      next: s.next, short: s.short, needsReview: s.needsReview, suggestion: s.suggestion, inProgress, simulated: 'SIMULATED push notification (nothing was actually sent)' });
    const key = call.state.needs_jane_approval;
    if (key && !n.approval) n.approval = { key, status: 'pending' };
    if (isNew) this.emit(store, call.id, 'notification_created', { level: n.level });
    return n;
  }

  endCall(profile, callId, by = 'caller') {
    const store = this.store(profile);
    const call = store.calls[callId];
    if (!call) return { lost: true, call: null, summary: null };
    if (call.summary) return { call: this.publicCall(call), summary: call.summary };
    const st = call.state;
    if (call.routed) return { call: this.publicCall(call), summary: null };
    call.ended = true; call.endedBy = by; call.endedAt = Date.now();
    if (by === 'caller' && st.outcome === 'pending' && !st.purpose) {
      st.outcome = 'no_purpose'; this.emit(store, call.id, 'ended_before_purpose', {});
      st.notes_for_jane.push('Caller hung up before Sonic understood the purpose');
    }
    if (by === 'caller' && st.outcome === 'pending' && st.purpose && !st.issue && !st.proposed_slots.length && !st.needs_jane_approval && st.message_for_jane) st.outcome = 'message_captured';
    const summary = this.buildSummary(store, call);
    call.summary = summary;
    const n = this.upsertNotification(store, call, false);
    call.notificationId = n.id;
    // Data minimisation: store only purpose and outcome. Never codes, addresses or full transcripts.
    if (st.purpose && st.identity_state !== 'suspicious' && st.identity_state !== 'urgent' && !['delivery', 'pickup'].includes(st.call_type) && call.number.startsWith('+')) {
      const arr = (store.numberNotes[call.number] = store.numberNotes[call.number] || []);
      arr.push({ at: Date.now(), topic: st.topic ? st.topic.id : null, source: 'inferred', text: `${st.caller_name || 'Caller'}: ${nlu.shortQuote(st.purpose, 120)} (${OUTCOME_LABEL[st.outcome]})` });
      if (arr.length > 5) arr.shift();
    }
    this.emit(store, call.id, 'call_ended', { by, outcome: st.outcome, type: st.call_type, turns: call.turns.length, ms: call.endedAt - call.startedAt, escalate: st.escalate, identity: st.identity_state });
    return { call: this.publicCall(call), summary };
  }

  // ---------------------------------------------------------------- approvals, feedback, memory
  decideApproval(profile, notificationId, decision) {
    const store = this.store(profile);
    const n = store.notifications.find((x) => x.id === notificationId);
    if (!n || !n.approval) throw new Error('no approval pending');
    const call = store.calls[n.callId];
    n.approval.status = decision === 'approve' ? 'approved' : 'denied';
    if (decision === 'approve') call.approvals[n.approval.key] = true;
    this.emit(store, call.id, 'approval_decided', { decision, key: n.approval.key });
    return n;
  }

  feedback(profile, notificationId, type, detail = '') {
    const store = this.store(profile);
    const n = store.notifications.find((x) => x.id === notificationId);
    if (!n) throw new Error('no notification');
    n.feedback = { type, detail, at: Date.now() };
    store.feedback.push({ notificationId, number: n.number, type, detail, at: Date.now() });
    this.emit(store, n.callId, 'feedback_submitted', { type });
    const neg = ['wrong_response', 'missed_urgency', 'dont_handle'];
    let suggestion = null;
    const negCount = store.feedback.filter((f) => f.number === n.number && neg.includes(f.type)).length;
    if (type === 'dont_handle') {
      suggestion = { text: `Ring calls from ${n.number} straight through to you (Sonic will not answer them)?`, op: { op: 'caller_flag', number: n.number, ringThrough: true } };
    } else if (neg.includes(type) && negCount >= 2) {
      suggestion = { text: `You have corrected Sonic ${negCount} times for ${n.number}. Mark this caller as important so you are always alerted?`, op: { op: 'caller_flag', number: n.number, important: true } };
    }
    // Negative signals are logged, not treated as proof Sonic erred. They queue for sampled review.
    return { notification: n, suggestion, note: neg.includes(type) && !suggestion ? 'Logged. One correction is not saved as a rule. A second one for this caller will offer to save a preference.' : null };
  }

  memory(profile, body) {
    const store = this.store(profile);
    switch (body.op) {
      case 'set_permission': store.permissions[body.key] = !!body.value; break;
      case 'topic_status': {
        const t = store.topics.find((x) => x.id === body.id); if (!t) throw new Error('no topic');
        t.status = body.status; t.updatedAt = Date.now(); break;
      }
      case 'caller_flag': {
        const f = (store.callerFlags[body.number] = store.callerFlags[body.number] || {});
        if (body.important !== undefined) f.important = !!body.important;
        if (body.ringThrough !== undefined) f.ringThrough = !!body.ringThrough;
        break;
      }
      case 'delete_note': (store.numberNotes[body.number] || []).splice(body.index, 1); break;
      case 'confirm_note': { const n = (store.numberNotes[body.number] || [])[body.index]; if (n) n.source = 'saved'; break; }
      case 'edit_contact_rule': { const c = store.contacts.find((x) => x.id === body.id); if (c) c.priority_rule = body.rule || null; break; }
      case 'add_contact': {
        if (!store.contacts.find((c) => c.number === body.number)) {
          store.contacts.push({ id: 'c' + Date.now(), name: body.name, relationship: body.relationship || 'unspecified', number: body.number, preferences: 'No preferences set yet.', priority_rule: null, context: [] });
        } break;
      }
      case 'remove_contact': store.contacts = store.contacts.filter((c) => c.id !== body.id); break;
      case 'reset': this.reset(profile); break;
      default: throw new Error('unknown op');
    }
    this.emit(this.store(profile), null, 'memory_changed', { op: body.op });
    return this.publicState(profile);
  }

  // ---------------------------------------------------------------- views
  publicState(profile) {
    const s = this.store(profile);
    return {
      profile, kind: s.kind, jane: { name: s.profile.name, home: s.profile.home, office: s.profile.office },
      permissions: s.permissions, contacts: s.contacts, topics: s.topics, numberNotes: s.numberNotes, callerFlags: s.callerFlags,
      shipments: s.shipments, messages: s.messages.map((m) => ({ id: m.id, from: m.from, type: m.type, text: m.text })),
      notifications: s.notifications, events: s.events.slice(-120), feedback: s.feedback,
      presets: PRESETS, llmAvailable: llm.available(), llmProvider: llm.provider(), llmModel: llm.lastUsedModel() || llm.modelName(), llmLastError: this.lastLlmError || null, calendar: s.calendar,
    };
  }

  metrics(profile) {
    const s = this.store(profile);
    const calls = Object.values(s.calls).filter((c) => !c.routed);
    const done = calls.filter((c) => c.summary);
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : 'n/a');
    const ev = (t) => s.events.filter((e) => e.type === t).length;
    const byType = {};
    for (const c of done) {
      const k = c.state.call_type; (byType[k] = byType[k] || []).push((c.endedAt - c.startedAt) / 1000);
    }
    const fb = s.feedback;
    return {
      calls: calls.length, completed: done.length,
      intent_identification_rate: pct(done.filter((c) => c.state.purpose).length, done.length),
      ended_before_purpose: ev('ended_before_purpose'),
      escalations: ev('escalation_triggered'), urgent_calls: done.filter((c) => c.state.escalate === 'urgent').length,
      bypass_requests: ev('bypass_requested'), clarification_requests: ev('clarification_requested'),
      privacy_declines: ev('privacy_block'), guard_blocks: ev('guard_blocked'), llm_fallbacks: ev('llm_fallback'),
      frustration_signals: ev('frustration_signal'),
      feedback_total: fb.length, negative_feedback_rate: pct(fb.filter((f) => f.type !== 'correct').length, fb.length),
      median_seconds_by_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v.sort((a, b) => a - b)[Math.floor(v.length / 2)])])),
      note: 'Mock, in session numbers. Short is not automatically good, long is not automatically bad. Do not read these as quality without sampled review.',
    };
  }
}

module.exports = { Engine, OUTCOME_LABEL };
