/**
 * Strava archive import ("Download your account" ZIP): the ZIP reader, activities.csv, a gzipped FIT ride
 * read end to end, and the plan (exact-id refresh, fuzzy link to an app ride, nothing removed).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');

const ctx = vm.createContext({ window: {}, DecompressionStream, Response, Blob, TextDecoder, console });
for (const file of ['velo-metrics', 'velo-dedupe', 'velo-strava-sync', 'velo-importer', 'velo-export', 'velo-zip', 'velo-strava-archive'])
  vm.runInContext(fs.readFileSync(`js/${file}.js`, 'utf8'), ctx);
const [S, A, Z, I, E] = ['VeloStravaSync', 'VeloStravaArchive', 'VeloZip', 'VeloRideImporter', 'VeloExport'].map(n => vm.runInContext(n, ctx));

/** A ZIP (deflate, like Strava's) of { name: Buffer } built with Node's zlib. */
function makeZip(files, folder = '') {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [rawName, data] of Object.entries(files)) {
    const name = Buffer.from(folder + rawName);
    const comp = zlib.deflateRawSync(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([Buffer.concat([...locals, cd, end])]);
}

// The long English export, column for column as Strava writes it (German and other languages use the same order).
const HEADER = ['Activity ID', 'Activity Date', 'Activity Name', 'Activity Type', 'Activity Description', 'Elapsed Time', 'Distance',
  'Max Heart Rate', 'Relative Effort', 'Commute', 'Activity Private Note', 'Activity Gear', 'Filename', 'Athlete Weight', 'Bike Weight',
  'Elapsed Time', 'Moving Time', 'Distance', 'Max Speed', 'Average Speed', 'Elevation Gain', 'Elevation Loss', 'Elevation Low',
  'Elevation High', 'Max Grade', 'Average Grade', 'Average Positive Grade', 'Average Negative Grade', 'Max Cadence', 'Average Cadence',
  'Max Heart Rate', 'Average Heart Rate', 'Max Watts', 'Average Watts', 'Calories', 'Max Temperature', 'Average Temperature',
  'Relative Effort', 'Total Work', 'Number of Runs', 'Uphill Time', 'Downhill Time', 'Other Time', 'Perceived Exertion', 'Type',
  'Start Time', 'Weighted Average Power', 'Power Count', 'Commute', 'Media', 'Type'];
const row = (o) => HEADER.map((h, i) => {
  const v = o[i] ?? '';
  return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
}).join(',');
const plain = (v) => JSON.parse(JSON.stringify(v)); // arrays from the vm context have another prototype
const col = (name, last = false) => (last ? HEADER.lastIndexOf(name) : HEADER.indexOf(name));

/** 30 min at 200 W with heart rate, starting 2026-03-01 07:00:00 UTC, as a FIT file. */
function fitRide() {
  const samples = Array.from({ length: 1800 }, (_, i) => ({ time: i, power: 200, hr: 140, cadence: 90 }));
  return Buffer.from(E.buildFit({ date: '2026-03-01T07:00:00Z', title: 'test' }, samples));
}

function csv() {
  const r1 = {}; // power ride with a FIT file
  r1[col('Activity ID')] = '1001'; r1[col('Activity Date')] = 'Mar 1, 2026, 7:00:00 AM'; r1[col('Activity Name')] = 'Zwift - Watopia';
  r1[col('Activity Type')] = 'Virtual Ride'; r1[col('Activity Description')] = 'Line one\nline "two", with comma';
  r1[col('Elapsed Time')] = '1800'; r1[col('Distance')] = '15.20'; r1[col('Filename')] = 'activities/1001.fit.gz';
  r1[col('Elapsed Time', true)] = '1800.0'; r1[col('Moving Time')] = '1800.0'; r1[col('Distance', true)] = '15200.0'; r1[col('Calories')] = '410';
  const r2 = {}; // strength session, summary only
  r2[col('Activity ID')] = '1002'; r2[col('Activity Date')] = 'Mar 2, 2026, 6:15:30 PM'; r2[col('Activity Name')] = 'Gym';
  r2[col('Activity Type')] = 'Weight Training'; r2[col('Activity Description')] = 'Back squat 5x5\nDeadlift 3x5';
  r2[col('Elapsed Time')] = '3600'; r2[col('Elapsed Time', true)] = '3600.0'; r2[col('Moving Time')] = '3300.0';
  r2[col('Average Heart Rate')] = '118.5'; r2[col('Relative Effort')] = '25';
  const r3 = {}; // outdoor ride whose file is missing from the ZIP: summary from the CSV
  r3[col('Activity ID')] = '1003'; r3[col('Activity Date')] = 'Mar 3, 2026, 12:00:00 PM'; r3[col('Activity Name')] = 'Lunch Ride';
  r3[col('Activity Type')] = 'Ride'; r3[col('Filename')] = 'activities/1003.gpx'; r3[col('Elapsed Time', true)] = '5400';
  r3[col('Moving Time')] = '5000'; r3[col('Distance', true)] = '40000'; r3[col('Average Heart Rate')] = '135';
  return '﻿' + [HEADER.map(h => h).join(','), row(r1), row(r2), row(r3)].join('\r\n') + '\r\n';
}

test("parseDate reads Strava's English and German export dates as UTC", () => {
  assert.equal(A.parseDate('Mar 1, 2026, 7:00:00 AM'), '2026-03-01T07:00:00.000Z');
  assert.equal(A.parseDate('Dec 31, 2025, 12:05:09 AM'), '2025-12-31T00:05:09.000Z');
  assert.equal(A.parseDate('Jul 4, 2025, 12:30:00 PM'), '2025-07-04T12:30:00.000Z');
  assert.equal(A.parseDate('Sep 9, 2024, 18:30:12'), '2024-09-09T18:30:12.000Z');
  assert.equal(A.parseDate('2024-09-09 18:30:12'), '2024-09-09T18:30:12.000Z');
  assert.equal(A.parseDate('31.10.2026, 14:57:40'), '2026-10-31T14:57:40.000Z');
  assert.equal(A.parseDate('5.1.2021, 8:03:00'), '2021-01-05T08:03:00.000Z');
  assert.equal(A.parseDate('yesterday'), '');
});

test('numbers: plain, thousands separators and a decimal comma', () => {
  assert.equal(A.num('2706.0'), 2706);
  assert.equal(A.num('25,15'), 25.15);
  assert.equal(A.num('1,234.5'), 1234.5);
  assert.equal(A.num('12,345'), 12345);
  assert.equal(A.num(''), 0);
  assert.equal(A.num('-3'), 0);
});

test('activities.csv: quoted multi-line text, repeated columns in metres and seconds, sport types', () => {
  const list = A.parseActivitiesCsv(csv());
  assert.equal(list.length, 3);
  const [ride, gym, outdoor] = list;
  assert.equal(ride.id, '1001');
  assert.equal(ride.sportType, 'VirtualRide');
  assert.equal(ride.description, 'Line one\nline "two", with comma');
  assert.equal(ride.distanceM, 15200);
  assert.equal(ride.filename, 'activities/1001.fit.gz');
  assert.equal(gym.sportType, 'WeightTraining');
  assert.equal(gym.moving, 3300);
  assert.equal(gym.avgHr, 118.5);
  assert.equal(A.wantsFile(ride), true);
  assert.equal(A.wantsFile(gym), false);
  assert.equal(outdoor.distanceM, 40000);
});

test('a German activities.csv is read by column position, with German types and tags', () => {
  const de = ['Aktivitäts-ID', 'Aktivitätsdatum', 'Name der Aktivität', 'Aktivitätsart', 'Aktivitätsbeschreibung', 'Verstrichene Zeit', 'Distanz',
    'Max. Herzfrequenz', 'Relative Leistung', 'Pendeln', 'Hinweis zur Privatsphäre für Aktivitäten', 'Aktivitätsausrüstung', 'Dateiname',
    'Sportlergewicht', 'Fahrradgewicht', 'Verstrichene Zeit', 'Bewegungszeit', 'Distanz', ...HEADER.slice(18, 30), 'Max. Herzfrequenz',
    ...HEADER.slice(31, 44), 'Art', 'Startzeit', 'Gewichtete durchschnittliche Leistung', 'Leistungszahl', 'Pendeln', 'Medien', 'Art'];
  assert.equal(de.length, HEADER.length);
  const line = (vals) => { const r = new Array(de.length).fill(''); Object.entries(vals).forEach(([i, v]) => { r[i] = v; }); return r.map(v => /[",\n]/.test(v) ? `"${v}"` : v).join(','); };
  const text = [de.join(','),
    line({ 0: '20806084210', 1: '31.10.2026, 14:57:40', 2: 'Virtodrom', 3: 'Virtuelle Radfahrt', 5: '2706', 6: '25,15', 12: 'activities/21970497681.fit.gz',
      15: '2706.0', 16: '2639.0', 17: '25155.0', 31: '135.0', 33: '199.0', 34: '586.0', 46: '205.0', 50: 'riding|virtual' }),
    line({ 0: '20766961363', 1: '28.10.2026, 15:04:16', 2: 'Spaziergang', 3: 'Spaziergang', 5: '1800', 6: '2,10', 15: '1800.0', 16: '1700.0', 17: '2100.0' }),
    line({ 0: '20700000000', 1: '20.10.2026, 07:00:00', 2: 'Neue Sportart', 3: 'Irgendwas Neues', 5: '600', 15: '600.0', 50: 'running' })
  ].join('\n');
  const [ride, walk, unknown] = A.parseActivitiesCsv(text);
  assert.equal(ride.startIso, '2026-10-31T14:57:40.000Z');
  assert.equal(ride.sportType, 'VirtualRide');
  assert.equal(ride.distanceM, 25155);
  assert.equal(ride.moving, 2639);
  assert.equal(ride.avgWatts, 199);
  assert.equal(ride.np, 205);
  assert.equal(ride.calories, 586);
  assert.equal(ride.filename, 'activities/21970497681.fit.gz');
  assert.equal(A.wantsFile(ride), true);
  assert.equal(walk.sportType, 'Walk');
  assert.equal(walk.distanceM, 2100);
  assert.equal(unknown.sportType, 'Run'); // unknown label: from the language-neutral tags
});

test('a CSV that is not a Strava export is refused', () => {
  assert.throws(() => A.parseActivitiesCsv('a,b,c\n1,2,3\n'), /unknown layout/);
});

test('ZIP reader + gzipped FIT: the ride is read with its power and becomes a Strava activity', async () => {
  const zip = makeZip({ 'activities.csv': Buffer.from(csv()), 'activities/1001.fit.gz': zlib.gzipSync(fitRide()) }, 'export_123/');
  const entries = await Z.list(zip);
  assert.deepEqual(plain(entries.map(e => e.name).sort()), ['export_123/activities.csv', 'export_123/activities/1001.fit.gz']);
  const csvEntry = entries.find(e => e.name.endsWith('activities.csv'));
  const text = new TextDecoder().decode(await Z.read(zip, csvEntry));
  assert.equal(A.parseActivitiesCsv(text).length, 3);
  const fitEntry = entries.find(e => e.name.endsWith('.fit.gz'));
  const ride = I.parseFit(await Z.gunzip(await Z.read(zip, fitEntry)), 'Rider', 250);
  assert.equal(ride.avgWatts, 200);
  assert.ok(Math.abs(ride.duration - 1800) <= 2, String(ride.duration));
  const a = A.toActivity(A.parseActivitiesCsv(text)[0], ride);
  assert.equal(a.start_date, '2026-03-01T07:00:00Z');
  assert.equal(a.device_watts, true);
  assert.equal(a.weighted_average_watts, 200);
  assert.equal(a.distance, 15200);
  assert.equal(a.calories, 410);
  assert.ok(a.samples.length >= 1790);
  const rec = S.toRecord(a, { ftp: 250 });
  assert.equal(rec.id, 'strava_1001');
  assert.equal(rec.tssMethod, 'power-stream');
  assert.equal(rec.tss, Math.round(0.5 * 0.8 * 0.8 * 100));
  assert.equal(rec.trainer, true);
});

test('ZIP reader refuses a file that is not a ZIP', async () => {
  await assert.rejects(Z.list(new Blob([Buffer.from('not a zip at all')])), /not a ZIP/);
});

test('archive plan: refreshes by id, links an app ride, imports the rest and never removes anything', () => {
  const list = A.parseActivitiesCsv(csv());
  const acts = list.map(e => A.toActivity(e, null));
  assert.equal(acts[2].streams, 'none');
  assert.equal(acts[1].suffer_score, 25);
  const range = A.rangeFor(acts);
  const history = [
    // Imported earlier through the Strava API: same id -> refreshed or unchanged, never a second copy.
    S.toRecord({ ...acts[0], samples: undefined, device_watts: undefined, streams: undefined }, { ftp: 250 }),
    // Recorded in the cockpit: the Strava copy of the same ride is linked to it.
    { id: 'cockpit_1', source: 'Cockpit', date: '2026-03-03T12:00:20Z', duration: 5010, distanceKm: 40.1, samples: [{ time: 0, power: 180 }] },
    // A Strava record that is not in the archive (e.g. deleted later): kept by an archive import.
    { id: 'strava_999', source: 'Strava', stravaActivityId: '999', date: '2026-03-02T09:00:00Z', duration: 1200, activityType: 'run' }
  ];
  const plan = S.plan({ activities: acts, history, range, opts: { ftp: 250 }, keepMissing: true });
  assert.equal(plan.removed.length, 0);
  assert.equal(plan.staleLinks.length, 0);
  assert.deepEqual(plain(plan.new.map(x => x.activity.id)), ['1002']);
  assert.deepEqual(plain(plan.linked.map(x => x.rideId)), ['cockpit_1']);
  assert.equal(plan.refreshed.length + plan.unchanged, 1);
  const next = S.nextState(history, plan);
  assert.deepEqual(plain(S.validate(history, next.history, plan)), []);
  assert.ok(next.history.some(r => r.id === 'strava_999'));
  assert.equal(next.history.find(r => r.id === 'strava_1002').activityType, 'strength');
  // Without keepMissing (a live sync), the missing record would be removed.
  assert.equal(S.plan({ activities: acts, history, range, opts: { ftp: 250 } }).removed.length, 1);
});

test('plan compares only nearby days: a large archive plans quickly and still finds duplicates', () => {
  const t0 = Date.parse('2020-01-01T08:00:00Z');
  const acts = Array.from({ length: 3000 }, (_, i) => ({ id: String(5000 + i), sport_type: 'Ride', start_date: new Date(t0 + i * 86400000).toISOString(), moving_time: 3600, elapsed_time: 3700, distance: 30000 }));
  const history = Array.from({ length: 3000 }, (_, i) => ({ id: `c${i}`, source: 'Cockpit', date: new Date(t0 + i * 86400000 + 30000).toISOString(), duration: 3600, distanceKm: 30 }));
  const range = A.rangeFor(acts);
  const started = Date.now();
  const plan = S.plan({ activities: acts, history, range, opts: { ftp: 250 }, keepMissing: true });
  assert.equal(plan.linked.length, 3000);
  assert.equal(plan.new.length, 0);
  assert.ok(Date.now() - started < 15000, `${Date.now() - started} ms`);
});

test('second-by-second data: slim samples, the cutoff by years, summaries keep exact power numbers', () => {
  const slim = A.slimSamples([
    { time: 0, power: 210, hr: 140, cadence: 90, speed: 32.1, dist: 0.0091234, timestamp: 1, segmentStart: false, leftBal: null, rightBal: null },
    { time: 1, power: 0, hr: 0, cadence: 0, speed: null, dist: null, segmentStart: true, leftBal: 49, rightBal: 51 }
  ]);
  assert.deepEqual(plain(slim), [
    { time: 0, power: 210, hr: 140, cadence: 90, speed: 32.1, dist: 0.009 },
    { time: 1, power: 0, leftBal: 49, rightBal: 51, segmentStart: true }
  ]);
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(A.sampleCutoff(2, now), new Date(2024, 10, 2).getTime());
  assert.equal(A.sampleCutoff(Infinity, now), -Infinity);
  assert.equal(A.sampleCutoff(0, now), Infinity);

  const entry = A.parseActivitiesCsv(csv())[0];
  const samples = Array.from({ length: 1800 }, (_, i) => ({ time: i, power: 200, hr: 140 }));
  const ride = { date: '2026-03-01T07:00:00.000Z', duration: 1800, avgWatts: 200, np: 200, maxWatts: 200, kj: 360, samples };
  const summary = A.toActivity(entry, ride, { keepSamples: false });
  assert.equal(summary.samples, undefined);
  assert.equal(summary.streams, 'none');
  assert.equal(summary.weighted_average_watts, 200);
  const rec = S.toRecord(summary, { ftp: 250 });
  assert.equal(rec.tssMethod, 'power');
  assert.equal(rec.tssEstimated, false);
  assert.equal(rec.tss, Math.round(0.5 * 0.8 * 0.8 * 100));
});

test('rides without a power meter: Strava\'s estimated watts from the CSV are not used', () => {
  const entry = { ...A.parseActivitiesCsv(csv())[2], avgWatts: 150, np: 160, maxWatts: 400, kj: 800 };
  const a = A.toActivity(entry, null);
  assert.equal(a.average_watts, undefined);
  assert.equal(a.streams, 'none');
  const rec = S.toRecord(a, { ftp: 250, maxHr: 185 });
  assert.equal(rec.tssMethod, 'hr');
  assert.equal(rec.tssEstimated, true);
});
