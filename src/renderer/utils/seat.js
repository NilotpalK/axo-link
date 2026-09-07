/** Map axo-link session rows onto the LayerProto focused-seat fields. */

export function initials(value) {
  const parts = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'AX';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/** WAITING | RUNNING | DONE — display label only. */
export function statusOf(session) {
  if (session?.state === 'running') return 'RUNNING';
  if (session?.state === 'waiting') return 'WAITING';
  return 'DONE';
}

/** Snippet must be real text — empty seats stay off the focused card. */
export function snippetOf(session) {
  const summary = String(session?.summary || '').trim();
  if (summary) return summary;
  const last = String(session?.last || '').trim();
  if (last) return last;
  if (Array.isArray(session?.pending) && session.pending.length) {
    return `wants: ${session.pending.join(', ')}`;
  }
  return '';
}

export function toolsOf(session) {
  if (Array.isArray(session?.tools) && session.tools.length) {
    return session.tools.filter((t) => typeof t === 'string' && t.trim());
  }
  if (session?.did) {
    const parts = String(session.did)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length) return parts.slice(0, 4);
  }
  if (session?.hub || session?.vendor === 'layer-hub') return ['Layer'];
  if (session?.vendor) return [String(session.vendor)];
  return ['agent'];
}

export function seatFromSession(session) {
  if (!session) return null;
  const snippet = snippetOf(session);
  if (!snippet) return null;
  const name = String(session.label || 'seat').trim() || 'seat';
  return {
    id: session.id,
    name,
    character: String(session.character || '').trim() || initials(name),
    tools: toolsOf(session),
    status: statusOf(session),
    snippet,
    deepLink:
      typeof session.deepLink === 'string' && session.deepLink.trim()
        ? session.deepLink.trim()
        : undefined,
    hub: Boolean(session.hub || session.vendor === 'layer-hub'),
    waiting_kind: session.waiting_kind,
    raw: session,
  };
}

/** Seats that need Asher: waiting, real snippet, not locally decided. */
export function needsAsherSeats(list, decisions = {}) {
  return (list || [])
    .filter((s) => s.state === 'waiting' && !s.held && !decisions[s.id])
    .map(seatFromSession)
    .filter(Boolean)
    .sort((a, b) => (a.raw.since || 0) - (b.raw.since || 0));
}
