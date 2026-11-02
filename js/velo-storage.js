// SQLite owns saved data. Browser storage is a compatibility cache and a recovery outbox.
(function () {
  const keyAllowed = k => /^apex_[a-zA-Z0-9_:-]{1,180}$/.test(k) && !['apex_velo_history', 'apex_auto_backup', 'apex_sqlite_migration'].includes(k);
  const V = window.VeloStorage = { enabled: false, revision: 0, pending: [], error: null, conflict: false };
  const native = {};
  for (const k of ['getAllRides', 'saveRidesBatch', 'saveRide', 'applyRideChanges', 'deleteRide', 'clearAllRides', 'putSetting', 'getSetting', 'listSettings', 'deleteSetting']) native[k] = VeloDB[k].bind(VeloDB);
  const uuid = () => crypto.randomUUID().replace(/-/g, '_');
  let queuedAt = 0;
  // A change the user was told had failed (delete, clear) must never run later behind their back.
  const destructive = t => { const c = t.request || t.input || {}; return !!(c.clear || c.del?.length || c.dbDelete?.length); };
  // What the PC already holds per ride, so a save sends only new or changed rides instead of the whole history.
  // Saved sample arrays are replaced, never edited in place, so the array itself identifies its contents.
  const sampleIds = new WeakMap(); let nextSampleId = 1;
  const samplesKey = s => { if (!Array.isArray(s) || !s.length) return '0'; let id = sampleIds.get(s); if (!id) sampleIds.set(s, id = nextSampleId++); return id + ':' + s.length; };
  const signature = r => { const { samples, ...summary } = r; return JSON.stringify(summary) + '#' + samplesKey(samples); };
  const committed = new Map(); let committedOrder = null;
  V.markCommitted = function (rides) {
    committed.clear();
    for (const r of rides) committed.set(String(r.id), signature(r));
    committedOrder = rides.map(r => String(r.id)).join('\n');
  };
  // The local server accepts at most 200 MB per save. Ride changes are sent in parts of about CHUNK_BYTES;
  // a single request above MAX_REQUEST_BYTES can never succeed, so it is refused here (like the server's 413)
  // instead of timing out and being retried from the recovery outbox on every start.
  V.MAX_REQUEST_BYTES = 150 * 1024 * 1024;
  V.CHUNK_BYTES = 16 * 1024 * 1024;
  V.request = async function (url, input) {
    const body = input === undefined ? undefined : JSON.stringify(input);
    if (body !== undefined && body.length > V.MAX_REQUEST_BYTES) {
      throw Object.assign(new Error(`This save is too large for the local database (${Math.round(body.length / 1048576)} MB in one request) and was discarded.`), { status: 413 });
    }
    // Larger parts get more time (a few seconds per 10 MB on a slow disk).
    const timeout = 30000 + Math.round((body ? body.length : 0) / 1048576) * 1000;
    const r = await fetch('api/storage' + url, { cache: 'no-store', signal: AbortSignal.timeout(timeout),
      ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw Object.assign(new Error(j.error || `Local storage ${r.status}`), { status: r.status });
    return j;
  };
  V.render = function () {
    const el = document.getElementById('localStorageStatus');
    if (!el) return;
    el.textContent = V.error ? `Not saved to this PC: ${V.error}${V.recoveryUnavailable ? ' Browser recovery is also unavailable; export important rides before closing.' : ''}` : !V.enabled ? 'Using browser recovery storage. Start the updated launcher to enable local saving.'
      : V.pending.length ? 'Saving to this PC...' : `Saved on this PC · ${V.file}`;
    el.classList.toggle('backup-warn', !!V.error);
  };
  V.enqueue = function (change, url = '/save', { rideSignatures = [], orderKey } = {}) {
    if (!V.enabled) return Promise.reject(new Error('Local database unavailable.'));
    const input = structuredClone(change);
    const task = { input, url, rideSignatures, orderKey, operationId: uuid(), queuedAt: queuedAt = Math.max(Date.now(), queuedAt + 1) };
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    // Always attach a rejection handler, even for callers which rely on the visible save status.
    task.promise.catch(() => {});
    task.persisted = native.putSetting({ key: 'sqlite_pending:' + task.operationId, storeId: V.storeId,
      input: task.input, url: task.url, operationId: task.operationId, queuedAt: task.queuedAt });
    V.pending.push(task); V.render();
    if (V.conflict) task.reject(new Error(V.error || 'Reload this tab before saving again.'));
    else V.pump();
    return task.promise;
  };
  V.pump = async function () {
    if (V.running || V.conflict || !V.pending.length) return;
    V.running = true;
    try {
      while (V.pending.length) {
        const task = V.pending[0];
        if (!await task.persisted) V.recoveryUnavailable = true;
        if (!task.request) task.request = { ...task.input, revision: V.revision, operationId: task.operationId };
        // Persist BEFORE posting; a lost response is safe to replay with this exact operation ID.
        if (!await native.putSetting({ key: 'sqlite_pending:' + task.operationId, storeId: V.storeId, request: task.request, url: task.url, queuedAt: task.queuedAt })) V.recoveryUnavailable = true;
        const result = await V.request(task.url, task.request);
        V.revision = result.revision; V.error = null;
        // Update the comparison cache in server commit order, even after the caller saw a retryable failure.
        // Replayed outbox entries have no in-memory signatures: invalidate their rides rather than skipping
        // a later save against the old cache. No cache update may wait for an asynchronous browser mirror.
        const change = task.request;
        if (change.clear || task.url === '/restore') V.markCommitted([]);
        for (const r of change.put || []) committed.delete(String(r.id));
        for (const id of change.del || []) committed.delete(String(id));
        if (change.put?.length || change.del?.length || change.order) committedOrder = null;
        for (const [id, sig] of task.rideSignatures || []) committed.set(id, sig);
        if (task.orderKey !== undefined) committedOrder = task.orderKey;
        await native.deleteSetting('sqlite_pending:' + task.operationId);
        V.pending.shift(); task.resolve(result); V.render();
      }
    } catch (e) {
      // 409: another tab saved first, so stop and reload. Any other 4xx: the server refused this request and it
      // can never succeed, so report it and keep saving the rest instead of blocking every later save.
      const refused = e.status >= 400 && e.status < 500 && e.status !== 409;
      V.error = e.message; V.conflict = e.status === 409;
      for (const task of V.pending) task.reject(e);
      // Retain the rest for automatic retry, except changes whose failure the caller has now reported.
      const dropped = V.pending.filter((t, i) => (refused && i === 0) || destructive(t));
      V.pending = V.pending.filter(t => !dropped.includes(t));
      for (const t of dropped) await native.deleteSetting('sqlite_pending:' + t.operationId);
      V.render();
      if (refused && V.pending.length) setTimeout(() => V.pump(), 0);
    } finally { V.running = false; }
  };
  V.flush = async function () {
    if (!V.enabled) return;
    await V.pump();
    while (V.running) await new Promise(r => setTimeout(r, 20));
    if (V.pending.length || V.error) throw new Error(V.error || 'A save is still waiting.');
  };
  V.boot = async function () {
    if (window.__APEX_TEST_MODE__ || window.__APEX_DEMO_MODE__ || location.protocol === 'file:') return;
    const browserStorage = window.localStorage;
    try {
      let state = await V.request('');
      if (!state.initialized) {
        const dbRides = await native.getAllRides();
        const dbSettings = await native.listSettings('');
        if (dbRides === null || dbSettings === null) throw new Error('Browser data could not be read. Migration stopped; your original data is untouched.');
        let history = [];
        const rawHistory = localStorage.getItem('apex_velo_history');
        if (rawHistory !== null) {
          history = JSON.parse(rawHistory);
          if (!Array.isArray(history)) throw new Error('Browser history is invalid. Migration stopped.');
        } else if (window.APEX_LOCAL_HISTORY?.rides) history = window.APEX_LOCAL_HISTORY.rides.map(r => ({ ...r, profileName: r.profileName || APEX_LOCAL_HISTORY.riderName }));
        const byId = new Map(history.map(r => [String(r.id), r]));
        // An explicit empty-history marker represents a previous delete, not missing data.
        if (rawHistory !== '[]') for (const r of dbRides) {
          const old = byId.get(String(r.id));
          byId.set(String(r.id), old ? { ...old, ...(!(old.samples?.length) && r.samples?.length ? { samples: r.samples } : {}) } : r);
        }
        const settings = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i); if (keyAllowed(k)) settings[k] = localStorage.getItem(k);
        }
        try {
          await V.request('/migrate', { revision: state.revision, operationId: uuid(), rides: [...byId.values()], settings,
            dbSettings: dbSettings.filter(s => !s.key.startsWith('sqlite_')) });
        } catch(e) {
          if (e.status !== 409) throw e;
          const concurrent = await V.request(''); if (!concurrent.initialized) throw e;
        }
        state = await V.request('');
      }
      // Another browser may have old data of its own. Preserve that complete original export
      // before hydrating the PC database, even though it must never overwrite the database.
      if (browserStorage.getItem('apex_sqlite_migration') !== state.storeId) {
        const originals = await native.getAllRides();
        if (originals === null) throw new Error('The earlier browser records could not be preserved. Reload before switching storage.');
        const originalSettings = {};
        for(let i=0;i<browserStorage.length;i++) { const k=browserStorage.key(i); if(keyAllowed(k)) originalSettings[k]=browserStorage.getItem(k); }
        const local = JSON.parse(browserStorage.getItem('apex_velo_history') || '[]');
        if (!Array.isArray(local)) throw new Error('Earlier browser history is invalid; it has been left untouched.');
        const rides = new Map(originals.map(r=>[String(r.id),r]));
        for(const r of local) { const old=rides.get(String(r.id));rides.set(String(r.id),old?.samples?.length && !r.samples?.length ? {...r,samples:old.samples}:r); }
        if (rides.size || Object.keys(originalSettings).length) {
          const original = { key:'sqlite_browser_original:'+state.storeId, storeId:state.storeId,
            payload:{ app:'APEX VELO LAB', exportedAt:new Date().toISOString(), history:[...rides.values()], settings:originalSettings,
              profiles:JSON.parse(originalSettings.apex_velo_profiles || '[]'), activeProfileId:originalSettings.apex_velo_active_prof_id || null } };
          // Do not replace an earlier original export on a retry.
          if (!await native.getSetting(original.key) && !await native.putSetting(original)) throw new Error('Could not preserve the earlier browser export. Switching storage stopped.');
        }
        try { browserStorage.setItem('apex_sqlite_migration',state.storeId); } catch {} // A full browser cache must not block confirmed PC storage.
      }
      V.enabled = true; V.revision = state.revision; V.storeId = state.storeId; V.dir = state.dir; V.file = state.file;
      const outbox = (await native.listSettings('sqlite_pending:')) || [];
      for (const item of outbox.filter(s => s.storeId === V.storeId).sort((a,b) => (a.queuedAt || 0) - (b.queuedAt || 0))) {
        const task = { request: item.request, input: item.input, url: item.url, operationId: item.request?.operationId || item.operationId,
          queuedAt: item.queuedAt, persisted: Promise.resolve(true), resolve() {}, reject() {} };
        V.pending.push(task);
      }
      if (V.pending.length) {
        await V.pump(); state = await V.request(''); V.revision = state.revision;
        if (V.conflict) {
          // Reload resolves the tab conflict without discarding its retained unsaved operations.
          // Quarantine them for export; never automatically rebase them over newer data.
          for (const task of V.pending) {
            await task.persisted;
            const kept = await native.putSetting({ key: 'sqlite_conflict:' + task.operationId, storeId: V.storeId,
              request: task.request, input: task.input, url: task.url, queuedAt: task.queuedAt });
            if (!kept) throw new Error('The conflicting save could not be retained safely. Export important rides before proceeding.');
            await native.deleteSetting('sqlite_pending:' + task.operationId);
          }
          V.pending = []; V.conflict = false; V.error = null;
        }
      }
      const storage = window.localStorage;
      const cache = new Map(Object.entries(state.settings));
      const unrelated = {};
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (!keyAllowed(k)) unrelated[k] = storage.getItem(k); }
      // A cleared/changed browser starts from disk, never from a stale browser mirror.
      const known = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (keyAllowed(k)) known.push(k); }
      for (const k of known) try { storage.removeItem(k); } catch {}
      for (const [k,v] of cache) try { storage.setItem(k,v); } catch {}
      window.__APEX_SQLITE_RIDES__ = state.rides;
      // Keep the synchronous preference API without making browser quota a prerequisite to disk saves.
      const mirror = {
        getItem(k) { k = String(k); return keyAllowed(k) ? (cache.get(k) ?? null) : (storage.getItem(k) ?? unrelated[k] ?? null); },
        setItem(k,v) {
          k = String(k); v = String(v);
          if (!keyAllowed(k)) { storage.setItem(k,v); unrelated[k] = v; return; }
          if (cache.get(k) === v) return;
          cache.set(k,v); try { storage.setItem(k,v); } catch {}
          V.enqueue({ settings: { [k]: v } }).catch(() => {});
        },
        removeItem(k) {
          k = String(k);
          if (!keyAllowed(k)) { storage.removeItem(k); delete unrelated[k]; return; }
          if (!cache.has(k)) return;
          cache.delete(k); try { storage.removeItem(k); } catch {}
          V.enqueue({ settings: { [k]: null } }).catch(() => {});
        },
        clear() { for (const k of [...cache.keys()]) this.removeItem(k); for (const k of Object.keys(unrelated)) this.removeItem(k); },
        key(i) { return [...cache.keys(), ...Object.keys(unrelated)][i] ?? null; },
        get length() { return cache.size + Object.keys(unrelated).length; }
      };
      Object.defineProperty(window, 'localStorage', { configurable: true, get: () => mirror });
      const write = async (input, cacheState) => {
        try { await V.enqueue(input, '/save', cacheState); return true; }
        catch { return false; }
      };
      VeloDB.getAllRides = async () => { try { const j = await V.request('/rides'); return j.rides; } catch { return null; } };
      VeloDB.saveRidesBatch = async rides => {
        const sigs = rides.map(signature);
        const changed = [], changedSigs = [];
        // A queued write can still change a ride back after this call. Save the latest value of every
        // touched ride even when it matches the last completed save (edit -> undo while saving).
        const pending = V.pending.map(t => t.request || t.input);
        const replacing = pending.some(c => c.clear) || V.pending.some(t => t.url === '/restore');
        const touched = new Set(pending.flatMap(c => [...(c.put || []).map(r => String(r.id)), ...(c.del || []).map(String)]));
        const pendingOrder = replacing || pending.some(c => c.order || c.put?.length || c.del?.length);
        rides.forEach((r, i) => { if (replacing || touched.has(String(r.id)) || committed.get(String(r.id)) !== sigs[i]) { changed.push(r); changedSigs.push(sigs[i]); } });
        const order = rides.map(r => r.id), orderKey = order.map(String).join('\n');
        const fullList = rides.length >= committed.size;
        const sendOrder = rides.length && (pendingOrder || !(fullList && orderKey === committedOrder));
        if (!changed.length && !sendOrder) return true;
        const copy = structuredClone(changed);
        const saved = write({ put: copy, ...(sendOrder ? { order } : {}) }, {
          rideSignatures: copy.map((r, i) => [String(r.id), changedSigs[i]]), ...(fullList ? { orderKey } : {}) });
        // Retain full samples locally even if the PC save fails; they can be exported/retried.
        if (copy.length) await native.saveRidesBatch(copy);
        return saved;
      };
      VeloDB.saveRide = ride => VeloDB.saveRidesBatch([ride]);
      /**
       * Saves ride changes in parts of about V.CHUNK_BYTES (deletions go with the first part), so a large
       * import never exceeds the server's request limit or freezes the page in one huge JSON. onProgress(done,
       * total) reports the parts. Returns false as soon as a part fails: earlier parts are then already saved,
       * so a caller that needs all-or-nothing restores its restore point (applyStravaSync does).
       */
      VeloDB.applyRideChanges = async (put = [], del = [], { exact = false, onProgress = null } = {}) => {
        const parts = [];
        let part = [], size = 0;
        for (const r of put) {
          const bytes = JSON.stringify(r).length;
          if (part.length && size + bytes > V.CHUNK_BYTES) { parts.push(part); part = []; size = 0; }
          part.push(r); size += bytes;
        }
        if (part.length || !parts.length) parts.push(part);
        for (let i = 0; i < parts.length; i++) {
          const rideSignatures = parts[i].map(r => [String(r.id), signature(r)]);
          const change = structuredClone({ put: parts[i], del: i === 0 ? del : [], exact });
          const ok = await write(change, { rideSignatures });
          if (!ok) return false;
          await native.applyRideChanges(change.put, change.del, { exact });
          if (onProgress) onProgress(i + 1, parts.length);
          await new Promise(r => setTimeout(r, 0)); // let the page repaint between parts
        }
        return true;
      };
      VeloDB.deleteRide = id => VeloDB.applyRideChanges([], [id]);
      VeloDB.clearAllRides = async () => { const ok = await write({ clear: true }); if (ok) await native.clearAllRides(); return ok; };
      VeloDB.putSetting = obj => write({ dbPut: [obj] });
      VeloDB.deleteSetting = k => write({ dbDelete: [k] });
      VeloDB.listSettings = async prefix => {
        try { return (await V.request('/db-settings')).settings.filter(s => s.key.startsWith(prefix)); } catch { return null; }
      };
      VeloDB.getSetting = async k => (await VeloDB.listSettings(k))?.find(s => s.key === k) || null;
      V.render();
      setInterval(() => { if (V.pending.length && !V.conflict) V.pump(); }, 10000);
      window.addEventListener('online', () => V.pump());
      window.addEventListener('beforeunload', e => { if (V.pending.length) { e.preventDefault(); e.returnValue = ''; } });
    } catch (e) {
      V.enabled = false;
      for(const [key,method] of Object.entries(native)) VeloDB[key] = method;
      Object.defineProperty(window, 'localStorage', { configurable:true, get:()=>browserStorage });
      V.error = e.message; V.render();
    }
  };
  V.checkpointRide = async function (app) {
    if (!V.enabled || V.checkpointBusy || !app.hasUnsavedRide() || !app.recordedSamples.length) return;
    // Paused or idle: the recovery copy is already current, so do not rewrite the whole ride again.
    const mark = [app.recordedSamples.length, app.totalElapsedSeconds, app.intervalIndex, app.intervalSecondsRemaining,
      app.currentWorkout?.intervals?.reduce((a, iv) => a + (iv.duration || 0), 0)].join(':');
    if (V.checkpointMark === mark) return;
    V.checkpointBusy = true;
    V.rideKey ||= 'sqlite_active_ride:' + uuid();
    try {
      const snapshot = { key: V.rideKey, storeId: V.storeId, at: Date.now(), profileId: app.activeProfileId,
        workout: structuredClone(app.currentWorkout), samples: structuredClone(app.recordedSamples),
        elapsed: app.totalElapsedSeconds, step: app.intervalIndex, remaining: app.intervalSecondsRemaining,
        startedAt: app.sessionStartedAt, distance: app.totalDistanceMeters, maxSpeed: app.maxSpeedKmh,
        hadHardware: app.rideHadHardware, sourceChanges: structuredClone(app._deviceSourceChanges || []) };
      if (await native.putSetting(snapshot)) V.checkpointMark = mark;
      else app.showToast('Could not save the interrupted-ride recovery copy. Keep this tab open until the ride is saved.', 'warning');
    } finally { V.checkpointBusy = false; }
  };
  V.dropRideRecovery = async function () {
    const rideKey = V.rideKey;
    V.checkpointMark = null;
    while (V.checkpointBusy) await new Promise(r => setTimeout(r, 20));
    if (rideKey) await native.deleteSetting(rideKey);
  };
  V.initRecovery = async function (app) {
    if (!V.enabled) return;
    const original=await native.getSetting('sqlite_browser_original:'+V.storeId);
    const originalBanner=document.getElementById('earlierBrowserRecovery');
    if(original && !original.dismissed && originalBanner) {
      originalBanner.hidden=false;
      app.on(document.getElementById('btnExportEarlierBrowser'), 'click', ()=>app.downloadFile('apex_earlier_browser_backup.json',JSON.stringify(original.payload,null,2),'application/json'));
      app.on(document.getElementById('btnDismissEarlierBrowser'), 'click',async()=>{await native.putSetting({...original,dismissed:true});originalBanner.hidden=true;});
    }
    const conflicts = ((await native.listSettings('sqlite_conflict:')) || []).filter(s => s.storeId === V.storeId);
    const changesBanner = document.getElementById('unsavedChangeRecovery');
    if (conflicts.length && changesBanner) {
      changesBanner.hidden = false;
      app.on(document.getElementById('btnExportConflictingChanges'), 'click', () => {
        app.downloadFile('apex_retained_changes.json', JSON.stringify({ app: 'APEX VELO LAB RECOVERY', exportedAt: new Date().toISOString(), operations: conflicts }, null, 2), 'application/json');
      });
      app.on(document.getElementById('btnDiscardConflictingChanges'), 'click', async () => {
        if (!confirm('Discard the retained changes from the older tab? Download them first if you need them.')) return;
        for (const change of conflicts) await native.deleteSetting(change.key);
        changesBanner.hidden = true;
      });
    }
    // A ride whose save was retried and completed after this copy was kept is already in history: drop the copy.
    const rideStart = r => { const s0 = r.samples[0]; return Number.isFinite(s0?.timestamp) ? new Date(s0.timestamp - (s0.time || 0) * 1000).toISOString() : null; };
    const savedStarts = new Set((app.completedWorkouts || []).map(r => r.date));
    const list = [];
    for (const s of (await native.listSettings('sqlite_active_ride:')) || []) {
      if (s.storeId !== V.storeId || !s.samples?.length) continue;
      if (savedStarts.has(rideStart(s))) await native.deleteSetting(s.key); else list.push(s);
    }
    const recovery = list.sort((a,b) => b.at-a.at)[0];
    const banner = document.getElementById('interruptedRideRecovery');
    if (recovery && banner) {
      banner.hidden = false;
      document.getElementById('interruptedRideText').textContent = `An unfinished ride from ${new Date(recovery.at).toLocaleString()} has ${recovery.samples.length} recorded samples. Recover it paused, then resume or finish and save.`;
      app.on(document.getElementById('btnRecoverInterruptedRide'), 'click', () => {
        if (app.hasUnsavedRide()) { app.showToast('Finish the current ride first.', 'warning'); return; }
        if (!app.profiles.some(p => p.id === recovery.profileId)) { app.showToast('The original rider profile is missing. Restore that profile before recovering this ride.', 'warning'); return; }
        app.setActiveProfile(recovery.profileId, false); app.resetWorkout(false);
        V.rideKey = recovery.key;
        app.currentWorkout = recovery.workout; app.recordedSamples = recovery.samples;
        app.totalElapsedSeconds = recovery.elapsed; app.intervalIndex = recovery.step; app.intervalSecondsRemaining = recovery.remaining;
        app.sessionStartedAt = recovery.startedAt; app.totalDistanceMeters = recovery.distance; app.totalDistanceKm = recovery.distance/1000;
        app.maxSpeedKmh = recovery.maxSpeed; app.rideHadHardware = recovery.hadHardware; app._deviceSourceChanges = recovery.sourceChanges;
        app._nextSampleStartsSegment = true; app.analytics.reset();
        for (const sample of recovery.samples) { if (sample.segmentStart) app.analytics.startSegment(); app.analytics.update(sample.power || 0); }
        app.isPlaying = false; app.isWorkoutCompleted = false;
        app.updateWorkoutOverview(); app.updatePlaybackControlsUi(); app.renderIntervalTrack(); app.populateCustomIntervalTable(); app.updateHudTitles();
        banner.hidden = true; app.showToast('Ride recovered and paused. Reconnect devices before resuming.', 'success');
      });
      app.on(document.getElementById('btnDiscardInterruptedRide'), 'click', async () => {
        if (!confirm('Discard this unfinished ride recovery copy?')) return;
        await native.deleteSetting(recovery.key); banner.hidden = true;
      });
    }
    const timer = setInterval(() => V.checkpointRide(app).catch(() => {}), 5000);
    app._disposers.push(() => clearInterval(timer));
  };
})();
