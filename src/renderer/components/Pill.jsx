import PillWaveform from './PillWaveform.jsx';

const DOT = {
  running: 'bg-state-running',
  waiting: 'bg-state-waiting animate-pill-pulse',
  error: 'bg-state-error',
  idle: 'bg-state-idle',
};

export function Dot({ state }) {
  return <i className={`size-2 shrink-0 rounded-full transition-colors ${DOT[state] || DOT.idle}`} />;
}

/** The collapsed bar. Three moods: idle roster, listening, transcribing. */
export default function Pill({ sorted, waitingCount, notice, mic, onToggle, onAdd, onSetup }) {
  const listening = mic.status === 'recording';
  const sending = mic.status === 'sending';
  // Past 8 the dots stop being readable, so collapse them into the count.
  const tooMany = sorted.length > 8;

  return (
    <div
      className="drag flex h-11 flex-none cursor-pointer items-center gap-2 px-3.5"
      onClick={onToggle}
    >
      {listening ? (
        <>
          <div className="h-5 w-14 flex-none text-state-listening">
            <PillWaveform getLevel={mic.getLevel} active />
          </div>
          <span className="min-w-0 flex-1 truncate text-[11px] text-pill-dim">
            → {mic.targetLabel}
          </span>
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {!tooMany && sorted.map((s) => <Dot key={s.id} state={s.state} />)}
          </div>

          <span className="truncate text-[11px] whitespace-nowrap text-pill-dim">
            {notice ? (
              <span className="text-state-error">{notice}</span>
            ) : sending ? (
              'transcribing…'
            ) : waitingCount ? (
              <b className="font-semibold text-state-waiting">{waitingCount} waiting</b>
            ) : tooMany ? (
              `${sorted.length} agents`
            ) : sorted.length ? (
              'all busy'
            ) : null}
          </span>
        </>
      )}

      {onSetup && (
        <button
          className="no-drag size-5.5 flex-none cursor-pointer rounded-full border border-pill-border text-[11px] leading-none text-pill-dim transition-colors hover:border-pill-dim hover:text-pill-text"
          title="Setup / sign-in"
          onClick={(e) => {
            e.stopPropagation();
            onSetup();
          }}
        >
          ⚙
        </button>
      )}

      <button
        className="no-drag size-5.5 flex-none cursor-pointer rounded-full border border-pill-border text-sm/none text-pill-dim transition-colors hover:border-pill-dim hover:text-pill-text"
        title="Start an agent in a folder"
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
      >
        +
      </button>
    </div>
  );
}
