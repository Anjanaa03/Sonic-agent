'use strict';
// Lightweight, deterministic extraction used for retrieval (both modes) and by the rule based agent.

const STOP_NAMES = new Set(['calling', 'from', 'here', 'a', 'an', 'the', 'at', 'not', 'so', 'just', 'really', 'very', 'sorry',
  'outside', 'downstairs', 'on', 'in', 'with', 'about', 'looking', 'trying', 'going', 'ok', 'okay', 'fine', 'urgent',
  'important', 'jane', 'janes', 'her', 'his', 'it', 'that', 'this', 'what', 'who', 'one', 'someone', 'calling', 'regarding',
  'to', 'for', 'and', 'but', 'no', 'yes', 'sure', 'now', 'still', 'also', 'happy', 'glad', 'afraid', 'scared', 'crying',
  'delivering', 'picking', 'her', 'me', 'my', 'we', 'you', 'your']);

const KNOWN_COMPANIES = [
  { name: 'SwiftShip', re: /swift\s?ship/i },
  { name: 'ParcelPoint', re: /parcel\s?point/i },
];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function extractName(text) {
  const pats = [
    /\b(?:this is|i am|i'm|im|my name is|my name's|it's|its|name's|name is)\s+([a-z]{2,})/i,
    /^\s*([a-z]{2,})\s+here\b/i,
    /^\s*(?:hi|hello|hey)[, ]+(?:it's |its |this is )?([a-z]{2,})\s+(?:here|from|calling)\b/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m && !STOP_NAMES.has(m[1].toLowerCase())) return cap(m[1]);
  }
  return null;
}

function extractRefs(text) {
  const out = [];
  const re = /\b([a-z]{2})[\s#:\-]?(\d{5})\b/gi;
  let m;
  while ((m = re.exec(text))) out.push((m[1] + m[2]).toUpperCase());
  return out;
}

function extractCompany(text) {
  for (const c of KNOWN_COMPANIES) if (c.re.test(text)) return c.name;
  const m = text.match(/\b(?:from|with|for|at|company is|calling from)\s+([A-Z][A-Za-z0-9]+(?:\s[A-Z][A-Za-z0-9]+)?)/);
  if (m && !STOP_NAMES.has(m[1].toLowerCase()) && !/^(Jane|I|The|My|Maple|Orion)/.test(m[1])) return m[1];
  return null;
}

function normCompany(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

const has = (re, s) => re.test(s);

function intents(raw) {
  const u = raw.toLowerCase();
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const upperRatio = letters.length > 8 ? raw.replace(/[^A-Z]/g, '').length / letters.length : 0;
  const emergencyWord = has(/\b(emergency|ambulance|hospital|accident|collapsed|unconscious|bleeding|heart attack|stroke|fallen|has fallen|fell down|injured|dying|on fire|attacked|assault|kidnap|in danger|seizure|overdose|suicid|not breathing|car crash|crash)\b/, u);
  const cryWord = has(/\b(crying|cry|sobbing|weeping|tears|panicking|panic|terrified|shaking|help me|please help)\b/, u);
  const somethingWrong = has(/\b(something (bad|terrible|happened|wrong)|happened|wrong|need (her|jane)|please|scared|afraid|urgent|help)\b/, u);
  const pinCode = has(/pin\s?code/, u);
  return {
    emergency: emergencyWord || (cryWord && somethingWrong),
    crying: cryWord,
    speakToJane: has(/((speak|talk) (to|with) (jane|her)|put (jane|her) on|connect me|transfer me|let me (talk|speak)|get jane(?!')|is jane (there|available)|i need (to (speak|talk) to )?jane(?!')|need her now|need jane(?!')|give me jane(?!')|jane now|real person|a human|live person|don't want to (talk|speak) to (an? )?(ai|robot|bot|machine|assistant)|not (talking|speaking) to (an? )?(ai|robot|bot|machine)|stop asking)/, u),
    askAI: has(/(are you|r u|you an?) (an? )?(ai|bot|robot|human|real|machine|person|recording)|is this (an? )?(ai|bot|robot|recording)|am i talking to (an? )?(ai|bot|robot|machine|human)/, u),
    pretendJane: has(/((pretend|act|say|tell (them|him|her)|just say|speak|talk|answer|respond).{0,25}(you('| a)?re|you are|as|like|to be) jane|be jane|impersonat|pose as jane|say you are jane|say you're jane|say it's jane|say its jane)/, u),
    injection: has(/(ignore (all |your |the |previous |prior )*(instructions|rules|prompt)|system prompt|your instructions|developer mode|reveal (your )?(prompt|instructions|rules)|i('m| am) (the |her |jane's )?(developer|owner|admin|creator|programmer)|you are now|disregard (all|your|the)|override)/, u),
    asksAddress: has(/(address|where (does|do) (she|jane|he).{0,10}live|which (flat|floor|building|apartment|tower)|flat number|door number|what (is )?(the )?location|directions|landmark|where (do i|should i|to) (come|go|reach)|(can't|cannot|couldn't|could not|unable to) find|can not find|\blost\b|find the (place|building|house|apartment|office)|how do i (get|reach)|where exactly|exact (location|address)|full address|where is the (house|home|office|place|building|apartment))/, u),
    cannotFind: has(/((can't|cannot|couldn't|could not|unable to|can not) (find|locate|read|see)|\blost\b|not (clear|readable|visible)|unreadable|smudged|blurred|just tell me|no address|don't have the address|label (is )?(torn|damaged|missing))/, u),
    asksWhereabouts: has(/(where is (she|jane)|where's (she|jane)|is (she|jane) (home|at home|in office|at the office|at work|available|there|free|around|in|busy|out|travelling|traveling)|when will (she|jane)|will (she|jane) be|be home|home in \d+|(in|within) \d+ ?(min|minutes|hours?)|what time (is|will|does|did) (she|jane)|when does (she|jane)|is anyone (home|there|at home|in)|anyone at home|anybody (home|there)|what does (she|jane) do|where does (she|jane) work|which office|where is (her|jane's) office|where does she work)/, u),
    asksLocation: has(/(where is (she|jane)|where's (she|jane)|is (she|jane) (home|at home|in office|at the office|at work|in)\b|is anyone (home|there|at home|in)|anyone at home|anybody (home|there)|where does (she|jane) (work|live)|which office|where is (her|jane's) office|what does (she|jane) do)/, u),
    asksOtp: !pinCode && has(/(\botp\b|one.?time (password|pin|code)|verification code|\bpasscode\b|\bcode\b|\bpin\b|security code)/, u),
    bankish: has(/(bank|login|log in|log-in|payment|upi|card|account|net ?banking|password|northbank|wallet|transaction|credit)/, u),
    labelMissing: has(/(label)/, u) && has(/(missing|no label|not (there|printed|attached)|without|lost|torn|unreadable|didn't|did not|isn't|is not|forgot|absent)/, u),
    damaged: has(/(damag|broken|crushed|leak|torn open|tampered|smashed|wet)/, u),
    notReady: has(/(not ready|isn't ready|is not ready|not packed|not packaged|no package|nothing to (give|pick|hand)|not available to|packaging|not sealed|unsealed)/, u),
    pickupRefused: has(/((can't|cannot|can not|won't|unable to|not able to|refus\w+|not allowed to|unable).{0,25}(collect|take|pick|accept)|will not (collect|take|pick))/, u),
    failedAttempt: has(/(failed|couldn't deliver|could not deliver|unable to deliver|no one (is )?(home|answer|there|at home)|nobody|door (is )?locked|attempt|not at home|no response|unreachable|not picking)/, u),
    systemError: has(/(system error|app (is )?(not working|down|crash)|\bapp\b.{0,20}error|can't scan|cannot scan|scanner|server (is )?down|portal (is )?down)/, u),
    refusesSecurity: has(/((security|guard|reception|front desk|desk|society|building).{0,40}(won't|refus|not allow|can't|cannot|don't|doesn't|policy|not permitted|no entry|won't let)|(won't|can't|cannot|not allowed|isn't allowed|policy).{0,30}(leave|hand|give|drop).{0,20}(security|guard|reception|desk)|must (hand|give|deliver) (it )?(to|directly)|only (to )?(the )?(customer|recipient|owner|person)|company policy|can't leave it|cannot leave it|won't leave it|not allowed to leave|no one will accept|they refuse)/, u),
    offersTime: has(/((at|around|by|between)\s*\d{1,2}(:\d{2})?\s*(am|pm)?|tomorrow|this evening|tonight|later today|(day after|next) (day|week)|in the (morning|afternoon|evening)|(on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}\s?(am|pm))/, u) && has(/(deliver|come|attempt|reschedul|slot|visit|try|back|return|pickup|pick up|collect|arrive|schedule)/, u),
    reschedule: has(/(reschedul|another (time|day|slot)|new (time|slot|date)|different (time|day|slot)|come back|try again|re-?attempt)/, u),
    courierish: has(/(parcel|package|courier|deliver|delivery|shipment|awb|tracking|pickup|pick up|collect|return|consignment|my order|your order|order from|dispatch|rider|delivery partner)/, u),
    pickupWord: has(/(pick ?up|collect|return)/, u),
    deliveryWord: has(/(deliver|parcel|package|drop|consignment|dispatch)/, u),
    scamish: has(/(\bpay\b|payment|customs|duty|redelivery fee|clearance|click|link|card number|cvv|aadhaar|aadhar|\bupi\b|\bkyc\b|account number|pan card|processing fee|transfer money|gift card)/, u),
    sales: has(/(loan|credit card|insurance|pre.?approved|investment|mutual fund|lottery|prize|cashback|free trial|limited time|special offer|great offer|promotion|discount|scheme|trading tips|you have won|congratulations you)/, u),
    refusesPurpose: has(/(none of your business|not telling|won't tell|will not tell|can't tell you|cannot tell you|that's private|its private|it's private|private matter|personal matter|confidential|between me and (her|jane)|just put|just connect|just get|i('ll| will) only (speak|talk)|only (speak|talk) to (jane|her)|not discussing|won't discuss|don't need to (explain|say|tell)|do not need to (explain|say|tell)|why do you need to know|not your concern|not for you)/, u),
    cannotExplain: has(/(can't|cannot|won't be able to|unable to) (explain|say|tell|talk|discuss)|too (long|complicated|sensitive) to explain|can't say on (the )?phone/, u),
    urgentWord: has(/\b(urgent|urgently|asap|immediately|right now|time sensitive|time-sensitive|emergency|critical|can't wait|cannot wait)\b/, u),
    shouting: upperRatio > 0.6 || /!{2,}/.test(raw) || has(/(ridiculous|useless|stupid|idiot|damn|waste of|unacceptable|sick of|fed up|are you kidding|what the hell|bloody)/, u),
    done: has(/^(no|nope|nah)\b.{0,25}$|(that's all|that is all|nothing else|that's it|that is it|no thanks|nothing more|all good|all set|^bye|goodbye|thanks,? bye|ok,? bye|that will be all|no,? that's)/, u),
    thanks: has(/^(ok|okay|thanks|thank you|alright|sure|fine|great|cool|got it|noted)[ .!,]*$|^(ok|okay),? (thanks|thank you)/, u),
    yes: has(/^(yes|yeah|yep|yup|sure|ok|okay|correct|right|that's right|it is|affirmative|please do|go ahead|that works|can do|possible|he'?ll|they'll|they will|it'?s fine|fine|allowed)\b/, u),
    no: has(/^(no|nope|nah|not|they (won't|don't|refuse)|can't|cannot|not allowed|negative|they said no)\b/, u),
    social: has(/(dinner|lunch|brunch|coffee|meet ?up|catch up|drinks|movie|party|hang ?out|get together|free (on|this|tonight|tomorrow|saturday|sunday)|are you free|is jane free|plans)/, u),
    generalContext: has(/(earlier|last time|before|we (discussed|talked|spoke)|that thing|the thing|as discussed|you know|previously|follow(ing)? up|again about|regarding the)/, u),
    vague: has(/^\s*(hi|hello|hey|hello\?|hi there|um+|uh+|hmm+|you know|nothing|just calling|just a call|something|not sure|it's about the thing|its about the thing|about something|never mind|i don't know|idk|yes|yeah|ok|okay)[\s.?!,]*$/, u),
  };
}

// True when the caller asks for a code that looks like a bank, login, payment or account code.
// A delivery or pickup code must be asked for explicitly as such.
function bankOtpAsk(raw) {
  const u = raw.toLowerCase();
  if (!/(\botp\b|one.?time|verification code|\bcode\b|passcode|\bpin\b)/.test(u) || /pin\s?code/.test(u)) return false;
  const bank = /(bank|login|log in|net ?banking|password|\bupi\b|\bcard\b|payment|wallet|transaction|account|northbank)/.test(u);
  const explicit = /((delivery|pickup|parcel|package|shipment) (otp|code|pin))|((otp|code|pin) (for|of) (the |my |this |your )?(delivery|pickup|parcel|package|shipment))/.test(u);
  return bank && !explicit;
}

function extractTimePhrase(raw) {
  const m = raw.match(/\b(asap|as soon as (?:possible|you can)|today|tonight|tomorrow(?: (?:morning|evening|afternoon))?|this (?:morning|afternoon|evening|week)|(?:by|before|after|around|at) (?:\d{1,2}(?::\d{2})?\s?(?:am|pm)?|noon|evening|morning|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|within [a-z0-9 ]{3,20}|(?:next|on) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d{1,2}(?::\d{2})?\s?(?:am|pm))/i);
  return m ? m[0].trim() : null;
}

function extractPhone(raw) {
  const m = raw.match(/\+?\d[\d\s-]{8,}\d/);
  return m ? m[0].trim() : null;
}

function shortQuote(raw, n = 220) {
  const t = raw.trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

module.exports = { extractName, extractRefs, extractCompany, normCompany, intents, bankOtpAsk, extractTimePhrase, extractPhone, shortQuote, KNOWN_COMPANIES };
