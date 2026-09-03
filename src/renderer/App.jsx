import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Pill from './components/Pill.jsx';
import Roster from './components/Roster.jsx';
import KeyPrompt from './components/KeyPrompt.jsx';
import { useMic } from './hooks/useMic.js';

const RANK = { waiting: 0, running: 1, error: 2, idle: 3 };

export default function App() {
  const [list, setList] = useState([]);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('all');
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState(null);
  const [needKey, setNeedKey] = useState(false);

  // The session the open mic is aimed at, resolved by main at mic-open so it
  // can't shift while you are mid-sentence.
  const targetRef = useRef(null);
  const noticeTimer = useRef(null);

  const flash = useCallback((msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const resize = useCallback((v) => {
    setExpanded(v);
    axo.resize(v);
  }, []);

  useEffect(() => {
    axo.list().then(setList);
    return axo.onSessions(setList);
  }, []);

  const onTake = useCallback(
    async (audio) => {
      const target = targetRef.current;
      if (!target) return;
      const r = await axo.voice(target.targetId, audio);
      if (r.ok) {
        setSel(target.targetId);   // local only: an explicit click is a different signal
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

  const { sorted, waitingCount, approvals } = useMemo(() => {
    const sorted = [...list].sort((a, b) => RANK[a.state] - RANK[b.state] || a.since - b.since);
    const waiting = list.filter((s) => s.state === 'waiting');
    return {
      sorted,
      waitingCount: waiting.length,
      approvals: waiting.filter((s) => s.waiting_kind === 'approval_request').length,
    };
  }, [list]);

  const mic = {
    status: micStatus,
    getLevel,
    targetLabel: targetRef.current?.targetLabel || '',
  };

  return (
    <div
      className={`flex h-screen flex-col overflow-hidden border bg-pill-surface backdrop-blur-lg ${
        micStatus === 'recording' ? 'border-state-listening/60' : 'border-pill-border'
      } ${expanded ? 'rounded-[22px]' : 'rounded-full'}`}
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

      {expanded &&
        (needKey ? (
          <KeyPrompt
            onSave={async (key) => {
              if (await axo.setKey(key)) {
                setNeedKey(false);
                flash('Key saved — press ⌥Space to talk.');
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
