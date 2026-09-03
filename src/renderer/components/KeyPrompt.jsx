/** Shown once, when a voice reply finds no transcription key. */
export default function KeyPrompt({ onSave, onDismiss }) {
  return (
    <div className="no-drag flex-1 px-4 py-3">
      <div className="font-semibold">Transcription key</div>
      <p className="mt-1 text-[11px] leading-relaxed text-pill-dim">
        Voice replies transcribe through OpenAI. Paste a key from{' '}
        <span className="font-mono">platform.openai.com/api-keys</span> — it is encrypted by your
        OS keychain and never leaves this machine except to transcribe.
      </p>
      <input
        autoFocus
        type="password"
        placeholder="sk-…"
        className="mt-3 w-full rounded-[10px] border border-pill-border bg-black/30 px-3 py-2.5 font-mono outline-none focus:border-pill-dim"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target.value.trim()) onSave(e.target.value.trim());
          if (e.key === 'Escape') onDismiss();
        }}
      />
      <div className="mt-2 flex items-center justify-between text-[10.5px] text-pill-dim">
        <span>Enter to save</span>
        <button className="cursor-pointer underline-offset-2 hover:underline" onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
