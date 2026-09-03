import { useRef } from 'react';
import { Dot } from './Pill.jsx';

const KIND = { approval_request: 'needs approval', question: 'asked you', finished: 'done' };

function Tab({ name, count, on, alert, onClick }) {
  return (
    <button
      className={`cursor-pointer rounded-md border-0 px-2.5 py-1 text-[11px] transition-colors ${
        on ? 'bg-white/8 text-pill-text' : 'bg-transparent text-pill-dim hover:text-pill-text'
      }`}
      onClick={onClick}
    >
      {name}{' '}
      <span className={on || alert ? 'text-state-waiting' : 'opacity-70'}>{count}</span>
    </button>
  );
}

function Row({ s, selected, onSelect }) {
  const approval = s.waiting_kind === 'approval_request';
  const kind = s.state === 'waiting' ? KIND[s.waiting_kind] || 'waiting' : s.state;

  return (
    <div
      className={`cursor-pointer rounded-[10px] px-2.5 py-2 transition-colors hover:bg-white/4 ${
        selected ? 'bg-white/7' : ''
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <Dot state={s.state} />
        <span className="min-w-0 flex-1 truncate font-semibold">{s.label}</span>
        <span
          className={`text-[10px] tracking-[0.06em] whitespace-nowrap uppercase ${
            approval ? 'text-state-waiting' : 'text-pill-dim'
          }`}
        >
          {kind}
        </span>
      </div>

      <div className="pl-4">
        {s.summary && <div className="mt-[3px] line-clamp-3 text-[11px]">{s.summary}</div>}
        {s.did && <div className="mt-[3px] text-[10.5px] text-pill-dim">did: {s.did}</div>}

        {approval && s.pending?.length > 0 && (
          <div className="mt-[5px] rounded-md border border-state-waiting/20 bg-state-waiting/10 px-2 py-[5px] font-mono text-[10.5px] break-all text-[#f5d78e]">
            wants:
            {s.pending.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}

        {approval && (
          <div className="mt-1.5 flex gap-1.5">
            <button
              className="cursor-pointer rounded-md border border-pill-border bg-transparent px-3 py-1 text-[11px] text-pill-dim transition-colors hover:border-state-running hover:text-state-running"
              onClick={(e) => {
                e.stopPropagation();
                axo.approve(s.id);
              }}
            >
              Approve
            </button>
            <button
              className="cursor-pointer rounded-md border border-pill-border bg-transparent px-3 py-1 text-[11px] text-pill-dim transition-colors hover:border-state-error hover:text-state-error"
              onClick={(e) => {
                e.stopPropagation();
                axo.deny(s.id);
              }}
            >
              Deny
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Roster({ sorted, waitingCount, approvals, tab, setTab, sel, setSel }) {
  const inputRef = useRef(null);
  const shown = tab === 'waiting' ? sorted.filter((s) => s.state === 'waiting') : sorted;
  const cur = sorted.find((s) => s.id === sel);

  return (
    <>
      <div className="no-drag flex flex-none gap-1 px-2.5 pb-1.5">
        <Tab name="All" count={sorted.length} on={tab === 'all'} onClick={() => setTab('all')} />
        <Tab
          name="Waiting"
          count={waitingCount}
          on={tab === 'waiting'}
          alert={approvals > 0}
          onClick={() => setTab('waiting')}
        />
      </div>

      <div className="no-drag flex-1 overflow-y-auto px-1.5 pb-1">
        {shown.length ? (
          shown.map((s) => (
            <Row
              key={s.id}
              s={s}
              selected={s.id === sel}
              onSelect={() => {
                setSel(s.id);
                inputRef.current?.focus();
              }}
            />
          ))
        ) : (
          <div className="px-4 py-6.5 text-center leading-7 text-pill-dim">
            {tab === 'waiting' ? (
              'Nothing waiting on you.'
            ) : (
              <>
                No agents yet.
                <br />
                Hit + to start one in a folder.
              </>
            )}
          </div>
        )}
      </div>

      {/* The "or I can ask it" half: the CLI session stays open, so a follow-up
          question is just the next turn down the same stdin. */}
      <div className="no-drag flex-none border-t border-pill-border p-2">
        <input
          ref={inputRef}
          className="w-full rounded-[10px] border border-pill-border bg-black/30 px-3 py-2.5 outline-none focus:border-pill-dim disabled:opacity-45"
          disabled={!cur}
          placeholder={cur ? `Reply to ${cur.label}…` : 'Select a session…'}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !cur || !e.target.value.trim()) return;
            axo.send(cur.id, e.target.value.trim());
            e.target.value = '';
          }}
        />
      </div>
    </>
  );
}
