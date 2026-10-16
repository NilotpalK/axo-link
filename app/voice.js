'use strict';
// The pill's two voices. Both are Gemini Live sessions opened with a one-use
// token from the hub, so the API key never touches this machine.
//   dictation()  hold the key, talk, let go -> text, typed into the focused app
//   secretary()  talk to axo; it answers out loud and acts on the agents
// Audio in is 16 kHz 16-bit mono PCM from the pill; audio out is 24 kHz.
const { GoogleGenAI, Modality } = require('@google/genai');

const MIC = 'audio/pcm;rate=16000';
const VOICE_NAME = 'Kore';   // the hub reads text out in the same voice
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

Agents are known by label and machine, for example "axo-link on HOME-PC". For anything about what they are doing, call the agents tool; never guess, and never infer state from anything but its state field. Pass ids exactly as the tool returns them.

Each agent's last_message is the agent's own last message, word for word; you_sent is what was last sent to it. When the user asks what an agent said, give them its own words, never your summary or rewording; if they want a summary, offer to ask the agent itself for one. A short message you can say yourself. Anything longer, or whenever they ask for all of it, the whole thing, or word for word: say a few words such as "Reading it out", call read_aloud, and then say nothing more -- it reads the text out in full, exactly, in your voice, starting a few seconds later.

An agent of kind "terminal" is a Claude Code session in one of the user's terminal windows. reply types the user's words into it. To know what is on its screen right now -- a menu, a picker, a question, output -- call screen and read the relevant lines exactly as they appear. To pick something in a menu or picker it shows, call screen, then press the keys (arrows, enter, esc...), then call screen again to check what happened. press esc while it is working interrupts it. Its permission prompts are answered in its terminal: tell the user so rather than calling approve, deny or press.

When a tool returns an error, tell the user plainly what it says -- for example that something is half-typed in that terminal, so nothing was sent. Never say something was done unless the tool returned ok.

Approvals: before calling approve, read out the exact command the agent wants to run, in full, and get a clear yes to it. Then call approve with the request ids of exactly the commands you read out. If approve says the requests changed, read the new ones out and ask again. If the user says no but says what to do instead, call reply with their words.

Messages that start with [update] come from axo-link, not the user. Say the update in a sentence; if the agent asked something, put the question to the user.

If the user says they are driving, out, or away, call set_mode with away. If they say they are back at the desk, call set_mode with desk.`;

const id = { type: 'string', description: 'agent id from the agents tool' };
const TOOLS = [
  { name: 'agents', description: 'Every agent: id, label, machine, state, what it last said and did, and any command waiting on approval.' },
  { name: 'reply', description: "Send the user's words to an agent. If the agent is waiting on an approval, this denies it and tells the agent what to do instead.",
    parametersJsonSchema: { type: 'object', properties: { id, text: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'approve', description: 'Let an agent run the commands it is waiting on. Only after the user said yes to those exact commands.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        id,
        requests: { type: 'array', items: { type: 'string' }, description: 'request_ids from the agents tool for the commands the user approved' },
      },
      required: ['id', 'requests'],
    } },
  { name: 'deny', description: 'Refuse the command an agent is waiting on.',
    parametersJsonSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'stop', description: 'Stop an agent for good.',
    parametersJsonSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'screen', description: "Exactly what is on a terminal agent's screen right now, as text.",
    parametersJsonSchema: { type: 'object', properties: { id }, required: ['id'] } },
  { name: 'press', description: "Press keys in a terminal agent's window, in order: for menus, pickers and choices it shows. Read its screen first. Not for permission prompts.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        id,
        keys: { type: 'array', items: { type: 'string' }, description: 'each one of: up, down, left, right, enter, esc, tab, space, backspace, or a single letter or digit' },
      },
      required: ['id', 'keys'],
    } },
  { name: 'read_aloud', description: "Read an agent's last message, or a terminal agent's screen, out loud in full, word for word. Say nothing after calling it.",
    parametersJsonSchema: {
      type: 'object',
      properties: { id, what: { type: 'string', enum: ['last_message', 'screen'] } },
      required: ['id', 'what'],
    } },
  { name: 'set_mode', description: 'desk: speak only when the user talks to you. away: speak agent updates as they happen.',
    parametersJsonSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['desk', 'away'] } }, required: ['mode'] } },
].map((t) => ({ ...t, behavior: 'BLOCKING' }));   // answer before speaking

const brief = (a) => ({
  id: a.id, label: a.label, kind: a.kind || 'pill', machine: a.device, alive: a.alive, state: a.state,
  waiting_for: a.waiting_kind, did: a.did, error: a.state === 'error' ? a.summary : undefined,
  wants_to_run: a.pending, request_ids: a.pending_ids,
  last_message: a.last, you_sent: a.prompt,
});

/** what the secretary says when an agent raises its hand while you're away */
const update = (a) => `[update] ${a.label} on ${a.device} ` + (
  a.state === 'error' ? `stopped with an error: ${a.summary}`
    : a.waiting_kind === 'approval_request' ? `wants approval to run: ${a.pending.join('; ')}.`
    : a.waiting_kind === 'question' ? `asks: ${a.summary}`
    : `finished: ${a.summary || 'no summary'}`
) + (a.did ? ` It used: ${a.did}.` : '');

/** Text as it should sound, in parts small enough to start reading quickly.
 *  Markdown's marks go (code fences, backticks, bold, heading and bullet
 *  marks, link syntax); every word stays, in order. The first part is a
 *  single sentence, so the voice starts sooner; the second is mid-sized, so
 *  it's voiced before the first finishes; the rest run up to `max`.
 *  Big parts on purpose: each is one request, and the free tier allows 3 a
 *  minute -- a 2,600-character message is 4 or 5 parts, not 8, and the
 *  long ones hide any wait for the limit. */
function speakable(text, max = 1200, second = 400) {
  const plain = String(text)
    .replace(/^\s*```.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '');
  const sentences = plain.split(/\n\s*\n/)
    .flatMap((para) => para.trim().split(/(?<=[.!?:])\s+(?=\S)/))
    .map((s) => s.trim()).filter(Boolean);
  const parts = [];
  for (const s of sentences) {
    const last = parts.length > 1 ? parts.length - 1 : -1;   // never grow the first part
    const cap = last === 1 ? Math.min(second, max) : max;
    if (last >= 0 && parts[last].length + s.length + 1 <= cap) parts[last] += ' ' + s;
    else parts.push(s);
  }
  return parts;
}

/** the tools, as plain calls on the roster and the hub link */
function toolRunner({ link, roster, setMode, readAloud = () => {} }) {
  const screenOf = (a) => link.ask({ t: 'query', op: 'screen', id: a.id }).then((r) => r.text);
  return (name, args) => {
    if (name === 'agents') return { agents: roster().map(brief) };
    if (name === 'set_mode') return setMode(args.mode) ? { ok: true } : { error: 'mode is desk or away' };
    const op = { reply: 'send', approve: 'approve', deny: 'deny', stop: 'stop', screen: 'screen', read_aloud: 'read', press: 'press' }[name];
    if (!op) return { error: `no tool called ${name}` };
    const a = roster().find((x) => x.id === args.id);
    if (!a) return { error: 'no agent with that id; call agents first' };
    if (!a.alive) return { error: `${a.label} has ended` };
    if ((op === 'screen' || op === 'press' || (op === 'read' && args.what === 'screen')) && a.kind !== 'terminal') {
      return { error: `${a.label} has no screen: it runs in the pill` };
    }
    if (op === 'screen') {
      // asked of the machine it runs on, through the hub
      return screenOf(a).then((text) => ({ screen: text }), (e) => ({ error: e.message }));
    }
    if (op === 'read') {
      if (args.what === 'screen') return screenOf(a).then((text) => readAloud(text), (e) => ({ error: e.message }));
      return a.last ? readAloud(a.last) : { error: `${a.label} hasn't said anything yet` };
    }
    if ((op === 'approve' || op === 'deny') && a.kind === 'terminal') {
      return { error: `${a.label} runs in a terminal: its permission prompt is answered there` };
    }
    if ((op === 'approve' || op === 'deny') && a.waiting_kind !== 'approval_request') {
      return { error: `${a.label} is not waiting on an approval` };
    }
    if (op === 'approve') {
      // the yes was for specific commands; if the agent asks something else now, it doesn't carry over
      const asked = a.pending_ids || [], said = Array.isArray(args.requests) ? args.requests : [];
      if (said.length !== asked.length || !asked.every((x) => said.includes(x))) {
        return { error: 'the requests changed since you read them out; call agents and read the new ones' };
      }
      return done(link.do(op, a.id, undefined, said));
    }
    return done(link.do(op, a.id, op === 'press' ? args.keys : args.text));
  };
  // ok only once the agent's machine says it happened; otherwise its reason, word for word
  function done(p) { return p.then(() => ({ ok: true }), (e) => ({ error: e.message })); }
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
      // some answers come from another machine (a terminal's screen), so wait for all of them
      Promise.all(m.toolCall.functionCalls.map(async (f) => ({
        id: f.id, name: f.name, response: await run(f.name, f.args || {}),
      }))).then((functionResponses) => session?.sendToolResponse({ functionResponses }));
    }
    if (c?.turnComplete) { speaking = false; drain(); }
    touch();
  }

  // ponytail: no session resumption -- a dropped or idle-closed session just
  // reopens on next use with a fresh roster. Add resumption if context loss bites.
  const ensure = () => (opening ??= open(link, 'talk', {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
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

module.exports = { dictation, secretary, toolRunner, update, speakable };
