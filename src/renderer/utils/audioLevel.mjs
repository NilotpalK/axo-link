// Lifted from OpenWhispr's src/utils/audioLevel.ts (MIT,
// github.com/openwhispr/openwhispr), types stripped.

/** RMS of an analyser's current time-domain window, reusing `buf` across reads. */
export function analyserRms(analyser, buf) {
  if (!buf.current || buf.current.length !== analyser.fftSize) {
    buf.current = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(buf.current);
  let sumSquares = 0;
  for (let i = 0; i < buf.current.length; i++) {
    const v = buf.current[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / buf.current.length);
}

/** Loudest absolute sample in the same window. The speech gate needs peak
 *  alongside RMS: steady hum can pass an RMS threshold that no real syllable
 *  peak ever accompanies. */
export function analyserPeak(analyser, buf) {
  if (!buf.current || buf.current.length !== analyser.fftSize) {
    buf.current = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(buf.current);
  let peak = 0;
  for (let i = 0; i < buf.current.length; i++) {
    const v = Math.abs(buf.current[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Both in one pass -- the meter runs every 80ms and reads the same window. */
export function analyserLevels(analyser, buf) {
  if (!buf.current || buf.current.length !== analyser.fftSize) {
    buf.current = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(buf.current);
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < buf.current.length; i++) {
    const v = buf.current[i];
    sumSquares += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sumSquares / buf.current.length), peak };
}
