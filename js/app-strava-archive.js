/**
 * APEX VELO // LAB - Strava archive import (mixin on VeloApp).
 *
 * Reads the ZIP from Strava's "Download your account" in the browser (js/velo-zip.js): activities.csv for
 * every activity and, for rides, the activity file (.fit / .gpx / .tcx, often .gz). The rider first chooses
 * how far back second-by-second data is kept (a whole history can be gigabytes); older rides keep exact
 * NP and TSS from their file but no samples. The activities then go through the same preview and apply as
 * "Sync from Strava" (app-strava-sync.js): duplicates are linked instead of imported, a restore point is
 * saved first and "Undo last sync" puts everything back. Nothing is uploaded: the archive is read on this PC.
 */
(function () {
  const A = () => VeloStravaArchive;
  const esc = (s) => VeloApp.esc(s);
  const tick = () => new Promise(r => setTimeout(r, 0));

  Object.assign(VeloApp.prototype, {
    /** Shows import progress under the History drop zone and in the dialog (empty text hides it). */
    setArchiveProgress(text) {
      const el = document.getElementById('historyImportProgress');
      if (el) { el.textContent = text || ''; el.hidden = !text; }
      const live = document.getElementById('archiveProgress');
      if (live) live.textContent = text || '';
    },

    /** Unpacks one activity file from the archive and parses it as a ride (or returns null). */
    async parseArchiveFile(zipFile, entry, opts) {
      let buf = await VeloZip.read(zipFile, entry);
      let name = entry.name.toLowerCase();
      if (name.endsWith('.gz')) { buf = await VeloZip.gunzip(buf); name = name.slice(0, -3); }
      if (name.endsWith('.fit')) return VeloRideImporter.parseFit(buf, opts.profileName, opts.ftp);
      const text = new TextDecoder('utf-8').decode(buf);
      if (name.endsWith('.tcx')) return VeloRideImporter.parseTcx(text, opts.ftp, opts.profileName);
      if (name.endsWith('.gpx')) return VeloRideImporter.parseGpx(text, opts.ftp, opts.profileName);
      return null;
    },

    savedArchiveSampleYears() {
      let v = null;
      try { v = localStorage.getItem(A().SAMPLE_YEARS_KEY); } catch (e) { /* storage unavailable */ }
      if (v === null || v === '') return A().DEFAULT_SAMPLE_YEARS;
      const y = v === 'all' ? Infinity : Number(v);
      return A().SAMPLE_YEARS.includes(y) ? y : A().DEFAULT_SAMPLE_YEARS;
    },

    /** Step 1: opens the ZIP, reads activities.csv and asks how far back second-by-second data is kept. */
    async importStravaArchive(file) {
      if (this._syncBusy) { this.showToast('A Strava sync or import is already running.', 'warning'); return null; }
      if (!VeloZip.supported()) { this.showToast('This browser cannot unpack ZIP files - use a current Chrome or Edge.', 'error'); return null; }
      this._syncBusy = true;
      try {
        this.setArchiveProgress(`Opening ${file.name}...`);
        const entries = await VeloZip.list(file);
        const csvEntry = entries.find(e => /(^|\/)activities\.csv$/i.test(e.name));
        if (!csvEntry) throw new Error(`${file.name} has no activities.csv - is it the ZIP from Strava's "Download your account"?`);
        const list = A().parseActivitiesCsv(new TextDecoder('utf-8').decode(await VeloZip.read(file, csvEntry)));
        this._archiveSetup = { file, entries, csvEntry, list };
        this.setArchiveProgress('');
        this.renderArchiveSetup();
        this.bindArchiveUi();
        this.openModal('stravaSyncModal');
        return list.length;
      } catch (e) {
        this.setArchiveProgress('');
        this._archiveSetup = null;
        this.showToast(`Strava archive: ${e.message || e}`, 'error');
        return null;
      } finally {
        this._syncBusy = false;
      }
    },

    bindArchiveUi() {
      if (this._archiveUiBound) return;
      this._archiveUiBound = true;
      const modal = document.getElementById('stravaSyncModal');
      this.on(modal, 'click', (e) => {
        const b = e.target.closest('[data-archive]');
        if (!b) return;
        if (b.dataset.archive === 'start') {
          const sel = document.getElementById('archiveSampleYears');
          const years = sel && sel.value === 'all' ? Infinity : Number(sel ? sel.value : A().DEFAULT_SAMPLE_YEARS);
          this.runStravaArchiveImport(years);
        }
      });
      this.on(modal, 'change', (e) => { if (e.target.id === 'archiveSampleYears') this.renderArchiveSetupHint(); });
    },

    /** The setup step in the sync dialog: what the archive holds and the second-by-second choice. */
    renderArchiveSetup() {
      const s = this._archiveSetup;
      const body = document.getElementById('stravaSyncBody');
      if (!s || !body) return;
      const title = document.getElementById('stravaSyncTitle');
      if (title) title.textContent = 'Import Strava archive';
      const rides = s.list.filter(e => A().wantsFile(e));
      const dates = s.list.map(e => e.startIso.slice(0, 10)).sort();
      const chosen = this.savedArchiveSampleYears();
      const label = { 1: 'the last year', 2: 'the last 2 years', 5: 'the last 5 years', Infinity: 'all rides', 0: 'no rides (summaries only)' };
      const opt = (y) => `<option value="${y === Infinity ? 'all' : y}" ${y === chosen ? 'selected' : ''}>${label[y]}</option>`;
      body.innerHTML = `
        <div class="sync-head">
          <div><b>${esc(s.file.name)}</b> <span class="sync-sub">- ${s.list.length} activities from ${esc(dates[0] || '--')} to ${esc(dates[dates.length - 1] || '--')}, ${rides.length} rides with an activity file. Nothing has been changed yet.</span></div>
          <label class="field"><span>Keep second-by-second data (power curve, best efforts, CP model, ride charts) for</span>
            <select id="archiveSampleYears" class="input-field">${A().SAMPLE_YEARS.map(opt).join('')}</select></label>
          <div class="dim sync-notes" id="archiveSampleHint"></div>
          <div class="dim sync-notes" id="archiveProgress" aria-live="polite"></div>
        </div>
        <div class="modal-actions">
          <span class="sync-sub">The next step shows a preview; nothing is saved before you press Apply.</span>
          <div class="btn-row">
            <button type="button" class="btn btn-ghost" data-sync="cancel">Cancel</button>
            <button type="button" class="btn btn-primary" data-archive="start" id="btnArchiveStart">Read activities</button>
          </div>
        </div>`;
      this.renderArchiveSetupHint();
    },

    renderArchiveSetupHint() {
      const s = this._archiveSetup;
      const hint = document.getElementById('archiveSampleHint');
      const sel = document.getElementById('archiveSampleYears');
      if (!s || !hint || !sel) return;
      const years = sel.value === 'all' ? Infinity : Number(sel.value);
      const cutoff = A().sampleCutoff(years);
      const rides = s.list.filter(e => A().wantsFile(e));
      const inWindow = rides.filter(e => Date.parse(e.startIso) >= cutoff).length;
      hint.textContent = years === 0
        ? 'Every ride gets exact NP and TSS from its file, but no second-by-second data is stored. Fastest and smallest.'
        : `${inWindow} of ${rides.length} rides fall in this period; those with a power meter keep their second-by-second data. ` +
          'Older rides still get exact NP and TSS from their file.' + (years === Infinity && rides.length > 300 ? ' Not recommended for a long history: the app loads all of it at every start, which can take minutes and a lot of memory.' : '');
    },

    /** Step 2: reads the activity files and opens the sync preview for all activities. */
    async runStravaArchiveImport(years) {
      const s = this._archiveSetup;
      if (!s || this._syncBusy) return null;
      this._syncBusy = true;
      try { localStorage.setItem(A().SAMPLE_YEARS_KEY, years === Infinity ? 'all' : String(years)); } catch (e) { /* ignore */ }
      const startBtn = document.getElementById('btnArchiveStart');
      if (startBtn) { startBtn.disabled = true; startBtn.classList.add('is-loading'); }
      const progress = (t) => this.setArchiveProgress(t);
      try {
        const { file, entries, csvEntry, list } = s;
        // Files are named relative to the archive root, which may sit inside a folder of the ZIP.
        const root = csvEntry.name.slice(0, csvEntry.name.length - 'activities.csv'.length);
        const byName = new Map(entries.map(e => [e.name, e]));
        const cutoff = A().sampleCutoff(years);
        const opts = this.syncOptions();
        const wanted = list.filter(e => A().wantsFile(e));
        const stats = { fileName: file.name, rideFiles: 0, powerRides: 0, sampleRides: 0, missingFiles: 0, failed: [] };
        const activities = [];
        let done = 0;
        for (const entry of list) {
          let ride = null;
          if (A().wantsFile(entry)) {
            const ze = byName.get(root + entry.filename) || byName.get(entry.filename);
            if (!ze) stats.missingFiles++;
            else {
              try {
                ride = await this.parseArchiveFile(file, ze, opts);
                stats.rideFiles++;
              } catch (e) {
                console.warn(`[strava archive] ${entry.filename}: ${e.message}`);
                stats.failed.push(entry.filename);
              }
            }
            done++;
            if (done % 5 === 0 || done === wanted.length) {
              progress(`Reading ride files ${done}/${wanted.length}...`);
              this.setSyncBar(`Reading ride files: ${done} of ${wanted.length}`, done / wanted.length);
              await tick();
            }
          }
          const a = A().toActivity(entry, ride, { keepSamples: Date.parse(entry.startIso) >= cutoff });
          if (a.device_watts) stats.powerRides++;
          if (a.samples) stats.sampleRides++;
          activities.push(a);
          ride = null; // the parsed file (all its samples) can go now
        }

        progress('Comparing with your history...');
        this.setSyncBar('Comparing with your history...', null);
        await tick();
        const state = this.loadStravaSyncState();
        const range = A().rangeFor(activities);
        this._archiveSetup = null;
        this._stravaSyncPreview = {
          range, choice: range.choice, archive: stats,
          fetched: { activities, cache: {}, pending: 0, streamsAdded: 0, streamsPending: 0 },
          decisions: { ...state.decisions }, state
        };
        this.replanStravaSync();
        progress('');
        this.setSyncBar('');
        this.renderStravaSyncDialog();
        return this._stravaSyncPreview.plan;
      } catch (e) {
        progress('');
        this.setSyncBar('');
        this._stravaSyncPreview = null;
        this.showToast(`Strava archive: ${e.message || e}`, 'error');
        return null;
      } finally {
        this._syncBusy = false;
        if (startBtn) { startBtn.disabled = false; startBtn.classList.remove('is-loading'); }
      }
    }
  });
})();
