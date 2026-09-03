import { useEffect, useRef } from 'react';
import {
  resolveWaveformBarHeight,
  WAVEFORM_BAR_COUNT,
  WAVEFORM_BAR_MIN_PX,
} from '../utils/waveformMath.mjs';

// Lifted from OpenWhispr's PillWaveform.tsx (MIT, github.com/openwhispr/openwhispr),
// with its `cn` dependency dropped.

// Syllables run ~140-250ms; sampling much faster than that lands neighboring
// bars inside the same syllable, which reads as a fluid ridge. 80ms spacing
// lets adjacent bars straddle syllable onsets and gaps, so the real signal
// itself supplies the bar-to-bar variance.
const SAMPLE_INTERVAL_MS = 80;

/**
 * Level-driven waveform: bars scroll right-to-left with the live input signal.
 * Heights are written straight to the DOM from a rAF loop so recording never
 * pays React re-render cost.
 */
export default function PillWaveform({ getLevel, active, className = '' }) {
  const barRefs = useRef([]);
  const levelsRef = useRef([]);

  useEffect(() => {
    if (!active) return;

    // A new take starts from silence -- never replay the previous one's wave.
    levelsRef.current = new Array(WAVEFORM_BAR_COUNT).fill(0);
    for (let i = 0; i < WAVEFORM_BAR_COUNT; i += 1) {
      if (barRefs.current[i]) barRefs.current[i].style.height = `${WAVEFORM_BAR_MIN_PX}px`;
    }

    let frame = 0;
    let lastSample = 0;
    const paint = (now) => {
      if (now - lastSample >= SAMPLE_INTERVAL_MS) {
        lastSample = now;
        const level = getLevel();
        const levels = levelsRef.current;
        levels.shift();
        levels.push(level === null ? 0 : level);
        for (let i = 0; i < levels.length; i++) {
          const bar = barRefs.current[i];
          if (bar) bar.style.height = `${resolveWaveformBarHeight(levels[i])}px`;
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [active, getLevel]);

  return (
    <div className={`flex h-full items-center justify-center gap-[3px] ${className}`} aria-hidden="true">
      {Array.from({ length: WAVEFORM_BAR_COUNT }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="w-0.5 rounded-full bg-current transition-[height] duration-75 ease-out motion-reduce:transition-none"
          style={{ height: WAVEFORM_BAR_MIN_PX }}
        />
      ))}
    </div>
  );
}
