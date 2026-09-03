// Lifted from OpenWhispr's src/components/dictation/waveformMath.ts (MIT,
// github.com/openwhispr/openwhispr), types stripped. The curve constants are
// the reason to lift rather than invent -- they were fitted against real speech.
export const WAVEFORM_BAR_COUNT = 11;
export const WAVEFORM_BAR_MIN_PX = 3;
export const WAVEFORM_BAR_MAX_PX = 18;

// Conversational speech RMS sits around 0.02-0.15. The gain puts loud voicing
// at the top of the lane; the 0.75 exponent keeps quiet speech visible while
// preserving contrast between neighboring samples -- a square-root curve
// compressed them into a fluid ridge with little bar-to-bar variance.
const LEVEL_GAIN = 8;
const LEVEL_EXPONENT = 0.75;

const toBarLevel = (rms) =>
  Math.min(1, Math.pow(Math.max(0, rms) * LEVEL_GAIN, LEVEL_EXPONENT));

export const resolveWaveformBarHeight = (rms) =>
  WAVEFORM_BAR_MIN_PX + toBarLevel(rms) * (WAVEFORM_BAR_MAX_PX - WAVEFORM_BAR_MIN_PX);
