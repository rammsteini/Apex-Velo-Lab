/**
 * APEX VELO // LAB - import of Strava's bulk export ("Download your account" ZIP): pure logic, no DOM.
 *
 * The archive holds activities.csv (one row per activity: id, date, name, type, description, times,
 * distance, heart rate, power, calories ...) and activities/<file> (.fit / .gpx / .tcx, often .gz) for
 * every recorded activity. Each row becomes an activity in the same shape as the Strava API returns,
 * so the import goes through the same plan as "Sync from Strava" (VeloStravaSync.plan): exact-id and
 * fuzzy duplicate detection, preview, restore point and undo. Rides get their numbers and, with a power
 * meter, their second-by-second power from the activity file; other sports use the CSV summary.
 *
 * Works for any account language: Strava translates the CSV's column names and activity types but keeps
 * the column order, so columns are read by position (see COLUMNS) and the dates and types of English and
 * German exports are understood. The CSV is still needed: the activity files are not named by activity id.
 */
class VeloStravaArchive {
  // ------------------------------------------------------------------ CSV --
  /** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes. Returns rows of strings. */
  static parseCsvRows(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /**
   * Column positions. Strava translates the column names into the account's language but keeps their
   * order, so columns are read by position. Index 5 / 6 / 7 repeat at 15 / 17 / 30 in the long export
   * ("Elapsed Time", "Distance", "Max Heart Rate"): that is how the layout is recognised in any language.
   * The detail columns (15 on) are plain numbers in seconds, metres, bpm and watts; the shown distance at 6
   * is in the account's unit and may use a decimal comma.
   */
  static COLUMNS = {
    id: 0, date: 1, name: 2, type: 3, description: 4, elapsedShown: 5, distanceShown: 6, maxHrShown: 7,
    relEffort: 8, filename: 12, elapsed: 15, moving: 16, distanceM: 17, avgCadence: 29, maxHr: 30, avgHr: 31,
    maxWatts: 32, avgWatts: 33, calories: 34, work: 38, np: 46
  };

  /** True when the header has the long layout (detail columns at the expected positions). */
  static isLongLayout(header) {
    const h = header.map(x => String(x || '').trim().toLowerCase());
    const C = VeloStravaArchive.COLUMNS;
    return h.length > C.np && h[C.elapsedShown] === h[C.elapsed] && h[C.distanceShown] === h[C.distanceM] && h[C.maxHrShown] === h[C.maxHr];
  }

  /**
   * A number from the CSV, or 0 when empty or not positive. "2706.0", "1,234.5" and "25,15" (decimal
   * comma, as in a German export's shown distance) all work.
   */
  static num(v) {
    let s = String(v ?? '').trim();
    if (s.includes(',') && !s.includes('.') && !/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  static MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /**
   * Strava's export date, in UTC: "Jan 5, 2021, 6:30:12 PM" (English), "05.01.2021, 18:30:12"
   * (German and other day.month.year languages) or ISO. Returns an ISO string or ''.
   */
  static parseDate(v) {
    const s = String(v || '').trim();
    const iso = (y, mo, d, h, mi, sec) => {
      const t = Date.UTC(y, mo, d, h, mi, sec);
      return Number.isFinite(t) && mo >= 0 && mo < 12 && d >= 1 && d <= 31 ? new Date(t).toISOString() : '';
    };
    let m;
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      const t = Date.parse(s.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
      return Number.isFinite(t) ? new Date(t).toISOString() : '';
    }
    if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s))) {
      return iso(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
    }
    if ((m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s))) {
      const month = VeloStravaArchive.MONTHS[m[1].toLowerCase()];
      if (month === undefined) return '';
      let hh = +m[4];
      if (m[7]) { const pm = /p/i.test(m[7]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
      return iso(+m[3], month, +m[2], hh, +m[5], +(m[6] || 0));
    }
    return '';
  }

  /**
   * Activity type labels of non-English exports -> the API's sport_type. English labels need no table
   * ("Virtual Ride" -> "VirtualRide"). Unknown labels fall back to the language-neutral tags in the
   * export's last column ("riding|virtual", "running" ...), then to "Workout".
   */
  static TYPE_LABELS = {
    // German
    'radfahrt': 'Ride', 'virtuelle radfahrt': 'VirtualRide', 'e-bike-radfahrt': 'EBikeRide', 'mountainbike-fahrt': 'MountainBikeRide',
    'gravel-radfahrt': 'GravelRide', 'gravel-fahrt': 'GravelRide', 'e-mountainbike-fahrt': 'EMountainBikeRide', 'velomobil fahren': 'Velomobile',
    'handbike-fahrt': 'Handcycle', 'lauf': 'Run', 'virtueller lauf': 'VirtualRun', 'traillauf': 'TrailRun', 'spaziergang': 'Walk',
    'wandern': 'Hike', 'schneeschuhwanderung': 'Snowshoe', 'training': 'Workout', 'gewichtstraining': 'WeightTraining',
    'krafttraining': 'WeightTraining', 'yoga': 'Yoga', 'pilates': 'Pilates', 'schwimmen': 'Swim', 'ski alpin': 'AlpineSki',
    'skitouren': 'BackcountrySki', 'langlauf': 'NordicSki', 'eislaufen': 'IceSkate', 'stand-up-paddeln': 'StandUpPaddling',
    'kanu': 'Canoeing', 'kajak': 'Kayaking', 'rudern': 'Rowing', 'virtuelles rudern': 'VirtualRow', 'hiit': 'HighIntensityIntervalTraining',
    'crossfit': 'Crossfit', 'ellipsentrainer': 'Elliptical', 'stepper': 'StairStepper', 'klettern': 'RockClimbing'
  };

  /** Strava's sport_type values (the API's list). */
  static SPORT_TYPES = new Set(['AlpineSki', 'BackcountrySki', 'Badminton', 'Canoeing', 'Crossfit', 'EBikeRide', 'Elliptical', 'EMountainBikeRide',
    'Golf', 'GravelRide', 'Handcycle', 'HighIntensityIntervalTraining', 'Hike', 'IceSkate', 'InlineSkate', 'Kayaking', 'Kitesurf',
    'MountainBikeRide', 'NordicSki', 'Pickleball', 'Pilates', 'Racquetball', 'Ride', 'RockClimbing', 'RollerSki', 'Rowing', 'Run', 'Sail',
    'Skateboard', 'Snowboard', 'Snowshoe', 'Soccer', 'Squash', 'StairStepper', 'StandUpPaddling', 'Surfing', 'Swim', 'TableTennis', 'Tennis',
    'TrailRun', 'Velomobile', 'VirtualRide', 'VirtualRow', 'VirtualRun', 'Walk', 'WeightTraining', 'Wheelchair', 'Windsurf', 'Workout', 'Yoga']);

  /** Strava sport_type from the CSV's type label and (fallback) its tags column. */
  static sportType(label, tags = '') {
    const s = String(label || '').trim();
    const mapped = VeloStravaArchive.TYPE_LABELS[s.toLowerCase()];
    if (mapped) return mapped;
    // English label: "Virtual Ride" -> "VirtualRide", accepted when it is a real Strava sport type.
    const english = /^e-?bike ride$/i.test(s) ? 'EBikeRide' : s.replace(/[^A-Za-z]/g, '');
    if (VeloStravaArchive.SPORT_TYPES.has(english)) return english;
    const t = String(tags || '').toLowerCase().split('|');
    if (t.includes('e_riding')) return 'EBikeRide';
    if (t.includes('riding')) return t.includes('virtual') ? 'VirtualRide' : 'Ride';
    if (t.includes('running')) return t.includes('virtual') ? 'VirtualRun' : 'Run';
    return 'Workout';
  }

  /** Reads activities.csv (any language) into plain entries, in file order. */
  static parseActivitiesCsv(text) {
    const rows = VeloStravaArchive.parseCsvRows(text);
    if (rows.length < 2) throw new Error('activities.csv is empty.');
    const header = rows[0];
    const C = VeloStravaArchive.COLUMNS;
    const long = VeloStravaArchive.isLongLayout(header);
    if (header.length <= C.filename) throw new Error('activities.csv has an unknown layout (fewer columns than expected).');
    // Tags column: the last column named like the one at index 44 ("Type" / "Art"), present in newer exports.
    const typeCol = String(header[44] || '').trim();
    const tagsAt = long && typeCol ? header.map(x => String(x).trim()).lastIndexOf(typeCol) : -1;
    const n = VeloStravaArchive.num;
    const get = (row, i) => (i >= 0 && i < row.length ? row[i] : '');
    const detail = (row, k) => (long ? n(get(row, C[k])) : 0);
    const out = [];
    for (const row of rows.slice(1)) {
      const id = String(get(row, C.id)).trim();
      const startIso = VeloStravaArchive.parseDate(get(row, C.date));
      if (!/^\d+$/.test(id) || !startIso) continue;
      const tags = tagsAt > 44 ? get(row, tagsAt) : '';
      out.push({
        id, startIso,
        name: String(get(row, C.name)).trim(),
        typeLabel: String(get(row, C.type)).trim(),
        sportType: VeloStravaArchive.sportType(get(row, C.type), tags),
        description: String(get(row, C.description)).trim(),
        elapsed: detail(row, 'elapsed') || n(get(row, C.elapsedShown)),
        moving: detail(row, 'moving'),
        // Metres; the short export only has the shown distance (assumed km).
        distanceM: long ? detail(row, 'distanceM') : n(get(row, C.distanceShown)) * 1000,
        maxHr: detail(row, 'maxHr') || n(get(row, C.maxHrShown)), avgHr: detail(row, 'avgHr'),
        maxWatts: detail(row, 'maxWatts'), avgWatts: detail(row, 'avgWatts'), np: detail(row, 'np'),
        kj: detail(row, 'work') / 1000,
        calories: detail(row, 'calories'), avgCadence: detail(row, 'avgCadence'), relEffort: n(get(row, C.relEffort)),
        filename: String(get(row, C.filename)).trim().replace(/^\.?\//, '')
      });
    }
    if (!out.length) throw new Error('No activities could be read from activities.csv (unknown date format?).');
    return out;
  }

  /** ride / strength / run ... for an entry (VeloStravaSync's mapping of Strava sport types). */
  static kind(entry) {
    return typeof VeloStravaSync !== 'undefined' ? VeloStravaSync.activityKind(entry.sportType) : (/ride$/i.test(entry.sportType) ? 'ride' : 'other');
  }

  /** Activity files are read for rides only (other sports use the CSV summary). */
  static wantsFile(entry) {
    return !!entry.filename && /\.(fit|gpx|tcx)(\.gz)?$/i.test(entry.filename) && VeloStravaArchive.kind(entry) === 'ride';
  }

  /**
   * One CSV entry (plus the ride parsed from its file, if any) as a Strava API activity.
   * `ride` is a VeloRideImporter result: start time, duration, distance, heart rate, power and samples.
   * keepSamples = false keeps the file's exact power numbers (NP, TSS) but not its second-by-second data.
   */
  static toActivity(entry, ride = null, { keepSamples = true } = {}) {
    const r = ride && Number(ride.duration) > 0 ? ride : null;
    const pick = (csv, file) => (csv > 0 ? csv : Number(file) > 0 ? Number(file) : 0);
    const hasPower = !!(r && Number(r.avgWatts) > 0 && Array.isArray(r.samples) && r.samples.some(s => Number(s.power) > 0));
    // The file's first timestamp is the true start; the CSV date can be off by a few seconds.
    const fileStart = r ? Date.parse(r.date) : NaN;
    const startIso = Number.isFinite(fileStart) && Math.abs(fileStart - Date.parse(entry.startIso)) < 6 * 3600000
      ? new Date(fileStart).toISOString() : entry.startIso;
    const a = {
      id: entry.id,
      name: entry.name || '',
      type: entry.sportType,
      sport_type: entry.sportType,
      start_date: startIso.replace('.000Z', 'Z'),
      elapsed_time: Math.round(pick(entry.elapsed, r && r.duration)),
      moving_time: Math.round(pick(entry.moving, r && r.duration) || entry.elapsed),
      distance: Math.round(pick(entry.distanceM, r && r.totalDistanceMeters)),
      average_heartrate: pick(entry.avgHr, r && r.avgHr),
      max_heartrate: pick(entry.maxHr, r && r.maxHr),
      average_cadence: pick(entry.avgCadence, r && r.avgCadence),
      suffer_score: entry.relEffort,
      description: entry.description || '',
      calories: entry.calories,
      detailed: true,                          // description and calories are known (no detail fetch needed)
      trainer: /^virtual/i.test(entry.sportType)
    };
    if (hasPower) {
      a.device_watts = true;
      a.average_watts = r.avgWatts;
      a.max_watts = r.maxWatts || entry.maxWatts;
      a.weighted_average_watts = r.np || entry.np;
      a.kilojoules = r.kj || entry.kj;
      if (keepSamples) a.samples = VeloStravaArchive.slimSamples(r.samples);
      else a.streams = 'none'; // summary on purpose: a later Strava sync does not fetch the stream either
    } else if (VeloStravaArchive.kind(entry) === 'ride') {
      // No power meter: the CSV's watts are Strava's estimate, so they are left out and TSS comes from heart
      // rate (marked as estimated). There is also no power stream to fetch later for this ride.
      a.streams = 'none';
    }
    for (const k of Object.keys(a)) {
      if (['id', 'name', 'description', 'detailed'].includes(k)) continue;
      if (a[k] === undefined || a[k] === 0 || a[k] === false || a[k] === '') delete a[k];
    }
    return a;
  }

  /**
   * Second-by-second samples with only what the analyses use (time, power, heart rate, cadence, speed,
   * distance, pedal balance, pause markers): about a third of the size of a parsed file's samples.
   */
  static slimSamples(samples) {
    return (samples || []).map(x => {
      const o = { time: x.time, power: Number(x.power) || 0 };
      if (Number(x.hr) > 0) o.hr = x.hr;
      if (Number(x.cadence) > 0) o.cadence = x.cadence;
      if (Number(x.speed) > 0) o.speed = x.speed;
      if (Number(x.dist) > 0) o.dist = Math.round(x.dist * 1000) / 1000;
      if (Number(x.leftBal) > 0 && Number(x.rightBal) > 0) { o.leftBal = x.leftBal; o.rightBal = x.rightBal; }
      if (x.segmentStart) o.segmentStart = true;
      return o;
    });
  }

  /** Choices for how far back second-by-second data is kept (years; 0 = none, Infinity = all). */
  static SAMPLE_YEARS = [1, 2, 5, Infinity, 0];
  static DEFAULT_SAMPLE_YEARS = 2;
  static SAMPLE_YEARS_KEY = 'apex_strava_archive_sample_years';

  /** The earliest start (ms) whose rides keep their samples, for a choice in years. */
  static sampleCutoff(years, now = Date.now()) {
    if (years === Infinity) return -Infinity;
    if (!(years > 0)) return Infinity;
    const d = new Date(now);
    return new Date(d.getFullYear() - years, d.getMonth(), d.getDate()).getTime();
  }

  /** The plan range covering every activity in the archive (local days, like VeloStravaSync.rangeFor). */
  static rangeFor(activities) {
    const ts = activities.map(a => Date.parse(a.start_date)).filter(Number.isFinite);
    const min = ts.length ? Math.min(...ts) : Date.now();
    const max = ts.length ? Math.max(...ts) : Date.now();
    const a = new Date(min), b = new Date(max);
    const after = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    const before = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1);
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return {
      choice: { mode: 'archive' }, afterMs: after.getTime(), beforeMs: before.getTime(),
      afterIso: after.toISOString(), beforeIso: before.toISOString(),
      label: `Strava archive (${day(after)} to ${day(new Date(before.getTime() - 86400000))})`
    };
  }
}

if (typeof window !== 'undefined') window.VeloStravaArchive = VeloStravaArchive;
if (typeof module !== 'undefined') module.exports = VeloStravaArchive;
