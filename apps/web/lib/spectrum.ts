export const SPECTRUM_FFT_SIZE = 8192;
export const SPECTRUM_MIN_DB = -85;
export const SPECTRUM_MAX_DB = -15;
export const ANALYZER_MIN_DB = -90;
export const ANALYZER_MAX_DB = -10;

export type SpectrumBand = { lowHz: number; highHz: number; startBin: number; endBin: number; weights: Float32Array; totalWeight: number };
export type SpectrumMapping = { sampleRate: number; fftSize: number; minHz: number; maxHz: number; bands: SpectrumBand[] };

export function spectrumBandCount(width: number) { return width < 480 ? 24 : 48; }
// Candidates are merged below to respect actual FFT resolution. At 44.1/48 kHz
// and FFT8192 this yields ~84–118 measured bands, not duplicated low bins.
export function analyzerBandCount(width: number) { return Math.max(96, Math.min(140, Math.round(width / 3))); }

export type SpectrumDisplayColumn = { lowHz: number; highHz: number; x: number; width: number; startBand: number; weights: Float32Array; totalWeight: number };
export type SpectrumDisplayGrid = { columns: SpectrumDisplayColumn[] };

// Display density is independent of measured FFT resolution. Keep at least a
// 3 CSS pixel cell on narrow screens (including its gap), at most 120 columns.
export function analyzerDisplayColumnCount(plotWidth: number) {
  return Number.isFinite(plotWidth) ? Math.max(0, Math.min(120, Math.floor(plotWidth / 3))) : 0;
}

// Equal log-frequency cells / equal screen pitch. A low-resolution measured
// band may supply several cells: these are NOT independent measurements.
// Precompute overlap in Hz, assuming constant mean power within each measured
// band. Never interpolate dB or renormalize the frame to its loudest column.
export function createSpectrumDisplayGrid(mapping: SpectrumMapping, left: number, plotWidth: number, pixelRatio = 1): SpectrumDisplayGrid {
  const columns: SpectrumDisplayColumn[] = [];
  const count = analyzerDisplayColumnCount(plotWidth);
  if (!count || !mapping.bands.length || !Number.isFinite(left) || mapping.maxHz <= mapping.minHz) return { columns };
  const dpr = Math.min(2, Math.max(1, Number.isFinite(pixelRatio) ? pixelRatio : 1));
  const cellWidth = plotWidth / count;
  const gapPixels = Math.max(1, Math.round(0.7 * dpr));
  let startBand = 0;
  for (let i = 0; i < count; ++i) {
    const lowHz = mapping.minHz * (mapping.maxHz / mapping.minHz) ** (i / count);
    const highHz = mapping.minHz * (mapping.maxHz / mapping.minHz) ** ((i + 1) / count);
    while (startBand < mapping.bands.length && mapping.bands[startBand].highHz <= lowHz) startBand++;
    let endBand = startBand;
    while (endBand < mapping.bands.length && mapping.bands[endBand].lowHz < highHz) endBand++;
    const weights = new Float32Array(endBand - startBand);
    for (let j = startBand; j < endBand; ++j) {
      weights[j - startBand] = Math.max(0, Math.min(highHz, mapping.bands[j].highHz) - Math.max(lowHz, mapping.bands[j].lowHz));
    }
    // Snap both edges to physical pixels; widths and gaps can differ by at
    // most one physical pixel. First/last cells use exactly the same rule.
    const startPixel = Math.round((left + i * cellWidth) * dpr);
    const endPixel = Math.round((left + (i + 1) * cellWidth) * dpr);
    const x = (startPixel + Math.ceil(gapPixels / 2)) / dpr;
    const width = Math.max(0, endPixel - startPixel - gapPixels) / dpr;
    columns.push({ lowHz, highHz, x, width, startBand, weights, totalWeight: highHz - lowHz });
  }
  return { columns };
}

export function readSpectrumDisplay(grid: SpectrumDisplayGrid, measuredDb: Float32Array, heights: Float32Array, minDb: number, maxDb: number) {
  heights.fill(0);
  if (!Number.isFinite(minDb) || !Number.isFinite(maxDb) || maxDb <= minDb) return;
  for (let i = 0; i < Math.min(grid.columns.length, heights.length); ++i) {
    const column = grid.columns[i];
    let power = 0;
    for (let j = 0; j < column.weights.length; ++j) {
      const value = measuredDb[column.startBand + j];
      if (Number.isFinite(value)) {
        const weighted = 10 ** (value / 10) * column.weights[j];
        if (Number.isFinite(weighted)) power += weighted;
      }
    }
    if (power > 0 && Number.isFinite(power) && column.totalWeight > 0) {
      const db = 10 * Math.log10(power / column.totalWeight);
      heights[i] = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
    }
  }
}

export function createSpectrumMapping(sampleRate: number, fftSize: number, bandCount = 48, minHz = 32, maxHz = 16000): SpectrumMapping {
  maxHz = Math.min(maxHz, sampleRate / 2);
  const result: SpectrumMapping = { sampleRate, fftSize, minHz, maxHz, bands: [] };
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isInteger(fftSize) || fftSize < 32 ||
    (fftSize & (fftSize - 1)) !== 0 || !Number.isInteger(bandCount) || bandCount < 1 || bandCount > 512 ||
    !Number.isFinite(minHz) || minHz <= 0 || !Number.isFinite(maxHz) || maxHz <= minHz) return result;
  const step = sampleRate / fftSize;
  let low = minHz;
  const addBand = (high: number) => {
    // A bin represents the frequency cell around its centre. Boundary cells
    // contribute only their actual overlap, cached here rather than per frame.
    const startBin = Math.max(1, Math.floor(low / step + 0.5)); // Exclude DC.
    const endBin = Math.min(fftSize / 2, Math.ceil(high / step + 0.5));
    const weights = new Float32Array(Math.max(0, endBin - startBin));
    let totalWeight = 0;
    for (let k = startBin; k < endBin; ++k) {
      const weight = Math.max(0, Math.min(high, (k + 0.5) * step) - Math.max(low, (k - 0.5) * step)) / step;
      weights[k - startBin] = weight; totalWeight += weight;
    }
    if (totalWeight) result.bands.push({ lowHz: low, highHz: high, startBin, endBin, weights, totalWeight });
    low = high;
  };
  for (let i = 1; i <= bandCount; ++i) {
    const high = minHz * (maxHz / minHz) ** (i / bandCount);
    // Merge sub-bin candidates: each analysis band spans at least one FFT
    // resolution cell. Shared boundary fractions do not imply extra resolution.
    if (high - low < step && i !== bandCount) continue;
    if (i === bandCount && high - low < step && result.bands.length) low = result.bands.pop()!.lowHz;
    addBand(high);
  }
  return result;
}

// Coverage-weighted mean of linear bin powers, NOT a mean of dB values.
// Invalid/missing bins contribute silence, including -Infinity and NaN.
export function readSpectrumBands(mapping: SpectrumMapping, bins: Float32Array, db: Float32Array, heights: Float32Array, minDb = SPECTRUM_MIN_DB, maxDb = SPECTRUM_MAX_DB) {
  db.fill(-Infinity);
  heights.fill(0);
  for (let i = 0; i < Math.min(mapping.bands.length, db.length, heights.length); ++i) {
    const band = mapping.bands[i];
    let power = 0;
    for (let k = band.startBin; k < Math.min(band.endBin, bins.length); ++k) {
      const value = bins[k];
      if (!Number.isFinite(value)) continue;
      const binPower = 10 ** (value / 10);
      if (Number.isFinite(binPower)) power += binPower * band.weights[k - band.startBin];
    }
    const count = band.totalWeight;
    if (count <= 0 || power <= 0 || !Number.isFinite(power)) continue;
    db[i] = 10 * Math.log10(power / count);
    if (Number.isFinite(minDb) && Number.isFinite(maxDb) && maxDb > minDb) {
      heights[i] = Math.max(0, Math.min(1, (db[i] - minDb) / (maxDb - minDb)));
    }
  }
}

// Real measured levels only; linear fall in display units/second, no fake floor.
export function decaySpectrumPeaks(peaks: Float32Array, levels: Float32Array, deltaSeconds: number) {
  const fall = Math.max(0, Math.min(0.25, deltaSeconds)) * 1.5;
  for (let i = 0; i < peaks.length; ++i) peaks[i] = Math.max(levels[i] || 0, peaks[i] - fall, 0);
}

export function frequencyPosition(hz: number, minHz: number, maxHz: number) {
  return Math.log(hz / minHz) / Math.log(maxHz / minHz);
}

export function smoothSpectrum(current: Float32Array, target: Float32Array, deltaSeconds: number, attack = 0.03, release = 0.11) {
  let maximum = 0;
  const dt = Math.max(0, Math.min(0.25, deltaSeconds));
  for (let i = 0; i < current.length; ++i) {
    const goal = Number.isFinite(target[i]) ? target[i] : 0;
    const tau = goal > current[i] ? attack : release;
    current[i] += (goal - current[i]) * (1 - Math.exp(-dt / tau));
    if (current[i] < 0.001) current[i] = 0;
    maximum = Math.max(maximum, current[i]);
  }
  return maximum;
}
