import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Pill from './components/Pill.jsx';
import Roster from './components/Roster.jsx';
import KeyPrompt from './components/KeyPrompt.jsx';
import FocusedCard from './components/FocusedCard.jsx';
import { useMic } from './hooks/useMic.js';
import { needsAsherSeats } from './utils/seat.js';

const RANK = { waiting: 0, running: 1, error: 2, idle: 3 };

export default function App() {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState(null);
  const [needKey, setNeedKey] = useState(false);
  // Local dismiss / decision overlay — Hold is UI-only; Approve/Deny also
  // poke the CLI or hub when possible.
  const [decisions, setDecisions] = useState({});

  // The session the open mic is aimed at, resolved by main at mic-open so it
  // can't shift while you are mid-sentence.
  const targetRef = useRef(null);
  const noticeTimer = useRef(null);

  const flash = useCallback((msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const applyResize = useCallback((mode) => {
    axo.resize(mode);
  }, []);

  const resize = useCallback(
    (v) => {
      setExpanded(v);
      // focused size wins over collapsed when something needs Asher
    },
    [],
  );

  useEffect(() => {
    axo.list().then(setList);
    return axo.onSessions(setList);
  }, []);

  // Drop stale decisions once the session leaves waiting (or disappears).
  useEffect(() => {
    setDecisions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        const s = list.find((row) => row.id === id);
        if (!s || s.state !== 'waiting') {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [list]);

  const onTake = useCallback(
    async (audio) => {
      const target = targetRef.current;
      if (!target) return;
      const r = await axo.voice(target.targetId, audio);
      if (r.ok) {
        setSel(target.targetId);   // local only: an explicit click is a different signal
        setDecisions((d) => ({ ...d, [target.targetId]: 'replied' }));
      } else if (r.code === 'NO_KEY') {
        setNeedKey(true);
        resize(true);
      } else {
        flash(r.error);
      }
    },
    [flash, resize]
  );

  const { status: micStatus, getLevel, start: micStart, stop: micStop } = useMic({
    onTake,
    onError: flash,
  });

  // The hotkey toggles, so the handler needs the live status without
  // re-subscribing (and stacking listeners) on every status change.
  const micStatusRef = useRef(micStatus);
  micStatusRef.current = micStatus;

  useEffect(
    () =>
      axo.onMic((payload) => {
        if (micStatusRef.current === 'recording') return micStop();
        if (micStatusRef.current === 'sending') return;   // still uploading the last take
        if (payload.error) return flash(payload.error);
        targetRef.current = payload;
        micStart();
      }),
    [micStart, micStop, flash]
  );

  const select = useCallback((id) => {
    setSel(id);
    axo.select(id);   // main uses this as the last-resort voice target
  }, []);

  const decide = useCallback((id, decision) => {
    setDecisions((d) => ({ ...d, [id]: decision }));
  }, []);

  const { sorted, waitingCount, approvals } = useMemo(() => {
    const sorted = [...list].sort((a, b) => RANK[a.state] - RANK[b.state] || a.since - b.since);
    const waiting = list.filter((s) => s.state === 'waiting');
    return {
      sorted,
      waitingCount: waiting.length,
      approvals: waiting.filter((s) => s.waiting_kind === 'approval_request').length,
    };
  }, [list]);

  const queue = useMemo(() => needsAsherSeats(list, decisions), [list, decisions]);
  const focusedSeat = queue[0] || null;
  const focusedPosition = focusedSeat ? 1 : 0;
  const totalNeeds = queue.length;
  const queueWaiting = queue.length;
  const queueOthers = Math.max(list.length - (focusedSeat ? 1 : 0), 0);

  // Window geometry: expanded roster > focused card > collapsed pill.
  useEffect(() => {
    if (expanded) applyResize('expanded');
    else if (focusedSeat) applyResize('focused');
    else applyResize('collapsed');
  }, [expanded, focusedSeat, applyResize]);

  const onApprove = useCallback(
    async (seat) => {
      decide(seat.id, 'approved');
      await axo.approve(seat.id);
      flash('Approved');
    },
    [decide, flash],
  );

  const onDeny = useCallback(
    async (seat) => {
      decide(seat.id, 'denied');
      await axo.deny(seat.id);
      flash('Denied');
    },
    [decide, flash],
  );

  const onHold = useCallback(
    (seat) => {
      decide(seat.id, 'held');
      axo.hold?.(seat.id);
      flash('Held');
    },
    [decide, flash],
  );

  const onHoldAll = useCallback(() => {
    const ids = queue.map((seat) => seat.id);
    for (const id of ids) axo.hold?.(id);
    setDecisions((d) => {
      const next = { ...d };
      for (const id of ids) next[id] = 'held';
      return next;
    });
    flash('All waiting seats held');
  }, [queue, flash]);

  const onReply = useCallback(
    (seat) => {
      select(seat.id);
      if (micStatusRef.current === 'recording' || micStatusRef.current === 'sending') return;
      targetRef.current = { targetId: seat.id, targetLabel: seat.name };
      micStart();
    },
    [select, micStart],
  );

  const onOpen = useCallback(
    async (seat) => {
      if (!seat.deepLink) {
        flash('No deep link available');
        return;
      }
      const ok = await axo.openLink(seat.deepLink);
      if (!ok) flash('Could not open link');
    },
    [flash],
  );

  const mic = {
    status: micStatus,
    getLevel,
    targetLabel: targetRef.current?.targetLabel || '',
  };

  const showCard = Boolean(focusedSeat);

  return (
    <div
      className={`flex h-screen flex-col overflow-hidden border bg-pill-surface backdrop-blur-lg ${
        micStatus === 'recording' ? 'border-state-listening/60' : 'border-pill-border'
      } ${expanded || showCard ? 'rounded-[22px]' : 'rounded-full'}`}
    >
      <Pill
        sorted={sorted}
        waitingCount={waitingCount}
        notice={notice}
        mic={mic}
        onToggle={() => resize(!expanded)}
        onAdd={async () => {
          const id = await axo.pick();
          if (id) {
            select(id);
            resize(true);
          }
        }}
      />

      {showCard && (
        <FocusedCard
          seat={focusedSeat}
          position={focusedPosition}
          total={totalNeeds}
          queueOthers={queueOthers}
          queueWaiting={queueWaiting}
          onApprove={onApprove}
          onDeny={onDeny}
          onReply={onReply}
          onHold={onHold}
          onHoldAll={onHoldAll}
          onOpen={onOpen}
        />
      )}

      {expanded &&
        (needKey ? (
          <KeyPrompt
            onSave={async (key) => {
              if (await axo.setKey(key)) {
                setNeedKey(false);
                flash('Key saved — press F13 to talk.');
              }
            }}
            onDismiss={() => setNeedKey(false)}
          />
        ) : (
          <Roster
            sorted={sorted}
            waitingCount={waitingCount}
            approvals={approvals}
            tab={tab}
            setTab={setTab}
            sel={sel}
            setSel={select}
          />
        ))}
    </div>
  );
}
