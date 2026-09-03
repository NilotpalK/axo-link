// Lifted verbatim from OpenWhispr's src/helpers/localSpeechGate.js (MIT,
// github.com/openwhispr/openwhispr). Decides after the fact whether a take was
// speech at all, so room tone never costs an API call or a garbage transcript.
//
// The thresholds are the reason to lift this rather than invent it: they were
// tuned against real mics. Note the fail-open default at the top of
// getSpeechGateDecision -- audio you could not measure is never discarded.
const SILENCE_RMS_THRESHOLD = 0.002;
const SPEECH_WINDOW_RMS_THRESHOLD = 0.003;
const SPEECH_WINDOW_PEAK_THRESHOLD = 0.02;
const STRONG_SPEECH_RMS_THRESHOLD = 0.006;

export const createSpeechGateState = () => ({
  peakRms: 0,
  peakAmplitude: 0,
  windowCount: 0,
  speechWindowCount: 0,
  consecutiveSpeechWindows: 0,
  maxConsecutiveSpeechWindows: 0,
});

export const recordSpeechWindow = (state, rms, peak) => {
  if (!state) return null;

  state.windowCount += 1;
  state.peakRms = Math.max(state.peakRms, rms);
  state.peakAmplitude = Math.max(state.peakAmplitude, peak);

  const isSpeechWindow =
    rms >= SPEECH_WINDOW_RMS_THRESHOLD && peak >= SPEECH_WINDOW_PEAK_THRESHOLD;
  if (!isSpeechWindow) {
    state.consecutiveSpeechWindows = 0;
    return state;
  }

  state.speechWindowCount += 1;
  state.consecutiveSpeechWindows += 1;
  state.maxConsecutiveSpeechWindows = Math.max(
    state.maxConsecutiveSpeechWindows,
    state.consecutiveSpeechWindows
  );
  return state;
};

export const getSpeechGateDecision = (state) => {
  if (!state?.windowCount) {
    // Fail open: no windows measured means the meter never ran, not that the
    // room was quiet.
    return { skip: false, reason: 'unavailable' };
  }

  const metrics = {
    peakRms: state.peakRms,
    peakAmplitude: state.peakAmplitude,
    windowCount: state.windowCount,
    speechWindowCount: state.speechWindowCount,
    maxConsecutiveSpeechWindows: state.maxConsecutiveSpeechWindows,
  };

  if (state.peakRms < SILENCE_RMS_THRESHOLD) {
    return { skip: true, reason: 'silence', ...metrics };
  }

  const hasSpeech =
    state.speechWindowCount >= 1 || state.peakRms >= STRONG_SPEECH_RMS_THRESHOLD;

  if (!hasSpeech) {
    return { skip: true, reason: 'insufficient_speech', ...metrics };
  }

  return { skip: false, reason: 'speech_detected', ...metrics };
};

/** Trailing-silence auto-stop. Separate from the gate above: the gate judges a
 *  finished take, this decides when the take is over. Arms only after speech
 *  has been heard, so a slow start is never cut off. */
export const createAutoStop = ({ silenceMs = 1200, maxMs = 30000, noSpeechMs = 5000 } = {}) => {
  let startedAt = null;
  let heardSpeech = false;
  let quietSince = null;

  return (rms, now) => {
    if (startedAt === null) startedAt = now;
    if (now - startedAt >= maxMs) return 'max_duration';

    if (rms >= SPEECH_WINDOW_RMS_THRESHOLD) {
      heardSpeech = true;
      quietSince = null;
      return null;
    }

    // Opened the mic and said nothing -- close it rather than sit there hot.
    if (!heardSpeech) return now - startedAt >= noSpeechMs ? 'no_speech' : null;

    if (quietSince === null) quietSince = now;
    return now - quietSince >= silenceMs ? 'trailing_silence' : null;
  };
};
