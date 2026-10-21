import { analyzerDisplayColumnCount, createSpectrumDisplayGrid, readSpectrumDisplay, analyzerBandCount, ANALYZER_MIN_DB, ANALYZER_MAX_DB, createSpectrumMapping, decaySpectrumPeaks, frequencyPosition, readSpectrumBands, smoothSpectrum, spectrumBandCount } from "./spectrum";

test.each([44100, 48000])("%i Hz maps unique resolvable centres with coverage-weighted boundaries", (rate) => {
  const map = createSpectrumMapping(rate, 8192);
  expect(map.bands.length).toBeGreaterThanOrEqual(44); expect(map.bands.length).toBeLessThanOrEqual(48);
  expect(map.maxHz).toBe(16000);
  const step = rate / 8192;
  const centres = new Set<number>();
  const coverage = new Map<number, number>();
  map.bands.forEach((band, i) => {
    expect(band.highHz - band.lowHz).toBeGreaterThanOrEqual(step - 1e-8);
    if (i) expect(band.lowHz).toBeCloseTo(map.bands[i - 1].highHz);
    let independent = 0;
    for (let k = band.startBin; k < band.endBin; ++k) {
      expect(k).toBeGreaterThan(0); expect(k).toBeLessThan(4096);
      const weight = band.weights[k - band.startBin];
      expect(weight).toBeGreaterThan(0); expect(weight).toBeLessThanOrEqual(1);
      coverage.set(k, (coverage.get(k) ?? 0) + weight);
      if (k * step >= band.lowHz && k * step < band.highHz) {
        expect(centres.has(k)).toBe(false); centres.add(k); ++independent;
      }
    }
    expect(independent).toBeGreaterThan(0);
    expect(band.totalWeight * step).toBeCloseTo(band.highHz - band.lowHz);
  });
  expect([...coverage.values()].every(weight => weight <= 1.000001)).toBe(true);
  expect(frequencyPosition(32, 32, 16000)).toBe(0);
  expect(frequencyPosition(16000, 32, 16000)).toBe(1);
});

test("low resolution merges sub-bin candidates instead of faking independent bands", () => {
  const map = createSpectrumMapping(48000, 1024, 64);
  expect(map.bands.length).toBeLessThan(64);
  expect(map.bands[0].lowHz).toBe(32); expect(map.bands[0].startBin).toBe(1);
  map.bands.forEach(band => expect(band.highHz - band.lowHz).toBeGreaterThanOrEqual(48000 / 1024 - 1e-8));
});

test("panel width chooses 24 or approximately 48 bands without changing FFT resolution", () => {
  expect(spectrumBandCount(375)).toBe(24); expect(spectrumBandCount(600)).toBe(48);
  expect(createSpectrumMapping(48000, 8192, spectrumBandCount(375)).bands).toHaveLength(24);
});

test("Nyquist clamps the top edge and bin indices stay within frequencyBinCount", () => {
  const map = createSpectrumMapping(22050, 8192);
  expect(map.maxHz).toBe(11025);
  expect(map.bands.at(-1)?.endBin).toBe(4096);
  expect(map.bands.at(-1)?.highHz).toBe(11025);
  expect(createSpectrumMapping(48000, 4096).bands[0].startBin).not.toBe(createSpectrumMapping(48000, 8192).bands[0].startBin);
});

test.each([100, 1000, 8000])("a single %i Hz FFT peak maps to the containing band", (hz) => {
  const map = createSpectrumMapping(48000, 8192);
  const bins = new Float32Array(4096).fill(-Infinity);
  const k = Math.round(hz * 8192 / 48000);
  bins[k] = -25;
  const db = new Float32Array(map.bands.length); const heights = new Float32Array(db.length);
  readSpectrumBands(map, bins, db, heights);
  const peak = heights.indexOf(Math.max(...heights));
  expect(map.bands[peak].startBin).toBeLessThanOrEqual(k);
  expect(map.bands[peak].endBin).toBeGreaterThan(k);
});

test("aggregation uses mean linear power; lower unsaturated input produces a lower bar", () => {
  const map = createSpectrumMapping(48000, 8192, 1, 1000, 1010);
  expect(map.bands[0].endBin - map.bands[0].startBin).toBe(2);
  const bins = new Float32Array(4096).fill(-Infinity);
  const db = new Float32Array(1); const heights = new Float32Array(1);
  bins[map.bands[0].startBin] = -20; bins[map.bands[0].startBin + 1] = -40;
  readSpectrumBands(map, bins, db, heights);
  expect(db[0]).toBeCloseTo(10 * Math.log10((0.01 * 4.8828125 + 0.0001 * 5.1171875) / 10));
  const high = heights[0];
  bins[map.bands[0].startBin] -= 12; bins[map.bands[0].startBin + 1] -= 12;
  readSpectrumBands(map, bins, db, heights);
  expect(heights[0]).toBeGreaterThan(0); expect(heights[0]).toBeLessThan(high);
});

test.each([-Infinity, NaN, Infinity])("invalid/silent value %s produces no false floor", (value) => {
  const map = createSpectrumMapping(48000, 8192);
  const db = new Float32Array(map.bands.length); const heights = new Float32Array(map.bands.length);
  readSpectrumBands(map, new Float32Array(4096).fill(value), db, heights);
  expect(Array.from(heights).every((height) => height === 0)).toBe(true);
  expect(Array.from(db).every((level) => level === -Infinity)).toBe(true);
  readSpectrumBands(map, new Float32Array(), db, heights);
  expect(Array.from(heights).every((height) => height === 0)).toBe(true);
});

test("DC and out-of-range bins cannot create bars, short output arrays are safe", () => {
  const map = createSpectrumMapping(48000, 8192);
  const bins = new Float32Array(4096).fill(-Infinity); bins[0] = 0; bins[4000] = 0;
  const db = new Float32Array(2); const levels = new Float32Array(2);
  readSpectrumBands(map, bins, db, levels);
  expect(Array.from(levels)).toEqual([0, 0]);
  expect(createSpectrumMapping(NaN, 8192).bands).toEqual([]);
  expect(createSpectrumMapping(48000, 0).bands).toEqual([]);
});

test("time-based smoothing is frame-rate independent and decays to zero", () => {
  const a = new Float32Array(1); const b = new Float32Array(1); const target = new Float32Array([1]);
  for (let i = 0; i < 30; ++i) smoothSpectrum(a, target, 1 / 30);
  for (let i = 0; i < 60; ++i) smoothSpectrum(b, target, 1 / 60);
  expect(a[0]).toBeCloseTo(b[0], 5);
  target.fill(0);
  for (let i = 0; i < 24; ++i) smoothSpectrum(a, target, 1 / 30);
  expect(a[0]).toBe(0);
});

test("peak caps follow measured levels and decay by elapsed time to true zero", () => {
  const a = new Float32Array([0.8]); const b = new Float32Array([0.8]); const zero = new Float32Array(1);
  for (let i = 0; i < 6; ++i) decaySpectrumPeaks(a, zero, 1 / 30);
  for (let i = 0; i < 12; ++i) decaySpectrumPeaks(b, zero, 1 / 60);
  expect(a[0]).toBeCloseTo(0.5); expect(a[0]).toBeCloseTo(b[0]);
  decaySpectrumPeaks(a, new Float32Array([0.9]), 1 / 30); expect(a[0]).toBeCloseTo(0.9);
  for (let i = 0; i < 30; ++i) decaySpectrumPeaks(a, zero, 1 / 30);
  expect(a[0]).toBe(0);
});

test.each([44100, 48000])("dense %i Hz analysis covers 20–20k with independent resolvable bands", rate => {
  const narrow = createSpectrumMapping(rate, 8192, analyzerBandCount(300), 20, 20000);
  const wide = createSpectrumMapping(rate, 8192, analyzerBandCount(600), 20, 20000);
  expect(narrow.bands.length).toBeGreaterThanOrEqual(80);
  expect(wide.bands.length).toBeGreaterThan(narrow.bands.length); expect(wide.bands.length).toBeLessThanOrEqual(120);
  expect(wide.minHz).toBe(20); expect(wide.maxHz).toBe(20000);
  for (const map of [narrow, wide]) for (const band of map.bands) {
    expect(band.highHz - band.lowHz).toBeGreaterThanOrEqual(rate / 8192 - 1e-8);
    expect(band.startBin).toBeGreaterThan(0); expect(band.endBin).toBeLessThanOrEqual(4096);
  }
  expect(createSpectrumMapping(rate, 4096, analyzerBandCount(600), 20, 20000).bands.length).toBeLessThan(wide.bands.length);
  expect(createSpectrumMapping(32000, 8192, 120, 20, 20000).maxHz).toBe(16000);
});

test("dense bands respond independently to measured low and high tones and zero safely", () => {
  const map = createSpectrumMapping(48000, 8192, analyzerBandCount(380), 20, 20000);
  const bins = new Float32Array(4096).fill(-Infinity), db = new Float32Array(map.bands.length), heights = new Float32Array(db.length);
  const low = Math.round(100 * 8192 / 48000), high = Math.round(10000 * 8192 / 48000);
  bins[low] = -30; bins[high] = -40;
  readSpectrumBands(map, bins, db, heights, ANALYZER_MIN_DB, ANALYZER_MAX_DB);
  const before = heights.slice(); bins[high] -= 18;
  readSpectrumBands(map, bins, db, heights, ANALYZER_MIN_DB, ANALYZER_MAX_DB);
  map.bands.forEach((band, i) => {
    if (high >= band.startBin && high < band.endBin) expect(heights[i]).toBeLessThan(before[i]);
    else expect(heights[i]).toBe(before[i]);
  });
  for (const value of [-Infinity, NaN, Infinity]) {
    bins.fill(value); readSpectrumBands(map, bins, db, heights, ANALYZER_MIN_DB, ANALYZER_MAX_DB);
    expect([...heights].every(value => value === 0)).toBe(true);
  }
});

test("analyzer attack/release parameters stay time based without changing Studio defaults", () => {
  const a = new Float32Array(1), b = new Float32Array(1), target = new Float32Array([1]);
  smoothSpectrum(a, target, 1 / 30, .015, .1);
  smoothSpectrum(b, target, 1 / 60, .015, .1); smoothSpectrum(b, target, 1 / 60, .015, .1);
  expect(a[0]).toBeCloseTo(b[0], 5); expect(a[0]).toBeGreaterThan(.85);
  target.fill(0); for (let i = 0; i < 24; i++) smoothSpectrum(a, target, 1 / 30, .015, .1);
  expect(a[0]).toBe(0);
});

test.each([1, 1.25, 1.5, 2])("display columns keep equal physical widths and gaps at DPR %s", dpr => {
  const mapping = createSpectrumMapping(44100, 8192, analyzerBandCount(380), 20, 20000);
  for (const plotWidth of [3, 34.2, 244, 294, 344.33, 564]) {
    const { columns } = createSpectrumDisplayGrid(mapping, 30.1, plotWidth, dpr);
    expect(columns).toHaveLength(analyzerDisplayColumnCount(plotWidth));
    const widths = columns.map(c => c.width * dpr);
    const gaps = columns.slice(1).map((c, i) => (c.x - columns[i].x - columns[i].width) * dpr);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1 + 1e-8);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1.99);
    if (gaps.length) {
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1 - 1e-8);
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-8);
    }
    for (const c of columns) {
      expect(c.x * dpr).toBeCloseTo(Math.round(c.x * dpr), 8);
      expect(c.width * dpr).toBeCloseTo(Math.round(c.width * dpr), 8);
    }
  }
  expect(analyzerDisplayColumnCount(294)).toBeLessThan(analyzerDisplayColumnCount(564));
  expect(analyzerDisplayColumnCount(0)).toBe(0);
  expect(analyzerDisplayColumnCount(NaN)).toBe(0);
  expect(createSpectrumDisplayGrid(mapping, 30, 2).columns).toEqual([]);
});

test.each([44100, 48000])("display log cells map to measured coverage, not band indices (%s Hz)", rate => {
  const mapping = createSpectrumMapping(rate, 8192, analyzerBandCount(380), 20, 20000);
  const { columns } = createSpectrumDisplayGrid(mapping, 30, 344);
  expect(columns.length).toBeGreaterThan(mapping.bands.length);
  columns.forEach((column, i) => {
    expect(column.lowHz).toBeCloseTo(20 * 1000 ** (i / columns.length), 8);
    expect(column.highHz).toBeCloseTo(20 * 1000 ** ((i + 1) / columns.length), 8);
    const centreX = (column.x + column.width / 2 - 30) / 344;
    expect(Math.abs(centreX - frequencyPosition(Math.sqrt(column.lowHz * column.highHz), 20, 20000))).toBeLessThan(1 / 344);
    column.weights.forEach((weight, j) => {
      const band = mapping.bands[column.startBand + j];
      expect(weight).toBeCloseTo(Math.max(0, Math.min(column.highHz, band.highHz) - Math.max(column.lowHz, band.lowHz)), 3);
    });
  });
  // Several low display cells share the first measured band, not new FFT bins.
  const shared = columns.filter(c => c.startBand === 0 && c.weights.length === 1);
  expect(shared.length).toBeGreaterThan(1);
  const db = new Float32Array(mapping.bands.length).fill(-Infinity), levels = new Float32Array(columns.length);
  db[0] = -35; readSpectrumDisplay({ columns }, db, levels, -90, -10);
  for (const column of shared) expect(levels[columns.indexOf(column)]).toBeCloseTo(55 / 80, 6);
  const limited = createSpectrumMapping(32000, 8192, 120, 20, 20000);
  expect(createSpectrumDisplayGrid(limited, 30, 300).columns.at(-1)!.highHz).toBeCloseTo(16000);
});

test.each([44100, 48000].flatMap(rate => [100, 1000, 8000].map(hz => [rate, hz])))("%s Hz FFT tone %s Hz stays at its true log region after display resampling", (rate, hz) => {
  const mapping = createSpectrumMapping(rate, 8192, analyzerBandCount(380), 20, 20000);
  const grid = createSpectrumDisplayGrid(mapping, 30, 344);
  const bins = new Float32Array(4096).fill(-Infinity), db = new Float32Array(mapping.bands.length), bandLevels = new Float32Array(db.length), columns = new Float32Array(grid.columns.length);
  const k = Math.round(hz * 8192 / rate); bins[k] = -30;
  readSpectrumBands(mapping, bins, db, bandLevels, -90, -10);
  readSpectrumDisplay(grid, db, columns, -90, -10);
  const peak = columns.indexOf(Math.max(...columns)), cell = grid.columns[peak];
  expect(Math.abs(frequencyPosition(Math.sqrt(cell.lowHz * cell.highHz), 20, 20000) - frequencyPosition(k * rate / 8192, 20, 20000))).toBeLessThan(0.035);
  const high = columns[peak]; bins[k] -= 12;
  readSpectrumBands(mapping, bins, db, bandLevels, -90, -10); readSpectrumDisplay(grid, db, columns, -90, -10);
  expect(columns[peak]).toBeCloseTo(high - 12 / 80, 5);
  bins.fill(-Infinity); readSpectrumBands(mapping, bins, db, bandLevels, -90, -10); readSpectrumDisplay(grid, db, columns, -90, -10);
  expect([...columns].every(level => level === 0)).toBe(true);
});

test("display mixing averages linear powers by Hz overlap; invalid and missing data are silence", () => {
  const mapping = createSpectrumMapping(48000, 8192, 140, 20, 20000);
  const grid = createSpectrumDisplayGrid(mapping, 30, 36);
  const i = grid.columns.findIndex(c => c.weights.length > 1), c = grid.columns[i];
  const db = new Float32Array(mapping.bands.length).fill(-Infinity), levels = new Float32Array(grid.columns.length);
  db[c.startBand] = -20; db[c.startBand + 1] = -40;
  readSpectrumDisplay(grid, db, levels, -90, -10);
  const power = (0.01 * c.weights[0] + 0.0001 * c.weights[1]) / c.totalWeight;
  expect(levels[i]).toBeCloseTo((10 * Math.log10(power) + 90) / 80, 6);
  for (const value of [-Infinity, NaN, Infinity]) { db.fill(value); readSpectrumDisplay(grid, db, levels, -90, -10); expect([...levels].every(v => v === 0)).toBe(true); }
  readSpectrumDisplay(grid, new Float32Array(), levels, -90, -10); expect([...levels].every(v => v === 0)).toBe(true);
});
