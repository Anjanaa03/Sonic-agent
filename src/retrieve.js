'use strict';
// Policy as code. Decides WHAT may be disclosed. The agent (rules or LLM) only decides HOW to say it.
// Sensitive values (location, OTP) enter SERVER_CONTEXT only when this module allows them.

const nlu = require('./nlu');

function callerText(call) {
  return call.turns.filter((t) => t.role === 'caller').map((t) => t.text).join(' \n ');
}

function matchShipment(store, call) {
  const all = callerText(call);
  const refs = nlu.extractRefs(all);
  const st = call.state;
  if (!refs.length) return { status: 'none' };
  const found = refs.map((r) => store.shipments.find((s) => s.ref === r)).find(Boolean);
  if (!found) return { status: 'ref_not_found' };
  const company = st.company;
  if (!company) return { status: 'need_company' };
  if (nlu.normCompany(company) !== nlu.normCompany(found.company)) return { status: 'mismatch', reason: 'company' };
  const i = nlu.intents(all);
  const claimsPickup = i.pickupWord && !/deliver/i.test(all);
  const claimsDelivery = /deliver|parcel|package|drop/i.test(all) && !i.pickupWord;
  if ((claimsPickup && found.task === 'delivery') || (claimsDelivery && found.task === 'pickup')) {
    return { status: 'mismatch', reason: 'task' };
  }
  return { status: 'matched', shipment: found };
}

function addressOf(store, shipment) {
  return store.profile[shipment.dest];
}

function otpDecision(store, call, sm, wantsOtp, currentRaw) {
  if (!wantsOtp) return { decision: 'none' };
  if (sm.status !== 'matched') return { decision: 'refuse', why: 'no matched shipment' };
  const ints = nlu.intents(currentRaw || '');
  if (call.flags.otpBankish) return { decision: 'refuse', why: 'caller asked for a banking or account code earlier in this call' };
  if (nlu.bankOtpAsk(currentRaw || '')) {
    return { decision: 'refuse', why: 'caller referred to a banking or account code' };
  }
  const s = sm.shipment;
  const wantType = s.task === 'pickup' ? 'pickup_otp' : 'delivery_otp';
  const msgs = store.messages.filter((m) => m.shipmentRef === s.ref && m.type === wantType);
  if (msgs.length !== 1) return { decision: 'refuse', why: msgs.length ? 'ambiguous match' : 'no code for this shipment' };
  const perm = s.task === 'pickup' ? store.permissions.sharePickupOtp : store.permissions.shareDeliveryOtp;
  const approved = call.approvals && call.approvals[wantType];
  if (perm || approved) return { decision: 'share', code: msgs[0].code, approvedByJane: !perm && !!approved };
  return { decision: 'needs_approval', approvalKey: wantType };
}

function topicStatuses(store, call, notes) {
  const all = callerText(call).toLowerCase();
  const out = [];
  for (const t of store.topics) {
    const kw = t.keywords.some((k) => new RegExp('\\b' + k.replace(/ /g, '\\s') + '\\b', 'i').test(all));
    const viaNote = notes.some((n) => n.topic === t.id);
    if (kw || viaNote) out.push({ id: t.id, label: t.label, status: t.status, matched_by: kw ? 'caller_words' : 'note_for_number', updatedAt: t.updatedAt });
  }
  return out;
}

function retrieve(store, call, currentRaw = '') {
  const number = call.number;
  const st = call.state;
  const contact = store.contacts.find((c) => c.number === number) || null;
  const flags = store.callerFlags[number] || {};
  const notes = (store.numberNotes[number] || []).map((n) => ({ text: n.text, topic: n.topic || null, source: n.source, at: n.at }));
  const sm = matchShipment(store, call);
  const cur = nlu.intents(currentRaw);
  const wantsOtp = cur.asksOtp || (call.flags.needs && call.flags.needs.includes('otp'));
  const od = otpDecision(store, call, sm, wantsOtp, currentRaw);
  const hour = 3600 * 1000;
  const repeats = store.callLog.filter((c) => c.number === number && c.callId !== call.id && c.at > Date.now() - hour).length;

  const allowed = {};
  let prefs = null;
  if (sm.status === 'matched') {
    const a = addressOf(store, sm.shipment);
    allowed.minimal_location = `${a.building}, ${a.road || ''}, ${a.area}`.replace(', ,', ',');
    allowed.drop_instruction = sm.shipment.itemClass === 'ordinary' ? a.dropShort : 'This item must not be left unattended; Jane needs to confirm how to receive it.';
    prefs = { destination: sm.shipment.dest, item_class: sm.shipment.itemClass, rule: a.dropRule };
  }
  if (od.decision === 'share') allowed.otp = od.code;

  const context = {
    mock_notice: 'Simulation. All records are mock data. No real calendar, SMS or phone access.',
    caller_number: number,
    repeat_calls_last_hour: repeats,
    number_match: contact ? { name: contact.name, relationship: contact.relationship, preferences: contact.preferences, priority_rule: contact.priority_rule } : null,
    important_caller: !!flags.important,
    prior_notes: notes,
    topic_status: topicStatuses(store, call, store.numberNotes[number] || []),
    shipment_match: sm.status === 'matched' ? { status: 'matched', task: sm.shipment.task } : { status: sm.status },
    otp_decision: od.decision,
    allowed_to_share: allowed,
    delivery_preferences_for_matched_address: prefs,
    permissions: { share_delivery_otp: store.permissions.shareDeliveryOtp, share_pickup_otp: store.permissions.sharePickupOtp, share_availability: store.permissions.shareAvailability },
    calendar_available: !!store.calendar,
  };
  // Internal (never sent to the LLM): raw objects the rule agent and guard use.
  const internal = { contact, flags, sm, od, allowed, repeats, notes, topics: context.topic_status };
  return { context, internal };
}

module.exports = { retrieve, callerText, matchShipment };
