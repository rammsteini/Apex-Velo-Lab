// APEX VELO // LAB service worker - network-first for app files so updates are never
// masked by a stale cache; the cache is only a fallback when offline.
const CACHE_NAME = 'apex-velo-cache-v61';
const CORE = [
  './css/ftp-history.css', './js/velo-ftp-history.js', './js/velo-ftp-model.js', './js/app-ftp-history.js',
  './js/phone-zen.js',
  './js/velo-storage.js',
  './css/phone-layout.css',
  './js/app-devices.js',
  './', './index.html', './live.html', './manifest.json', './apex-velo-icon.png', './apex-velo-icon-192.png', './apex-velo-icon.ico', './css/style.css', './css/fonts.css', './css/analytics-studio.css', './vendor/chart.umd.min.js', './vendor/qrcode.js',
  './vendor/fonts/inter-latin-400-normal.woff2', './vendor/fonts/inter-latin-500-normal.woff2', './vendor/fonts/inter-latin-600-normal.woff2', './vendor/fonts/inter-latin-700-normal.woff2', './vendor/fonts/inter-latin-800-normal.woff2',
  './vendor/fonts/jetbrains-mono-latin-400-normal.woff2', './vendor/fonts/jetbrains-mono-latin-500-normal.woff2', './vendor/fonts/jetbrains-mono-latin-600-normal.woff2', './vendor/fonts/jetbrains-mono-latin-700-normal.woff2', './vendor/fonts/jetbrains-mono-latin-800-normal.woff2',
  './vendor/fonts/unbounded-latin-300-normal.woff2', './vendor/fonts/unbounded-latin-400-normal.woff2', './vendor/fonts/unbounded-latin-500-normal.woff2', './vendor/fonts/unbounded-latin-600-normal.woff2', './vendor/fonts/unbounded-latin-700-normal.woff2', './vendor/fonts/figtree-latin-400-normal.woff2', './vendor/fonts/figtree-latin-500-normal.woff2', './vendor/fonts/figtree-latin-600-normal.woff2', './vendor/fonts/figtree-latin-700-normal.woff2', './vendor/fonts/figtree-latin-800-normal.woff2',
  './js/velo-demo.js', './js/velo-local-history.js',
  './js/velo-metrics.js', './js/velo-glossary.js', './js/velo-db.js', './js/velo-sound.js', './js/velo-pip.js', './js/velo-folder-sync.js',
  './js/velo-biomech.js', './js/velo-live-graph.js', './js/velo-analytics.js', './js/velo-workouts.js',
  './js/velo-sport-science.js', './js/velo-ai-coach.js', './js/velo-block-planner.js', './js/velo-sim.js', './js/velo-ble.js', './js/velo-erg.js', './js/velo-insight.js', './js/velo-importer.js', './js/velo-zip.js', './js/velo-export.js',
  './js/velo-clock.js', './js/velo-progress.js', './js/velo-dedupe.js', './js/velo-strava-sync.js', './js/velo-strava-archive.js', './js/velo-health.js', './js/velo-wellness.js', './js/velo-trends.js', './js/velo-power.js', './js/velo-ask.js', './js/velo-describe.js', './js/app.js', './js/app-analytics.js', './js/app-power.js', './js/app-ride-analysis.js', './js/app-ask.js', './js/app-dashboard.js', './js/app-health-ana.js', './js/app-ana-studio.js', './js/app-ana-plus.js', './js/app-history.js', './js/app-coach.js', './js/app-describe.js', './js/app-block.js', './js/app-strava.js', './js/app-strava-sync.js', './js/app-strava-archive.js', './js/app-insight.js', './js/app-backup.js', './js/app-remote.js', './js/app-health.js', './js/app-settings.js', './js/app-slipstream.js'
];

self.addEventListener('install', (e) => {
  // Each file on its own: addAll() is all-or-nothing, so one missing file (e.g. no personal
  // history in data/) used to leave the whole offline cache empty.
  e.waitUntil(caches.open(CACHE_NAME).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache the local coach API (/api/*) or cross-origin calls other than the Chart.js / font CDNs.
  if (url.origin === self.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/') || url.pathname.startsWith('/.private-review/'))) return;
  const cacheableCdn = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (url.origin !== self.location.origin && !cacheableCdn) return;
  e.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && (resp.ok || resp.type === 'opaque')) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
