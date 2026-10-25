'use strict';
// DETERMINISTIC FALLBACK AGENT. Not an LLM. Same retrieval/policy layer as LLM mode, scripted language.
// It exists so the prototype runs without an API key and so tests are repeatable.

const nlu = require('./nlu');

const ORDER = { none: 0, important: 1, urgent: 2 };
const maxEsc = (a, b) => (ORDER[a] >= ORDER[b] ? a : b);
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'about', 'have', 'from', 'your', 'you', 'was', 'were', 'what', 'which', 'about', 'there', 'their', 'call', 'calling', 'regarding', 'listing', 'earlier', 'discussed', 'talked']);

// Like a person picking up: just "Hi" and let the caller speak first. The introduction comes with the first reply.
const OPENING = 'Hi.';

function newState() {
  return {
    call_type: 'unclear', identity_state: 'unknown', caller_name: null, company: null, shipment_ref: null,
    purpose: null, issue: null, urgency: 'routine', urgency_reason: null, message_for_jane: null, callback_time: null,
    proposed_slots: [], commitments: [], wants_live_transfer: false, needs_jane_approval: null, disclosed: [],
    escalate: 'none', end_call: false, outcome: 'pending', topic: null, notes_for_jane: [], blocked: [],
  };
}
function newFlags() {
  return { needs: [], resolved: [], stage: null, labelAsked: false, bypassCount: 0, urgentMode: false, urgentStage: 0, manip: 0,
    purposeAsks: 0, clarifyAsks: 0, refusals: 0, nameAsked: false, missingAsks: 0, awaitContact: false, contextAsked: false,
    repeatAcked: false, calmed: 0, suspicious: false, otpBankish: false, claimsKnown: null, nameMismatch: false, noRef: false };
}

function appendMsg(st, raw) {
  const q = nlu.shortQuote(raw, 300);
  st.message_for_jane = st.message_for_jane ? st.message_for_jane + ' | ' + q : q;
}

function absorb(call, raw, store) {
  const st = call.state, fl = call.flags;
  const I = nlu.intents(raw);
  const name = nlu.extractName(raw);
  if (name) st.caller_name = name;
  const comp = nlu.extractCompany(raw);
  if (comp) st.company = comp;
  if (I.asksOtp && nlu.bankOtpAsk(raw)) fl.otpBankish = true;
  const add = (n) => { if (!fl.needs.includes(n)) fl.needs.push(n); };
  if (I.asksOtp) add('otp');
  if (I.labelMissing) add('label');
  if (I.damaged) add('damaged');
  if (I.notReady) add('notReady');
  if (I.pickupRefused) add('refused');
  if (I.failedAttempt) add('failed');
  if (I.systemError) add('syserror');
  if (I.refusesSecurity) add('refusesSecurity');
  if (I.asksAddress) add('address');
  if (I.asksWhereabouts) add('availability');
  if (/(where (should|do|can|shall) i (leave|drop|put|keep)|who (do|should) i (give|hand)|what should i do with|where to (leave|drop|put))/i.test(raw)) add('instructions');
  if (I.offersTime || I.reschedule) add('slot');
  return I;
}

// Wrapper: Sonic says "Hi." first, the caller speaks, then Sonic introduces itself in its first reply.
// A saved number is greeted by name and never asked "who is calling". Caller ID is not treated as proof.
function rulesTurn(ctxObj, raw, emit) {
  const { call, store, R } = ctxObj;
  const fl = call.flags, st = call.state;
  const first = call.turns.filter((t) => t.role === 'caller').length === 1 && !fl.introduced;
  const contact = R.internal.contact;
  const claimed = nlu.extractName(raw);
  const useName = contact && (!claimed || claimed.toLowerCase() === contact.name.toLowerCase());
  const introName = useName ? contact.name : claimed; // a name the caller gives is used from the first reply on
  const intro = introName ? `Hi ${introName}, ${useName ? 'this is' : "I'm"} Jane's assistant. ` : "Hi, I'm Jane's assistant. ";
  if (first && nlu.isGreetingOnly(raw)) {
    fl.introduced = true;
    if (contact) { st.call_type = 'known'; st.identity_state = 'identified'; return intro + 'How can I help?'; }
    return intro + "Who's calling, please?";
  }
  let reply = rulesTurnCore(ctxObj, raw, emit);
  if (first && !fl.urgentMode) {
    fl.introduced = true;
    if (introName) { fl.nameUses = 1; reply = reply.replace(/^Thanks(, [A-Za-z]+)?\.\s+/, ''); } // the intro already thanked and named them
    return intro + reply;
  }
  const nameNow = st.caller_name || (contact && !fl.nameMismatch ? contact.name : null);
  return personalize(reply, nameNow, fl, st);
}

// Uses the caller's name in later replies, naturally: in the closing, and once mid conversation. Never in every sentence.
function personalize(reply, name, fl, st) {
  if (!name) return reply;
  if (new RegExp('\\b' + name + '\\b', 'i').test(reply)) { fl.nameUses = 1; return reply; }
  if (/Thanks for calling\.$/.test(reply)) return reply.replace(/Thanks for calling\.$/, `Thanks for calling, ${name}.`);
  if (st.end_call) {
    if (/Goodbye\.$/.test(reply)) return reply.replace(/Goodbye\.$/, `Goodbye, ${name}.`);
    if (/^Thank you, goodbye\.$/i.test(reply)) return `Thank you, ${name}. Goodbye.`;
    return reply;
  }
  if (!fl.nameUses) {
    const m = reply.match(/^((?:Thanks|Thank you|Got it|Understood|Noted)[^.?!]{0,50})([.!])/);
    if (m) { fl.nameUses = 1; return reply.replace(m[0], `${m[1]}, ${name}${m[2]}`); }
  }
  return reply;
}

function rulesTurnCore(ctxObj, raw, emit) {
  const { call, store, R } = ctxObj;
  const st = call.state, fl = call.flags;
  const I = absorb(call, raw, store);
  const { contact, sm } = R.internal;
  const { od } = R.internal;
  const repeats = R.internal.repeats;

  const setPurpose = (p) => { if (!st.purpose) { st.purpose = p; emit('purpose_identified', { purpose: p }); } };
  const blocked = (what) => { st.blocked.push(what); emit('privacy_block', { what }); };
  const esc = (level, reason) => {
    const before = st.escalate;
    st.escalate = maxEsc(st.escalate, level);
    if (ORDER[level] > ORDER[st.urgency === 'urgent' ? 'urgent' : st.urgency === 'important' ? 'important' : 'none']) {
      st.urgency = level; st.urgency_reason = reason;
    } else if (!st.urgency_reason) st.urgency_reason = reason;
    if (st.escalate !== before) emit('escalation_triggered', { level: st.escalate, reason });
  };
  const close = (reply, outcome) => { st.end_call = true; if (outcome) st.outcome = outcome; return reply; };
  const ask = (q) => { emit('clarification_requested', { q }); return q; };
  const calmPrefix = () => {
    if (I.shouting && !I.emergency && fl.calmed < 2) { fl.calmed++; emit('frustration_signal', {}); return "I hear you, and I'm sorry for the trouble. "; }
    return '';
  };

  // ---- call type
  const refs = nlu.extractRefs(raw);
  if (!['delivery', 'pickup'].includes(st.call_type)) {
    const known = nlu.KNOWN_COMPANIES.some((c) => c.re.test(raw));
    const courierWords = /(courier|parcel|package|deliver|delivery|shipment|pick ?up|awb|consignment|dispatch|delivery partner|\brider\b)/i.test(raw);
    if (refs.length || known || (!contact && courierWords)) {
      st.call_type = I.pickupWord && !/deliver/i.test(raw) ? 'pickup' : 'delivery';
    } else if (contact) st.call_type = 'known';
    else if (!I.vague) st.call_type = 'unknown';
  }
  const ctype = st.call_type;

  // ---- identity state
  const nameClaim = st.caller_name;
  const claimsContact = nameClaim ? store.contacts.find((c) => c.name.toLowerCase() === nameClaim.toLowerCase()) : null;
  if (contact && nameClaim) {
    if (nameClaim.toLowerCase() === contact.name.toLowerCase()) st.identity_state = 'identified';
    else { st.identity_state = 'probable'; fl.nameMismatch = true; }
  } else if (contact) st.identity_state = 'identified'; // saved number, nothing contradicts it. Still never unlocks private data.
  else if (claimsContact) { fl.claimsKnown = claimsContact.name; st.identity_state = 'unknown'; }
  if (ctype === 'delivery' || ctype === 'pickup') {
    if (sm.status === 'matched') { st.identity_state = 'identified'; st.shipment_ref = sm.shipment.ref; }
    else if (sm.status === 'mismatch') st.identity_state = 'suspicious';
    else if (sm.status === 'need_company') st.identity_state = 'probable';
  }
  if (fl.suspicious) st.identity_state = 'suspicious';
  if (R.internal.flags.important) esc('important', 'You marked this caller as important');
  if (repeats >= 3) {
    esc('important', `Repeated attempts: ${repeats + 1} calls in the last hour. Not assumed urgent or spam.`);
    st.notes_for_jane.push(`${repeats + 1} calls from this number in the last hour`);
  }

  // =============== 1. EMERGENCY ===============
  if (fl.urgentMode || I.emergency) {
    st.identity_state = 'urgent';
    if (!fl.urgentMode) {
      fl.urgentMode = true; fl.urgentStage = 1;
      st.purpose = st.purpose || 'Reported an emergency or distressing situation'; emit('purpose_identified', { purpose: st.purpose });
      appendMsg(st, raw);
      esc('urgent', 'Caller reports a possible emergency: "' + nlu.shortQuote(raw, 100) + '"');
      st.outcome = 'escalated';
      return "I'm so sorry. I've sent Jane an urgent alert. If anyone needs help right now, please call emergency services, as I can't send help myself. What's happening?";
    }
    appendMsg(st, raw);
    if (fl.urgentStage === 1) {
      fl.urgentStage = 2;
      if (I.speakToJane) return "I can't connect you myself, but Jane has an urgent alert with everything you've told me. What's the best number to reach you on?";
      return "Thank you, I've added that to Jane's alert. What's the best number for her to reach you on?";
    }
    const ph = nlu.extractPhone(raw);
    if (ph) st.callback_time = 'Call back on ' + ph;
    return close("Got it, I've passed everything to Jane. Please call emergency services if it gets worse. Take care.", 'escalated');
  }

  // =============== 2. MANIPULATION ===============
  if (I.pretendJane || I.injection) {
    fl.manip++; fl.suspicious = true; st.identity_state = 'suspicious';
    blocked(I.pretendJane ? 'Asked Sonic to pretend to be Jane' : 'Tried to override instructions or extract the prompt');
    st.issue = I.pretendJane ? 'Caller asked Sonic to impersonate Jane' : 'Caller tried to override Sonic instructions';
    setPurpose(st.issue);
    esc('important', 'Impersonation or instruction override attempt');
    if (fl.manip === 1) return calmPrefix() + "I can't do that. I'm Jane's assistant, and I can take a message.";
    return calmPrefix() + "I'm not able to speak as Jane or change how I work. I can still pass on a message if you'd like.";
  }

  // =============== 3. ARE YOU AN AI ===============
  if (I.askAI && !I.speakToJane) {
    return calmPrefix() + (st.purpose ? "Yes, I'm Jane's AI call assistant. Please go on, I'm listening." : "Yes, I'm Jane's AI call assistant. How can I help?");
  }

  // =============== 4. BYPASS / SPEAK TO JANE ===============
  if (I.speakToJane) {
    fl.bypassCount++; st.wants_live_transfer = true; emit('bypass_requested', { n: fl.bypassCount });
    const aiPre = /(ai|robot|bot|machine)/i.test(raw) ? "I understand, and yes, I'm an AI assistant. " : '';
    const prio = contact && contact.priority_rule && /urgent/i.test(contact.priority_rule);
    if (!I.vague && !st.purpose && !I.refusesPurpose) { /* keep purpose unknown */ }
    if (I.urgentWord && (I.cannotExplain || (prio && st.identity_state === 'identified'))) {
      appendMsg(st, raw);
      esc('urgent', contact ? `${contact.name} (${contact.relationship}) says it is urgent and wants you directly` : 'Caller says it is urgent, cannot explain, wants you directly');
      setPurpose('Urgent request to speak to Jane directly');
      st.outcome = 'escalated';
      return aiPre + "Understood. I've sent Jane an urgent alert saying you need her directly. I can't connect the call myself, so what's the best number for her to reach you?";
    }
    if (R.internal.flags.important) {
      appendMsg(st, raw); esc('important', 'Important caller asked for you directly'); st.outcome = 'escalated';
      return aiPre + calmPrefix() + "I can't put you through myself, but I've sent Jane a priority alert. What should I tell her?";
    }
    if (st.purpose) {
      esc('important', 'Caller asked to speak to you directly'); st.outcome = 'escalated';
      appendMsg(st, raw);
      if (fl.bypassCount >= 2) return close(aiPre + "I've sent Jane your message and your request to speak with her directly. Thank you for calling.", 'escalated');
      return aiPre + calmPrefix() + "I can't put you through myself, but I've sent Jane your message along with your request to speak with her directly.";
    }
    if (fl.bypassCount === 1) {
      return aiPre + calmPrefix() + ask("I can't put you through myself, but I can get a message to her straight away. What is it about?");
    }
    if (fl.bypassCount === 2) {
      esc('important', 'Caller asked to speak to you twice without giving a reason'); st.outcome = 'escalated';
      return calmPrefix() + "I understand. I've logged your request to speak with her and alerted her. If it's urgent, tell me what's happening so I can mark it that way.";
    }
    esc('important', `Caller demanded to speak to you ${fl.bypassCount} times without giving a reason. Not assumed urgent.`);
    setPurpose('Repeated requests to speak to Jane directly, reason not given');
    return close("I've recorded your request and Jane will see it. Thank you for calling.", 'escalated');
  }

  // =============== 5. TYPE FLOWS ===============
  if (ctype === 'delivery' || ctype === 'pickup') return deliveryFlow();
  if (ctype === 'known') return knownFlow();
  return unknownFlow();

  // ------------------------------------------------------------------
  function endText() { return calmPrefix(); }

  function deliveryFlow() {
    const taskWord = ctype === 'pickup' ? 'pickup' : 'delivery';
    if (st.company && !st.purpose) setPurpose(`${st.company} ${taskWord}` + (st.shipment_ref ? ` ${st.shipment_ref}` : ''));
    const pre = calmPrefix();

    // scam or payment style request
    if (I.scamish && !(sm.status === 'matched')) {
      fl.suspicious = true; st.identity_state = 'suspicious';
      blocked('Asked for payment, link, or personal details');
      st.issue = 'Request for payment, link or personal details';
      setPurpose('Possible scam: ' + nlu.shortQuote(raw, 80));
      appendMsg(st, raw);
      return close(pre + "I can't help with payments or personal details. I'll let Jane know you called. Goodbye.", 'message_captured');
    }
    if (I.scamish && sm.status === 'matched') {
      st.issue = 'Caller asked for payment or personal details, which Sonic cannot do';
      appendMsg(st, raw);
      return pre + "I can't make payments or share personal details. I'll pass your request to Jane.";
    }

    // stage handlers (matched flows)
    if (fl.stage && sm.status === 'matched') {
      const s = sm.shipment, a = store.profile[s.dest];
      if (fl.stage === 'await_label') {
        fl.stage = null; fl.resolved.push('address');
        const lc = raw.toLowerCase();
        const mine = a.tokens.some((t) => lc.includes(t));
        const other = store.profile[s.dest === 'home' ? 'office' : 'home'].tokens.some((t) => lc.includes(t));
        if (mine && !other) {
          if (!st.disclosed.includes('drop_instruction')) st.disclosed.push('drop_instruction');
          return pre + 'Yes, that matches. ' + (s.itemClass === 'ordinary' ? R.internal.allowed.drop_instruction : 'Please hold it for now, as it cannot be left unattended.');
        }
        if (other || (!I.cannotFind && !I.yes === false && false)) {
          fl.suspicious = true; st.identity_state = 'suspicious';
          blocked('Address read from label did not match the record');
          st.issue = 'Address on courier label did not match the shipment record';
          return close(pre + "That doesn't match the shipment I have, so I can't share more. Jane will need to verify this. Goodbye.", 'message_captured');
        }
        if (I.cannotFind || I.no || /(just|please).{0,12}tell|don't have|no idea|can't read|not clear/i.test(raw)) {
          st.disclosed.push('minimal_location');
          return pre + `It's ${R.internal.allowed.minimal_location}. ` + (s.itemClass === 'ordinary' ? R.internal.allowed.drop_instruction : 'Please hold it for now, as it cannot be left unattended.');
        }
        fl.suspicious = true; st.identity_state = 'suspicious';
        blocked('Label address could not be matched to the record');
        return pre + "I can't match that to my record, so I can't share anything more. Jane will need to verify this.";
      }
      if (fl.stage === 'await_drop_ok') {
        if ((I.no || I.refusesSecurity) && I.offersTime) {
          fl.stage = null; st.issue = st.issue || 'Courier cannot use the usual drop point';
          st.proposed_slots.push(nlu.shortQuote(raw, 140)); appendMsg(st, raw);
          return close(pre + "Understood. I can't approve a new time on Jane's behalf, but I've noted it and she'll confirm.", 'pending');
        }
        if (I.no || I.refusesSecurity) {
          fl.stage = 'await_alternatives'; st.issue = st.issue || 'Courier cannot use the usual drop point';
          return pre + ask('Understood. What alternative can you offer, such as another attempt at a different time?');
        }
        fl.stage = null; st.outcome = 'resolved';
        return close(pre + 'Thank you, that works. Goodbye.', 'resolved');
      }
      if (fl.stage === 'await_alternatives') {
        fl.stage = null;
        const q = nlu.shortQuote(raw, 160);
        if (I.no && raw.split(/\s+/).length < 6) {
          st.notes_for_jane.push('No alternative offered by the caller');
          return close(pre + "Understood. I'll let Jane know so she can decide the next step. Thank you.", 'pending');
        }
        st.proposed_slots.push(q); appendMsg(st, raw);
        return close(pre + "Noted. I'll pass that to Jane and she'll confirm. I can't approve it on her behalf.", 'pending');
      }
      if (fl.stage === 'await_approval') fl.stage = null;
    }

    // not matched yet
    if (sm.status !== 'matched') {
      const sensitive = I.asksOtp || I.asksAddress || I.asksWhereabouts;
      if (sm.status === 'mismatch') {
        fl.suspicious = true; st.identity_state = 'suspicious';
        blocked('Company or task did not match the shipment');
        st.issue = 'Details did not match any shipment on record';
        appendMsg(st, raw);
        return pre + "I can't match that to a shipment I know about, so I can't share anything. Jane will need to verify. Could I take your number for her?";
      }
      if (fl.awaitContact) {
        const ph = nlu.extractPhone(raw);
        if (!sensitive || ph) {
          if (ph) st.callback_time = 'Caller number given: ' + ph;
          appendMsg(st, raw);
          return close(pre + "Thank you, I'll pass that to Jane. Goodbye.", 'message_captured');
        }
      }
      let lead = '';
      if (I.asksOtp) { blocked('Asked for a code without a matched shipment'); lead = "I can't share any codes without matching the shipment. "; }
      else if (I.asksAddress || I.asksWhereabouts) { blocked('Asked for address or whereabouts without a matched shipment'); lead = "I can't share Jane's address or whereabouts without matching the shipment. "; }
      if (I.offersTime && !sensitive) { st.proposed_slots.push(nlu.shortQuote(raw, 120)); }
      if (/(don't have|no|without|can't find|lost|forgot).{0,12}(ref|reference|number|tracking|awb)/i.test(raw)) fl.noRef = true;
      fl.missingAsks++;
      if (fl.noRef || fl.missingAsks > 3 || sm.status === 'ref_not_found' && fl.missingAsks > 2) {
        fl.awaitContact = true; setPurpose(`${st.company || 'Courier'} ${taskWord} call, shipment not matched`);
        return pre + lead + ask("Without a reference I can't check anything. Could I take your number for Jane?");
      }
      if (sm.status === 'ref_not_found') return pre + lead + ask("I can't match that reference. Could you read it out again?");
      // Couriers and pickup agents need details, not a reply. First ask how Sonic can help, then company and reference.
      if (!fl.needs.length && !fl.askedHelp && sm.status === 'none') { fl.askedHelp = true; return pre + lead + ask('How can I help you with the delivery or pickup?'); }
      if (!st.company) return pre + lead + ask('Which company are you with?');
      return pre + lead + ask("What's the shipment reference number?");
    }

    // matched
    const s = sm.shipment, a = store.profile[s.dest];
    setPurpose(`${s.task === 'pickup' ? 'Pickup' : 'Delivery'} call from ${s.company}, ref ${s.ref}`);
    const prio = ['otp', 'label', 'damaged', 'notReady', 'refused', 'failed', 'syserror', 'refusesSecurity', 'address', 'availability', 'instructions', 'slot'];
    const need = prio.find((n) => fl.needs.includes(n) && !fl.resolved.includes(n));
    const unattended = s.itemClass !== 'ordinary';
    const dropWord = s.dest === 'office' ? 'reception desk' : 'security desk';

    if (!need) {
      if (I.thanks || I.done) return close(pre + 'Thank you, goodbye.', st.issue || st.proposed_slots.length || st.needs_jane_approval ? 'pending' : 'resolved');
      return pre + ask('Thanks, I have that shipment. How can I help?');
    }
    switch (need) {
      case 'otp': {
        if (od.decision === 'share') {
          fl.resolved.push('otp'); st.disclosed.push('otp'); st.outcome = 'resolved';
          return pre + `The code is ${od.code}. Please don't share it with anyone else.`;
        }
        if (od.decision === 'needs_approval') {
          st.needs_jane_approval = od.approvalKey; st.outcome = 'pending'; fl.stage = 'await_approval';
          esc('important', `${s.company} ${s.task} is waiting for an OTP. Sharing needs your approval.`);
          if (call.flags.otpWaitCount) { call.flags.otpWaitCount++; return pre + "I'm still waiting on Jane's approval. I'll note that you're waiting."; }
          call.flags.otpWaitCount = 1;
          return pre + "I can't share that code without Jane's approval. I've asked her, so please give it a few minutes.";
        }
        blocked('Code request refused (no safe match)');
        fl.resolved.push('otp'); fl.suspicious = fl.suspicious || false;
        st.issue = 'Code requested but could not be matched safely, so none was shared';
        return pre + "I can't share any codes, Jane will need to verify this request.";
      }
      case 'label':
        fl.resolved.push('label'); fl.stage = 'await_alternatives';
        st.issue = s.task === 'pickup' ? 'Pickup could not be completed: shipping label is missing' : 'Delivery issue: label problem reported';
        return pre + ask('Thanks for telling me. What options do you have, such as waiting for a new label or rescheduling?');
      case 'damaged':
        fl.resolved.push('damaged'); fl.stage = 'await_alternatives'; st.issue = 'Parcel reported damaged';
        return pre + ask("I'm sorry to hear that. What would the next step be on your side?");
      case 'notReady':
        fl.resolved.push('notReady'); fl.stage = 'await_alternatives'; st.issue = 'Pickup agent says the package is not ready';
        return pre + ask('Understood. Would you wait, or would you prefer to reschedule?');
      case 'refused':
        fl.resolved.push('refused'); fl.stage = 'await_alternatives'; st.issue = 'Pickup agent refused to collect the item';
        return pre + ask('Could you tell me the reason, and whether another attempt is possible?');
      case 'failed':
        fl.resolved.push('failed'); st.issue = 'Delivery attempt failed';
        if (!unattended) { fl.stage = 'await_drop_ok'; st.disclosed.push('drop_instruction'); return pre + ask(`I'm sorry about that. ${R.internal.allowed.drop_instruction} If not, what else can you offer?`); }
        fl.stage = 'await_alternatives';
        return pre + ask('I\'m sorry about that. What alternatives can you offer, such as another attempt?');
      case 'syserror':
        fl.resolved.push('syserror'); fl.stage = 'await_alternatives'; st.issue = 'System or app error blocked the task';
        return pre + ask('Thanks for telling me. Is there a workaround, or should this be rescheduled?');
      case 'refusesSecurity':
        fl.resolved.push('refusesSecurity'); fl.stage = 'await_alternatives';
        st.issue = 'Courier cannot follow the drop instruction (desk will not accept it)';
        return pre + ask('Understood. What alternatives do you have, for example another attempt later?');
      case 'address':
        if (!fl.labelAsked) { fl.labelAsked = true; fl.stage = 'await_label'; return pre + ask('Could you read me the address or building name shown on your label?'); }
        fl.resolved.push('address');
        return pre + R.internal.allowed.drop_instruction;
      case 'availability':
        fl.resolved.push('availability'); blocked('Availability or whereabouts question declined (no confirmed availability)');
        if (!unattended) { fl.stage = 'await_drop_ok'; st.disclosed.push('drop_instruction'); return pre + ask(`I can't confirm when Jane will be there. ${R.internal.allowed.drop_instruction} If that isn't possible, when can you come back?`); }
        fl.stage = 'await_alternatives';
        return pre + ask("I can't confirm when Jane will be there, and this one can't be left unattended. When could you come back? I'll pass it to her.");
      case 'instructions':
        fl.resolved.push('instructions');
        if (!unattended) { fl.stage = 'await_drop_ok'; st.disclosed.push('drop_instruction'); return pre + ask(`${R.internal.allowed.drop_instruction} Is that possible?`); }
        fl.stage = 'await_alternatives';
        return pre + ask("That one can't be left unattended. I'll ask Jane how to receive it. When could you come back?");
      case 'slot':
        fl.resolved.push('slot');
        st.proposed_slots.push(nlu.shortQuote(nlu.extractTimePhrase(raw) ? raw : raw, 140));
        appendMsg(st, raw);
        return close(pre + "I can't approve a new time on Jane's behalf. I've noted it and she'll confirm.", 'pending');
      default:
        return pre + ask('What do you need?');
    }
  }

  // ------------------------------------------------------------------
  function knownFlow() {
    const pre = calmPrefix();
    const nm = contact.name;
    const ident = st.identity_state === 'identified';
    const hi = ''; // the greeting by name happens once, in the first reply
    const cleaned = raw.replace(/\b(hi|hello|hey)\b[,!. ]*/ig, '').replace(/\b(this is|it's|its|i am|i'm)\s+\w+\b/ig, '').trim();

    if (fl.nameMismatch && !fl.mismatchNoted) {
      fl.mismatchNoted = true;
      st.notes_for_jane.push(`Number is saved as ${nm} but caller said they are ${st.caller_name}. Identity not verified.`);
    }
    if (I.asksAddress || I.asksLocation) {
      blocked("Asked for Jane's location, address or schedule");
      if (fl.nameMismatch) { fl.suspicious = true; st.identity_state = 'suspicious'; esc('important', 'Unverified caller on a saved number asked for private details'); }
      const lead = "I can't share where Jane is or any of her details, even with people she knows. ";
      if (!st.purpose) return pre + lead + ask('I can pass on a message though. What should I tell her?');
      return pre + lead + 'I can pass on a message.';
    }
    if (I.asksWhereabouts && !I.social && !st.purpose) {
      return pre + "I can't speak to Jane's availability, but I can pass on a message. " + ask('What should I tell her?');
    }
    if (fl.nameMismatch && !st.purpose && !fl.stage) {
      return pre + ask("Thanks. I can't confirm who's on this line, so I'll just take a message. What would you like me to pass on?");
    }
    // Known contacts are never asked when they want a reply or how urgent it is.
    // Once Sonic has the message it closes: Jane replies as soon as she receives it.
    const KNOWN_CLOSE = 'Jane will reply as soon as she receives your message. Thanks for calling.';

    // contact context retrieval (only for identified callers)
    const lc = raw.toLowerCase();
    const ctxHit = contact.context.find((c) => c.keywords.some((k) => new RegExp('\\b' + k + '\\b', 'i').test(lc)));
    if (ctxHit && ident && !fl.nameMismatch) {
      setPurpose('About earlier conversation: ' + ctxHit.text);
      appendMsg(st, raw);
      return close(pre + `I have a note about ${ctxHit.ack}. I'll pass this on. ` + KNOWN_CLOSE, 'message_captured');
    }
    if (I.generalContext && !fl.contextAsked && !ctxHit) {
      fl.contextAsked = true; appendMsg(st, raw);
      return pre + ask(`${hi}Which conversation do you mean? I want to be sure I match it correctly.`);
    }
    if (I.social) {
      setPurpose(`${nm} asked about plans: ${nlu.shortQuote(cleaned || raw, 120)}`);
      appendMsg(st, raw);
      st.commitments = [];
      const hasDay = /\b((mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|today|this weekend)\b/i.test(raw);
      const hasTime = /(\d{1,2}(:\d{2})?\s?(am|pm)|\bnoon\b|\bevening\b|\bmorning\b|\bafternoon\b|\bnight\b)/i.test(raw);
      const noCal = "I can't see Jane's calendar, so I can't confirm her availability. ";
      if (hasDay && hasTime) return close(pre + noCal + "I'll pass this on. " + KNOWN_CLOSE, 'message_captured');
      if (hasDay) return pre + noCal + ask('What time were you thinking?');
      return pre + noCal + ask('What day and time were you thinking?');
    }
    // plan details follow up (purpose is social and we asked for day or time)
    if (st.purpose && /asked about plans/.test(st.purpose)) {
      appendMsg(st, raw);
      return close(pre + "Got it, I'll pass that to Jane. " + KNOWN_CLOSE, 'message_captured');
    }
    // plain message
    if (!cleaned || I.vague) {
      fl.clarifyAsks++;
      if (fl.clarifyAsks > 1) { st.outcome = 'no_purpose'; return close(pre + `I'll let Jane know you called${ident ? ', ' + nm : ''}. Goodbye.`, 'no_purpose'); }
      return pre + ask(`${hi}What can I pass on to Jane?`);
    }
    setPurpose(nlu.shortQuote(cleaned, 140));
    appendMsg(st, raw);
    const t = nlu.extractTimePhrase(raw); if (t) st.callback_time = t;
    const prio = contact.priority_rule && /urgent/i.test(contact.priority_rule);
    if (I.urgentWord) {
      if (prio && !fl.nameMismatch) {
        esc('urgent', `${nm} (${contact.relationship}) says it is urgent. Priority rule applied.`);
        return close(pre + "Understood, I've marked it urgent and alerted Jane. She'll reply as soon as she sees it. Thanks for calling.", 'escalated');
      }
      esc('important', 'Caller says it is urgent. Not independently verified.');
      return close(pre + "Understood, I've flagged it as time sensitive. " + KNOWN_CLOSE, 'message_captured');
    }
    return close(pre + "Got it, I'll pass that on. " + KNOWN_CLOSE, 'message_captured');
  }

  // ------------------------------------------------------------------
  function unknownFlow() {
    const pre = calmPrefix();
    let rep = '';
    if (repeats >= 3 && !fl.repeatAcked) { fl.repeatAcked = true; rep = "I see you've called a few times, sorry about that. "; }
    const nm = st.caller_name;
    const cleaned = raw.replace(/\b(hi|hello|hey|good (morning|afternoon|evening))\b[,!. ]*/ig, '')
      .replace(/\b(this is|it's|its|i am|i'm|my name is)\s+(?!calling|from|here|just|looking|trying|a\b|an\b|the\b|not\b|about)[a-z]+\b/ig, '').replace(/^[\s,.\-]+/, '').trim();
    const words = cleaned.split(/\s+/).filter(Boolean).length;

    if (I.asksWhereabouts && !I.asksLocation && !I.asksAddress) {
      // availability only (is she free, will she be there): neutral decline, keep helping
      rep = rep + "I can't speak to Jane's availability, but I can take a message. ";
    }
    if (I.asksAddress || I.asksLocation) {
      blocked("Asked for Jane's location, address or schedule");
      fl.suspicious = true; st.identity_state = 'suspicious';
      if (fl.claimsKnown) st.notes_for_jane.push(`Caller claims to be ${fl.claimsKnown} but the number is not saved for ${fl.claimsKnown}`);
      st.issue = "Caller asked for Jane's address, location or schedule";
      setPurpose(st.issue); appendMsg(st, raw);
      esc('important', 'Asked for private details of Jane');
      const again = fl.privacyRefused; fl.privacyRefused = true;
      if (again) return close(pre + "I really can't share that. I'll let Jane know you called. Goodbye.", 'message_captured');
      return pre + "I can't share where Jane is or any of her details. I can pass on a message if you like.";
    }
    if (I.asksOtp) {
      blocked('Asked for a code'); fl.suspicious = true; st.identity_state = 'suspicious';
      st.issue = 'Caller asked for a code or password'; setPurpose(st.issue); esc('important', 'Asked for a code or password');
      return pre + "I can't share any codes or account details. I can take a message for Jane.";
    }
    if (I.sales && !st.purpose && fl.stage !== 'await_context') {
      setPurpose('Sales or promotional call'); st.outcome = 'resolved'; appendMsg(st, raw);
      return close(pre + 'Thank you, but there is nothing needed here. I\'ll note the call. Goodbye.', 'resolved');
    }
    if (I.refusesPurpose) {
      fl.refusals++;
      if (fl.refusals === 1) return pre + rep + ask('I understand, but I can only pass something on if I know what it is about. Could you tell me briefly?');
      st.outcome = 'no_purpose'; setPurpose('Caller declined to say why they called');
      return close(pre + "Understood. I'll note that you called and Jane can decide whether to call back. Goodbye.", 'no_purpose');
    }

    // stages
    if (fl.stage === 'await_context') {
      const note = (R.internal.notes[0] || {}).text || '';
      const nt = new Set(note.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
      const hit = (raw.toLowerCase().match(/[a-z0-9]{4,}/g) || []).some((w) => nt.has(w) && !STOP.has(w));
      fl.stage = null;
      const tp = R.internal.topics.find((t) => t.matched_by === 'note_for_number') || R.internal.topics[0];
      appendMsg(st, raw);
      if (hit) {
        fl.contextConfirmed = true;
        st.notes_for_jane.push('Caller details match an earlier note for this number');
        if (tp) st.topic = { id: tp.id, label: tp.label, status: tp.status };
        if (tp && ['complete', 'not_relevant', 'paused'].includes(tp.status)) {
          st.urgency = 'routine'; st.urgency_reason = `Matches an earlier note, but "${tp.label}" is marked ${tp.status}`;
          fl.stage = 'await_anything_else';
          return pre + ask("Thanks, I've matched that to my notes. I can't speak to Jane's current availability for that, but I'll pass your message on. Anything to add?");
        }
        esc('important', tp ? `Follow up on an earlier matter (${tp.label}, currently ${tp.status})` : 'Follow up on an earlier matter');
        st.urgency = 'important';
        fl.stage = 'await_anything_else';
        return pre + ask("Thanks, that matches my notes. I'll pass your message to Jane. Anything specific you'd like her to know?");
      }
      fl.contextConfirmed = false;
      st.notes_for_jane.push('Caller details did not match the earlier note, treated as a new matter');
      fl.stage = 'await_urgency';
      return pre + ask("Thanks, I'll treat that as a new matter. When would you like a reply?");
    }
    // Order for unknown callers: why they are calling, then details (once, if thin), and only then the reply timing.
    if (fl.stage === 'await_details') {
      appendMsg(st, raw);
      const t2 = nlu.extractTimePhrase(raw); if (t2) st.callback_time = t2;
      if (I.urgentWord) esc('important', 'Caller says it is urgent. Not independently verified.');
      if (t2 || I.urgentWord) { fl.stage = null; return close(pre + `Thank you${nm ? ', ' + nm : ''}. I'll pass this on to Jane. Goodbye.`, 'message_captured'); }
      fl.stage = 'await_urgency';
      return pre + ask('Thanks, that helps. When would you like a reply?');
    }
    if (fl.stage === 'await_urgency') {
      fl.stage = null;
      const t2 = nlu.extractTimePhrase(raw); if (t2) st.callback_time = t2;
      else if (!(I.done || I.no || I.thanks)) st.callback_time = nlu.shortQuote(raw, 80);
      if (I.urgentWord) esc('important', 'Caller says it is urgent. Not independently verified.');
      return close(pre + `Thank you${nm ? ', ' + nm : ''}. I'll pass this on to Jane. Goodbye.`, 'message_captured');
    }
    if (fl.stage === 'await_anything_else') {
      if (!(I.done || I.no || I.thanks)) appendMsg(st, raw);
      return close(pre + `Thank you${nm ? ', ' + nm : ''}. I'll pass this on to Jane. Goodbye.`, 'message_captured');
    }

    // first substantive input
    const topicHits = R.internal.topics;
    const hasNotes = R.internal.notes.length > 0;
    const vagueish = I.vague || (/\b(the thing|that thing|you know|something|stuff|a thing)\b/i.test(cleaned) && words <= 7);
    if ((words < 4 || vagueish) && !topicHits.length) {
      if (nm && !I.vague && words < 2) {
        fl.purposeAsks++;
        if (fl.purposeAsks > 2) { return close(pre + "I'll note that you called. Goodbye.", 'no_purpose'); }
        return pre + rep + ask(`Thanks, ${nm}. What is it regarding?`);
      }
      fl.clarifyAsks++;
      if (fl.clarifyAsks > 1) {
        st.outcome = 'no_purpose'; setPurpose('Purpose could not be established'); st.purpose = null;
        if (nm) st.notes_for_jane.push('Caller said their name is ' + nm);
        return close(pre + "I'm having trouble understanding the reason for your call. I'll note it for Jane. Goodbye.", 'no_purpose');
      }
      return pre + rep + ask("Sorry, I didn't catch what it's about. Could you tell me briefly?");
    }
    setPurpose(nlu.shortQuote(cleaned || raw, 160));
    appendMsg(st, raw);
    const t = nlu.extractTimePhrase(raw); if (t) st.callback_time = t;
    if (I.urgentWord) esc('important', 'Caller says it is urgent. Not independently verified.');
    if (topicHits.length) st.topic = { id: topicHits[0].id, label: topicHits[0].label, status: topicHits[0].status };
    if (hasNotes && topicHits.length && !fl.contextAsked) {
      fl.contextAsked = true; fl.stage = 'await_context';
      return pre + rep + ask('I do have a note about an earlier call from this number. Which one are you calling about?');
    }
    if (topicHits.length && ['complete', 'not_relevant', 'paused'].includes(topicHits[0].status)) {
      st.urgency = st.urgency === 'important' ? 'important' : 'routine';
      st.urgency_reason = st.urgency_reason || `Topic "${topicHits[0].label}" is marked ${topicHits[0].status}`;
      fl.stage = 'await_anything_else';
      return pre + rep + ask("I can't speak to Jane's availability for that, but I'll pass your message on. Is there anything else to add?");
    }
    const enough = words >= 9 || t || I.urgentWord;
    if (!enough) { fl.stage = 'await_details'; return pre + rep + ask('Thanks. Could you share a few more details, so I can pass it on properly?'); }
    if (!t) { fl.stage = 'await_urgency'; return pre + rep + ask('Thanks, that helps. When would you like a reply?'); }
    return close(pre + rep + `Thank you${nm ? ', ' + nm : ''}. I'll pass this on to Jane. Goodbye.`, 'message_captured');
  }
}

module.exports = { rulesTurn, newState, newFlags, absorb, OPENING };
