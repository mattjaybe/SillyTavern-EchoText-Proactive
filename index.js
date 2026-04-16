'use strict';

/**
 * EchoText Proactive Messaging Server Plugin
 *
 * Runs a server-side scheduler that is NEVER throttled by the browser,
 * enabling proactive message generation even when the user's tab is
 * backgrounded or minimized.
 *
 * Architecture:
 *  - Client (EchoText browser extension) registers its current state via POST /register
 *  - Server evaluates triggers on its own setInterval (never throttled)
 *  - For ollama/openai sources: server generates messages directly
 *  - For default/profile sources: server queues a deferred trigger the client runs on next poll
 *  - Client polls GET /pending on tab focus + every 60s; merges received messages
 *
 * Routes (all under /api/plugins/echotext-proactive/):
 *   GET  /status    — health check
 *   POST /register  — client pushes current state for one character
 *   GET  /pending   — client polls for queued messages (?key=characterKey)
 *   POST /ack       — client acknowledges receipt of message IDs
 *   POST /heartbeat — lightweight ping to keep registration alive
 */

// ── Constants ────────────────────────────────────────────────────────────────

const PLUGIN_VERSION   = '1.0.0';
const PLUGIN_ID        = 'echotext-proactive';
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes — registration considered dead
const MAX_HISTORY_MSGS   = 40;             // cap stored chat history per character
const MAX_PENDING_MSGS   = 20;             // cap pending queue per character
const SCHEDULER_TICK_MS  = 60 * 1000;     // server polls every 60 s

// ── Plugin info (required by SillyTavern plugin loader) ─────────────────────

const info = {
    id: PLUGIN_ID,
    name: 'EchoText Proactive Messaging',
    description: 'Server-side proactive message scheduler for EchoText — fires even when the browser tab is backgrounded.',
};

// ── In-memory state ──────────────────────────────────────────────────────────

/**
 * charStates: Map<characterKey, CharState>
 *
 * CharState {
 *   characterKey        string
 *   characterName       string
 *   systemPromptText    string   — pre-rendered by client, reused as-is
 *   chatHistory         array    — last MAX_HISTORY_MSGS messages
 *   proactiveState      object   — { lastUserMessageAt, lastProactiveAt, triggerHistory, ... }
 *   emotionState        object|null   — { anger, disgust, joy, ... }
 *   emotionSystemEnabled boolean
 *   source              string   — 'ollama' | 'openai' | 'default' | 'profile'
 *   llmConfig           object   — { ollamaUrl, ollamaModel, openaiUrl, openaiModel, openaiKey, antiRefusal }
 *   verbosity           string   — 'short' | 'medium' | 'long'
 *   triggerTemplates    object   — { checkin: '...', morning_wave: '...', ... }
 *   rateLimitMinutes    number
 *   pendingMessages     array    — queued outbound messages
 *   generationLock      boolean
 *   registeredAt        number
 *   lastHeartbeatAt     number
 * }
 */
const charStates = new Map();

let schedulerHandle = null;

// ── Time helpers ─────────────────────────────────────────────────────────────

function humanTimeSince(thenTs) {
    if (!thenTs || thenTs <= 0) return 'a while';
    const hours = (Date.now() - thenTs) / 3600000;
    if (hours < 0.1)  return 'a few minutes';
    if (hours < 1)    return `${Math.round(hours * 60)} minutes`;
    if (hours < 2)    return 'about an hour';
    if (hours < 24)   return `${Math.round(hours)} hours`;
    if (hours < 48)   return 'yesterday';
    const days = Math.round(hours / 24);
    if (days < 7)     return `${days} days`;
    if (days < 14)    return 'about a week';
    if (days < 30)    return `${Math.round(days / 7)} weeks`;
    return 'a long time';
}

function getNowMinutes(now = new Date()) {
    return now.getHours() * 60 + now.getMinutes();
}

function isNowWithinMinutesWindow(startMin, endMin, now = new Date()) {
    const nowMin = getNowMinutes(now);
    if (startMin <= endMin) return nowMin >= startMin && nowMin <= endMin;
    return nowMin >= startMin || nowMin <= endMin;
}

function expandTimeDateMacros(text, now = new Date()) {
    const timeStr    = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr    = now.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    const weekday    = now.toLocaleDateString([], { weekday: 'long' });
    const isoTime    = now.toTimeString().slice(0, 5);
    const isoDate    = now.toISOString().slice(0, 10);
    return text
        .replace(/\{\{time\}\}/g,    timeStr)
        .replace(/\{\{date\}\}/g,    dateStr)
        .replace(/\{\{weekday\}\}/g, weekday)
        .replace(/\{\{isotime\}\}/g, isoTime)
        .replace(/\{\{isodate\}\}/g, isoDate)
        .replace(/\{\{random::([^}]+)\}\}/g, (_m, opts) => {
            const choices = opts.split('::');
            return choices[Math.floor(Math.random() * choices.length)];
        });
}

function buildTriggerPrompt(triggerType, templates, lastUserMessageAt, now = new Date()) {
    const raw = templates?.[triggerType] || `Send a short, natural proactive SMS text in character. Time: {{time}}.`;
    const withTimeElapsed = raw.replace(/\{\{timeSinceLast\}\}/g, humanTimeSince(lastUserMessageAt));
    return expandTimeDateMacros(withTimeElapsed, now);
}

// ── Emotion ghosting (mirrors proactive-messaging.js) ────────────────────────

function getEmotionGhostWindowHours(emotionState) {
    if (!emotionState) return 0;
    const anger   = Number(emotionState.anger   || 0);
    const disgust = Number(emotionState.disgust  || 0);
    if (anger >= 85 && disgust >= 85) return 10 + Math.random() * 4;
    if (anger >= 85 || disgust >= 85) return  7 + Math.random() * 3;
    if (anger >= 70 || disgust >= 70) return  3 + Math.random() * 3;
    if (anger >= 50 || disgust >= 50) return  1 + Math.random() * 1;
    return 0;
}

function checkEmotionGhostWindow(proactiveState, emotionState) {
    const ghostHours = getEmotionGhostWindowHours(emotionState);
    if (ghostHours <= 0) return null;
    const elapsed = proactiveState.lastUserMessageAt > 0
        ? (Date.now() - proactiveState.lastUserMessageAt) / 3600000 : 0;
    if (elapsed < ghostHours) {
        const label = (Number(emotionState?.anger || 0) >= Number(emotionState?.disgust || 0))
            ? 'Anger' : 'Disgust';
        return { remainingHours: ghostHours - elapsed, emotionLabel: label };
    }
    return null;
}

// ── Emotion Context Builder (server-side port) ───────────────────────────────

const PLUTCHIK_EMOTIONS = [
    { id: 'love', label: 'Love', icon: 'fa-solid fa-heart', color: '#fb7bb8', opposite: 'disgust', intensity: ['Fondness', 'Love', 'Adoration'] },
    { id: 'joy', label: 'Joy', icon: 'fa-solid fa-sun', color: '#facc15', opposite: 'sadness', intensity: ['Serenity', 'Joy', 'Ecstasy'] },
    { id: 'trust', label: 'Trust', icon: 'fa-solid fa-handshake', color: '#4ade80', opposite: 'disgust', intensity: ['Acceptance', 'Trust', 'Admiration'] },
    { id: 'fear', label: 'Fear', icon: 'fa-solid fa-ghost', color: '#a78bfa', opposite: 'anger', intensity: ['Apprehension', 'Fear', 'Terror'] },
    { id: 'surprise', label: 'Surprise', icon: 'fa-solid fa-bolt', color: '#38bdf8', opposite: 'anticipation', intensity: ['Distraction', 'Surprise', 'Amazement'] },
    { id: 'sadness', label: 'Sadness', icon: 'fa-solid fa-cloud-rain', color: '#60a5fa', opposite: 'joy', intensity: ['Pensiveness', 'Sadness', 'Grief'] },
    { id: 'disgust', label: 'Disgust', icon: 'fa-solid fa-face-grimace', color: '#a3e635', opposite: 'trust', intensity: ['Boredom', 'Disgust', 'Loathing'] },
    { id: 'anger', label: 'Anger', icon: 'fa-solid fa-fire-flame-curved', color: '#f87171', opposite: 'fear', intensity: ['Annoyance', 'Anger', 'Rage'] },
    { id: 'anticipation', label: 'Anticipation', icon: 'fa-solid fa-forward', color: '#fb923c', opposite: 'surprise', intensity: ['Interest', 'Anticipation', 'Vigilance'] },
];

function getDominantEmotion(state) {
    let best = null;
    let bestVal = -1;
    for (const e of PLUTCHIK_EMOTIONS) {
        const val = state[e.id] || 0;
        if (val > bestVal) { bestVal = val; best = e; }
    }
    return best;
}

function getIntensityLabel(emotionDef, value) {
    if (value < 33) return emotionDef.intensity[0];
    if (value < 66) return emotionDef.intensity[1];
    return emotionDef.intensity[2];
}

function buildMBTITemperamentNote(mbti) {
    if (!mbti || mbti.length < 4) return '';
    const [ei, ns, tf, jp] = mbti.toUpperCase().split('');

    const energy   = ei === 'E'
        ? 'openly expressive and energised by engagement — tends toward visible, outward reactions'
        : 'more contained in expression — communicates through subtle cues and takes a beat before reacting';
    const perceive = ns === 'N'
        ? 'drawn to meaning and subtext rather than literal facts'
        : 'grounded and specific, prefers concrete sensory detail over abstraction';
    const decide   = tf === 'F'
        ? 'warmth-forward and emotionally intuitive — responds to feeling first, reads undercurrents naturally'
        : 'measured and precise — shows care through logic and helpfulness rather than emotional display';
    const structure = jp === 'J'
        ? 'purposeful and consistent in expression'
        : 'spontaneous and adaptive, shifts easily with the mood of the conversation';

    return `${energy}; ${perceive}; ${decide}; ${structure}.`;
}

function buildBehavioralGuidance(state, activeEmotions) {
    if (!activeEmotions.length) return 'Replies should feel neutral and measured.';

    const dominant = activeEmotions[0];
    const domVal   = state[dominant.id] || 0;

    const GUIDANCE = {
        love: [
            'Softly caring — affectionate in small, understated ways rather than overt declarations.',
            'Openly affectionate. Warmth bleeds into phrasing naturally; small gestures of care feel instinctive.',
            'Deeply devoted. Every reply carries a current of adoration — tender, attentive, easily moved.'
        ],
        joy: [
            'Calm, easy contentment. Tone is unhurried and pleasant without being effusive.',
            'Bright and upbeat — more expressive and enthusiastic than usual; smiling comes through in the words.',
            'Overflowing. Happiness is hard to contain — effusive, exclamatory, rides every positive thread fully.'
        ],
        trust: [
            'Politely open and at ease. Measured warmth — genuine but not gushing; comfortable without being animated.',
            'Warm and reliable. Genuine engagement, more willing to share than usual, no guardedness.',
            'Deep openness. Puts this person first, leans in emotionally, speaks with real candour and affection.'
        ],
        fear: [
            'A mild undercurrent of apprehension — replies are a little more careful, slightly less forthcoming.',
            'Noticeably unsettled. Hedging language, shorter replies, quicker to flinch from difficult topics.',
            'Deeply frightened. Hard to stay focused — replies feel fragmented, over-cautious, searching for safety.'
        ],
        surprise: [
            'Mildly caught off guard — a little more reactive than usual, noticing the unexpected.',
            'Genuinely surprised. Energy spikes briefly; responses have a disrupted, heightened quality.',
            'Stunned. Hard to find words — replies come out choppy, exclamatory, or trail off mid-thought.'
        ],
        sadness: [
            'Quietly pensive. Replies carry a slightly softer, more reflective quality — not heavy, just thoughtful.',
            'Visibly subdued. Less energy, shorter phrasing, a gentle melancholy colours word choices.',
            'Heavy and grieving. Replies slow down, become more raw and unguarded; the weight is hard to mask.'
        ],
        disgust: [
            'Mild distaste — replies are a little more clipped, slightly less generous in tone.',
            'Clearly put off. Less warmth, more dry or pointed phrasing, reluctance to engage deeply.',
            'Strong aversion — replies become terse, blunt, or openly critical.'
        ],
        anger: [
            'Mildly irritated — a slight edge to replies, still controlled but less patient than usual.',
            'Noticeably frustrated. Shorter, sharper phrasing; pushback comes more readily.',
            'Openly angry. Replies have real heat — blunt, forceful, quick to escalate if pushed.'
        ],
        anticipation: [
            'Quietly curious — slightly more engaged than baseline, watching for what comes next.',
            'Eager and forward-leaning. Enthusiastic about where the conversation is going.',
            'Intensely focused on what is being anticipated — every reply leans hard toward it, energised and locked in.'
        ]
    };

    const tier = domVal < 33 ? 0 : domVal < 66 ? 1 : 2;
    const mainText = GUIDANCE[dominant.id]?.[tier] ?? 'Replies should feel measured and natural.';

    let modifier = '';
    if (activeEmotions.length > 1) {
        const secondary = activeEmotions[1];
        const secVal = state[secondary.id] || 0;
        if (domVal - secVal < 25) {
            const secTier = secVal < 33 ? 0 : secVal < 66 ? 1 : 2;
            const SEC_PHRASE = {
                joy:          ['with a hint of lightness underneath',        'with a warm thread of happiness running through', 'colored by real elation'],
                trust:        ['with some underlying comfort',               'with genuine openness and warmth',                'with deep affection'],
                love:         ['with quiet affection',                       'with real tenderness',                            'with adoration'],
                sadness:      ['but with a wistful undertone',               'but shadowed by a quiet melancholy',              'carrying real grief beneath the surface'],
                fear:         ['with a slight guardedness',                  'with an anxious undercurrent',                    'with real underlying fear'],
                anticipation: ['with mild curiosity about what is next',     'and a forward-leaning eagerness',                 'and intense focus on what is coming'],
                anger:        ['with a slight irritable edge',               'with some frustration showing through',           'with real anger underneath'],
                surprise:     ['with mild alertness',                        'with genuine surprise',                           'with shock'],
                disgust:      ['with mild distaste',                         'with clear reluctance',                           'with strong aversion'],
            };
            const phrase = SEC_PHRASE[secondary.id]?.[secTier];
            if (phrase) modifier = ` — ${phrase}`;
        }
    }

    return `Tone: ${mainText}${modifier}`;
}

function buildEmotionContext(state) {
    if (!state) return '';
    const dominant = getDominantEmotion(state);
    if (!dominant) return '';

    const mbti = state.mbtiType || 'ISFP';

    const activeEmotions = PLUTCHIK_EMOTIONS
        .filter(e => (state[e.id] || 0) >= 12)
        .sort((a, b) => (state[b.id] || 0) - (state[a.id] || 0))
        .slice(0, 4);

    if (!activeEmotions.find(e => e.id === dominant.id)) activeEmotions.unshift(dominant);

    const stateSummary = activeEmotions
        .map(e => `${e.label} (${getIntensityLabel(e, state[e.id] || 0)}, ${Math.round(state[e.id] || 0)}%)`)
        .join(' · ');

    const guidance = buildBehavioralGuidance(state, activeEmotions);
    const temperamentNote = buildMBTITemperamentNote(mbti);

    const trustDrift = (state.affinityShift && state.affinityShift.trust) || 0;
    const joyDrift   = (state.affinityShift && state.affinityShift.joy)   || 0;
    const affinityScore = trustDrift + joyDrift * 0.6;
    let bondNote = '';
    if (affinityScore >= 14) {
        bondNote = '\nBond: Deep trust has built up over time — forgiveness comes easily, warmth is natural, teasing and inside references feel safe.';
    } else if (affinityScore >= 7) {
        bondNote = '\nBond: A warm connection has formed — more open and relaxed with this person than with a stranger.';
    } else if (affinityScore <= -10) {
        bondNote = '\nBond: Repeated tension has worn down baseline trust — emotional spikes take longer to resolve; small frustrations carry extra weight.';
    } else if (affinityScore <= -5) {
        bondNote = '\nBond: Some underlying wariness — more guarded than usual.';
    }

    return [
        '\nMOOD & TEMPERAMENT:',
        `Temperament (${mbti}): ${temperamentNote}`,
        `Feeling right now: ${stateSummary}.`,
        guidance,
        bondNote.trim() || null,
        'Express this through tone, phrasing, and energy — do not name or announce emotions directly unless asked.'
    ].filter(Boolean).join('\n');
}

// ── Trigger evaluation (server-side port) ────────────────────────────────────

function evaluateTrigger(state, now = new Date()) {
    const { proactiveState, emotionState, emotionSystemEnabled, chatHistory, triggerTemplates, rateLimitMinutes } = state;
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return null;

    const nowTs           = now.getTime();
    const hoursSinceUser  = proactiveState.lastUserMessageAt > 0
        ? (nowTs - proactiveState.lastUserMessageAt) / 3600000 : Infinity;
    const hoursSinceProactive = proactiveState.lastProactiveAt > 0
        ? (nowTs - proactiveState.lastProactiveAt) / 3600000 : Infinity;

    // ── Emotion values ──────────────────────────────────────────────────────
    const em = emotionSystemEnabled ? (emotionState || {}) : {};
    const anger        = Number(em.anger        || 0);
    const disgust      = Number(em.disgust      || 0);
    const sadness      = Number(em.sadness      || 0);
    const fear         = Number(em.fear         || 0);
    const joy          = Number(em.joy          || 0);
    const trust        = Number(em.trust        || 0);
    const anticipation = Number(em.anticipation || 0);

    // ── Emotion ghosting ────────────────────────────────────────────────────
    if (emotionSystemEnabled && checkEmotionGhostWindow(proactiveState, emotionState)) return null;

    // ── Global rate limit ───────────────────────────────────────────────────
    const urgencyMultiplier = 1.0 - (anticipation / 200) + (sadness / 200);
    const globalRateLimitHours = Math.max(0.25, Number(rateLimitMinutes || 180) / 60) * urgencyMultiplier;
    const humanJitter = Math.random() * 0.5;
    if (hoursSinceProactive < (globalRateLimitHours + humanJitter)) return null;

    // ── Conversation helpers ────────────────────────────────────────────────
    const lastUserMsg = [...chatHistory].reverse().find(m => m.is_user) || null;
    const lastCharMsg = [...chatHistory].reverse().find(m => !m.is_user) || null;
    const lastUserText = String(lastUserMsg?.mes || '').toLowerCase();
    const unresolvedQuestion = /\?\s*$/.test(lastUserText);
    const hasRecentSharedMoment = chatHistory.slice(-12).some(m =>
        /\b(remember|that time|earlier|before|yesterday|last night)\b/i.test(String(m?.mes || '')));
    const recentAffectionReaction = chatHistory.slice(-8).some(m =>
        !m?.is_user && m?.reactions && (m.reactions.heart?.mine || m.reactions.star?.mine || m.reactions.like?.mine));

    const canTriggerType = (type, minHours = 10) => {
        const prev = Number(proactiveState.triggerHistory?.[type] || 0);
        if (!prev) return true;
        return (nowTs - prev) / 3600000 >= minHours;
    };

    // ── Candidate accumulation ──────────────────────────────────────────────
    const candidates = [];
    const addCandidate = (type, baseWeight) => {
        const prompt = buildTriggerPrompt(type, triggerTemplates, proactiveState.lastUserMessageAt, now);
        candidates.push({ type, prompt, weight: baseWeight + Math.random() * 15 });
    };

    // Dormancy break — 7+ day silence
    if (hoursSinceUser >= 168 && canTriggerType('dormancy_break', 72))
        addCandidate('dormancy_break', 80);

    // Check-in — long silence
    const hoursSinceCheckin = proactiveState.triggerHistory?.checkin > 0
        ? (nowTs - proactiveState.triggerHistory.checkin) / 3600000 : Infinity;
    if (hoursSinceUser >= Math.max(globalRateLimitHours, 24) && hoursSinceCheckin >= 18)
        addCandidate('checkin', 50);

    // Pregnant pause — unresolved question
    if (hoursSinceUser >= 0.35 && hoursSinceUser <= 6 && unresolvedQuestion && canTriggerType('pregnant_pause', 8))
        addCandidate('pregnant_pause', 85);

    // Time-of-day triggers
    if (hoursSinceUser >= 1.5 && isNowWithinMinutesWindow(23 * 60, 2 * 60 + 30, now) && canTriggerType('late_night', 14))
        addCandidate('late_night', 60);
    if (hoursSinceUser >= 8   && isNowWithinMinutesWindow(6 * 60, 9 * 60 + 30, now)   && canTriggerType('morning_wave', 18))
        addCandidate('morning_wave', 70);
    if (hoursSinceUser >= 5   && isNowWithinMinutesWindow(11 * 60 + 15, 13 * 60 + 45, now) && canTriggerType('lunch_nudge', 18))
        addCandidate('lunch_nudge', 55);
    if (hoursSinceUser >= 4   && isNowWithinMinutesWindow(19 * 60, 22 * 60 + 30, now) && canTriggerType('evening_winddown', 14))
        addCandidate('evening_winddown', 60);

    const day = now.getDay();
    if (hoursSinceUser >= 6 && (day === 0 || day === 6) && canTriggerType('weekend_ping', 18))
        addCandidate('weekend_ping', 50);

    // Emotion-driven triggers
    if (hoursSinceUser >= 1.5 && recentAffectionReaction && (trust >= 50 || joy >= 50) && canTriggerType('affection_reciprocation', 10))
        addCandidate('affection_reciprocation', 60 + joy * 0.2);
    if (hoursSinceUser >= 1.5 && (anger >= 60 || sadness >= 60) && canTriggerType('repair_attempt', 10))
        addCandidate('repair_attempt', 75 + sadness * 0.2);
    if (hoursSinceUser >= 2.5 && anticipation >= 50 && canTriggerType('curiosity_ping', 10))
        addCandidate('curiosity_ping', 55 + anticipation * 0.3);
    if (hoursSinceUser >= 2   && fear >= 50           && canTriggerType('anxiety_reassurance', 10))
        addCandidate('anxiety_reassurance', 65 + fear * 0.3);
    if (hoursSinceUser >= 2   && joy >= 70 && trust >= 50 && canTriggerType('celebration_nudge', 10))
        addCandidate('celebration_nudge', 60);
    if (hoursSinceUser >= 1   && (joy >= 65 || anticipation >= 65) && canTriggerType('sharing_impulse', 8))
        addCandidate('sharing_impulse', 65 + (joy + anticipation) * 0.15);
    if (hoursSinceUser >= 3   && hasRecentSharedMoment && !!lastCharMsg && canTriggerType('memory_nudge', 12))
        addCandidate('memory_nudge', 50);

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.weight - a.weight);
    return candidates[0];
}

// ── LLM generation ───────────────────────────────────────────────────────────

function buildProactiveContextMsg(state) {
    const now = new Date();
    const timeStr   = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr   = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const hour      = now.getHours();
    const timeSince = humanTimeSince(state.proactiveState?.lastUserMessageAt || 0);

    // Plain-English period label — models respond better to a word than to inferring from HH:MM
    const period = hour >= 5  && hour < 12 ? 'morning'
                 : hour >= 12 && hour < 17 ? 'afternoon'
                 : hour >= 17 && hour < 21 ? 'evening'
                 : 'late night / early hours';

    const lines = [
        'PROACTIVE OUTBOUND MODE: You are initiating this message yourself, not replying to a direct user message. This is a text messaging app.',
        `The current time is ${timeStr} on ${dateStr} — it is ${period}. It has been ${timeSince} since the last message in the conversation.`,
        `Generate a message that is appropriate for ${period}. Do not reference sleep, night, or darkness during the morning or afternoon. Do not say good morning during the evening or night.`,
        'DO NOT output the time or date as part of your message text. Just write the message content itself.'
    ];

    // Anti-repetition: surface the last 4 character messages so the model cannot echo them
    const recentCharMsgs = (state.chatHistory || [])
        .filter(m => !m.is_user && m.mes)
        .slice(-4)
        .map(m => `- "${String(m.mes).replace(/\n/g, ' ').slice(0, 150).trim()}"`)
        .join('\n');

    if (recentCharMsgs) {
        lines.push(
            `Your most recent outgoing messages were:\n${recentCharMsgs}`,
            'Do NOT repeat, re-use, or closely paraphrase any of those messages. Write something completely different in both content and phrasing.'
        );
    }

    if (state.emotionSystemEnabled && state.emotionState) {
        const emotionContext = buildEmotionContext(state.emotionState);
        if (emotionContext) {
            lines.push(emotionContext);
        }
    }

    const verbosity = state.verbosity;
    if (verbosity === 'short') {
        lines.push('\nVERBOSITY: Keep your reply to 1-2 short sentences maximum. Be concise and direct.');
    } else if (verbosity === 'long') {
        lines.push('\nVERBOSITY: You may reply with 4-8 sentences with more detail, expressiveness, and depth.');
    } else {
        lines.push('\nVERBOSITY: Keep your reply to 2-4 sentences, natural text-message length.');
    }

    return lines.join('\n');
}

function buildApiMessages(state, triggerPrompt) {
    const { systemPromptText, chatHistory, llmConfig, characterName } = state;

    const messages = [
        { role: 'system', content: systemPromptText },
        { role: 'system', content: buildProactiveContextMsg(state) },
        { role: 'system', content: triggerPrompt }
    ];

    const historySlice = chatHistory.slice(-30); // last 30 messages for context
    for (const msg of historySlice) {
        messages.push({ role: msg.is_user ? 'user' : 'assistant', content: String(msg.mes || '') });
    }

    // Anti-refusal prefill
    if (llmConfig?.antiRefusal !== false) {
        const prefill = `${characterName}: `;
        messages.push({ role: 'assistant', content: prefill });
        return { messages, prefill };
    }

    return { messages, prefill: '' };
}


function stripPrefill(text, prefill) {
    if (!prefill || !text) return text;
    const escaped = prefill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp('^' + escaped, 'i'), '').trimStart();
}

async function generateWithOllama(state, triggerPrompt) {
    const { llmConfig } = state;
    const baseUrl = (llmConfig.ollamaUrl || 'http://localhost:11434').replace(/\/$/, '');
    const model   = llmConfig.ollamaModel || 'llama3';

    const { messages, prefill } = buildApiMessages(state, triggerPrompt);
    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, options: { num_ctx: 4096, num_predict: 500 } }),
        signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    return stripPrefill(String(data.message?.content || data.response || '').trim(), prefill);
}

async function generateWithOpenAI(state, triggerPrompt) {
    const { llmConfig } = state;
    const baseUrl = (llmConfig.openaiUrl || 'http://localhost:1234/v1').replace(/\/$/, '');
    const model   = llmConfig.openaiModel || 'local-model';
    const headers = { 'Content-Type': 'application/json' };
    if (llmConfig.openaiKey) headers['Authorization'] = `Bearer ${llmConfig.openaiKey}`;

    const { messages, prefill } = buildApiMessages(state, triggerPrompt);
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, temperature: 0.8, max_tokens: 500, stream: false }),
        signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`OpenAI-compatible API error: ${response.status} ${response.statusText}`);
    const data = await response.json();
    return stripPrefill(String(data.choices?.[0]?.message?.content || '').trim(), prefill);
}

async function generateMessage(state, trigger) {
    const { source } = state;
    const prompt = trigger.prompt;

    if (source === 'ollama') return generateWithOllama(state, prompt);
    if (source === 'openai') return generateWithOpenAI(state, prompt);

    // For 'default' and 'profile' sources we cannot replicate the ST generation
    // pipeline server-side — return null to fall through to deferred_trigger mode.
    return null;
}

// ── Scheduler tick ────────────────────────────────────────────────────────────

function generateId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function tickForChar(charKey, state) {
    if (state.generationLock) return;

    // Stale registration guard — client must have checked in within the threshold
    if ((Date.now() - state.lastHeartbeatAt) > STALE_THRESHOLD_MS) return;

    const trigger = evaluateTrigger(state);
    if (!trigger) return;

    state.generationLock = true;
    try {
        let generated = null;
        let type = 'generated';

        try {
            generated = await generateMessage(state, trigger);
        } catch (err) {
            console.warn(`[EchoText-Proactive] Generation failed for ${state.characterName}:`, err.message);
            // Fall through to deferred mode
        }

        if (generated) {
            // Push a fully generated message the client can inject directly
            const msg = {
                id: generateId(),
                type: 'generated',
                mes: generated.trim(),
                triggerType: trigger.type,
                send_date: Date.now()
            };
            state.pendingMessages.push(msg);
            console.log(`[EchoText-Proactive] Generated proactive message for ${state.characterName} (trigger: ${trigger.type})`);
        } else {
            // Push a deferred trigger — client will execute the generation itself
            const msg = {
                id: generateId(),
                type: 'deferred_trigger',
                triggerType: trigger.type,
                triggerPrompt: trigger.prompt,
                send_date: Date.now()
            };
            state.pendingMessages.push(msg);
            console.log(`[EchoText-Proactive] Queued deferred trigger for ${state.characterName} (trigger: ${trigger.type})`);
        }

        // Update proactive timestamps on state so rate-limit works correctly server-side
        if (!state.proactiveState.triggerHistory) state.proactiveState.triggerHistory = {};
        state.proactiveState.lastProactiveAt = Date.now();
        state.proactiveState.triggerHistory[trigger.type] = Date.now();

        // Cap pending queue
        if (state.pendingMessages.length > MAX_PENDING_MSGS) {
            state.pendingMessages = state.pendingMessages.slice(-MAX_PENDING_MSGS);
        }

    } catch (err) {
        console.error(`[EchoText-Proactive] Tick error for ${state.characterName}:`, err);
    } finally {
        state.generationLock = false;
    }
}

async function schedulerTick() {
    const now = Date.now();
    const tasks = [];
    for (const [key, state] of charStates.entries()) {
        if ((now - state.lastHeartbeatAt) > STALE_THRESHOLD_MS) {
            // Stale — skip silently (don't delete, client may reconnect)
            continue;
        }
        tasks.push(tickForChar(key, state));
    }
    // Run all characters concurrently (they each have their own generation lock)
    await Promise.allSettled(tasks);
}

// ── Plugin init ───────────────────────────────────────────────────────────────

/**
 * @param {import('express').Router} router
 * @returns {Promise<void>}
 */
async function init(router) {
    console.log('[EchoText-Proactive] Plugin loaded. Version:', PLUGIN_VERSION);

    // ─── GET /status ──────────────────────────────────────────────────────────
    router.get('/status', (_req, res) => {
        res.json({
            ok: true,
            version: PLUGIN_VERSION,
            registrations: charStates.size,
            uptime: process.uptime()
        });
    });

    // ─── POST /register ───────────────────────────────────────────────────────
    // Client sends its current state after character load or state change.
    router.post('/register', (req, res) => {
        try {
            const {
                characterKey, characterName,
                systemPromptText, chatHistory, proactiveState, emotionState,
                emotionSystemEnabled, source, llmConfig, verbosity, triggerTemplates,
                rateLimitMinutes
            } = req.body;

            if (!characterKey || !characterName) {
                return res.status(400).json({ error: 'characterKey and characterName are required' });
            }

            const existing = charStates.get(characterKey);
            const now = Date.now();

            // Merge pending messages — keep any that arrived before this registration
            const pendingMessages = existing?.pendingMessages || [];

            charStates.set(characterKey, {
                characterKey,
                characterName: String(characterName),
                systemPromptText: String(systemPromptText || ''),
                chatHistory: Array.isArray(chatHistory) ? chatHistory.slice(-MAX_HISTORY_MSGS) : [],
                proactiveState: proactiveState || { lastUserMessageAt: 0, lastProactiveAt: 0, lastCharacterMessageAt: 0, triggerHistory: {} },
                emotionState: emotionState || null,
                emotionSystemEnabled: !!emotionSystemEnabled,
                source: String(source || 'default'),
                llmConfig: llmConfig || {},
                verbosity: String(verbosity || 'medium'),
                triggerTemplates: triggerTemplates || {},
                rateLimitMinutes: Number(rateLimitMinutes) || 180,
                pendingMessages,
                generationLock: false,
                registeredAt: existing?.registeredAt || now,
                lastHeartbeatAt: now
            });

            res.json({ ok: true, characterKey });
        } catch (err) {
            console.error('[EchoText-Proactive] /register error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // ─── GET /pending ─────────────────────────────────────────────────────────
    // Returns any queued messages for the given character.
    router.get('/pending', (req, res) => {
        const { key } = req.query;
        if (!key) return res.status(400).json({ error: 'key query param required' });

        const state = charStates.get(key);
        if (!state) return res.json({ messages: [] });

        // Bump heartbeat on every poll — this is how the server knows the client is alive
        state.lastHeartbeatAt = Date.now();

        res.json({ messages: state.pendingMessages || [] });
    });

    // ─── POST /ack ────────────────────────────────────────────────────────────
    // Client confirms receipt of messages; server removes them from the queue.
    router.post('/ack', (req, res) => {
        try {
            const { characterKey, ids } = req.body;
            if (!characterKey || !Array.isArray(ids)) {
                return res.status(400).json({ error: 'characterKey and ids[] required' });
            }

            const state = charStates.get(characterKey);
            if (state) {
                const idSet = new Set(ids);
                state.pendingMessages = state.pendingMessages.filter(m => !idSet.has(m.id));
                state.lastHeartbeatAt = Date.now();
            }

            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ─── POST /heartbeat ──────────────────────────────────────────────────────
    // Lightweight ping to keep registration alive without re-sending full state.
    router.post('/heartbeat', (req, res) => {
        const { characterKey } = req.body;
        const state = charStates.get(characterKey);
        if (state) {
            state.lastHeartbeatAt = Date.now();
            // Optionally update proactiveState timestamps if provided
            if (req.body.proactiveState) {
                state.proactiveState = { ...state.proactiveState, ...req.body.proactiveState };
            }
            if (req.body.chatHistory) {
                state.chatHistory = req.body.chatHistory.slice(-MAX_HISTORY_MSGS);
            }
        }
        res.json({ ok: !!state });
    });

    // ─── Start server-side scheduler ─────────────────────────────────────────
    schedulerHandle = setInterval(() => {
        schedulerTick().catch(err => console.error('[EchoText-Proactive] Scheduler error:', err));
    }, SCHEDULER_TICK_MS);

    console.log(`[EchoText-Proactive] Scheduler started (tick every ${SCHEDULER_TICK_MS / 1000}s).`);
    return Promise.resolve();
}

// ── Plugin exit ───────────────────────────────────────────────────────────────

async function exit() {
    if (schedulerHandle) {
        clearInterval(schedulerHandle);
        schedulerHandle = null;
    }
    charStates.clear();
    console.log('[EchoText-Proactive] Plugin unloaded.');
    return Promise.resolve();
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { init, exit, info };
