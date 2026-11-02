/**
 * APEX VELO // LAB - "Sync from Strava" (mixin on VeloApp).
 *
 *  1. Sync  -> reads the chosen range from Strava (GET only, via the local server), fetches
 *              second-by-second power for imports with a power meter, and shows a preview:
 *              new / linked / refreshed / removed / merged duplicates / needs review.
 *              The preview writes nothing.
 *  2. Apply -> writes a restore point first (history in localStorage + IndexedDB, training block,
 *              sync state; the last 5 are kept), computes the complete new history in memory,
 *              validates it, then writes it once. Any error: nothing is written.
 *  3. Undo  -> restores the last restore point exactly.
 *  4. Background check -> ~5 s after the app opens, reads Strava (no streams) and plans without
 *              applying; a badge on History and on the Sync button shows what a sync would change.
 *
 * Planning rules live in VeloStravaSync (js/velo-strava-sync.js).
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = () => VeloStravaSync;
  const SAMPLES_REF = '__samplesRef';

  const readJson = (key, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v === null ? fallback : v; } catch (e) { return fallback; }
  };
  const rawGet = (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } };

  Object.assign(VeloApp.prototype, {
    // ------------------------------------------------------------------ setup --
    initStravaSyncUi() {
      this._syncChoice = S().normaliseChoice(readJson(S().RANGE_KEY, null));
      const sel = document.getElementById('stravaSyncRange');
      const from = document.getElementById('stravaSyncFrom');
      const to = document.getElementById('stravaSyncTo');
      if (sel) {
        sel.value = this._syncChoice.mode === 'custom' ? 'custom' : String(this._syncChoice.weeks);
        this.on(sel, 'change', () => this.onSyncRangeChange());
      }
      if (from && to) {
        const r = S().rangeFor(this._syncChoice);
        const lastDay = new Date(r.beforeMs - 86400000);
        from.value = this._syncChoice.from || S().dayKey(new Date(r.afterMs));
        to.value = this._syncChoice.to || S().dayKey(lastDay);
        this.on(from, 'change', () => this.onSyncRangeChange());
        this.on(to, 'change', () => this.onSyncRangeChange());
      }
      this.on(document.getElementById('btnStravaSync'), 'click', () => this.previewStravaSync());
      this.on(document.getElementById('btnStravaUndo'), 'click', () => this.undoLastStravaSync());
      const strength = this.strengthLoadOptions();
      const inAtl = document.getElementById('chkStrengthInFatigue');
      const inCtl = document.getElementById('chkStrengthInFitness');
      if (inAtl) { inAtl.checked = strength.inFatigue; this.on(inAtl, 'change', () => this.setStrengthLoadOptions({ inFatigue: inAtl.checked })); }
      if (inCtl) { inCtl.checked = strength.inFitness; this.on(inCtl, 'change', () => this.setStrengthLoadOptions({ inFitness: inCtl.checked })); }
      const modal = document.getElementById('stravaSyncModal');
      this.on(modal, 'click', (e) => {
        const b = e.target.closest('[data-sync]');
        if (!b) return;
        const act = b.dataset.sync;
        if (act === 'apply') this.applyStravaSync();
        else if (act === 'cancel') this.cancelStravaSync();
        else if (act === 'import' || act === 'same') this.decideStravaReview(b.dataset.id, act, b.dataset.target);
        else if (act === 'undecide') this.decideStravaReview(b.dataset.id, null);
        else if (act === 'connect') this.connectStrava();
      });
      const auto = document.getElementById('chkStravaAutoCheck');
      if (auto) { auto.checked = this.stravaAutoCheckEnabled(); this.on(auto, 'change', () => this.setStravaAutoCheck(auto.checked)); }
      this.syncRangeUiState();
      this.renderStravaSyncStatus();
      this.scheduleStravaAutoCheck();
    },

    onSyncRangeChange() {
      const sel = document.getElementById('stravaSyncRange');
      const v = sel ? sel.value : String(S().DEFAULT_WEEKS);
      const choice = v === 'custom'
        ? { mode: 'custom', from: (document.getElementById('stravaSyncFrom') || {}).value, to: (document.getElementById('stravaSyncTo') || {}).value }
        : { mode: 'preset', weeks: Number(v) };
      this._syncChoice = S().normaliseChoice(choice);
      // The picker's last choice is a UI preference (not history), so it is remembered right away.
      try { localStorage.setItem(S().RANGE_KEY, JSON.stringify(v === 'custom' ? { mode: 'custom', from: choice.from, to: choice.to } : this._syncChoice)); } catch (e) { /* ignore */ }
      this.syncRangeUiState();
    },

    syncRangeUiState() {
      const custom = (document.getElementById('stravaSyncRange') || {}).value === 'custom';
      const box = document.getElementById('stravaSyncCustom');
      if (box) box.hidden = !custom;
      const lbl = document.getElementById('stravaSyncRangeLabel');
      if (lbl) lbl.textContent = S().rangeFor(this._syncChoice).label;
    },

    // ------------------------------------------------------- strength load --
    strengthLoadOptions() {
      const o = readJson(S().STRENGTH_KEY, {});
      return { inFatigue: o.inFatigue !== false, inFitness: o.inFitness === true };
    },

    setStrengthLoadOptions(patch) {
      const o = { ...this.strengthLoadOptions(), ...patch };
      try { localStorage.setItem(S().STRENGTH_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
      this.refreshAnalytics();
      this.renderCalendarView();
      this.showToast(`Strength sessions ${o.inFatigue ? 'count' : 'do not count'} toward fatigue (ATL)${o.inFitness ? ' and fitness (CTL)' : ''}.`, 'info');
    },

    /** PMC options for VeloAnalytics.calculatePmcHistory. */
    pmcOptions() {
      const o = this.strengthLoadOptions();
      return { strengthInAtl: o.inFatigue, strengthInCtl: o.inFitness };
    },

    // -------------------------------------------------------------- status --
    async renderStravaSyncStatus() {
      const undoBtn = document.getElementById('btnStravaUndo');
      const info = document.getElementById('stravaSyncUndoInfo');
      const last = await this.latestStravaBackup();
      if (undoBtn) undoBtn.disabled = !last;
      if (info) {
        info.textContent = last
          ? `Last sync ${new Date(last.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} - ${last.summary || ''}`
          : 'No sync to undo yet.';
      }
    },

    setSyncProgress(text, busy = true) {
      const el = document.getElementById('stravaSyncProgress');
      if (el) { el.textContent = text || ''; el.classList.toggle('is-busy', !!busy && !!text); }
      const btn = document.getElementById('btnStravaSync');
      if (btn) { btn.disabled = !!busy && !!text; btn.classList.toggle('is-loading', !!busy && !!text); }
    },

    // ------------------------------------------------------------- network --
    async stravaSyncFetch(url) {
      let r, j;
      try {
        r = await fetch(url, { method: 'GET', cache: 'no-store' });
        j = await r.json().catch(() => ({}));
      } catch (e) {
        throw Object.assign(new Error('Could not reach the local server. Is Launch-Apex-Velo.bat running?'), { network: true });
      }
      if (!r.ok) throw Object.assign(new Error(j.error || `Strava sync failed (HTTP ${r.status}).`), { status: r.status, needsConnect: !!j.needsConnect, needsReconnect: !!j.needsReconnect });
      return j;
    },

    /** Reads the range from Strava and fetches missing descriptions in batches (progress shown). */
    async fetchStravaRange(range, { detailBudget = S().DETAIL_BUDGET, quiet = false } = {}) {
      const progress = (t) => { if (!quiet) this.setSyncProgress(t); };
      progress('Reading your Strava activities...');
      const list = await this.stravaSyncFetch(`api/strava/sync?after=${encodeURIComponent(range.afterIso)}&before=${encodeURIComponent(range.beforeIso)}`);
      this._lastStravaRate = list.rate || this._lastStravaRate; // fresh usage for this sync's budget checks
      const state = this.loadStravaSyncState();
      const cache = { ...(state.detailCache || {}) };
      const { need } = S().withDetails(list.activities || [], cache);
      const todo = need.slice(0, detailBudget);
      let done = 0, rateLimited = false;
      const missing = new Set();
      for (let i = 0; i < todo.length; i += S().DETAIL_BATCH) {
        const rate = this._lastStravaRate;
        if (rate && rate.limit15 && rate.used15 >= rate.limit15 - 5) { rateLimited = true; break; }
        const batch = todo.slice(i, i + S().DETAIL_BATCH);
        progress(`Fetching activity details ${done}/${todo.length}...`);
        const d = await this.stravaSyncFetch(`api/strava/sync?ids=${batch.join(',')}`);
        this._lastStravaRate = d.rate || this._lastStravaRate;
        const now = Date.now();
        (d.activities || []).forEach(a => { cache[String(a.id)] = { description: String(a.description || ''), calories: Number(a.calories) || 0, fetchedAt: now }; });
        (d.missing || []).forEach(id => missing.add(String(id)));
        done += batch.length;
        if (d.rateLimited) { rateLimited = true; break; }
      }
      const merged = S().withDetails(list.activities || [], cache);
      const pending = merged.activities.filter(a => !a.detailed).length;
      return { activities: merged.activities.filter(a => !missing.has(String(a.id))), cache, pending, rateLimited, fetchedDetails: done };
    },

    // --------------------------------------------------------------- state --
    loadStravaSyncState() {
      const st = readJson(S().STATE_KEY, {});
      return { merged: st.merged || {}, decisions: st.decisions || {}, detailCache: st.detailCache || {}, lastSync: st.lastSync || null };
    },

    syncOptions() {
      const p = this.activeProfile || {};
      return { ftp: p.ftp || 185, maxHr: p.maxHr || 175, lthr: p.lthr || 0, profileName: p.name || '' };
    },

    // ------------------------------------------------------------- preview --
    async previewStravaSync(choice) {
      if (this._syncBusy) return null;
      this._syncBusy = true;
      const c = S().normaliseChoice(choice || this._syncChoice);
      const range = S().rangeFor(c);
      try {
        const fetched = await this.fetchStravaRange(range);
        const state = this.loadStravaSyncState();
        this._stravaSyncPreview = { range, choice: c, fetched, decisions: { ...state.decisions }, state };
        this.replanStravaSync();
        await this.fetchStravaStreams(this._stravaSyncPreview);
        this.setSyncProgress('', false);
        this.setStravaSyncBadge(this._stravaSyncPreview.plan);
        this.renderStravaSyncDialog();
        this.openModal('stravaSyncModal');
        return this._stravaSyncPreview.plan;
      } catch (e) {
        this.setSyncProgress('', false);
        const msg = e.message || String(e);
        this._stravaSyncPreview = null;
        this.renderStravaSyncError(msg, e.needsConnect || e.needsReconnect);
        this.showToast(msg, 'error');
        return null;
      } finally {
        this._syncBusy = false;
      }
    },

    /**
     * Second-by-second power for imports with a power meter and no samples yet: at most
     * STREAM_BUDGET per sync, stopping early near Strava's 15-minute read limit. The converted
     * samples go on the activity (or streams = 'none' when Strava has no power stream), then the
     * plan is made again. Nothing is written - that only happens on Apply.
     */
    async fetchStravaStreams(p) {
      const ids = S().streamCandidates(p.plan);
      const f = p.fetched;
      f.streamsAdded = 0; f.streamsPending = 0; f.streamsError = '';
      if (!ids.length) return 0;
      const todo = ids.slice(0, S().STREAM_BUDGET);
      const byId = new Map(f.activities.map(a => [String(a.id), a]));
      let done = 0;
      for (const id of todo) {
        const rate = this._lastStravaRate;
        if (rate && rate.limit15 && rate.used15 >= rate.limit15 - 5) { f.streamsRateLimited = true; break; }
        this.setSyncProgress(`Fetching power data ${done}/${todo.length}...`);
        let d;
        try {
          d = await this.stravaSyncFetch(`api/strava/sync?streams=${encodeURIComponent(id)}`);
        } catch (e) {
          // The summaries are already planned; the missing power data is added by the next sync.
          f.streamsError = e.message || String(e);
          break;
        }
        this._lastStravaRate = d.rate || this._lastStravaRate;
        if (d.rateLimited) { f.streamsRateLimited = true; break; }
        done++;
        const a = byId.get(id);
        if (!a || d.missing) continue;
        const samples = S().streamsToSamples(d.streams);
        if (samples) { a.samples = samples; f.streamsAdded++; } else a.streams = 'none';
      }
      f.streamsPending = ids.length - done;
      this.replanStravaSync();
      return done;
    },

    replanStravaSync() {
      const p = this._stravaSyncPreview;
      if (!p) return null;
      p.plan = S().plan({
        activities: p.fetched.activities, history: this.completedWorkouts, range: p.range,
        state: { merged: p.state.merged, decisions: p.decisions }, opts: this.syncOptions(),
        keepMissing: !!p.archive  // an archive import only adds, links and refreshes - it never removes
      });
      p.decisionsChanged = S().stable(p.decisions) !== S().stable(p.state.decisions);
      return p.plan;
    },

    decideStravaReview(id, verdict, target) {
      const p = this._stravaSyncPreview;
      if (!p) return;
      if (!verdict) delete p.decisions[id];
      else p.decisions[id] = verdict === 'same' ? { verdict: 'same', target } : { verdict: 'import' };
      this.replanStravaSync();
      this.renderStravaSyncDialog();
    },

    cancelStravaSync() {
      this._stravaSyncPreview = null;
      this._archiveSetup = null;
      this.closeModal('stravaSyncModal');
    },

    renderStravaSyncError(msg, reconnect) {
      const el = document.getElementById('stravaSyncProgress');
      if (el) {
        el.innerHTML = `<span class="sync-error">${esc(msg)}</span>${reconnect ? ' <button type="button" class="link-btn" id="btnStravaSyncReconnect">Reconnect Strava</button>' : ''}`;
        const b = document.getElementById('btnStravaSyncReconnect');
        if (b) b.onclick = () => this.connectStrava();
      }
    },

    renderStravaSyncDialog() {
      const p = this._stravaSyncPreview;
      const body = document.getElementById('stravaSyncBody');
      if (!p || !body) return;
      const plan = p.plan;
      const title = document.getElementById('stravaSyncTitle');
      if (title) title.textContent = p.archive ? 'Strava archive preview' : 'Strava sync preview';
      const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '--' : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
      const kindChip = (a) => { const k = S().activityKind(a.sport_type || a.type); return k === 'ride' ? '' : `<span class="chip chip-xs act-chip act-${k}">${esc(a.sport_type || k)}</span>`; };
      const mins = (a) => `${Math.round((Number(a.moving_time) || Number(a.elapsed_time) || 0) / 60)} min`;
      const actLine = (a) => `<span class="sync-when num">${fmtDate(a.start_date)}</span><b>${esc(a.name || 'Untitled')}</b>${kindChip(a)}<span class="sync-dur num">${mins(a)}</span>`;
      const section = (key, title, items, row, open) => `
        <details class="sync-cat sync-${key}" ${open && items.length ? 'open' : ''} data-cat="${key}">
          <summary><span>${title}</span><span class="chip chip-ghost num">${items.length}</span></summary>
          ${items.length ? `<ul class="sync-list">${items.map(row).join('')}</ul>` : '<div class="dim sync-empty">None</div>'}
        </details>`;
      const newRows = (x) => {
        const r = x.record;
        const load = r.activityType === 'ride' ? `${r.tss} TSS${r.tssEstimated ? ` (est. from ${r.tssMethod})` : ''}` : r.activityType === 'strength' ? `strength load ${r.strengthTss}` : 'no training load';
        return `<li>${actLine(x.activity)}<span class="sync-sub">${esc(load)}</span></li>`;
      };
      const linkRows = (x) => `<li>${actLine(x.activity)}<span class="sync-sub">combines with your ride "${esc(x.rideTitle || '')}" (${fmtDate(x.rideDate)})${x.score !== null ? ` - ${Math.round(x.score * 100)}% match` : ''}; Strava distance/time, local recordings kept</span></li>`;
      const STREAM_KEYS = new Set(['samples', 'streams', 'np', 'tss', 'if', 'tssMethod', 'tssEstimated', 'maxWatts']);
      const refRows = (x) => {
        const powerOnly = x.changes.every(k => STREAM_KEYS.has(k));
        const what = S().isAppNative(x.record) ? `updates matched ride: ${x.changes.filter(k => k !== 'stravaSummaryFallback').join(', ')}` : !powerOnly ? `changed on Strava: ${x.changes.join(', ')}`
          : x.record.streams === 'ok' ? 'adds second-by-second power (TSS from the power stream)' : 'no power stream on Strava - keeps the summary';
        return `<li>${actLine(x.activity)}<span class="sync-sub">${esc(what)}</span></li>`;
      };
      const remRows = (x) => `<li><span class="sync-when num">${fmtDate(x.record.date)}</span><b>${esc(x.record.title)}</b><span class="sync-sub">deleted on Strava - removes the imported copy</span></li>`;
      const mergeRows = (x) => `<li>${actLine(x.activity)}<span class="sync-sub">${esc(x.reason)}${x.keptName ? ` - keeps "${esc(x.keptName)}"` : ''}${x.removeRecordId ? ' - removes its imported copy' : ''}</span></li>`;
      const reviewRows = (x) => `<li class="sync-review-row">${actLine(x.activity)}
          <span class="sync-sub">looks like "${esc(x.candidate.title)}" (${esc(x.candidate.source)}, ${fmtDate(x.candidate.date)}) - ${Math.round(x.score * 100)}% match: ${esc((x.why || []).join(', '))}</span>
          <span class="btn-row btn-row-tight"><button type="button" class="btn btn-xs" data-sync="import" data-id="${esc(x.activity.id)}">Import</button>
          <button type="button" class="btn btn-xs btn-primary" data-sync="same" data-id="${esc(x.activity.id)}" data-target="${esc(x.candidate.id)}">It's the same</button></span></li>`;
      const decided = Object.keys(p.decisions).filter(id => !p.state.decisions[id] || S().stable(p.state.decisions[id]) !== S().stable(p.decisions[id]));
      const willApply = plan.hasChanges || p.decisionsChanged;
      const notes = [];
      if (plan.alreadyLinked) notes.push(`${plan.alreadyLinked} already linked to your rides`);
      if (plan.unchanged) notes.push(`${plan.unchanged} imported earlier and unchanged`);
      if (plan.knownMerged) notes.push(`${plan.knownMerged} merged duplicate${plan.knownMerged === 1 ? '' : 's'} skipped`);
      if (plan.staleLinks.length) notes.push(`${plan.staleLinks.length} of your rides link to a Strava activity that no longer exists (your rides are not changed)`);
      if (p.fetched.streamsAdded) notes.push(`${p.fetched.streamsAdded} ride${p.fetched.streamsAdded === 1 ? '' : 's'} get${p.fetched.streamsAdded === 1 ? 's' : ''} second-by-second power data`);
      if (p.fetched.streamsPending) notes.push(`${p.fetched.streamsPending} ride${p.fetched.streamsPending === 1 ? '' : 's'} still without power data (${p.fetched.streamsError ? 'Strava could not be read' : 'Strava rate limit'}) - the next sync adds ${p.fetched.streamsPending === 1 ? 'it' : 'them'}`);
      if (p.archive) {
        const a = p.archive;
        notes.push(`${a.rideFiles} ride file${a.rideFiles === 1 ? '' : 's'} read from ${a.fileName}`);
        if (a.powerRides) notes.push(`${a.powerRides} with a power meter, ${a.sampleRides} of them with second-by-second data`);
        if (a.failed.length) notes.push(`${a.failed.length} file${a.failed.length === 1 ? '' : 's'} could not be read (summary from activities.csv used instead)`);
        if (a.missingFiles) notes.push(`${a.missingFiles} ride file${a.missingFiles === 1 ? '' : 's'} not in the ZIP (summary used)`);
        notes.push('nothing is removed by an archive import');
      }
      if (p.fetched.pending) notes.push(`${p.fetched.pending} activit${p.fetched.pending === 1 ? 'y' : 'ies'} without description yet (Strava rate limit) - the next sync adds them`);
      body.innerHTML = `
        <div class="sync-head">
          <div><b>${esc(p.range.label)}</b> <span class="sync-sub">- ${plan.fetched} Strava activit${plan.fetched === 1 ? 'y' : 'ies'} read. Nothing has been changed yet.</span></div>
          <div class="sync-counts">
            <span class="chip">${plan.new.length} new</span><span class="chip">${plan.linked.length} linked</span><span class="chip">${plan.refreshed.length} refreshed</span>
            <span class="chip">${plan.removed.length} removed</span><span class="chip">${plan.merged.length} merged</span><span class="chip ${plan.review.length ? 'chip-amber' : ''}">${plan.review.length} need review</span>
          </div>
          ${willApply ? '' : '<div class="sync-nochange" id="stravaSyncNoChanges">No changes - the app already matches Strava for this range.</div>'}
          ${notes.length ? `<div class="dim sync-notes">${esc(notes.join(' · '))}</div>` : ''}
        </div>
        ${section('new', 'New from Strava', plan.new, newRows, true)}
        ${section('linked', 'Combined with rides already in the app', plan.linked, linkRows, true)}
        ${section('refreshed', 'Refreshed rides', plan.refreshed, refRows, true)}
        ${section('removed', 'Removed (deleted on Strava)', plan.removed, remRows, true)}
        ${section('merged', 'Merged Strava duplicates', plan.merged, mergeRows, false)}
        ${section('review', 'Needs review (possible duplicates - never imported automatically)', plan.review, reviewRows, true)}
        ${decided.length ? `<div class="dim sync-notes">Your decisions for ${decided.length} activit${decided.length === 1 ? 'y' : 'ies'} are saved when you press Apply.</div>` : ''}
        <div class="modal-actions">
          <span class="sync-sub">A restore point is saved first - "Undo last sync" puts everything back.</span>
          <div class="btn-row">
            <button type="button" class="btn btn-ghost" data-sync="cancel">Cancel</button>
            <button type="button" class="btn btn-primary" data-sync="apply" id="btnStravaSyncApply" ${willApply ? '' : 'disabled'}>Apply</button>
          </div>
        </div>`;
    },

    // ------------------------------------------------------ restore points --
    /**
     * Everything a sync can change, captured exactly. Ride samples are kept by reference (they are
     * still stored at undo time), except for records the sync deletes or whose samples it replaces:
     * those samples are stored in full, since they will be gone.
     */
    async snapshotForSync(next = null) {
      const idb = await VeloDB.getAllRides();
      if (idb === null) throw new Error('The ride database could not be read, so no restore point could be made. Nothing was changed.');
      const full = new Set();
      if (next) {
        (next.del || []).forEach(id => full.add(id));
        const memById = new Map(this.completedWorkouts.map(r => [r.id, r]));
        (next.put || []).forEach(q => {
          const m = memById.get(q.id);
          if (m && Array.isArray(m.samples) && m.samples.length && q.samples !== m.samples) full.add(q.id);
        });
      }
      const strip = (r) => {
        const o = {};
        Object.keys(r).forEach(k => {
          o[k] = k === 'samples' && Array.isArray(r.samples) && !full.has(r.id) ? { [SAMPLES_REF]: r.samples.length } : r[k];
        });
        return o;
      };
      return {
        local: { history: rawGet('apex_velo_history'), block: rawGet(VeloBlockPlanner.STORAGE_KEY), syncState: rawGet(S().STATE_KEY) },
        idb: idb.map(strip),
        memory: this.completedWorkouts.map(strip)
      };
    },

    async writeStravaBackup(snapshot, meta) {
      const createdAt = Date.now();
      const key = `${S().BACKUP_PREFIX}${createdAt}`;
      const ok = this._syncFailAt === 'backup' ? false : await VeloDB.putSetting({ key, createdAt, ...meta, ...snapshot });
      if (!ok) throw new Error('Could not save the restore point, so the sync was not applied. Nothing was changed.');
      const back = await VeloDB.getSetting(key);
      if (!back || back.createdAt !== createdAt) throw new Error('The restore point could not be verified, so the sync was not applied. Nothing was changed.');
      return key;
    },

    async listStravaBackups() {
      const all = await VeloDB.listSettings(S().BACKUP_PREFIX);
      return (all || []).sort((a, b) => b.createdAt - a.createdAt);
    },

    async latestStravaBackup() {
      const list = await this.listStravaBackups();
      return list[0] || null;
    },

    async pruneStravaBackups() {
      const list = await this.listStravaBackups();
      for (const b of list.slice(S().KEEP_BACKUPS)) await VeloDB.deleteSetting(b.key);
    },

    /** Mirrors a history list to localStorage like persistHistoryLocal (full, else summaries). */
    writeHistoryLocal(list) {
      if (this._syncFailAt === 'local') return false;
      // Browser storage holds a few MB: with many recorded samples go straight to the summaries.
      const samples = list.reduce((n, r) => n + (Array.isArray(r.samples) ? r.samples.length : 0), 0);
      if (samples > 200000) {
        try { localStorage.setItem('apex_velo_history', JSON.stringify(list.map(({ samples: s, ...rest }) => rest))); return true; } catch (e2) { return false; }
      }
      try { localStorage.setItem('apex_velo_history', JSON.stringify(list)); return true; } catch (e) {
        try { localStorage.setItem('apex_velo_history', JSON.stringify(list.map(({ samples, ...rest }) => rest))); return true; } catch (e2) { return false; }
      }
    },

    /** Puts IndexedDB + localStorage back exactly as in a restore point. */
    async restoreSnapshot(snap, { keepAfter = null } = {}) {
      const current = await VeloDB.getAllRides();
      if (current === null) throw new Error('The ride database could not be read - nothing was restored.');
      const curById = new Map(current.map(r => [r.id, r]));
      const memById = new Map(this.completedWorkouts.map(r => [r.id, r]));
      const withSamples = (r, pool) => {
        const o = {};
        for (const k of Object.keys(r)) {
          if (k === 'samples' && r.samples && r.samples[SAMPLES_REF] !== undefined) {
            const src = pool.get(r.id) || curById.get(r.id) || memById.get(r.id);
            if (!src || !Array.isArray(src.samples)) throw new Error(`Samples of ride ${r.id} are missing - nothing was restored.`);
            o.samples = src.samples;
          } else o[k] = r[k];
        }
        return o;
      };
      const idbRides = snap.idb.map(r => withSamples(r, curById));
      // App-native rides recorded after the sync are never dropped by an undo (they stay as stored).
      const snapIds = new Set(snap.idb.map(r => r.id));
      const extraNative = (keepAfter || []).filter(r => S().isAppNative(r) && !snapIds.has(r.id));
      const keepIds = new Set(extraNative.map(r => r.id));
      const del = current.filter(r => !snapIds.has(r.id) && !keepIds.has(r.id)).map(r => r.id);
      // Exact: a record that had no samples before the sync gets none back (streams added by the sync go).
      const ok = await VeloDB.applyRideChanges(idbRides, del, { exact: true });
      if (!ok) throw new Error('Could not write the ride database - nothing was restored.');
      const memory = [...extraNative, ...snap.memory.map(r => withSamples(r, memById))];
      const setRaw = (k, v) => { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, v); };
      if (extraNative.length) this.writeHistoryLocal(memory); else setRaw('apex_velo_history', snap.local.history);
      setRaw(VeloBlockPlanner.STORAGE_KEY, snap.local.block);
      setRaw(S().STATE_KEY, snap.local.syncState);
      if (window.VeloStorage?.enabled) await VeloStorage.flush();
      this.completedWorkouts = memory;
      if (this.blockPlanner) this.blockPlanner.block = VeloBlockPlanner.load();
      return true;
    },

    // --------------------------------------------------------------- apply --
    async applyStravaSync() {
      const p = this._stravaSyncPreview;
      if (!p || this._syncBusy) return { ok: false, error: 'Nothing to apply.' };
      this._syncBusy = true;
      const btn = document.getElementById('btnStravaSyncApply');
      if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
      const before = this.completedWorkouts;
      let backupKey = null, idbWritten = false;
      try {
        // Plan again against the history as it is now (a ride may have been saved meanwhile).
        const plan = this.replanStravaSync();
        const next = S().nextState(before, plan);
        const errors = S().validate(before, next.history, plan);
        if (errors.length) throw new Error(`Safety check failed, nothing was written: ${errors.slice(0, 3).join('; ')}`);
        const state = this.loadStravaSyncState();
        const keepCache = {};
        const seen = new Set(p.fetched.activities.map(a => String(a.id)));
        Object.entries({ ...state.detailCache, ...p.fetched.cache }).forEach(([id, v]) => {
          if (seen.has(id) || before.some(r => S().linkOf(r) === id || String(r.stravaActivityId || '') === id)) keepCache[id] = v;
        });
        const nextState = {
          merged: plan.mergedMap, decisions: p.decisions, detailCache: keepCache,
          lastSync: { at: Date.now(), range: p.range.label, counts: { new: plan.new.length, linked: plan.linked.length, refreshed: plan.refreshed.length, removed: plan.removed.length, merged: plan.merged.length, review: plan.review.length } }
        };
        const summary = `${plan.new.length} new, ${plan.linked.length} linked, ${plan.refreshed.length} refreshed, ${plan.removed.length} removed, ${plan.merged.length} merged`;

        // 1. Restore point BEFORE any change.
        const snap = await this.snapshotForSync(next);
        backupKey = await this.writeStravaBackup(snap, { range: p.range.label, summary, links: plan.linked.map(l => ({ rideId: l.rideId, activityId: String(l.activity.id) })) });

        // 2. One IndexedDB transaction with every put and delete.
        if (this._syncFailAt === 'idb') throw new Error('Simulated failure while writing the ride database.');
        // Large changes are saved in parts: once the first part may be written, a failure restores the restore point.
        idbWritten = true;
        this.setSyncBar('Saving rides...', 0);
        const dbOk = await VeloDB.applyRideChanges(next.put, next.del, { onProgress: (done, total) => this.setSyncBar(`Saving rides... part ${done} of ${total}`, done / total) });
        if (!dbOk) throw new Error(window.VeloStorage?.error ? `Could not write the ride database: ${String(VeloStorage.error).replace(/\.$/, '')}.` : 'Could not write the ride database.');

        // 3. localStorage mirror + sync state.
        if (!this.writeHistoryLocal(next.history)) throw new Error('Could not write the ride history to browser storage.');
        try { localStorage.setItem(S().STATE_KEY, JSON.stringify(nextState)); } catch (e) { throw new Error('Could not save the sync state.'); }
        if (window.VeloStorage?.enabled) await VeloStorage.flush();
        if (this._syncFailAt === 'after-local') throw new Error('Simulated failure after writing browser storage.');

        this.completedWorkouts = next.history;
        this._stravaSyncPreview = null;
        this.setSyncBar('');
        this.closeModal('stravaSyncModal');
        await this.pruneStravaBackups();
        if (this.reviewTrainingBlock) this.reviewTrainingBlock({ announce: true });
        this.afterHistoryReplaced();
        this.renderStravaSyncStatus();
        this.setStravaSyncBadge(null);
        this.showToast(`Strava sync applied: ${summary}. "Undo last sync" restores the previous state.`, 'success');
        return { ok: true, plan, backupKey };
      } catch (e) {
        let msg = e.message || String(e);
        if (idbWritten || backupKey) {
          // (A failed backup write leaves no key, so nothing had been changed.)
          // Roll back to the restore point so storage is exactly as before.
          try {
            if (idbWritten) {
              this.setSyncBar('Putting everything back...', 0);
              const snapRec = await VeloDB.getSetting(backupKey);
              if (!snapRec) throw new Error('restore point not found');
              await this.restoreSnapshot(snapRec);
              msg += ' Everything was put back as it was.';
            } else if (!/Nothing was changed/.test(msg)) {
              msg += ' Nothing was changed.';
            }
            this.completedWorkouts = before;
            // The restore point of a sync that never happened is not kept.
            if (backupKey) await VeloDB.deleteSetting(backupKey);
          } catch (e2) {
            msg += ` Rolling back also failed (${e2.message}) - use "Undo last sync".`;
          }
        }
        this.showToast(msg, 'error');
        const body = document.getElementById('stravaSyncBody');
        if (body && !body.querySelector('.sync-error')) body.insertAdjacentHTML('afterbegin', `<div class="sync-error">${esc(msg)}</div>`);
        return { ok: false, error: msg };
      } finally {
        this._syncBusy = false;
        this.setSyncBar('');
        if (btn) btn.classList.remove('is-loading');
      }
    },

    /** The progress bar of the sync / archive dialog: label and fraction 0-1 (no label hides it, null = busy). */
    setSyncBar(label, fraction = null) {
      const wrap = document.getElementById('stravaSyncBar');
      if (!wrap) return;
      wrap.hidden = !label;
      const text = wrap.querySelector('.sync-bar-label');
      const bar = wrap.querySelector('progress');
      if (text) text.textContent = label || '';
      if (bar) { if (fraction === null) bar.removeAttribute('value'); else bar.value = Math.max(0, Math.min(1, fraction)); }
    },

    /** Re-renders every view that depends on the ride list (no storage writes). */
    afterHistoryReplaced() {
      if (this.scheduleAutoBackup) this.scheduleAutoBackup();
      this.renderHistoryTable();
      this.renderCalendarView();
      this.refreshAnalytics();
      if (this.activeTab === 'ai-coach' && this.renderTrainingBlock) this.renderTrainingBlock();
    },

    // ---------------------------------------------------- background check --
    stravaAutoCheckEnabled() { return rawGet(S().AUTOCHECK_KEY) !== 'false'; },

    setStravaAutoCheck(on) {
      try { localStorage.setItem(S().AUTOCHECK_KEY, on ? 'true' : 'false'); } catch (e) { /* ignore */ }
      if (!on) { clearTimeout(this._stravaAutoTimer); this.setStravaSyncBadge(null); }
      this.showToast(on ? 'Strava is checked for changes each time the app opens (nothing is imported until you press Sync).' : 'Automatic Strava check turned off.', 'info');
    },

    scheduleStravaAutoCheck(delayMs = 5000) {
      if (window.__APEX_TEST_MODE__ || !this.stravaAutoCheckEnabled()) return;
      clearTimeout(this._stravaAutoTimer);
      this._stravaAutoTimer = setTimeout(() => { this.runStravaAutoCheck().catch(() => {}); }, delayMs);
    },

    /**
     * Read-only look at the chosen range: the activity list plus ~20 details, no streams, planned
     * but never applied. Only sets the badges (and one toast). Returns the plan, or null when skipped.
     */
    async runStravaAutoCheck() {
      if (this._syncBusy || this._stravaAutoRunning || this._stravaSyncPreview || !this.stravaAutoCheckEnabled()) return null;
      if (!this.strava || !this.strava.reachable) await this.refreshStravaStatus(false);
      const sv = this.strava || {};
      if (!sv.connected || !sv.canSync) return null;
      // Its own flag: pressing "Sync from Strava" meanwhile is never blocked, and wins.
      this._stravaAutoRunning = true;
      try {
        const range = S().rangeFor(this._syncChoice || S().normaliseChoice(null));
        const fetched = await this.fetchStravaRange(range, { detailBudget: 20, quiet: true });
        const state = this.loadStravaSyncState();
        const plan = S().plan({
          activities: fetched.activities, history: this.completedWorkouts, range,
          state: { merged: state.merged, decisions: state.decisions }, opts: this.syncOptions()
        });
        if (this._syncBusy || this._stravaSyncPreview) return null;
        const n = this.setStravaSyncBadge(plan);
        if (n && !this._stravaAutoToasted) {
          this._stravaAutoToasted = true;
          this.showToast(`Strava has ${n} change${n === 1 ? '' : 's'} for ${range.label.toLowerCase()} - open History and press "Sync from Strava" to review.`, 'info');
        }
        return plan;
      } catch (e) {
        return null; // a background check stays quiet; "Sync from Strava" shows real errors
      } finally {
        this._stravaAutoRunning = false;
      }
    },

    /** Count badge on the History tab and the Sync button (none when plan is null or has nothing). */
    setStravaSyncBadge(plan) {
      const n = plan ? (plan.changeCount || 0) + (plan.review ? plan.review.length : 0) : 0;
      const targets = [document.querySelector('.nav-btn[data-tab="history"]'), document.getElementById('btnStravaSync')];
      targets.forEach(el => {
        if (!el) return;
        let b = el.querySelector('.sync-badge');
        if (!n) { if (b) b.remove(); return; }
        if (!b) { b = document.createElement('span'); b.className = 'sync-badge num'; el.appendChild(b); }
        b.textContent = n > 99 ? '99+' : String(n);
        b.title = `${n} change${n === 1 ? '' : 's'} waiting on Strava`;
      });
      this._stravaPendingCount = n;
      return n;
    },

    // ---------------------------------------------------------------- undo --
    async undoLastStravaSync({ confirmFirst = true } = {}) {
      if (this._syncBusy) return { ok: false };
      const last = await this.latestStravaBackup();
      if (!last) { this.showToast('There is no sync to undo.', 'warning'); return { ok: false }; }
      const when = new Date(last.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      if (confirmFirst && !confirm(`Undo the Strava sync of ${when}? History, links and the training block go back to how they were before it. Rides recorded since then are kept.`)) return { ok: false };
      this._syncBusy = true;
      try {
        // Rides recorded or sent to Strava after the sync keep their current state.
        const snapIds = new Set(last.idb.map(r => r.id));
        const later = this.completedWorkouts.filter(r => S().isAppNative(r) && !snapIds.has(r.id));
        await this.restoreSnapshot(last, { keepAfter: later });
        await VeloDB.deleteSetting(last.key);
        this.afterHistoryReplaced();
        this.renderStravaSyncStatus();
        this.showToast(`Sync of ${when} undone - history restored.`, 'success');
        return { ok: true };
      } catch (e) {
        this.showToast(`Undo failed: ${e.message}`, 'error');
        return { ok: false, error: e.message };
      } finally {
        this._syncBusy = false;
      }
    }
  });
})();
