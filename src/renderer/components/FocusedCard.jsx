/** Light focused card when a seat needs Asher — LayerProto concepts, pill chrome. */

const STATUS_CLASS = {
  WAITING: 'border-[#51492e] bg-[#1d1a11] text-[#e8d9a7]',
  RUNNING: 'border-[#344150] bg-[#121820] text-[#b7c8de]',
  DONE: 'border-[#344034] bg-[#131813] text-[#aebcae]',
};

function Btn({ primary, children, onClick, title, className = '' }) {
  return (
    <button
      type="button"
      title={title}
      className={`no-drag min-h-[36px] cursor-pointer rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${className} ${
        primary
          ? 'border-pill-text bg-pill-text text-[#111113] hover:bg-white'
          : 'border-pill-border bg-white/4 text-pill-text hover:border-pill-dim hover:bg-white/8'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default function FocusedCard({
  seat,
  position,
  total,
  queueOthers,
  queueWaiting,
  onApprove,
  onDeny,
  onReply,
  onHold,
  onHoldAll,
  onOpen,
}) {
  if (!seat) return null;

  return (
    <article
      className="no-drag mx-2.5 mb-2 rounded-[12px] border border-pill-border bg-black/35 px-3 py-2.5"
      aria-label={`${seat.name} needs your attention`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-pill-border pb-2">
        <div className="text-[10px] font-semibold tracking-[0.09em] text-pill-dim">
          FOCUSED · {position} OF {Math.max(total, 1)}
        </div>
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-pill-dim hover:text-pill-text"
          onClick={onHoldAll}
        >
          hold all
        </button>
      </div>

      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5">
        <div
          className="grid size-10 place-items-center rounded-[10px] border border-pill-border bg-white/6 text-[12px] font-bold tracking-wide"
          aria-hidden="true"
        >
          {seat.character}
        </div>

        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-tight">{seat.name}</div>
          <div className="mt-1 flex flex-wrap gap-1" aria-label="Tools">
            {seat.tools.map((tool) => (
              <span
                key={tool}
                className="rounded-md border border-pill-border bg-black/30 px-1.5 py-0.5 text-[10px] text-pill-dim"
              >
                {tool}
              </span>
            ))}
          </div>
        </div>

        <span
          className={`self-start rounded-md border px-1.5 py-1 text-[9px] font-bold tracking-[0.08em] ${
            STATUS_CLASS[seat.status] || STATUS_CLASS.WAITING
          }`}
        >
          {seat.status}
        </span>
      </div>

      <div className="mb-1 text-[10px] font-medium tracking-wide text-pill-dim">Needs Asher</div>
      <p className="m-0 text-[13px] leading-snug text-pill-text">{seat.snippet}</p>

      <div
        className="mt-3 grid grid-cols-2 gap-1.5"
        aria-label={`Actions for ${seat.name}`}
      >
        <Btn primary onClick={() => onApprove(seat)}>
          Approve
        </Btn>
        <Btn onClick={() => onDeny(seat)}>Deny</Btn>
        <Btn onClick={() => onReply(seat)}>Reply</Btn>
        <Btn onClick={() => onHold(seat)}>Hold</Btn>
        <Btn
          className="col-span-2"
          title={seat.deepLink ? seat.deepLink : 'No deep link'}
          onClick={() => onOpen(seat)}
        >
          Open
        </Btn>
      </div>

      <div className="mt-2.5 border-t border-pill-border pt-2 text-[11px] text-pill-dim">
        {queueOthers} others · {queueWaiting} waiting
      </div>
    </article>
  );
}
