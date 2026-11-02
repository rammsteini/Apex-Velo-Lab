/**
 * APEX VELO // LAB - "Sync from Strava": pure planning logic (no DOM, no storage, no network).
 *
 * Strava is only ever READ. A sync is a complete, idempotent refresh of a date range:
 *  - Strava-imported records (source 'Strava') in the range are rebuilt from what Strava returns now:
 *    updated when edited on Strava, added when new, removed only when deleted on Strava.
 *  - Rides recorded in this app (cockpit, HealthFit, FIT imports - anything whose source is not
 *    'Strava') keep their identity and recordings. Matched summaries use Strava distance/time
 *    and fill missing metrics; native rides are never deleted.
 *  - Records outside the range are untouched.
 *
 * Duplicates are caught in three layers:
 *  1. Exact id: an activity already linked to a ride (ride.strava.activityId / stravaActivityId)
 *     is never imported again.
 *  2. Fuzzy (VeloDedupe): a duplicate of an existing ride is linked to it instead of imported
 *     (the app's 1 Hz ride always wins); 0.6-0.8 matches are "possible" and wait for the rider.
 *  3. Within the Strava batch: the same session logged twice (e.g. Motra + watch) keeps the richer
 *     one; the other id is remembered as merged and never imported.
 *
 * The app layer (app-strava-sync.js) turns a plan into storage writes: backup first, validate, write once.
 */
class VeloStravaSync {
  static SOURCE = 'Strava';
  static PRESET_WEEKS = [2, 4, 8, 12, 26];
  static DEFAULT_WEEKS = 8;
  static STATE_KEY = 'apex_strava_sync_state';     // decisions, merged ids, detail cache, last sync
  static RANGE_KEY = 'apex_strava_sync_range';     // the range picker's last choice
  static STRENGTH_KEY = 'apex_strength_load';      // strength-load toggles
  static BACKUP_PREFIX = 'strava_sync_backup_';
  static KEEP_BACKUPS = 5;
  static STRENGTH_TSS_CAP = 60;
  static HEAVY_STRENGTH_TSS = 45;
  static DETAIL_BATCH = 10;          // activities/{id} per request to the local server
  static DETAIL_BUDGET = 60;         // detail requests per sync (Strava allows 100 reads / 15 min)
  static DETAIL_STALE_MS = 3 * 86400000;
  static STREAM_BUDGET = 30;         // activities/{id}/streams per sync (1 read request each)
  static STREAM_MAX_GAP_S = 5;       // gaps up to 5 s (smart recording) are held; longer gaps are pauses
  static AUTOCHECK_KEY = 'apex_strava_autocheck';

  // ------------------------------------------------------------- streams --
  /**
   * Converts Strava streams ({ time: {data}, watts: {data}, ... } or plain arrays) into the app's
   * 1 Hz samples. Only recorded channels are included. A gap of 2-5 s (a device's "smart recording")
   * holds the last reading so every sample is one second; a longer gap is a pause: its seconds are not filled,
   * the time channel keeps the gap and the next sample is marked segmentStart.
   * Returns null when there is no power stream.
   */
  static streamsToSamples(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const get = (k) => { const v = raw[k]; const d = v && !Array.isArray(v) ? v.data : v; return Array.isArray(d) ? d : null; };
    const time = get('time'), watts = get('watts');
    if (!time || !watts || time.length < 2 || watts.length !== time.length) return null;
    const hr = get('heartrate'), cad = get('cadence'), vel = get('velocity_smooth'), dist = get('distance');
    const same = (arr) => arr && arr.length === time.length ? arr : null;
    const H = same(hr), C = same(cad), V = same(vel), Dd = same(dist);
    const sample = (i) => {
      const s = { power: Math.max(0, Math.round(Number(watts[i]) || 0)) };
      if (H && Number(H[i]) > 0) s.hr = Math.round(Number(H[i]));
      if (C) s.cadence = Math.round(Number(C[i]) || 0);
      if (V) s.speed = Math.round((Number(V[i]) || 0) * 36) / 10;
      if (Dd) s.dist = Math.round(Number(Dd[i]) || 0) / 1000;
      return s;
    };
    // Keep the activity's own clock: a pause (cafe stop) stays a gap in time and starts a new segment, so
    // rolling peaks, NP and CP never join the efforts either side of it, and W' recovers across it.
    const out = [], t0 = Number(time[0]) || 0;
    for (let i = 0; i < time.length; i++) {
      const cur = sample(i);
      const t = Math.round(Number(time[i]) - t0) + 1;
      const prev = out[out.length - 1];
      if (prev && !(t > prev.time)) continue; // repeated or out-of-order second
      const gap = prev ? t - prev.time : 1;
      if (gap > 1 && gap <= VeloStravaSync.STREAM_MAX_GAP_S) {
        for (let k = 1; k < gap; k++) out.push({ ...prev, segmentStart: false, time: prev.time + k });
      }
      out.push({ time: t, ...cur, ...(gap > VeloStravaSync.STREAM_MAX_GAP_S ? { segmentStart: true } : {}) });
    }
    return out.length >= 60 ? out : null;
  }

  /** Real power data worth fetching: a cycling activity with a power meter (not Strava's estimate). */
  static hasMeasuredPower(a) {
    return VeloStravaSync.activityKind(a.sport_type || a.type) === 'ride' && a.device_watts === true && VeloStravaSync.num(a.average_watts) > 0;
  }

  /**
   * Activities of a plan whose imported record should get second-by-second data:
   * new or refreshed or unchanged imports with a power meter and no samples yet (and not tried before).
   */
  static streamCandidates(plan) {
    const want = [];
    const consider = (a, rec) => {
      if (!a || !rec || !VeloStravaSync.hasMeasuredPower(a) || a.samples) return;
      if ((Array.isArray(rec.samples) && rec.samples.length) || rec.streams === 'none') return;
      want.push(String(a.id));
    };
    plan.new.forEach(x => consider(x.activity, x.record));
    plan.refreshed.forEach(x => consider(x.activity, x.record));
    plan.linked.forEach(x => consider(x.activity, x.record));
    (plan.unchangedList || []).forEach(x => consider(x.activity, x.record));
    return [...new Set(want)];
  }

  // ------------------------------------------------------------ helpers --
  static isStravaRecord(r) { return !!r && r.source === VeloStravaSync.SOURCE; }
  static isAppNative(r) { return !!r && r.source !== VeloStravaSync.SOURCE; }
  /** The Strava activity id an app-native ride is linked to (or ''). */
  static linkOf(r) { return r ? String((r.strava && r.strava.activityId) || r.stravaActivityId || '') : ''; }

  /** ride / strength / walk / run / mobility / other, from Strava's sport_type (or type). */
  static activityKind(sport) {
    const s = String(sport || '');
    const fam = (typeof VeloDedupe !== 'undefined' && VeloDedupe.FAMILY[s]) || null;
    if (fam) return fam;
    if (/ride$|^velomobile$|^handcycle$/i.test(s)) return 'ride';
    if (/strength|weight|workout|crossfit|hiit/i.test(s)) return 'strength';
    if (/yoga|pilates|stretch/i.test(s)) return 'mobility';
    if (/walk|hike/i.test(s)) return 'walk';
    if (/run/i.test(s)) return 'run';
    return 'other';
  }

  static isCycling(r) { return !r || !r.activityType || r.activityType === 'ride'; }

  static localDayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  static parseDay(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  static dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Normalises a range choice: { mode: 'preset', weeks } or { mode: 'custom', from, to } (YYYY-MM-DD). */
  static normaliseChoice(c) {
    if (c && c.mode === 'custom' && VeloStravaSync.parseDay(c.from) && VeloStravaSync.parseDay(c.to)) {
      return { mode: 'custom', from: c.from, to: c.to };
    }
    const w = Number(c && c.weeks);
    return { mode: 'preset', weeks: VeloStravaSync.PRESET_WEEKS.includes(w) ? w : VeloStravaSync.DEFAULT_WEEKS };
  }

  /**
   * The time window of a range choice, in local days: [after, before).
   * A preset of N weeks covers the last N*7 days including today.
   */
  static rangeFor(choice, now = new Date()) {
    const c = VeloStravaSync.normaliseChoice(choice);
    let after, before;
    if (c.mode === 'custom') {
      after = VeloStravaSync.parseDay(c.from);
      before = VeloStravaSync.parseDay(c.to);
      if (before < after) { const t = after; after = before; before = t; }
      before = new Date(before.getFullYear(), before.getMonth(), before.getDate() + 1);
    } else {
      const today = VeloStravaSync.localDayStart(now);
      after = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (c.weeks * 7 - 1));
      before = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    }
    const lastDay = new Date(before.getFullYear(), before.getMonth(), before.getDate() - 1);
    return {
      choice: c, afterMs: after.getTime(), beforeMs: before.getTime(),
      afterIso: after.toISOString(), beforeIso: before.toISOString(),
      label: c.mode === 'custom'
        ? `${VeloStravaSync.dayKey(after)} to ${VeloStravaSync.dayKey(lastDay)}`
        : `last ${c.weeks} weeks (${VeloStravaSync.dayKey(after)} to ${VeloStravaSync.dayKey(lastDay)})`
    };
  }

  static inRange(dateIso, range) {
    const t = Date.parse(dateIso);
    return Number.isFinite(t) && t >= range.afterMs && t < range.beforeMs;
  }

  /** ISO string (UTC, no milliseconds) or ''. */
  static isoZ(v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString().replace('.000Z', 'Z') : '';
  }

  static num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  /** Stable JSON (sorted keys) for comparing records. */
  static stable(v) {
    if (Array.isArray(v)) return `[${v.map(VeloStravaSync.stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${VeloStravaSync.stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  // --------------------------------------------------- strength sessions --
  static LIFTS = [
    ['Back squat', /back\s*squat/i], ['Front squat', /front\s*squat/i], ['Split squat', /split\s*squat|bulgarian/i],
    ['Squat', /squat/i], ['Romanian deadlift', /romanian\s*dead\s*lift|romanian|\brdl\b/i], ['Deadlift', /dead\s*lift/i],
    ['Hip thrust', /hip\s*thrust/i], ['Leg press', /leg\s*press/i], ['Lunge', /lunge/i], ['Step-up', /step[\s-]*up/i],
    ['Bench press', /bench/i], ['Overhead press', /overhead\s*press|military\s*press|\bohp\b/i], ['Pull-up', /pull[\s-]*up|chin[\s-]*up/i],
    ['Row', /\brow(s|ing)?\b/i], ['Clean', /\bclean\b/i], ['Snatch', /snatch/i], ['Calf raise', /calf/i], ['Leg curl', /leg\s*curl|hamstring\s*curl/i],
    ['Leg extension', /leg\s*extension/i]
  ];
  static LEG_LIFTS = /squat|dead\s*lift|\brdl\b|romanian|lunge|leg\s*press|hip\s*thrust|step[\s-]*up|bulgarian/i;

  /** Exercise lines of a Strava / Motra description (one exercise per line). */
  static parseExercises(description) {
    return String(description || '')
      .split(/\r?\n/)
      .map(l => l.replace(/^[\s\-*•·\d.)]+(?=[A-Za-zÀ-ÿ])/, '').trim())
      .filter(l => /[A-Za-zÀ-ÿ]{3}/.test(l) && l.length <= 140 && !/^https?:\/\//i.test(l))
      .slice(0, 30);
  }

  /** Main lifts named in a session (known lift names first, in order of appearance). */
  static mainLifts(rec) {
    // Most specific names first; a matched phrase is blanked so "Back squat" is not also counted as "Squat".
    let text = (rec.description || (rec.exercises || []).join('\n'));
    const found = [];
    for (const [name, re] of VeloStravaSync.LIFTS) {
      const g = new RegExp(re.source, 'gi');
      if (g.test(text)) { found.push(name); text = text.replace(new RegExp(re.source, 'gi'), ' '); }
    }
    if (found.length) return found.slice(0, 4);
    return (rec.exercises || []).slice(0, 2).map(l => l.replace(/[:\-–].*$/, '').replace(/\d.*$/, '').trim()).filter(Boolean);
  }

  static isHeavyLegDay(r) {
    if (!r || r.activityType !== 'strength') return false;
    const text = [r.description || '', ...(r.exercises || [])].join('\n');
    return VeloStravaSync.LEG_LIFTS.test(text) || VeloStravaSync.num(r.strengthTss) >= VeloStravaSync.HEAVY_STRENGTH_TSS;
  }

  /** Strength sessions in the look-back window, for the coach prompts. */
  static strengthSummary(workouts, days, now = new Date()) {
    const since = now.getTime() - days * 86400000;
    const list = (workouts || [])
      .filter(r => r && r.activityType === 'strength')
      .filter(r => { const t = Date.parse(r.date); return Number.isFinite(t) && t >= since && t <= now.getTime(); })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const sessions = list.map(r => ({
      date: (typeof VeloMetrics !== 'undefined' ? VeloMetrics.localDateKey(r.date) : String(r.date).slice(0, 10)),
      lifts: VeloStravaSync.mainLifts(r), heavyLegs: VeloStravaSync.isHeavyLegDay(r), strengthTss: VeloStravaSync.num(r.strengthTss)
    }));
    const line = sessions.length
      ? `${sessions.length} strength session${sessions.length === 1 ? '' : 's'} in the last ${days} days: ` +
        sessions.slice(0, 12).map(s => `${s.date}${s.heavyLegs ? ' (heavy legs)' : ''}${s.lifts.length ? ' - ' + s.lifts.join(', ') : ''}`).join('; ') +
        '. Heavy leg days count like a hard day: no key ride the day after.'
      : `No strength sessions in the last ${days} days.`;
    return { count: sessions.length, sessions, line };
  }

  /**
   * Every non-cycling activity in the look-back window as plain facts for the AI prompts (newest first):
   * date and time, sport, title, duration, distance, heart rate, Strava relative effort, calories and the
   * session notes / exercises. No labels or rules are added: the AI judges the effect on the rider itself.
   */
  static otherActivitiesSummary(workouts, days, now = new Date(), max = 25) {
    const since = now.getTime() - days * 86400000;
    const list = (workouts || [])
      .filter(r => r && r.activityType && r.activityType !== 'ride')
      .filter(r => { const t = Date.parse(r.date); return Number.isFinite(t) && t >= since && t <= now.getTime(); })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    const n = VeloStravaSync.num;
    const clean = (t, len) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, len);
    const lines = list.slice(0, max).map(r => {
      const local = String(r.startLocal || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
      const when = local ? `${local[1]} ${local[2]}` : (typeof VeloMetrics !== 'undefined' ? VeloMetrics.localDateKey(r.date) : String(r.date).slice(0, 10));
      const facts = [`${Math.round(n(r.duration) / 60)} min`];
      if (n(r.distanceKm) > 0) facts.push(`${r.distanceKm} km`);
      if (n(r.avgHr) > 0) facts.push(`avg HR ${r.avgHr}${n(r.maxHr) > 0 ? `, max ${r.maxHr}` : ''} bpm`);
      if (n(r.sufferScore) > 0) facts.push(`Strava relative effort ${r.sufferScore}`);
      if (n(r.totalCalories) > 0) facts.push(`${r.totalCalories} kcal`);
      const notes = clean(r.description || (r.exercises || []).join('; '), 300);
      return `- ${when}: ${r.sportType || r.activityType} "${clean(r.title, 80)}" (${facts.join(', ')})${notes ? ` - notes: ${notes}` : ''}`;
    });
    const more = list.length > max ? `\n- ...and ${list.length - max} older ones` : '';
    return { count: list.length, line: lines.length ? lines.join('\n') + more : `- None in the last ${days} days.` };
  }

  // ------------------------------------------------- activity -> record --
  /**
   * Builds the history record for a Strava activity. Deterministic, so re-syncing unchanged
   * activities gives identical records. `existing` (the current imported record) keeps the FTP
   * used for its TSS and any details this sync could not fetch.
   */
  static toRecord(a, opts = {}, existing = null) {
    const n = VeloStravaSync.num;
    const id = String(a.id);
    const sport = String(a.sport_type || a.type || '');
    const kind = VeloStravaSync.activityKind(sport);
    const dur = Math.round(n(a.moving_time) || n(a.elapsed_time));
    const rec = {
      id: `strava_${id}`,
      source: VeloStravaSync.SOURCE,
      stravaActivityId: id,
      strava: { state: 'imported', activityId: id },
      title: String(a.name || '').trim() || (kind === 'ride' ? 'Strava ride' : sport || 'Strava activity'),
      date: VeloStravaSync.isoZ(a.start_date),
      duration: dur,
      activityType: kind,
      sportType: sport,
      profileName: (existing && existing.profileName) || opts.profileName || ''
    };
    if (a.start_date_local) rec.startLocal = VeloStravaSync.isoZ(a.start_date_local);
    if (n(a.elapsed_time) && n(a.elapsed_time) !== dur) rec.elapsedSec = Math.round(n(a.elapsed_time));
    if (a.trainer) rec.trainer = true;
    if (n(a.distance) > 0) { rec.totalDistanceMeters = Math.round(n(a.distance)); rec.distanceKm = Math.round(n(a.distance) / 10) / 100; }
    if (n(a.average_watts) > 0) rec.avgWatts = Math.round(n(a.average_watts));
    if (n(a.max_watts) > 0) rec.maxWatts = Math.round(n(a.max_watts));
    if (n(a.weighted_average_watts) > 0) rec.np = Math.round(n(a.weighted_average_watts));
    if (n(a.kilojoules) > 0) rec.kj = Math.round(n(a.kilojoules));
    if (n(a.average_heartrate) > 0) rec.avgHr = Math.round(n(a.average_heartrate));
    if (n(a.max_heartrate) > 0) rec.maxHr = Math.round(n(a.max_heartrate));
    if (n(a.average_cadence) > 0) rec.avgCadence = Math.round(n(a.average_cadence));
    if (n(a.suffer_score) > 0) rec.sufferScore = Math.round(n(a.suffer_score));
    // Details (description, calories) come from activities/{id}; when this sync could not fetch them,
    // the values already imported are kept instead of being wiped.
    const detailed = a.detailed === true;
    const desc = detailed ? String(a.description || '').trim() : (existing && existing.description) || '';
    const kcal = detailed ? n(a.calories) : n(existing && existing.totalCalories);
    if (desc) rec.description = desc;
    if (kcal > 0) rec.totalCalories = Math.round(kcal);

    if (kind === 'ride') {
      const ftp = n(existing && existing.ftpAtRide) || n(opts.ftp) || 185;
      rec.ftpAtRide = ftp;
      // Second-by-second power: freshly fetched streams, else the samples already imported.
      const samples = Array.isArray(a.samples) && a.samples.length ? a.samples
        : (existing && Array.isArray(existing.samples) && existing.samples.length ? existing.samples : null);
      const streamsFlag = a.streams === 'none' ? 'none' : samples ? 'ok' : (existing && existing.streams) || undefined;
      if (streamsFlag) rec.streams = streamsFlag;
      const h = dur / 3600;
      const pw = rec.np || rec.avgWatts || 0;
      let ifv, method;
      if (samples && typeof VeloMetrics !== 'undefined') {
        rec.samples = VeloMetrics.toOneHz(samples);
        const powers = rec.samples.map(s => s.power || 0);
        rec.avgWatts = VeloMetrics.avgPower(powers);
        const np = VeloMetrics.normalizedPower(rec.samples) || rec.avgWatts || 0;
        rec.np = Math.round(np);
        rec.maxWatts = VeloMetrics.stats(powers).max;
        ifv = np / ftp; method = 'power-stream';
        rec.if = (Math.round(ifv * 100) / 100).toFixed(2);
        rec.tss = Math.round((rec.samples.length / 3600) * ifv * ifv * 100);
        rec.tssMethod = method;
        rec.tssEstimated = false;
        return rec;
      }
      if (pw > 0) { ifv = pw / ftp; method = 'power'; }
      else if (rec.avgHr) {
        // A threshold HR from the profile is stored with the record, so later profile edits do not rewrite
        // old imports. An estimated one (90% of max HR) is replaced once you enter your real threshold HR.
        const lthr = VeloStravaSync.lthrFor(rec, opts, existing);
        ifv = Math.max(0.4, Math.min(1.2, rec.avgHr / lthr)); method = 'hr';
      } else { ifv = 0.65; method = 'duration'; }
      rec.if = (Math.round(ifv * 100) / 100).toFixed(2);
      rec.tss = Math.round(h * ifv * ifv * 100);
      rec.tssMethod = method;
      rec.tssEstimated = method !== 'power';
    } else {
      rec.tss = 0; // never counts as cycling load
      if (kind === 'strength') {
        const cap = VeloStravaSync.STRENGTH_TSS_CAP;
        let st, method;
        if (rec.sufferScore) { st = rec.sufferScore; method = 'relative effort'; }
        else if (rec.avgHr) {
          const lthr = VeloStravaSync.lthrFor(rec, opts, existing);
          st = (dur / 3600) * Math.pow(Math.min(1, rec.avgHr / lthr), 2) * 100 * 0.6; method = 'heart rate';
        }
        else { st = (dur / 3600) * 30; method = 'duration'; }
        rec.strengthTss = Math.min(cap, Math.round(st));
        rec.strengthTssMethod = method;
        const ex = VeloStravaSync.parseExercises(desc);
        if (ex.length) rec.exercises = ex;
        rec.heavyLegs = VeloStravaSync.isHeavyLegDay(rec);
      }
    }
    return rec;
  }

  /** Combine matched summaries while preserving local samples and measured training load. */
  static combineRecord(ride, activity, opts = {}) {
    const S = VeloStravaSync;
    const summary = S.toRecord(activity, opts, ride);
    const next = { ...ride };
    const positive = v => Number.isFinite(Number(v)) && Number(v) > 0;
    const fallback = ride.stravaSummaryFallback || {
      duration: ride.duration || 0, distanceKm: ride.distanceKm || 0,
      totalDistanceMeters: ride.totalDistanceMeters || 0, elapsedSec: ride.elapsedSec || 0
    };
    next.stravaSummaryFallback = fallback;
    const moving = positive(activity.moving_time) ? Number(activity.moving_time)
      : positive(activity.elapsed_time) ? Number(activity.elapsed_time) : 0;
    next.duration = moving ? Math.round(moving) : fallback.duration || ride.duration;
    if (positive(next.duration)) next.durationMin = Math.round(next.duration / 60);
    const meters = positive(activity.distance) ? Number(activity.distance)
      : Number(fallback.totalDistanceMeters) || Number(fallback.distanceKm) * 1000
        || Number(ride.totalDistanceMeters) || Number(ride.distanceKm) * 1000;
    if (positive(meters)) {
      next.totalDistanceMeters = Math.round(meters);
      next.distanceKm = Math.round(meters / 10) / 100;
    }
    const elapsed = positive(activity.elapsed_time) ? Math.round(Number(activity.elapsed_time)) : fallback.elapsedSec;
    if (positive(elapsed)) next.elapsedSec = elapsed;
    else delete next.elapsedSec;
    if (positive(next.distanceKm) && positive(next.duration))
      next.avgSpeedKmh = Math.round(next.distanceKm / (next.duration / 3600) * 10) / 10;
    for (const key of ['avgWatts', 'maxWatts', 'np', 'kj', 'avgHr', 'maxHr', 'avgCadence', 'totalCalories']) {
      if (!positive(next[key]) && positive(summary[key])) next[key] = summary[key];
    }
    if (!next.description && summary.description) next.description = summary.description;
    if (!(Array.isArray(ride.samples) && ride.samples.length) && summary.samples) {
      next.samples = summary.samples;
      next.samplesCount = summary.samples.length;
      next.streams = summary.streams;
    } else if (!ride.streams && summary.streams) next.streams = summary.streams;
    if (!positive(next.tss) && !(Array.isArray(ride.samples) && ride.samples.length)) {
      for (const key of ['tss', 'if', 'tssMethod', 'tssEstimated', 'ftpAtRide', 'lthrAtRide', 'lthrEstimated'])
        if (summary[key] !== undefined) next[key] = summary[key];
    }
    return next;
  }

  /** Threshold HR for heart-rate TSS; sets rec.lthrAtRide (+ lthrEstimated when guessed from max HR). */
  static lthrFor(rec, opts, existing) {
    const n = VeloStravaSync.num;
    let lthr, est = false;
    if (existing && n(existing.lthrAtRide) && !existing.lthrEstimated) lthr = n(existing.lthrAtRide);
    else if (n(opts.lthr)) lthr = n(opts.lthr);
    else { lthr = Math.round((n(opts.maxHr) || 175) * 0.9); est = true; }
    rec.lthrAtRide = lthr;
    if (est) rec.lthrEstimated = true;
    return lthr;
  }

  /** What to hand VeloDedupe for any record or activity (explicit sport family, energy in kcal). */
  static dedupeView(x, isActivity) {
    if (isActivity) {
      return {
        id: String(x.id), start: VeloStravaSync.isoZ(x.start_date), family: VeloStravaSync.activityKind(x.sport_type || x.type), localAsUtc: false,
        moving_time: VeloStravaSync.num(x.moving_time) || VeloStravaSync.num(x.elapsed_time),
        elapsed_time: VeloStravaSync.num(x.elapsed_time) || VeloStravaSync.num(x.moving_time),
        distance: VeloStravaSync.num(x.distance), kcal: VeloStravaSync.num(x.calories) || VeloStravaSync.num(x.kilojoules) || undefined
      };
    }
    return {
      id: x.id, start: x.date, family: x.activityType || 'ride', localAsUtc: VeloStravaSync.storesLocalAsUtc(x),
      durSec: VeloStravaSync.num(x.duration), elapsed_time: VeloStravaSync.num(x.elapsedSec) || VeloStravaSync.num(x.duration),
      distM: VeloStravaSync.num(x.totalDistanceMeters) || VeloStravaSync.num(x.distanceKm) * 1000,
      kcal: VeloStravaSync.num(x.totalCalories) || VeloStravaSync.num(x.kj) || undefined
    };
  }

  static score(a, b) { return VeloDedupe.score(a, b); }

  /** HealthFit records keep the local wall clock labelled as UTC; Strava and cockpit rides store true UTC. */
  static storesLocalAsUtc(r) { return !VeloStravaSync.isStravaRecord(r) && /healthfit/i.test(`${r.source || ''} ${r.profileName || ''}`); }

  /** How much a Strava activity says about the session (description with exercises beats a bare record). */
  static richness(a) {
    const ex = VeloStravaSync.parseExercises(a.description).length;
    return (ex >= 2 ? 4 : a.description ? 2 : 0) + (VeloStravaSync.num(a.calories) > 0 ? 1 : 0) + (String(a.name || '').length > 20 ? 0.5 : 0);
  }

  // ---------------------------------------------------------------- plan --
  /**
   * Plans a sync. Pure: nothing is changed.
   * @param {object} p
   *   activities - what Strava returned for the range (with details merged in where fetched)
   *   history    - the app's current records
   *   range      - from rangeFor()
   *   state      - { merged: {loserId: keptId}, decisions: {id: {verdict:'import'|'same', target}} }
   *   opts       - { ftp, maxHr, lthr, profileName }
   *   keepMissing - true for an archive import: records missing from `activities` are never removed
   *                 and no stale links are reported (the archive is a snapshot, not the live account)
   */
  static plan({ activities, history, range, state = {}, opts = {}, keepMissing = false }) {
    const S = VeloStravaSync;
    const mergedPrev = { ...(state.merged || {}) };
    const decisions = state.decisions || {};
    const hist = history || [];
    const acts = (activities || []).filter(a => a && a.id != null && S.inRange(a.start_date, range))
      .map(a => ({ ...a, id: String(a.id) }));
    const fetchedIds = new Set(acts.map(a => a.id));

    const appLinks = new Map();      // strava id -> app-native ride
    const stravaRecs = new Map();    // strava id -> imported record
    hist.forEach(r => {
      if (S.isStravaRecord(r)) { if (r.stravaActivityId) stravaRecs.set(String(r.stravaActivityId), r); }
      else { const l = S.linkOf(r); if (l) appLinks.set(l, r); }
    });

    const out = {
      range, opts, fetched: acts.length,
      new: [], linked: [], refreshed: [], removed: [], merged: [], review: [], staleLinks: [],
      alreadyLinked: 0, unchanged: 0, unchangedList: [], knownMerged: 0,
      mergedMap: { ...mergedPrev }, decisions: { ...decisions }
    };

    // Previously merged ids stay merged (never imported).
    const pool = [];
    acts.forEach(a => {
      if (mergedPrev[a.id] && !appLinks.has(a.id)) {
        out.knownMerged++;
        const rec = stravaRecs.get(a.id);
        if (rec) out.merged.push({ activity: a, keptId: mergedPrev[a.id], removeRecordId: rec.id, reason: 'merged earlier' });
        return;
      }
      pool.push(a);
    });

    // Layer 3: the same session logged twice within this batch -> keep the richer one.
    const pref = (a) => [appLinks.has(a.id) ? 2 : stravaRecs.has(a.id) ? 1 : 0, S.richness(a), S.num(a.elapsed_time)];
    const ordered = [...pool].sort((x, y) => {
      const px = pref(x), py = pref(y);
      for (let i = 0; i < px.length; i++) if (px[i] !== py[i]) return py[i] - px[i];
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    // Two sessions more than a day apart never match (VeloDedupe allows 20 min plus a timezone offset), so
    // each activity is compared only with those from its own and the neighbouring days: fast for a whole
    // Strava archive, with the same result as comparing every pair.
    const DAY = 86400000;
    const dayOf = (t) => Number.isFinite(t) ? Math.floor(t / DAY) : NaN;
    const near = (buckets, t) => {
      const d = dayOf(t);
      if (!Number.isFinite(d)) return buckets.get('all') || [];
      return [].concat(buckets.get(d - 1) || [], buckets.get(d) || [], buckets.get(d + 1) || [], buckets.get('all') || []);
    };
    const addTo = (buckets, t, item) => {
      const d = dayOf(t);
      const key = Number.isFinite(d) ? d : 'all';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(item);
    };
    const kept = [];
    const keptByDay = new Map();
    ordered.forEach(a => {
      const va = S.dedupeView(a, true);
      const twin = near(keptByDay, Date.parse(a.start_date)).find(k => VeloDedupe.classify(S.score(va, S.dedupeView(k, true)).score) === 'duplicate');
      if (twin && !(appLinks.has(a.id) && appLinks.has(twin.id))) {
        const sc = S.score(va, S.dedupeView(twin, true));
        const rec = stravaRecs.get(a.id);
        out.merged.push({ activity: a, keptId: twin.id, keptName: twin.name, score: sc.score, why: sc.why, removeRecordId: rec ? rec.id : null, reason: 'logged twice on Strava' });
        out.mergedMap[a.id] = twin.id;
        return;
      }
      kept.push(a);
      addTo(keptByDay, Date.parse(a.start_date), a);
    });

    // Layers 1 and 2 for every kept activity.
    const claimed = new Set(); // app ride ids linked in this plan
    const candidatesByDay = new Map();
    hist.filter(r => r && r.date).forEach(r => addTo(candidatesByDay, Date.parse(r.date), r));
    const recOpts = opts;
    [...kept].sort((x, y) => Date.parse(x.start_date) - Date.parse(y.start_date) || (x.id < y.id ? -1 : 1)).forEach(a => {
      // Layer 1: exact id
      if (appLinks.has(a.id)) {
        out.alreadyLinked++;
        const before = appLinks.get(a.id);
        const record = S.combineRecord(before, a, opts);
        const changes = S.diffRecords(before, record);
        if (changes.length) out.refreshed.push({ activity: a, record, before, changes });
        else out.unchangedList.push({ activity: a, record: before });
        const rec = stravaRecs.get(a.id);
        if (rec) out.merged.push({ activity: a, keptId: a.id, removeRecordId: rec.id, reason: 'already recorded in the app' });
        return;
      }
      const existing = stravaRecs.get(a.id);
      if (existing) {
        const next = S.toRecord(a, recOpts, existing);
        const changes = S.diffRecords(existing, next);
        if (changes.length) out.refreshed.push({ activity: a, record: next, before: existing, changes });
        else { out.unchanged++; out.unchangedList.push({ activity: a, record: existing }); }
        return;
      }
      // Rider's earlier decision on a "possible" match
      const dec = decisions[a.id];
      if (dec && dec.verdict === 'import') { out.new.push({ activity: a, record: S.toRecord(a, recOpts), reason: 'you chose Import' }); return; }
      if (dec && dec.verdict === 'same') {
        const target = hist.find(r => r.id === dec.target);
        if (target && S.isAppNative(target) && !S.linkOf(target) && !claimed.has(target.id)) {
          claimed.add(target.id);
          out.linked.push({ activity: a, rideId: target.id, rideTitle: target.title, rideDate: target.date, score: null, why: ['you chose "It\'s the same"'] });
          return;
        }
        if (target && (S.isStravaRecord(target) || S.linkOf(target))) {
          const keptId = S.isStravaRecord(target) ? String(target.stravaActivityId) : S.linkOf(target);
          out.merged.push({ activity: a, keptId, removeRecordId: null, reason: 'you chose "It\'s the same"' });
          out.mergedMap[a.id] = keptId;
          return;
        }
      }
      // Layer 2: fuzzy against everything already in the app
      const va = S.dedupeView(a, true);
      let best = null;
      near(candidatesByDay, Date.parse(a.start_date)).forEach(r => {
        if (S.isStravaRecord(r) && String(r.stravaActivityId) === a.id) return;
        if (!keepMissing && S.isStravaRecord(r) && !fetchedIds.has(String(r.stravaActivityId)) && S.inRange(r.date, range)) return; // being removed
        if (claimed.has(r.id)) return;
        const sc = S.score(va, S.dedupeView(r, false));
        if (sc.score > 0 && (!best || sc.score > best.score)) best = { ...sc, ride: r };
      });
      const verdict = best ? VeloDedupe.classify(best.score) : 'new';
      if (verdict === 'duplicate') {
        const r = best.ride;
        if (S.isAppNative(r) && !S.linkOf(r)) {
          claimed.add(r.id);
          out.linked.push({ activity: a, rideId: r.id, rideTitle: r.title, rideDate: r.date, score: best.score, why: best.why });
        } else {
          const keptId = S.isStravaRecord(r) ? String(r.stravaActivityId) : S.linkOf(r);
          out.merged.push({ activity: a, keptId, keptName: r.title, score: best.score, why: best.why, removeRecordId: null, reason: 'duplicate of a record already in the app' });
          out.mergedMap[a.id] = keptId;
        }
        return;
      }
      if (verdict === 'possible') {
        out.review.push({ activity: a, record: S.toRecord(a, recOpts), candidate: { id: best.ride.id, title: best.ride.title, date: best.ride.date, source: best.ride.source || 'App' }, score: best.score, why: best.why });
        return;
      }
      out.new.push({ activity: a, record: S.toRecord(a, recOpts), reason: best ? `closest match ${Math.round(best.score * 100)}%` : 'no match' });
    });

    // Imported records deleted on Strava (in range only).
    stravaRecs.forEach((rec, sid) => {
      if (keepMissing || !S.inRange(rec.date, range) || fetchedIds.has(sid)) return;
      out.removed.push({ record: rec });
    });
    // App rides whose linked activity no longer exists: reported only, never changed.
    hist.forEach(r => {
      if (keepMissing || !S.isAppNative(r)) return;
      const l = S.linkOf(r);
      if (l && S.inRange(r.date, range) && !fetchedIds.has(l)) out.staleLinks.push({ rideId: r.id, rideTitle: r.title, activityId: l });
    });
    out.linked.forEach(x => { x.record = S.combineRecord(hist.find(r => r.id === x.rideId), x.activity, opts); });
    out.changeCount = out.new.length + out.linked.length + out.refreshed.length + out.removed.length + out.merged.filter(m => m.removeRecordId || !mergedPrev[m.activity.id]).length;
    out.hasChanges = out.changeCount > 0;
    return out;
  }

  /** Fields that differ between two versions of an imported record. */
  static diffRecords(a, b) {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    const changes = [];
    keys.forEach(k => {
      if (k === 'samples') { if (a.samples !== b.samples && VeloStravaSync.stable(a.samples || null) !== VeloStravaSync.stable(b.samples || null)) changes.push(k); return; }
      if (VeloStravaSync.stable(a[k]) !== VeloStravaSync.stable(b[k])) changes.push(k);
    });
    return changes.sort();
  }

  // --------------------------------------------------------------- apply --
  /**
   * The complete new history for a plan, computed in memory. App-native rides are the very same
   * objects unless their matched summary or Strava link changes.
   * @returns {{ history, put: object[], del: string[], links: object[] }}
   */
  static nextState(history, plan) {
    const S = VeloStravaSync;
    const drop = new Set([
      ...plan.removed.map(x => x.record.id),
      ...plan.merged.map(m => m.removeRecordId).filter(Boolean)
    ]);
    const refreshed = new Map(plan.refreshed.map(x => [x.record.id, x.record]));
    const links = new Map(plan.linked.map(l => [l.rideId, l]));
    const put = [];
    const next = [];
    history.forEach(r => {
      if (drop.has(r.id)) return;
      if (refreshed.has(r.id)) { const rec = refreshed.get(r.id); next.push(rec); put.push(rec); return; }
      if (links.has(r.id) && S.isAppNative(r)) {
        const l = links.get(r.id);
        const prev = r.strava && typeof r.strava === 'object' ? r.strava : {};
        const keepState = ['sent', 'duplicate', 'found'].includes(prev.state);
        const copy = { ...S.combineRecord(r, l.activity, plan.opts), strava: { ...prev, state: keepState ? prev.state : 'found', activityId: String(l.activity.id), name: l.activity.name || '', linkedBy: 'sync' } };
        next.push(copy); put.push(copy);
        return;
      }
      next.push(r);
    });
    const added = plan.new.map(x => x.record).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    put.push(...added);
    return { history: [...added, ...next], put, del: [...drop], links: plan.linked };
  }

  /**
   * Checks the new state before anything is written. Returns a list of problems (empty = safe).
   */
  static validate(before, after, plan) {
    const S = VeloStravaSync;
    const errs = [];
    const ids = new Set();
    after.forEach(r => { if (ids.has(r.id)) errs.push(`duplicate record id ${r.id}`); ids.add(r.id); });
    const afterById = new Map(after.map(r => [r.id, r]));
    const linkIds = new Map(plan.linked.map(l => [l.rideId, String(l.activity.id)]));
    before.forEach(r => {
      if (!S.isAppNative(r)) return;
      const a = afterById.get(r.id);
      if (!a) { errs.push(`app ride ${r.id} would be lost`); return; }
      if (a === r) return;
      const refresh = plan.refreshed.find(x => x.record.id === r.id);
      const link = plan.linked.find(x => x.rideId === r.id);
      const activity = refresh ? refresh.activity : link && link.activity;
      const expected = activity ? S.combineRecord(r, activity, plan.opts) : r;
      const strip = (x) => { const { strava, samples, ...rest } = x; return rest; };
      const samplesOk = Array.isArray(r.samples) && r.samples.length ? a.samples === r.samples
        : S.stable(a.samples) === S.stable(expected.samples);
      if (S.stable(strip(a)) !== S.stable(strip(expected)) || !samplesOk) errs.push(`app ride ${r.id} has unexpected changes`);
      const was = S.linkOf(r), now = S.linkOf(a);
      if (was && was !== now) errs.push(`app ride ${r.id} would lose its Strava link`);
      if (!was && now !== linkIds.get(r.id)) errs.push(`app ride ${r.id} got an unexpected link`);
    });
    const seen = new Map();
    const appLinked = new Set(after.filter(S.isAppNative).map(S.linkOf).filter(Boolean));
    after.filter(S.isStravaRecord).forEach(r => {
      const sid = String(r.stravaActivityId);
      if (seen.has(sid)) errs.push(`Strava activity ${sid} imported twice`);
      seen.set(sid, r);
      if (appLinked.has(sid)) errs.push(`Strava activity ${sid} is both imported and linked to a ride`);
    });
    before.filter(S.isStravaRecord).forEach(r => {
      if (!S.inRange(r.date, plan.range) && afterById.get(r.id) !== r) errs.push(`record ${r.id} outside the range would change`);
    });
    const removedCount = new Set([...plan.removed.map(x => x.record.id), ...plan.merged.map(m => m.removeRecordId).filter(Boolean)]).size;
    const expected = before.length + plan.new.length - removedCount;
    if (after.length !== expected) errs.push(`record count ${after.length}, expected ${expected}`);
    return errs;
  }

  // ------------------------------------------------------- detail fetches --
  /**
   * Merges cached details into listed activities and says which ids still need activities/{id}:
   * never fetched first (non-cycling before rides, newest first), then the stalest cached ones.
   */
  static withDetails(activities, cache, now = Date.now()) {
    const merged = (activities || []).map(a => {
      const c = cache && cache[String(a.id)];
      if (a.detailed) return a;
      if (c) return { ...a, description: c.description || '', calories: c.calories || 0, detailed: true, detailFetchedAt: c.fetchedAt };
      return a;
    });
    const missing = merged.filter(a => !a.detailed)
      .sort((x, y) => (VeloStravaSync.activityKind(x.sport_type) === 'ride') - (VeloStravaSync.activityKind(y.sport_type) === 'ride') || Date.parse(y.start_date) - Date.parse(x.start_date));
    const stale = merged.filter(a => a.detailed && a.detailFetchedAt && now - a.detailFetchedAt > VeloStravaSync.DETAIL_STALE_MS)
      .sort((x, y) => x.detailFetchedAt - y.detailFetchedAt);
    return { activities: merged, need: [...missing, ...stale].map(a => String(a.id)) };
  }
}

if (typeof window !== 'undefined') window.VeloStravaSync = VeloStravaSync;
if (typeof module !== 'undefined') module.exports = VeloStravaSync;
