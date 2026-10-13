'use strict';
// The pill's two voices. Both are Gemini Live sessions opened with a one-use
// token from the hub, so the API key never touches this machine.
//   dictation()  hold the key, talk, let go -> text, typed into the focused app
//   secretary()  talk to axo; it answers out loud and acts on the agents
// Audio in is 16 kHz 16-bit mono PCM from the pill; audio out is 24 kHz.
const { GoogleGenAI, Modality } = require('@google/genai');

const MIC = 'audio/pcm;rate=16000';
// push-to-talk: the hotkey, not Gemini, decides when you start and stop
const PTT = { automaticActivityDetection: { disabled: true } };

async function open(link, kind, config, callbacks) {
  const { token, model } = await link.ask({ t: 'voice', kind });
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  return ai.live.connect({ model, config, callbacks });
}

/** One key-hold of audio. Whatever arrives before the session is open is kept
 *  and sent first: under push-to-talk the server adds no lead-in of its own. */
function utterance(opening) {
  let early = [], live = null;
  const ready = opening.then((s) => {
    s.sendRealtimeInput({ activityStart: {} });
    for (const data of early) s.sendRealtimeInput({ audio: { data, mimeType: MIC } });
    early = null;
    return (live = s);
  });
  ready.catch(() => {});   // reported by end(), not as an unhandled rejection
  return {
    ready,
    audio(data) {
      if (live) live.sendRealtimeInput({ audio: { data, mimeType: MIC } });
      else early?.push(data);
    },
  };
}

/** speech -> text. A fresh session per key-hold; end() resolves the transcript. */
function dictation(link) {
  let text = '', ending = false, settle = () => {}, quiet;
  const u = utterance(open(link, 'dictate', {
    responseModalities: [Modality.TEXT],
    inputAudioTranscription: {},
    realtimeInputConfig: PTT,
  }, {
    onmessage: (m) => {
      const c = m.serverContent;
      if (c?.inputTranscription?.text) text += c.inputTranscription.text;
      if (!ending) return;
      // done when the model says so, or once the transcript goes quiet
      if (c?.inputTranscription?.finished || c?.turnComplete) settle();
      else { clearTimeout(quiet); quiet = setTimeout(settle, 1200); }
    },
  }));
  // ponytail: verbatim transcript. Wispr also strips "um"s and fixes grammar;
  // add a cleanup pass with a text model if raw dictation reads badly.
  return {
    audio: u.audio,
    async end(cancel) {
      if (cancel) { u.ready.then((s) => s.close(), () => {}); return ''; }
      const s = await u.ready;
      ending = true;
      const done = new Promise((r) => { settle = r; quiet = setTimeout(r, 1200); setTimeout(r, 5000); });
      s.sendRealtimeInput({ activityEnd: {} });
      await done;
      clearTimeout(quiet);
      s.close();
      return text.replace(/\s+/g, ' ').trim();
    },
  };
}

const SYSTEM = `You are axo, the voice of axo-link: a secretary for the coding agents running on the user's computers. The user is often away from the screen, driving or walking, so talk like a sharp human assistant: one or two short sentences, no lists, never read ids aloud. Always speak English.

Agents are known by label and machine, for example "axo-link on HOME-PC". For anything about what they are doing, call the agents tool; never guess. Pass ids exactly as the tool returns them.

Approvals: before calling approve, say the exact command the agent wants to run and get a clear yes to it. If the user says no but says what to do instead, call reply with their words.

Messages that start with [update] come from axo-link, not the user. Say the update in a sentence; if the agent asked something, put the question to the user.

If the user says they are driving, out, or away, call set_mode with away. If they say they are back at the desk, call set_mode with desk.`;

const id = { type: 'string', description: 'agent id from the agents tool' };
const TOOLS = [
  { name: 'agents', description: 'Every agent: id, label, machine, state, what it last said and did, and any command waiting on approval.' },
  { name: 'reply', description: "Send the user's words to an agent. If the agent is waiting on an approval, this denies it and tells the agent what to do instead.",
    parametersJsonSchema: { type: 'object', properties: { id, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'approve', description: 'Let an agent run the command it is waiting on. Only after the user said yes to that exact command.',
    parametersJsonSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'deny', description: 'Refuse the command an agent is waiting on.',
    parametersJsonSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'stop', description: 'Stop an agent for good.',
    parametersJsonSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'set_mode', description: 'desk: speak only when the user talks to you. away: speak agent updates as they happen.',
    parametersJsonSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['desk', 'away'] } }, required: ['mode'] } },
].map((t) => ({ ...t, behavior: 'BLOCKING' }));   // answer before speaking

const brief = (a) => ({
  id: a.id, label: a.label, machine: a.device, alive: a.alive, state: a.state,
  waiting_for: a.waiting_kind, summary: a.summary, did: a.did, wants_to_run: a.pending, last: a.last,
});

/** what the secretary says when an agent raises its hand while you're away */
const update = (a) => `[update] ${a.label} on ${a.device} ` + (
  a.waiting_kind === 'approval_request' ? `wants approval to run: ${a.pending.join('; ')}.`
    : a.waiting_kind === 'question' ? `asks: ${a.summary}`
    : `finished: ${a.summary || 'no summary'}`
) + (a.did ? ` It used: ${a.did}.` : '');

/** the tools, as plain calls on the roster and the hub link */
function toolRunner({ link, roster, setMode }) {
  return (name, args) => {
    if (name === 'agents') return { agents: roster().map(brief) };
    if (name === 'set_mode') return setMode(args.mode) ? { ok: true } : { error: 'mode is desk or away' };
    const op = { reply: 'send', approve: 'approve', deny: 'deny', stop: 'stop' }[name];
    if (!op) return { error: `no tool called ${name}` };
    const a = roster().find((x) => x.id === args.id);
    if (!a) return { error: 'no agent with that id; call agents first' };
    if (!a.alive) return { error: `${a.label} has ended` };
    if ((op === 'approve' || op === 'deny') && a.waiting_kind !== 'approval_request') {
      return { error: `${a.label} is not waiting on an approval` };
    }
    return link.do(op, a.id, args.text) ? { ok: true } : { error: 'not connected to the hub' };
  };
}

/** speech both ways. One session, opened on first use, closed after a quiet minute. */
function secretary({ link, roster, run, ui, busy = () => false }) {
  let session = null, opening = null, listening = false, speaking = false, idle;
  const notes = [];

  const close = () => { session?.close(); session = opening = null; speaking = false; };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!listening && !speaking) close(); }, 60000);
  };

  function onmessage(m) {
    const c = m.serverContent;
    if (c?.interrupted) { speaking = false; ui.flush(); }
    for (const p of c?.modelTurn?.parts || []) {
      if (p.inlineData?.data) { speaking = true; ui.audio(p.inlineData.data); }
    }
    if (c?.outputTranscription?.text) ui.caption(c.outputTranscription.text);
    if (m.toolCall) {
      session?.sendToolResponse({
        functionResponses: m.toolCall.functionCalls.map((f) => ({ id: f.id, name: f.name, response: run(f.name, f.args || {}) })),
      });
    }
    if (c?.turnComplete) { speaking = false; drain(); }
    touch();
  }

  // ponytail: no session resumption -- a dropped or idle-closed session just
  // reopens on next use with a fresh roster. Add resumption if context loss bites.
  const ensure = () => (opening ??= open(link, 'talk', {
    responseModalities: [Modality.AUDIO],
    systemInstruction: `${SYSTEM}\n\nAgents right now: ${JSON.stringify(roster().map(brief))}`,
    tools: [{ functionDeclarations: TOOLS }],
    realtimeInputConfig: PTT,
    outputAudioTranscription: {},
  }, {
    onmessage,
    onclose: () => { session = opening = null; speaking = false; },
  }).then((s) => (session = s), (e) => { opening = null; throw e; }));

  // floor rule: never talk over the user, never over itself
  function drain() {
    if (!notes.length || listening || speaking || busy()) return;
    ensure().then((s) => {
      if (!notes.length || listening || speaking || busy()) return;
      speaking = true;   // holds the next note until this turn completes
      s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: notes.splice(0).join('\n') }] }], turnComplete: true });
    }, ui.error);
  }

  return {
    listen() {
      listening = true;
      clearTimeout(idle);
      if (speaking) { speaking = false; ui.flush(); }   // you talking cuts it off
      const u = utterance(ensure());
      return {
        audio: u.audio,
        async end(cancel) {
          listening = false;
          touch();
          if (cancel) { u.ready.then(close, () => {}); return ''; }   // half a sentence isn't worth an answer
          (await u.ready).sendRealtimeInput({ activityEnd: {} });
          return '';
        },
      };
    },
    announce(text) { notes.push(text); drain(); },
    drain,
  };
}

module.exports = { dictation, secretary, toolRunner, update };
