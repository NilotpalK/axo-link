import { useCallback, useEffect, useRef, useState } from 'react';
import { analyserLevels } from '../utils/audioLevel.mjs';
import {
  createSpeechGateState,
  recordSpeechWindow,
  getSpeechGateDecision,
  createAutoStop,
} from '../utils/speechGate.mjs';

// Syllables run ~140-250ms, so 80ms windows straddle onsets and gaps. Same
// cadence the waveform samples at, so one meter feeds both.
const METER_INTERVAL_MS = 80;

// Lifted from OpenWhispr's audioManager.js:906-914, with their reasons:
// AGC off because Chromium's AGC on Windows mutates the system mic volume via
// WASAPI; echo cancellation and noise suppression off to avoid latency and
// speech distortion. We can afford echo cancellation off because the hotkey
// kills `say` before the mic opens, so there is nothing to echo.
const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/**
 * One mic take: record, meter, auto-stop on trailing silence, hand the bytes
 * back. Adapted from OpenWhispr's useVoiceDraft.ts (MIT) -- the recorder graph
 * and teardown are theirs, the auto-stop and gating are ours.
 */
export function useMic({ onTake, onError }) {
  const [status, setStatus] = useState('idle'); // idle | recording | sending

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const contextRef = useRef(null);
  const analyserRef = useRef(null);
  const meterRef = useRef(null);
  const bufRef = useRef(null);
  const levelRef = useRef(0);
  const chunksRef = useRef([]);
  const gateRef = useRef(null);
  const discardRef = useRef(false);

  // Latest-value refs: the recorder's onstop is bound at start time.
  const onTakeRef = useRef(onTake);
  onTakeRef.current = onTake;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** PillWaveform's contract: current level, or null when nothing is capturing. */
  const getLevel = useCallback(() => (recorderRef.current ? levelRef.current : null), []);

  const teardown = useCallback(() => {
    clearInterval(meterRef.current);
    meterRef.current = null;
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    levelRef.current = 0;
  }, []);

  const finish = useCallback(async () => {
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    const gate = getSpeechGateDecision(gateRef.current);
    chunksRef.current = [];
    teardown();

    if (discardRef.current || blob.size === 0 || gate.skip) {
      setStatus('idle');
      return;
    }

    setStatus('sending');
    try {
      await onTakeRef.current(await blob.arrayBuffer());
    } catch (e) {
      onErrorRef.current?.(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('idle');
    }
  }, [teardown]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      // Chromium's audio graph is pull-based: an analyser not transitively
      // connected to the destination reads flat zeros forever. Route through a
      // muted gain so it fills without anything being audible.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(context.destination);

      chunksRef.current = [];
      discardRef.current = false;
      gateRef.current = createSpeechGateState();
      bufRef.current = null;

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => void finish();
      recorder.start(250);

      recorderRef.current = recorder;
      streamRef.current = stream;
      contextRef.current = context;
      analyserRef.current = analyser;

      const shouldStop = createAutoStop();
      meterRef.current = setInterval(() => {
        // A stalled context reads flat silence, which would trip the auto-stop.
        if (contextRef.current?.state !== 'running' || !analyserRef.current) return;
        const { rms, peak } = analyserLevels(analyserRef.current, bufRef);
        levelRef.current = rms;
        recordSpeechWindow(gateRef.current, rms, peak);
        if (shouldStop(rms, performance.now())) recorderRef.current?.stop();
      }, METER_INTERVAL_MS);

      setStatus('recording');
    } catch (e) {
      teardown();
      setStatus('idle');
      onErrorRef.current?.(e instanceof Error ? e.message : String(e));
    }
  }, [finish, teardown]);

  const stop = useCallback(() => recorderRef.current?.stop(), []);
  const cancel = useCallback(() => {
    discardRef.current = true;
    recorderRef.current?.stop();
  }, []);

  // Never leave the mic hot if the pill unmounts mid-take.
  useEffect(
    () => () => {
      discardRef.current = true;
      recorderRef.current?.stop();
    },
    []
  );

  return { status, getLevel, start, stop, cancel };
}
