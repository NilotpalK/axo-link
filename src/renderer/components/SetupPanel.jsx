/** First-run / Settings: provider seats with Connect / Disconnect. */

const STATUS = {
  connected: 'border-[#344034] bg-[#131813] text-[#aebcae]',
  pending: 'border-[#51492e] bg-[#1d1a11] text-[#e8d9a7]',
  disconnected: 'border-pill-border bg-black/20 text-pill-dim',
};

function statusLabel(status) {
  if (status === 'connected') return 'connected';
  if (status === 'pending') return 'pending SSO';
  return 'not connected';
}

function Row({ row, busy, onConnect, onDisconnect }) {
  const connected = row.status === 'connected';
  return (
    <div className="rounded-[10px] border border-pill-border/80 bg-black/25 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">{row.label}</div>
          <div className="mt-0.5 truncate text-[10.5px] text-pill-dim">{row.detail}</div>
        </div>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-bold tracking-[0.06em] uppercase ${
            STATUS[row.status] || STATUS.disconnected
          }`}
        >
          {statusLabel(row.status)}
        </span>
      </div>

      {row.statusDetail && (
        <div className="mt-1.5 line-clamp-2 text-[10.5px] text-pill-dim">{row.statusDetail}</div>
      )}

      <div className="mt-2 flex gap-1.5">
        {connected ? (
          <button
            type="button"
            disabled={busy}
            className="cursor-pointer rounded-md border border-pill-border bg-transparent px-2.5 py-1 text-[11px] text-pill-dim transition-colors hover:border-state-error hover:text-state-error disabled:opacity-40"
            onClick={() => onDisconnect(row.id)}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            className="cursor-pointer rounded-md border border-pill-border bg-white/6 px-2.5 py-1 text-[11px] text-pill-text transition-colors hover:border-pill-dim disabled:opacity-40"
            onClick={() => onConnect(row.id)}
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

export default function SetupPanel({
  providers,
  busyId,
  onConnect,
  onDisconnect,
  onRefresh,
  onDone,
}) {
  return (
    <div className="no-drag flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between gap-2 px-3 pb-1.5 pt-0.5">
        <div>
          <div className="text-[10px] font-semibold tracking-[0.09em] text-pill-dim">SETUP</div>
          <div className="text-[12px] text-pill-text">Sign in to agent seats</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-pill-dim hover:text-pill-text"
            onClick={onRefresh}
          >
            refresh
          </button>
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-pill-dim hover:text-pill-text"
            onClick={onDone}
          >
            done
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-2.5 pb-2">
        {(providers || []).map((row) => (
          <Row
            key={row.id}
            row={row}
            busy={busyId === row.id}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>

      <div className="flex-none border-t border-pill-border px-3 py-2 text-[10.5px] leading-snug text-pill-dim">
        Local detection only — CLI on PATH, env keys, Layer hub URL. Browser OAuth is a TODO.
      </div>
    </div>
  );
}
