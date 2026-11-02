/**
 * APEX VELO // LAB - History mixin: workout log, single-ride review, exports,
 * imports, HealthFit sync and the training calendar.
 */
(function () {
  const esc = (s) => VeloApp.esc(s);
  const pos = (v) => Number(v) > 0;
  /** Non-cycling activities (imported from Strava): label, icon and colour on the calendar and in history. */
  const ACT = {
    strength: { label: 'Strength', icon: 'i-dumbbell', color: '#f472b6' },
    walk: { label: 'Walk', icon: 'i-footsteps', color: '#34d399' },
    run: { label: 'Run', icon: 'i-footsteps', color: '#fb923c' },
    mobility: { label: 'Mobility', icon: 'i-lotus', color: '#a78bfa' },
    other: { label: 'Activity', icon: 'i-activity', color: '#94a3b8' }
  };
  const actOf = (r) => ACT[r.activityType] || ACT.other;

  Object.assign(VeloApp.prototype, {
    initHistoryDom() {
      const fileInput = document.getElementById('fileInputTcx');
      this.on(fileInput, 'change', (e) => { this.handleIncomingFiles(e.target.files); e.target.value = ''; });
      this.on(document.getElementById('btnChooseImportFiles'), 'click', () => fileInput && fileInput.click());
      const dz = document.getElementById('historyDropzone');
      if (dz) {
        this.on(dz, 'dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
        this.on(dz, 'dragleave', () => dz.classList.remove('dragover'));
        this.on(dz, 'drop', (e) => { e.preventDefault(); dz.classList.remove('dragover'); this.handleIncomingFiles(e.dataTransfer.files); });
      }
      this.on(document.getElementById('btnSyncHealthFitHistory'), 'click', () => this.resyncHealthFitHistory());
      this.on(document.getElementById('btnClearAllWorkoutsTable'), 'click', () => this.clearAllWorkouts());
      this.on(document.getElementById('btnConnectHealthFitFolder'), 'click', () => this.folderSync.connectFolder(false));
      this.on(document.getElementById('btnWipeAndSyncHealthFitFolder'), 'click', () => this.folderSync.connectFolder(true));
      // Menus close after a choice (and when clicking elsewhere).
      document.querySelectorAll('details.menu').forEach(d => this.on(d, 'click', (e) => { if (e.target.closest('.menu-item')) d.open = false; }));
      this.on(document, 'click', (e) => document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }));
      document.querySelectorAll('.history-table th.sortable-th').forEach(th => this.on(th, 'click', () => th.dataset.sort && this.sortHistory(th.dataset.sort)));

      const tbody = document.getElementById('historyTableBody');
      this.on(tbody, 'click', (e) => {
        const act = e.target.closest('[data-act]');
        const tr = e.target.closest('tr[data-id]');
        if (!tr) return;
        if (act) {
          e.stopPropagation();
          const id = tr.dataset.id;
          if (act.dataset.act === 'fit') this.exportFitForRide(id);
          else if (act.dataset.act === 'tcx') this.exportTcxForRide(id);
          else if (act.dataset.act === 'delete') this.deleteCompletedRide(id);
          return;
        }
        this.showRideSummaryById(tr.dataset.id);
      });

      this.on(document.getElementById('btnExportFitActive'), 'click', () => this.exportSession('fit'));
      this.on(document.getElementById('btnExportTcxActive'), 'click', () => this.exportTcx());
      this.on(document.getElementById('btnExportCsvRide'), 'click', () => this.exportCsv());
      this.on(document.getElementById('btnExportJsonHistory'), 'click', () => this.exportJson());

      this.on(document.getElementById('modalRideDetails'), 'click', (e) => {
        const b = e.target.closest('[data-act]');
        if (!b || !this._reviewRideId) return;
        const id = this._reviewRideId;
        if (b.dataset.act === 'fit') this.exportFitForRide(id);
        else if (b.dataset.act === 'tcx') this.exportTcxForRide(id);
        else if (b.dataset.act === 'csv') this.exportCsvForRide(id);
        else if (b.dataset.act === 'delete') this.deleteRideFromSummary(id);
        else if (b.dataset.act === 'close') this.closeModal('rideSummaryModal');
      });
      this.on(document.getElementById('btnRidePrev'), 'click', () => this.stepRideReview(1));
      this.on(document.getElementById('btnRideNext'), 'click', () => this.stepRideReview(-1));
      this.on(document.getElementById('calendarContentArea'), 'click', (e) => {
        const del = e.target.closest('.btn-delete-cal-ride, .btn-delete-cal-ride-mini');
        if (del) { e.stopPropagation(); this.deleteRideFromCalendar(del.dataset.id); return; }
        const month = e.target.closest('[data-month]');
        if (month) { this.jumpToCalendarMonth(parseInt(month.dataset.year, 10), parseInt(month.dataset.month, 10)); return; }
        const loadPlanned = e.target.closest('[data-block-load-cal]');
        if (loadPlanned && this.loadBlockSession) { e.stopPropagation(); this.loadBlockSession(loadPlanned.dataset.blockLoadCal); return; }
        if (e.target.closest('[data-planned]')) { this.switchTab('ai-coach'); document.getElementById('trainingBlockCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        const card = e.target.closest('[data-ride]');
        if (card) this.showRideSummaryById(card.dataset.ride);
      });
    },

    // ------------------------------------------------------------- imports --
    addImportedRides(rides, message) {
      if (!rides.length) return;
      this.completedWorkouts.unshift(...rides);
      this.saveHistory();
      this.renderHistoryTable();
      this.refreshAnalytics();
      this.showToast(message || `Imported ${rides.length} ride${rides.length === 1 ? '' : 's'}. Training load updated.`, 'success');
    },

    handleIncomingFiles(fileList) {
      if (!fileList || !fileList.length) return;
      Array.from(fileList).forEach(file => {
        const name = file.name.toLowerCase();
        const stem = file.name.replace(/\.[^/.]+$/, '');
        // Strava's "Download your account" archive: every activity, through the Strava sync preview.
        if (name.endsWith('.zip')) { this.importStravaArchive(file); return; }
        // A single compressed ride file (.fit.gz / .tcx.gz / .gpx.gz, as in the Strava archive): unzip, then import.
        if (/\.(fit|tcx|gpx)\.gz$/.test(name)) {
          if (typeof DecompressionStream === 'undefined') { this.showToast(`This browser cannot open .gz files - unzip ${file.name} first.`, 'error'); return; }
          new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob()
            .then(blob => this.handleIncomingFiles([new File([blob], file.name.slice(0, -3))]))
            .catch(err => this.showToast(`Could not read ${file.name}: ${err.message}`, 'error'));
          return;
        }
        // An automatic backup (data\backups\*.json.gz): unzip, then restore like a .json backup.
        if (name.endsWith('.json.gz')) {
          if (typeof DecompressionStream === 'undefined') { this.showToast('This browser cannot open .gz backups - unzip it first.', 'error'); return; }
          new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text()
            .then(text => this.importJsonText(text, file.name))
            .catch(err => this.showToast(`Could not read ${file.name}: ${err.message}`, 'error'));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => this.showToast(`Could not read ${file.name}.`, 'error');
        if (name.endsWith('.fit')) {
          reader.onload = (e) => {
            try {
              const ride = VeloRideImporter.parseFit(e.target.result, this.activeProfile.name, this.activeProfile.ftp);
              ride.title = stem.replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}-/, '');
              ride.fileName = file.name;
              this.addImportedRides([ride], `Imported FIT ride "${ride.title}".`);
            } catch (err) {
              console.error('FIT import error', err);
              this.showToast(`Could not parse ${file.name}: ${err.message}`, 'error');
            }
          };
          reader.readAsArrayBuffer(file);
          return;
        }
        reader.onload = (e) => {
          try {
            const content = e.target.result;
            if (name.endsWith('.tcx')) {
              const ride = VeloRideImporter.parseTcx(content, this.activeProfile.ftp, this.activeProfile.name);
              ride.title = stem;
              this.addImportedRides([ride]);
            } else if (name.endsWith('.gpx')) {
              const ride = VeloRideImporter.parseGpx(content, this.activeProfile.ftp, this.activeProfile.name);
              ride.title = ride.title && !/^Imported Ride/.test(ride.title) ? ride.title : stem;
              this.addImportedRides([ride]);
            } else if (name.endsWith('.csv')) {
              const ride = VeloRideImporter.parseCsv(content, this.activeProfile.name, this.activeProfile.ftp);
              ride.title = stem;
              this.addImportedRides([ride]);
            } else if (name.endsWith('.json')) {
              this.importJsonText(content, file.name);
            } else {
              this.showToast(`Unsupported file type: ${file.name}`, 'warning');
            }
          } catch (err) {
            console.error('Import error', err);
            this.showToast(`Could not parse ${file.name}: ${err.message}`, 'error');
          }
        };
        reader.readAsText(file);
      });
    },

    /** Restores a backup (or a list of rides) from JSON text: adds rides not already in the history. */
    importJsonText(content, fileName) {
      try {
        const parsed = JSON.parse(content);
        const list = Array.isArray(parsed) ? parsed : (parsed.history || parsed.rides || [parsed]);
        const known = new Set(this.completedWorkouts.map(r => r.id));
        const fresh = list.filter(r => r && r.date && !known.has(r.id));
        if (parsed.profiles && Array.isArray(parsed.profiles) && parsed.profiles.length && confirm('This backup includes rider profiles. Restore them too?')) {
          this.profiles = parsed.profiles;
          this.activeProfileId = parsed.activeProfileId || this.profiles[0].id;
          this.applyProfileChange();
        }
        if (parsed.health && parsed.health.days && this.restoreHealthStore) this.restoreHealthStore(parsed.health);
        if (!fresh.length) { this.showToast(`${fileName}: every ride in it is already in your history.`, 'info'); return 0; }
        this.addImportedRides(fresh, `Restored ${fresh.length} ride${fresh.length === 1 ? '' : 's'} from ${fileName}.`);
        return fresh.length;
      } catch (err) {
        this.showToast(`Could not parse ${fileName}: ${err.message}`, 'error');
        return -1;
      }
    },

    // -------------------------------------------------------- history table --
    sortHistory(column) {
      if (this.historySortColumn === column) this.historySortDirection = this.historySortDirection === 'asc' ? 'desc' : 'asc';
      else {
        this.historySortColumn = column;
        this.historySortDirection = (column === 'title' || column === 'profile') ? 'asc' : 'desc';
      }
      this.renderHistoryTable();
    },

    getRideDistanceKm(r) {
      return pos(r.distanceKm) ? Number(r.distanceKm) : 0;
    },

    getRideAvgSpeedKmh(r) {
      if (pos(r.avgSpeedKmh)) return Number(r.avgSpeedKmh);
      const d = this.getRideDistanceKm(r);
      return d > 0 && r.duration > 0 ? parseFloat((d / (r.duration / 3600)).toFixed(1)) : 0;
    },

    getSortedWorkouts() {
      const dir = this.historySortDirection === 'asc' ? 1 : -1;
      const key = {
        date: r => new Date(r.date || 0).getTime(),
        duration: r => r.duration || 0,
        distance: r => this.getRideDistanceKm(r),
        speed: r => this.getRideAvgSpeedKmh(r),
        np: r => r.np || r.avgWatts || 0,
        balance: r => (Number.isFinite(Number(r.leftBal)) && r.leftBal !== null ? Number(r.leftBal) : -1),
        tss: r => r.tss || 0,
        if: r => parseFloat(r.if || 0),
        kj: r => r.kj || 0
      }[this.historySortColumn];
      const sorted = [...this.completedWorkouts];
      if (this.historySortColumn === 'title' || this.historySortColumn === 'profile') {
        const f = this.historySortColumn === 'title' ? (r => (r.title || '').toLowerCase()) : (r => (r.profileName || '').toLowerCase());
        return sorted.sort((a, b) => f(a).localeCompare(f(b)) * dir);
      }
      const k = key || (r => new Date(r.date || 0).getTime());
      return sorted.sort((a, b) => (k(a) - k(b)) * dir);
    },

    renderHistoryTable() {
      const medalHist = this.medalHistory ? this.medalHistory() : null;
      const tbody = document.getElementById('historyTableBody');
      if (!tbody) return;
      // Menus close after a choice (and when clicking elsewhere).
      document.querySelectorAll('details.menu').forEach(d => this.on(d, 'click', (e) => { if (e.target.closest('.menu-item')) d.open = false; }));
      this.on(document, 'click', (e) => document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; }));
      document.querySelectorAll('.history-table th.sortable-th').forEach(th => {
        const sorted = th.dataset.sort === this.historySortColumn;
        th.classList.toggle('sorted-th', sorted);
        const icon = th.querySelector('.sort-icon');
        if (icon) icon.textContent = sorted ? (this.historySortDirection === 'asc' ? '▲' : '▼') : '⇅';
      });
      if (!this.completedWorkouts.length) {
        tbody.innerHTML = `<tr><td colspan="12" class="empty-cell">No completed workouts in database.<br>Import FIT/TCX/CSV files above, ride a workout, or try <b>Explore a demo</b>.</td></tr>`;
        this.updateHeroStats();
        return;
      }
      tbody.innerHTML = this.getSortedWorkouts().map(r => {
        const d = new Date(r.date);
        const dateStr = isNaN(d) ? '--' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dist = this.getRideDistanceKm(r);
        const spd = this.getRideAvgSpeedKmh(r);
        const np = r.np || r.avgWatts || 0;
        const bal = Number(r.leftBal) > 0 && Number(r.rightBal) > 0 ? `${r.leftBal} / ${r.rightBal}` : '--';
        const tss = pos(r.tss) ? r.tss : (np > 0 ? '0' : '--');
        const ifv = pos(r.if) ? Number(r.if).toFixed(2) : (np > 0 ? '0.00' : '--');
        const z = pos(r.if) ? VeloProgress.ifBand(parseFloat(r.if)) : null;
        const hasSamples = r.samples && r.samples.length >= 5;
        return `
          <tr data-id="${esc(r.id)}">
            <td class="num nowrap">${dateStr}</td>
            <td class="muted">${esc(r.profileName || 'Imported rider')}</td>
            <td><div class="cell-title">${z ? `<i class="zone-dot" style="--zc:${z.color}" title="${z.label}"></i>` : ''}<b>${esc(r.title)}</b>${hasSamples ? '<span class="chip chip-ghost chip-xs">1 Hz</span>' : ''}${VeloMetrics.isCycling(r) ? '' : `<span class="chip chip-xs act-chip act-${esc(r.activityType)}">${actOf(r).label}</span>`}${r.tssEstimated ? `<span class="chip chip-ghost chip-xs" title="TSS estimated from ${esc(r.tssMethod)}">est.</span>` : ''}${this.medalChips && medalHist ? this.medalChips(this.rideMedals(r, medalHist), r.date, true) : ''}${this.stravaChip ? this.stravaChip(r) : ''}</div></td>
            <td class="num">${this.fmtTime(r.duration)}</td>
            <td class="num">${dist > 0 ? dist + ' km' : '--'}</td>
            <td class="num">${spd > 0 ? spd + ' km/h' : '--'}</td>
            <td class="num strong">${np > 0 ? np + ' W' : '--'}</td>
            <td class="num">${bal}</td>
            <td class="num strong">${tss}</td>
            <td class="num">${ifv}</td>
            <td class="num">${pos(r.kj) ? r.kj + ' kJ' : '--'}</td>
            <td><div class="btn-row btn-row-tight nowrap">
              <button type="button" class="btn btn-xs" data-act="fit" title="Export FIT">FIT</button>
              <button type="button" class="btn btn-xs" data-act="tcx" title="Export TCX">TCX</button>
              <button type="button" class="icon-btn icon-btn-danger btn-delete-workout" data-act="delete" title="Delete from history"><svg class="ic"><use href="#i-trash"/></svg></button>
            </div></td>
          </tr>`;
      }).join('');
      this.updateHeroStats();
    },

    async deleteCompletedRide(rideId) {
      if (!confirm('Remove this workout from history?')) return;
      const idx = this.completedWorkouts.findIndex(x => x.id === rideId);
      if (idx === -1) return;
      const removed = this.completedWorkouts[idx];
      if (!await VeloDB.deleteRide(rideId)) { this.showToast('Could not save this deletion. The workout is still in your history.', 'error'); return; }
      this.completedWorkouts.splice(idx, 1);
      this.persistHistoryLocal();
      this.renderHistoryTable();
      this.renderCalendarView();
      this.refreshAnalytics();
      this.updateHeroStats();
      if (this.reviewTrainingBlock) this.reviewTrainingBlock({ announce: false });
      if (this.scheduleAutoBackup) this.scheduleAutoBackup();
      this.showToast(`Removed "${removed.title || 'Workout'}" from history.`);
    },

    async deleteRideFromCalendar(rideId) { await this.deleteCompletedRide(rideId); },

    async deleteRideFromSummary(rideId) {
      this.closeModal('rideSummaryModal');
      await this.deleteCompletedRide(rideId);
    },

    async clearAllWorkouts(promptConfirm = true) {
      if (promptConfirm && !confirm('Permanently remove all workouts from history and the local database?')) return;
      if (!await VeloDB.clearAllRides()) { this.showToast('Could not clear saved history. Your workouts are unchanged.', 'error'); return; }
      this.completedWorkouts = [];
      try { localStorage.setItem('apex_velo_history', '[]'); } catch (e) { /* ignore */ }
      this.renderHistoryTable();
      this.renderCalendarView();
      this.refreshAnalytics();
      this.showToast('All completed workouts removed.');
      if (this.scheduleAutoBackup) this.scheduleAutoBackup();
    },

    async resyncHealthFitHistory(silent = false) {
      if (!APEX_LOCAL_HISTORY || !Array.isArray(APEX_LOCAL_HISTORY.rides) || !APEX_LOCAL_HISTORY.rides.length) {
        if (!silent) this.showToast('No local archive found. Import FIT, TCX, CSV or a backup in History instead.', 'info');
        return false;
      }
      // Archive refreshes must never delete independently recorded or imported rides.
      const current = window.__APEX_TEST_MODE__ && silent ? [] : this.completedWorkouts;
      const merged = new Map(current.map(r => [r.id, r]));
      for (const r of APEX_LOCAL_HISTORY.rides) if (!merged.has(r.id)) merged.set(r.id, { ...r, profileName: r.profileName || APEX_LOCAL_HISTORY.riderName || this.activeProfile.name });
      this.completedWorkouts = [...merged.values()];
      this.persistHistoryLocal();
      try { localStorage.setItem('apex_velo_healthfit_resynced_v4', 'true'); } catch (e) { /* ignore */ }
      await VeloDB.saveRidesBatch(this.completedWorkouts);
      this.renderHistoryTable();
      this.renderCalendarView();
      this.refreshAnalytics();
      if (!silent) this.showToast(`Local archive merged. ${this.completedWorkouts.length} rides retained.`, 'success');
      return true;
    },

    /** History header: ride count and the date span of the history. */
    updateHeroStats() {
      const rides = this.cyclingRides();
      this.setText('hfTotalRides', rides.length);
      const dates = rides.map(r => new Date(r.date)).filter(d => !isNaN(d)).sort((a, b) => a - b);
      const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      this.setText('hfArchiveSub', dates.length ? `${f(dates[0])} to ${f(dates[dates.length - 1])}` : 'No rides loaded yet');
    },

    // ----------------------------------------------------------- ride review --
    showRideSummaryById(id) {
      const r = this.completedWorkouts.find(x => x.id === id);
      if (r) this.showRideSummary(r);
    },

    stepRideReview(dir) {
      const list = [...this.completedWorkouts].sort((a, b) => new Date(b.date) - new Date(a.date));
      const i = list.findIndex(r => r.id === this._reviewRideId);
      const next = list[i + dir];
      if (next) this.showRideSummary(next);
    },

    /** Splits a sampled ride into the prescribed steps (consecutive samples with the same target). */
    segmentByTarget(samples) {
      const segs = [];
      let cur = null;
      samples.forEach(s => {
        if (!cur || s.target !== cur.target) { cur = { target: s.target, samples: [] }; segs.push(cur); }
        cur.samples.push(s);
      });
      return segs.filter(g => g.samples.length >= 5);
    },

    showRideSummary(record, isNaturalEnd = false) {
      this.destroyScrubChart();
      this._reviewRideId = record.id;
      const samples = record.samples || [];
      const hasSamples = samples.length >= 5;
      const details = document.getElementById('modalRideDetails');
      this.setText('modalRideTitle', record.title || 'Workout');
      const d = new Date(record.date);
      this.setText('modalRideSub', `${isNaN(d) ? '' : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })} - ${record.source || 'Recorded ride'} - ${record.profileName || ''}`);

      const sorted = [...this.completedWorkouts].sort((a, b) => new Date(b.date) - new Date(a.date));
      const idx = sorted.findIndex(r => r.id === record.id);
      const prevBtn = document.getElementById('btnRidePrev'), nextBtn = document.getElementById('btnRideNext');
      if (prevBtn) prevBtn.disabled = idx < 0 || idx >= sorted.length - 1;
      if (nextBtn) nextBtn.disabled = idx <= 0;

      const isAutoSaved = isNaturalEnd || (record.source === 'APEX VELO Cockpit' && record.completedAt && Date.now() - record.completedAt < 25000);
      const catBadge = document.getElementById('modalRideCategoryBadge');
      if (catBadge) {
        catBadge.className = isAutoSaved ? 'eyebrow eyebrow-lime' : 'eyebrow';
        catBadge.textContent = isAutoSaved ? 'WORKOUT COMPLETED & AUTOSAVED' : 'WORKOUT REVIEW';
      }

      // Peaks from samples (or '--' when the ride has no 1 Hz stream)
      const powers = hasSamples ? samples.map(s => s.power || 0) : [];
      const peak = (sec) => (hasSamples ? VeloMetrics.bestRollingAvg(VeloMetrics.toOneHz(samples), sec) : null);
      const p5s = hasSamples ? peak(5) : (pos(record.maxWatts) ? null : null);
      const p1m = peak(60), p5m = peak(300), p20m = peak(1200);
      const prs = this.getAllTimeMmpBests();
      const prFor = (i) => prs[i] || null;
      const fmtPeak = (v, i) => {
        if (!(v > 0)) return '--';
        const pr = prFor(i);
        return `${v}W${pr ? `<small class="num ${v >= pr ? 'pos' : ''}">${Math.round((v / pr) * 100)}% of PR</small>` : ''}`;
      };

      // Comparison vs the rider's previous 90 days
      const t = new Date(record.date).getTime();
      const window90 = this.completedWorkouts.filter(r => r.id !== record.id && t - new Date(r.date).getTime() > 0 && t - new Date(r.date).getTime() <= 90 * 86400000);
      const avgOf = (f) => { const v = window90.map(f).filter(x => x > 0); return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const cmp = (val, base) => (val > 0 && base ? `<span class="delta ${val >= base ? 'up' : 'down'}">${val >= base ? '+' : ''}${Math.round(((val - base) / base) * 100)}% vs 90d avg</span>` : '');
      const npVal = record.np || record.avgWatts || 0;

      const dist = pos(record.distanceKm) ? `${record.distanceKm} km` : '--';
      const avgSpd = this.getRideAvgSpeedKmh(record) > 0 ? `${this.getRideAvgSpeedKmh(record)} km/h` : '--';
      const maxSpd = pos(record.maxSpeedKmh) ? `${record.maxSpeedKmh} km/h` : '--';
      const avgP = pos(record.avgWatts) ? `${record.avgWatts}W` : '--';
      const maxP = pos(record.maxWatts) ? `${record.maxWatts}W` : '--';
      const npStr = pos(record.np) ? `${record.np}W` : '--';
      const tssStr = pos(record.tss) ? record.tss : (pos(record.np) ? '0' : '--');
      const ifStr = pos(record.if) ? Number(record.if).toFixed(2) : (pos(record.np) ? '0.00' : '--');
      const kjStr = pos(record.kj) ? `${record.kj} kJ` : '--';
      const kcal = pos(record.totalCalories) ? record.totalCalories : (pos(record.kj) ? VeloMetrics.kcalFromKj(record.kj) : 0);
      const calStr = kcal > 0 ? `${kcal} kcal` : '--';
      const hrStr = pos(record.avgHr) ? `${record.avgHr}${pos(record.maxHr) ? ' / ' + record.maxHr : ''} bpm` : '--';
      const cadStr = pos(record.avgCadence) ? `${record.avgCadence}${pos(record.maxCadence) ? ' / ' + record.maxCadence : ''} rpm` : '--';
      const balStr = Number(record.leftBal) > 0 && Number(record.rightBal) > 0 ? `${record.leftBal}% / ${record.rightBal}%` : '--';

      const banner = isAutoSaved ? `
        <div class="workout-completed-banner">
          <div class="wcb-main">
            <svg class="ic ic-lg"><use href="#i-trophy"/></svg>
            <div><div class="wcb-title">WORKOUT COMPLETE - SESSION OVERVIEW</div><div class="wcb-sub">Automatically saved to Training History &amp; the Banister PMC model</div></div>
          </div>
          <div class="btn-row btn-row-tight">
            ${record.compliancePct > 0 ? `<span class="chip chip-accent num" title="Execution fidelity vs interval targets">${record.compliancePct}% Execution</span>` : ''}
            <span class="chip chip-lime">AUTOSAVED</span>
          </div>
        </div>` : '';

      // Power analysis (js/app-ride-analysis.js): lanes with W' balance, zones, curves, quadrants.
      const A = hasSamples && this.rideAnalysis ? this.rideAnalysis(record) : null;
      let zonesHtml = '';
      let stepsHtml = '';
      if (hasSamples) {
        const ftp = record.ftpAtRide || this.activeProfile.ftp;
        const zs = VeloInsight.timeInZones(samples, ftp);
        const tot = Math.max(1, samples.length);
        const mins = (sec) => (sec >= 60 ? `${Math.round(sec / 60)} min` : `${sec} s`);
        const lot = VeloInsight.longestOnTarget(samples);
        const hrr = VeloInsight.hrRecovery(samples, ftp, this.activeProfile.maxHr);
        const torque = VeloInsight.avgTorque(samples);
        const cadAvg = VeloMetrics.stats(samples.map(s => s.cadence)).avg;
        const hrrHtml = hrr ? `
            <div class="analysis-item">
              <div class="ai-lbl">Heart-rate recovery &middot; 60 s</div>
              <div class="hrr-row">${hrr.efforts.map(e => `<span class="hrr-chip num" title="Effort ${e.n}: ${e.hrEnd} bpm at the end, ${e.hr60} bpm 60 s later">#${e.n} <b>&minus;${e.drop}</b></span>`).join('')}</div>
              <div class="ai-sub ${hrr.slowing ? 'warn' : ''}">${hrr.slowing ? `Recovery slowed from &minus;${hrr.first} to &minus;${hrr.last} bpm - fatigue building on later repeats.` : 'bpm drop in the 60 s after each hard effort (pedalling easy in ERG, so compare repeats, not rides).'}</div>
            </div>` : '';
        zonesHtml = `
          ${A && this.rideZonesHtml ? this.rideZonesHtml(record, A) : `
          <div class="review-block">
            <div class="sub-title"><span>Time in power zone</span><span class="hint num">FTP ${ftp} W</span></div>
            <div class="zone-bars-stacked tall">${zs.map((v, i) => `<div class="zone-seg z-seg-${i + 1}" style="width:${(v / tot) * 100}%" title="${VeloMetrics.ZONES[i].short} ${VeloMetrics.ZONES[i].name}: ${mins(v)} (${Math.round((v / tot) * 100)}%)"></div>`).join('')}</div>
            <div class="zone-legend-row">${zs.map((v, i) => `<span><i class="zdot z-seg-${i + 1}"></i>${VeloMetrics.ZONES[i].short} <strong class="num">${this.fmtTime(v)}</strong></span>`).join('')}</div>
          </div>`}
          <div class="review-block ride-analysis">
            <div class="analysis-item">
              <div class="ai-lbl">Longest on target (&plusmn;5%)</div>
              <div class="ai-val num">${lot ? this.fmtTime(lot.seconds) : '--'}</div>
              <div class="ai-sub">${lot ? `at ${lot.target} W, from ${this.fmtTime(lot.from)} into the ride` : 'No targets on this ride (free ride or import).'}</div>
            </div>
            <div class="analysis-item">
              <div class="ai-lbl">Cadence &amp; torque</div>
              <div class="ai-val num">${cadAvg ? cadAvg + ' rpm' : '--'} <small>&middot;</small> ${torque !== null ? torque + ' N&middot;m' : '--'}</div>
              <div class="ai-sub">Average pedalling torque while pedalling. Same power at lower cadence = more torque per stroke.</div>
            </div>
            ${hrrHtml}
          </div>`;
        const segs = this.segmentByTarget(samples);
        const diagnosis = this.intervalBreakdownHtml ? this.intervalBreakdownHtml(record) : '';
        if (segs.length >= 2) {
          stepsHtml = `
            <div class="review-block">
              <div class="sub-title"><span>Interval execution</span><span class="hint">${segs.length} steps detected from target changes</span></div>
              <div class="table-scroll"><table class="data-table lap-breakdown-table">
                <thead><tr><th>#</th><th>Duration</th><th>Target</th><th>Avg power</th><th>Execution</th><th>Cadence</th><th>Heart rate</th></tr></thead>
                <tbody>${segs.map((g, i) => {
                  const pw = VeloMetrics.stats(g.samples.map(s => s.power));
                  const cd = VeloMetrics.stats(g.samples.map(s => s.cadence));
                  const hr = VeloMetrics.stats(g.samples.map(s => s.hr));
                  const ex = VeloMetrics.complianceScore(g.samples);
                  return `<tr><td class="num">${i + 1}</td><td class="num">${this.fmtTime(g.samples.length)}</td><td class="num">${g.target ? g.target + ' W' : '--'}</td><td class="num strong">${pw.count ? VeloMetrics.avgPower(g.samples.map(s => s.power)) + ' W' : '--'}</td><td><span class="exec-bar"><span style="width:${ex || 0}%" class="${ex >= 95 ? 'good' : ex >= 85 ? 'ok' : 'bad'}"></span></span><span class="num">${ex !== null ? ex + '%' : '--'}</span></td><td class="num">${cd.avg ? cd.avg + ' rpm' : '--'}</td><td class="num">${hr.avg ? hr.avg + ' bpm' : '--'}</td></tr>`;
                }).join('')}</tbody>
              </table></div>
            </div>`;
          stepsHtml += diagnosis;
        }
      }

      const telemetry = A && this.rideLanesHtml ? this.rideLanesHtml(A) : hasSamples ? `
        <div class="review-block inspector-chart-box">
          <div class="sub-title"><span>Telemetry scrubber</span><span id="scrubReadout" class="hint num">Hover the chart to inspect each second</span></div>
          <div class="chart-box" style="height:230px;"><canvas id="rideScrubCanvas"></canvas></div>
        </div>` : `
        <div class="review-block summary-only">
          <svg class="ic ic-lg"><use href="#i-activity"/></svg>
          <div>
            <div class="so-title">Authentic Session Summary</div>
            <div class="so-text">Second-by-second trackpoint telemetry was not recorded for this activity. The metrics above are the authentic session summary from ${esc(record.source || 'the source file')}; peaks and charts that need 1 Hz data show --.</div>
          </div>
        </div>`;

      if (!VeloMetrics.isCycling(record)) {
        details.innerHTML = this.activitySummaryHtml(record);
        if (this.renderStravaPanel) {
          details.insertAdjacentHTML('afterbegin', '<div id="rideStravaPanel" class="strava-panel" aria-live="polite"></div>');
          this.renderStravaPanel(record);
        }
        this.openModal('rideSummaryModal');
        return;
      }

      details.innerHTML = `
        ${banner}
        ${record.rampTest ? `<p class="wcb-sub">${VeloApp.esc(record.rampTest.message || 'Ramp test complete.')}</p>` : ''}
        ${this.rideInsightHtml ? this.rideInsightHtml(record) : ''}
        <div class="inspector-header-stats">
          <div class="metric-cell"><span class="metric-cell-lbl">Duration${VeloGlossary.html('gap')}</span><span class="metric-cell-val num">${this.fmtTime(record.duration)}</span>${cmp(record.duration, avgOf(r => r.duration))}</div>
          <div class="metric-cell" data-accent="violet"><span class="metric-cell-lbl">Distance${VeloGlossary.html('gap')}</span><span class="metric-cell-val num">${dist}</span></div>
          <div class="metric-cell" data-accent="cyan"><span class="metric-cell-lbl">Avg Speed${VeloGlossary.html('gap')}</span><span class="metric-cell-val num">${avgSpd}</span><span class="metric-cell-sub num">max ${maxSpd}</span></div>
          <div class="metric-cell" data-accent="cyan"><span class="metric-cell-lbl">Avg Power${VeloGlossary.html('gap')}</span><span class="metric-cell-val num">${avgP}</span><span class="metric-cell-sub num">max ${maxP}</span></div>
          <div class="metric-cell" data-accent="violet"><span class="metric-cell-lbl">Norm Power (NP)${VeloGlossary.html('np')}</span><span class="metric-cell-val num">${npStr}</span>${cmp(npVal, avgOf(r => r.np || r.avgWatts))}</div>
          <div class="metric-cell" data-accent="lime"><span class="metric-cell-lbl">TSS${VeloGlossary.html('tss')}</span><span class="metric-cell-val num">${tssStr}</span>${cmp(record.tss, avgOf(r => r.tss))}</div>
          <div class="metric-cell" data-accent="cyan"><span class="metric-cell-lbl">Intensity (IF)${VeloGlossary.html('if')}</span><span class="metric-cell-val num">${ifStr}</span></div>
          <div class="metric-cell"><span class="metric-cell-lbl">Work${VeloGlossary.html('kj')}</span><span class="metric-cell-val num">${kjStr}</span></div>
          <div class="metric-cell" data-accent="amber"><span class="metric-cell-lbl">Calories${VeloGlossary.html('kcal')}</span><span class="metric-cell-val num">${calStr}</span></div>
          <div class="metric-cell" data-accent="rose"><span class="metric-cell-lbl">Heart Rate (Avg/Max)${VeloGlossary.html('gap')}</span><span class="metric-cell-val num">${hrStr}</span></div>
          <div class="metric-cell" data-accent="amber"><span class="metric-cell-lbl">Cadence (Avg/Max)${VeloGlossary.html('cadence')}</span><span class="metric-cell-val num">${cadStr}</span></div>
          <div class="metric-cell"><span class="metric-cell-lbl">L/R Balance${VeloGlossary.html('lr')}</span><span class="metric-cell-val num">${balStr}</span></div>
        </div>
        <div class="peak-grid">
          <div class="metric-cell" data-accent="amber"><span class="metric-cell-lbl">Peak 5s Sprint</span><span class="metric-cell-val num">${fmtPeak(p5s, 0)}</span></div>
          <div class="metric-cell" data-accent="cyan"><span class="metric-cell-lbl">Peak 1m Anaerobic</span><span class="metric-cell-val num">${fmtPeak(p1m, 3)}</span></div>
          <div class="metric-cell" data-accent="lime"><span class="metric-cell-lbl">Peak 5m VO2Max</span><span class="metric-cell-val num">${fmtPeak(p5m, 5)}</span></div>
          <div class="metric-cell" data-accent="violet"><span class="metric-cell-lbl">Peak 20m Threshold</span><span class="metric-cell-val num">${fmtPeak(p20m, 7)}</span></div>
        </div>
        ${A && this.rideAdvancedHtml ? this.rideAdvancedHtml(record, A) : ''}
        ${telemetry}
        ${zonesHtml}
        ${A && this.rideChartsHtml ? this.rideChartsHtml(A) : ''}
        ${stepsHtml}
        <div class="modal-actions">
          <div class="btn-row">
            <button type="button" class="btn btn-primary" data-act="fit"><svg class="ic"><use href="#i-download"/></svg>Export FIT</button>
            <button type="button" class="btn" data-act="tcx"><svg class="ic"><use href="#i-download"/></svg>TCX</button>
            <button type="button" class="btn" data-act="csv"><svg class="ic"><use href="#i-download"/></svg>CSV</button>
            <button type="button" class="btn btn-danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Delete</button>
          </div>
          <button type="button" class="btn btn-ghost" data-act="close">Close</button>
        </div>`;

      if (this.renderStravaPanel) {
        details.insertAdjacentHTML('afterbegin', '<div id="rideStravaPanel" class="strava-panel" aria-live="polite"></div>');
        this.renderStravaPanel(record);
        const st = this.stravaStateOf(record);
        if (st.state === 'processing' && st.uploadId && !this.stravaPolls.has(record.id)) this.pollStravaUpload(record.id);
        else if (st.state === 'none' && this.canSendToStrava(record)) this.autoCheckRideOnStrava(record);
      }
      this.openModal('rideSummaryModal');
      if (hasSamples) {
        clearTimeout(this._scrubTimer);
        this._scrubTimer = setTimeout(() => this.initRideScrubChart(record), 60);
      }
    },

    /** Detail view of a non-cycling activity: duration, heart rate, strength load and the exercise list. */
    activitySummaryHtml(r) {
      const a = actOf(r);
      const cell = (lbl, val, accent) => `<div class="metric-cell"${accent ? ` data-accent="${accent}"` : ''}><span class="metric-cell-lbl">${lbl}</span><span class="metric-cell-val num">${val}</span></div>`;
      const ex = Array.isArray(r.exercises) ? r.exercises : [];
      const lifts = r.activityType === 'strength' && typeof VeloStravaSync !== 'undefined' ? VeloStravaSync.mainLifts(r) : [];
      return `
        <div class="inspector-header-stats">
          ${cell('Activity', `<svg class="ic"><use href="#${a.icon}"/></svg> ${esc(r.sportType || a.label)}`)}
          ${cell('Duration', this.fmtTime(r.duration))}
          ${cell('Heart Rate (Avg/Max)', pos(r.avgHr) ? `${r.avgHr}${pos(r.maxHr) ? ' / ' + r.maxHr : ''} bpm` : '--', 'rose')}
          ${cell('Calories', pos(r.totalCalories) ? `${r.totalCalories} kcal` : '--', 'amber')}
          ${cell('Relative effort', pos(r.sufferScore) ? r.sufferScore : '--', 'violet')}
          ${r.activityType === 'strength' ? cell('Strength load', pos(r.strengthTss) ? `${r.strengthTss}<small class="num"> ${esc(r.strengthTssMethod || '')}</small>` : '--', 'lime') : ''}
          ${pos(r.distanceKm) ? cell('Distance', `${r.distanceKm} km`, 'cyan') : ''}
        </div>
        <div class="review-block">
          <div class="sub-title"><span>${r.activityType === 'strength' ? 'Exercises' : 'Notes'}</span><span class="hint">${r.heavyLegs ? 'Heavy leg day - counts like a hard day for the training block' : 'Not counted in cycling power, MMP or FTP analytics'}</span></div>
          ${lifts.length ? `<div class="btn-row btn-row-tight">${lifts.map(l => `<span class="chip chip-xs act-chip act-strength">${esc(l)}</span>`).join('')}</div>` : ''}
          ${ex.length ? `<ol class="exercise-list">${ex.map(l => `<li>${esc(l)}</li>`).join('')}</ol>` : `<div class="dim">${r.description ? esc(r.description) : 'No exercise list on Strava for this session.'}</div>`}
        </div>
        <div class="modal-actions">
          <div class="btn-row"><button type="button" class="btn btn-danger" data-act="delete"><svg class="ic"><use href="#i-trash"/></svg>Delete</button></div>
          <button type="button" class="btn btn-ghost" data-act="close">Close</button>
        </div>`;
    },

    destroyScrubChart() {
      clearTimeout(this._scrubTimer);
      if (this.currentScrubChart) {
        this.currentScrubChart.destroy();
        this.currentScrubChart = null;
      }
      if (this.destroyReviewCharts) this.destroyReviewCharts();
    },

    initRideScrubChart(record) {
      const canvas = document.getElementById('rideScrubCanvas');
      const samples = record.samples || [];
      if (!canvas || samples.length < 5) return;
      this.destroyScrubChart();
      if (this.initRideReviewCharts && VeloMetrics.isCycling(record)) { this.initRideReviewCharts(record); return; }
      // Down-sample very long rides for rendering (keeps every point for rides < 2 h)
      const step = Math.max(1, Math.ceil(samples.length / 7200));
      const pts = samples.filter((_, i) => i % step === 0);
      this.currentScrubChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: pts.map(s => this.fmtTime(s.time)),
          datasets: [
            { label: 'Power', data: pts.map(s => s.power), borderColor: '#4aa8ff', backgroundColor: 'rgba(74,168,255,0.14)', fill: true, borderWidth: 1.5, tension: 0.1, yAxisID: 'y' },
            { label: 'Target', data: pts.map(s => s.target || null), borderColor: 'rgba(230,237,247,0.45)', borderDash: [4, 4], borderWidth: 1, stepped: true, yAxisID: 'y' },
            { label: 'Heart rate', data: pts.map(s => s.hr || null), borderColor: '#ff5c86', borderWidth: 1.2, tension: 0.1, yAxisID: 'y1' },
            { label: 'Cadence', data: pts.map(s => s.cadence || null), borderColor: '#ffae3d', borderWidth: 1.2, tension: 0.1, yAxisID: 'y2' }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#6f7894', maxTicksLimit: 8, maxRotation: 0 } },
            y: { position: 'left', grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#6f7894' }, title: { display: true, text: 'W', color: '#6f7894' } },
            y1: { display: false, min: 50, max: 200 },
            y2: { display: false, min: 40, max: 130 }
          },
          plugins: {
            legend: { display: true, labels: { color: '#9aa7bd', boxWidth: 10 } },
            tooltip: {
              callbacks: {
                title: (items) => `t = ${items[0].label}`,
                afterBody: (items) => {
                  const s = pts[items[0].dataIndex];
                  const ro = document.getElementById('scrubReadout');
                  if (ro && s) ro.textContent = `${this.fmtTime(s.time)} - ${s.power} W - ${s.cadence || '--'} rpm - ${s.hr || '--'} bpm${s.speed ? ` - ${s.speed} km/h` : ''}`;
                  return '';
                }
              }
            }
          }
        }
      });
    },

    // -------------------------------------------------------------- exports --
    /** A record for the live (not yet saved) session, built only from recorded samples. */
    sessionRecord() {
      const samples = this.recordedSamples;
      const p = VeloMetrics.stats(samples.map(s => s.power));
      return {
        id: 'session_live',
        title: this.currentWorkout.title,
        date: samples.length ? new Date(samples[0].timestamp - samples[0].time * 1000).toISOString() : new Date().toISOString(),
        duration: this.totalElapsedSeconds,
        totalDistanceMeters: Math.round(this.totalDistanceMeters),
        distanceKm: this.totalDistanceKm,
        maxSpeedKmh: this.maxSpeedKmh,
        avgWatts: VeloMetrics.avgPower(samples.map(s => s.power)), maxWatts: p.max,
        np: this.analytics.normalizedPower, tss: this.analytics.tss, if: this.analytics.intensityFactor.toFixed(2),
        kj: Math.round(this.analytics.totalJoules / 1000),
        samples
      };
    },

    exportSession(kind) {
      if (!this.recordedSamples.length) {
        this.showToast('No telemetry recorded in this session yet.', 'warning');
        return;
      }
      this.exportRide(this.sessionRecord(), kind);
    },

    exportRide(ride, kind) {
      const samples = ride.samples || [];
      const stem = VeloExport.fileStem(ride);
      if (!samples.length && kind !== 'csv') this.showToast('Summary-only ride: the file contains the session totals without trackpoints.', 'info');
      if (kind === 'fit') this.downloadFile(`${stem}.fit`, VeloExport.buildFit(ride, samples), 'application/vnd.ant.fit');
      else if (kind === 'tcx') this.downloadFile(`${stem}.tcx`, VeloExport.buildTcx(ride, samples), 'application/vnd.garmin.tcx+xml');
      else this.downloadFile(`${stem}.csv`, VeloExport.buildCsv(ride, samples), 'text/csv');
    },

    exportFitForRide(rideId) { const r = this.completedWorkouts.find(x => x.id === rideId); if (r) this.exportRide(r, 'fit'); },
    exportTcxForRide(rideId) { const r = this.completedWorkouts.find(x => x.id === rideId); if (r) this.exportRide(r, 'tcx'); },
    exportCsvForRide(rideId) {
      const r = rideId ? this.completedWorkouts.find(x => x.id === rideId) : null;
      if (r) this.exportRide(r, 'csv'); else this.exportSession('csv');
    },
    exportTcx() { this.exportSession('tcx'); },
    exportCsv() { this.exportSession('csv'); },

    exportJson() {
      const data = this.backupPayload();
      this.downloadFile(`apex_velo_backup_${VeloMetrics.localDateKey(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
    },

    downloadFile(filename, content, type) {
      const blob = new Blob([content], { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    },

    // ------------------------------------------------------------- calendar --
    initCalendarEvents() {
      const step = (d) => {
        if (this.calendarViewPreset === '1week') this.calendarWeekOffset += d;
        else if (this.calendarViewPreset === '1month') this.calendarMonthOffset += d;
        else if (this.calendarViewPreset === 'ytd') this.calendarYearOffset = (this.calendarYearOffset || 0) + d;
        this.renderCalendarView();
      };
      this.on(document.getElementById('btnCalPrevWeek'), 'click', () => step(-1));
      this.on(document.getElementById('btnCalNextWeek'), 'click', () => step(1));
      this.on(document.getElementById('btnCalToday'), 'click', () => {
        this.calendarWeekOffset = 0; this.calendarMonthOffset = 0; this.calendarYearOffset = 0;
        this.renderCalendarView();
      });
      document.querySelectorAll('#calPresetPills .preset-pill').forEach(pill => this.on(pill, 'click', () => {
        document.querySelectorAll('#calPresetPills .preset-pill').forEach(p => p.classList.toggle('active', p === pill));
        this.calendarViewPreset = pill.dataset.preset || '1week';
        this.renderCalendarView();
      }));
    },

    updateCalendarRollups(label, tss, durationSec, kj, distanceKm, ridesCount, avgNp) {
      this.setText('calRollupTssLbl', label);
      this.setText('calWeeklyTss', `${Math.round(tss).toLocaleString()} TSS`);
      const hrs = Math.floor(durationSec / 3600), mins = Math.floor((durationSec % 3600) / 60);
      this.setText('calWeeklyHours', `${hrs}h ${String(mins).padStart(2, '0')}m`);
      this.setText('calWeeklyKj', `${Math.round(kj).toLocaleString()} kJ`);
      this.setText('calPeriodDistance', distanceKm > 0 ? `${distanceKm.toFixed(1)} km` : '--');
      this.setText('calPeriodRides', `${ridesCount} ${ridesCount === 1 ? 'Ride' : 'Rides'}`);
      this.setText('calPeriodAvgNp', avgNp > 0 ? `${Math.round(avgNp)} W NP` : '--');
    },

    /**
     * Apple Health recovery for one calendar day: a readiness bar and resting HR / HRV / sleep, each
     * coloured against your own normal (plain = in range, amber = worse, red = much worse).
     * Nothing for days without data or in the future.
     */
    recoveryStripHtml(dayKey, compact = false) {
      if (!this.healthForDay || !this.healthDays || !this.healthDays.length) return '';
      const h = this.healthForDay(dayKey);
      if (!h) return '';
      const { rec, flags } = h;
      const rd = VeloHealth.readiness(this.healthDays, dayKey);
      const lvl = rd.day === dayKey && ['green', 'amber', 'red'].includes(rd.level) ? rd.level : 'none';
      const item = (cls, flag, icon, val) => (val === null || val === undefined ? '' : `<span class="rv ${cls} rv-${flag || 'ok'}">${icon}<b class="num">${val}</b></span>`);
      const tip = [
        rec.rhr !== null ? `Resting HR ${rec.rhr} bpm` : '', rec.hrv !== null ? `HRV ${rec.hrv} ms` : '',
        rec.sleepH !== null ? `Sleep ${VeloHealth.fmtH(rec.sleepH)}${rec.deepH !== null ? ` (deep ${VeloHealth.fmtH(rec.deepH)}, REM ${VeloHealth.fmtH(rec.remH)})` : ''}` : '',
        lvl !== 'none' ? `Readiness: ${rd.label}${rd.reasons.length ? ' - ' + rd.reasons.join('; ') : ''}` : ''
      ].filter(Boolean).join('\n');
      return `<div class="recov-strip ${compact ? 'compact' : ''}" data-ready="${lvl}" title="${esc(tip)}">
        ${item('rv-rhr', flags.rhr, '&hearts;', rec.rhr)}${item('rv-hrv', flags.hrv, '&#8767;', rec.hrv)}${item('rv-sleep', flags.sleep, '&#9790;', rec.sleepH !== null ? VeloHealth.fmtH(rec.sleepH) : null)}
      </div>`;
    },

    /** Period averages of resting HR, HRV and sleep, with the change from the previous period. */
    updateRecoveryRollup(from, to, unit) {
      const box = document.getElementById('calRecoveryRollup');
      if (!box) return;
      const days = this.healthDays || [];
      const cur = this.healthPeriod ? this.healthPeriod(from, to) : { rhr: null, hrv: null, sleepH: null };
      const has = days.length && (cur.rhr !== null || cur.hrv !== null || cur.sleepH !== null);
      box.hidden = !has;
      if (!has) return;
      // The previous week / calendar month / year, for the change arrows.
      let prev = null;
      if (unit) {
        const a = new Date(from + 'T12:00:00');
        const k = VeloMetrics.localDateKey;
        const range = unit === 'week' ? [VeloHealth.addDays(from, -7), VeloHealth.addDays(from, -1)]
          : unit === 'month' ? [k(new Date(a.getFullYear(), a.getMonth() - 1, 1)), k(new Date(a.getFullYear(), a.getMonth(), 0))]
            : [`${a.getFullYear() - 1}-01-01`, `${a.getFullYear() - 1}-12-31`];
        prev = this.healthPeriod(range[0], range[1]);
      }
      const delta = (now, before, unitTxt, goodUp, fmt = (x) => x) => {
        if (now === null || !prev || before === null) return '';
        const d = Math.round((now - before) * 10) / 10;
        if (Math.abs(d) < (unitTxt === 'h' ? 0.1 : 1)) return ' <small class="rd flat">=</small>';
        const good = goodUp ? d > 0 : d < 0;
        return ` <small class="rd ${good ? 'good' : 'bad'}">${d > 0 ? '&#9650;' : '&#9660;'}${fmt(Math.abs(d))}${unitTxt === 'h' ? '' : ' ' + unitTxt}</small>`;
      };
      const el = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
      el('calAvgRhr', cur.rhr !== null ? `${cur.rhr} bpm${delta(cur.rhr, prev && prev.rhr, 'bpm', false)}` : '--');
      el('calAvgHrv', cur.hrv !== null ? `${cur.hrv} ms${delta(cur.hrv, prev && prev.hrv, 'ms', true)}` : '--');
      el('calAvgSleep', cur.sleepH !== null ? `${VeloHealth.fmtH(cur.sleepH)}${delta(cur.sleepH, prev && prev.sleepH, 'h', true, (x) => VeloHealth.fmtH(x))}` : '--');
      this.setText('calRecoveryHint', unit ? `period averages from Apple Health, change vs the previous ${unit}` : 'all-time averages from Apple Health');
    },

    getWeekRange(offset = 0) {
      const mon = VeloProgress.weekStart(new Date());
      mon.setDate(mon.getDate() + offset * 7);
      return Array.from({ length: 7 }, (_, i) => new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
    },

    /** Period totals of the cycling records (strength and other activities are shown, not summed). */
    rollup(all) {
      const rides = (all || []).filter(r => VeloMetrics.isCycling(r));
      let tss = 0, sec = 0, kj = 0, dist = 0, npSum = 0, npN = 0;
      rides.forEach(r => {
        tss += r.tss || 0; sec += r.duration || 0; kj += r.kj || 0; dist += this.getRideDistanceKm(r);
        const np = r.np || r.avgWatts || 0;
        if (np > 0) { npSum += np; npN++; }
      });
      return { tss, sec, kj, dist, rides: rides.length, avgNp: npN ? npSum / npN : 0 };
    },

    /** Calendar card of a non-cycling activity (strength, walk, yoga...). */
    activityCardHtml(r, mini = false) {
      const a = actOf(r);
      const load = pos(r.strengthTss) ? `load ${r.strengthTss}` : a.label;
      if (mini) {
        return `<div class="calendar-ride-card mini act-card act-${esc(r.activityType)}" data-ride="${esc(r.id)}" title="${esc(r.title)} (${a.label})" style="--zc:${a.color}">
          <div class="crc-row"><span class="crc-title"><svg class="ic ic-xs"><use href="#${a.icon}"/></svg>${esc(r.title)}</span><button type="button" class="btn-delete-cal-ride-mini" data-id="${esc(r.id)}" title="Delete">&times;</button></div>
          <div class="crc-meta num">${this.fmtTime(r.duration)} - ${esc(load)}</div></div>`;
      }
      const lifts = r.activityType === 'strength' && typeof VeloStravaSync !== 'undefined' ? VeloStravaSync.mainLifts(r).slice(0, 3).join(', ') : '';
      return `<div class="calendar-ride-card act-card act-${esc(r.activityType)}" data-ride="${esc(r.id)}" style="--zc:${a.color}">
        <div class="crc-row"><span class="crc-title" title="${esc(r.title)}"><svg class="ic ic-xs"><use href="#${a.icon}"/></svg>${esc(r.title)}</span>
          <button type="button" class="btn-delete-cal-ride" data-id="${esc(r.id)}" title="Delete"><svg class="ic ic-xs"><use href="#i-trash"/></svg></button></div>
        <div class="crc-meta num"><span>${a.label} - ${this.fmtTime(r.duration)}</span><b>${esc(load)}</b></div>
        ${lifts || r.heavyLegs ? `<div class="crc-meta dim"><span>${esc(lifts)}</span>${r.heavyLegs ? '<span class="chip chip-xs act-heavy">heavy legs</span>' : ''}</div>` : ''}
      </div>`;
    },

    rideCardHtml(r, mini = false) {
      if (!VeloMetrics.isCycling(r)) return this.activityCardHtml(r, mini);
      const np = r.np || r.avgWatts || 0;
      const band = pos(r.if) ? VeloProgress.ifBand(parseFloat(r.if)) : null;
      if (mini) {
        return `<div class="calendar-ride-card mini" data-ride="${esc(r.id)}" title="${esc(r.title)}" style="--zc:${band ? band.color : 'var(--line-strong)'}">
          <div class="crc-row"><span class="crc-title">${esc(r.title)}</span><button type="button" class="btn-delete-cal-ride-mini" data-id="${esc(r.id)}" title="Delete workout">&times;</button></div>
          <div class="crc-meta num">${r.tss || 0} TSS${np ? ` - ${np}W` : ''}</div></div>`;
      }
      return `<div class="calendar-ride-card" data-ride="${esc(r.id)}" style="--zc:${band ? band.color : 'var(--line-strong)'}">
        <div class="crc-row"><span class="crc-title" title="${esc(r.title)}">${esc(r.title)}</span>
          <button type="button" class="btn-delete-cal-ride" data-id="${esc(r.id)}" title="Delete workout"><svg class="ic ic-xs"><use href="#i-trash"/></svg></button></div>
        <div class="crc-meta num"><span>${np ? np + 'W' : '--'} - ${this.fmtTime(r.duration)}</span><b>${pos(r.tss) ? r.tss + ' TSS' : '--'}</b></div>
        <div class="crc-meta dim num"><span>${this.getRideDistanceKm(r) ? this.getRideDistanceKm(r) + ' km' : '--'}</span><span>${pos(r.kj) ? r.kj + ' kJ' : '--'}</span></div>
      </div>`;
    },

    renderCalendarView() {
      const container = document.getElementById('calendarContentArea');
      if (!container) return;
      const titleEl = document.getElementById('calWeekRangeTitle');
      const btnPrev = document.getElementById('btnCalPrevWeek');
      const btnNext = document.getElementById('btnCalNextWeek');
      const btnToday = document.getElementById('btnCalToday');
      [btnPrev, btnNext, btnToday].forEach(b => { if (b) b.style.display = 'inline-flex'; });
      const byDay = new Map();
      this.completedWorkouts.forEach(r => {
        const k = VeloMetrics.localDateKey(r.date);
        if (!k) return;
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(r);
      });
      const todayKey = VeloMetrics.localDateKey(new Date());
      const planned = this.plannedByDay ? this.plannedByDay() : new Map();

      if (this.calendarViewPreset === '1week') {
        if (btnPrev) btnPrev.textContent = '← Prev week';
        if (btnNext) btnNext.textContent = 'Next week →';
        if (btnToday) btnToday.textContent = 'This week';
        const days = this.getWeekRange(this.calendarWeekOffset);
        if (titleEl) titleEl.textContent = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        const all = [];
        let plannedTss = 0;
        const cols = days.map(day => {
          const k = VeloMetrics.localDateKey(day);
          const rides = byDay.get(k) || [];
          const plans = planned.get(k) || [];
          all.push(...rides);
          plannedTss += plans.filter(p => p.status !== 'missed').reduce((a, p) => a + (p.tss || 0), 0);
          const r = this.rollup(rides);
          return `<div class="calendar-day-col ${k === todayKey ? 'today' : ''}">
            <div class="calendar-day-header"><span class="calendar-day-name">${day.toLocaleDateString('en-US', { weekday: 'short' })}</span><span class="calendar-day-date num">${day.getDate()}</span></div>
            ${this.recoveryStripHtml(k)}
            ${r.tss ? `<div class="day-load" style="--load:${Math.min(1, r.tss / 150)}"><span class="num">${Math.round(r.tss)} TSS</span></div>` : ''}
            ${rides.map(x => this.rideCardHtml(x)).join('')}${plans.map(p => this.plannedCardHtml(p)).join('')}
            ${rides.length || plans.length ? '' : '<div class="rest-day">Rest</div>'}
          </div>`;
        }).join('');
        container.innerHTML = `<div class="calendar-grid" id="calendarGrid">${cols}</div>`;
        const r = this.rollup(all);
        this.updateCalendarRollups('WEEKLY TSS', r.tss, r.sec, r.kj, r.dist, r.rides, r.avgNp);
        this.updateRecoveryRollup(VeloMetrics.localDateKey(days[0]), VeloMetrics.localDateKey(days[6]), 'week');
        if (plannedTss > 0) {
          this.setText('calRollupTssLbl', 'WEEK TSS / STILL PLANNED');
          this.setText('calWeeklyTss', `${Math.round(r.tss)} / ${Math.round(plannedTss)} TSS`);
        }
      } else if (this.calendarViewPreset === '1month') {
        if (btnPrev) btnPrev.textContent = '← Prev month';
        if (btnNext) btnNext.textContent = 'Next month →';
        if (btnToday) btnToday.textContent = 'This month';
        const ref = new Date();
        ref.setDate(1);
        ref.setMonth(ref.getMonth() + (this.calendarMonthOffset || 0));
        const y = ref.getFullYear(), m = ref.getMonth();
        const monthName = ref.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (titleEl) titleEl.textContent = monthName;
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const firstIdx = (new Date(y, m, 1).getDay() + 6) % 7;
        const monthRides = [];
        let cells = '';
        for (let i = 0; i < firstIdx; i++) cells += '<div class="cal-cell empty"></div>';
        for (let d = 1; d <= daysInMonth; d++) {
          const k = VeloMetrics.localDateKey(new Date(y, m, d));
          const rides = byDay.get(k) || [];
          const plans = planned.get(k) || [];
          monthRides.push(...rides);
          const tss = rides.filter(r => VeloMetrics.isCycling(r)).reduce((a, r) => a + (r.tss || 0), 0);
          cells += `<div class="cal-cell ${k === todayKey ? 'today' : ''}" style="--load:${Math.min(1, tss / 150)}">
            <div class="cal-cell-head"><span class="num">${d}</span>${tss > 0 ? `<span class="cal-cell-tss num">${Math.round(tss)}</span>` : ''}</div>
            ${this.recoveryStripHtml(k, true)}
            ${rides.map(r => this.rideCardHtml(r, true)).join('')}${plans.map(p => this.plannedCardHtml(p, true)).join('')}
          </div>`;
        }
        const list = monthRides.sort((a, b) => new Date(a.date) - new Date(b.date)).map(r => `
          <div class="calendar-ride-card list ${VeloMetrics.isCycling(r) ? '' : `act-card act-${esc(r.activityType)}`}" data-ride="${esc(r.id)}" ${VeloMetrics.isCycling(r) ? '' : `style="--zc:${actOf(r).color}"`}>
            <span class="num dim">${new Date(r.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <b class="crc-title">${VeloMetrics.isCycling(r) ? '' : `<svg class="ic ic-xs"><use href="#${actOf(r).icon}"/></svg>`}${esc(r.title)}</b>
            <span class="num dim">${this.fmtTime(r.duration)}</span>
            <span class="num">${(r.np || r.avgWatts) ? (r.np || r.avgWatts) + 'W' : '--'}</span>
            <b class="num">${pos(r.tss) ? r.tss + ' TSS' : '--'}</b>
            <button type="button" class="btn-delete-cal-ride" data-id="${esc(r.id)}" title="Delete workout"><svg class="ic ic-xs"><use href="#i-trash"/></svg></button>
          </div>`).join('');
        container.innerHTML = `
          <div class="card cal-month-card">
            <div class="cal-weekdays">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span>${d}</span>`).join('')}</div>
            <div class="cal-month-matrix">${cells}</div>
          </div>
          <div class="card"><div class="card-title"><span>Activities in ${monthName}</span><span class="chip chip-ghost num">${monthRides.length}</span></div>
            <div class="cal-list">${list || `<div class="empty-state">No rides in ${monthName}.</div>`}</div></div>`;
        const r = this.rollup(monthRides);
        this.updateCalendarRollups('MONTHLY TSS', r.tss, r.sec, r.kj, r.dist, r.rides, r.avgNp);
        this.updateRecoveryRollup(VeloMetrics.localDateKey(new Date(y, m, 1)), VeloMetrics.localDateKey(new Date(y, m, daysInMonth)), 'month');
      } else if (this.calendarViewPreset === 'ytd') {
        if (btnPrev) btnPrev.textContent = '← Prev year';
        if (btnNext) btnNext.textContent = 'Next year →';
        if (btnToday) btnToday.textContent = 'This year';
        const year = new Date().getFullYear() + (this.calendarYearOffset || 0);
        if (titleEl) titleEl.textContent = `${year}`;
        const yearRides = this.completedWorkouts.filter(r => new Date(r.date).getFullYear() === year);
        const months = Array.from({ length: 12 }, (_, i) => this.rollup(yearRides.filter(r => new Date(r.date).getMonth() === i)));
        const best = Math.max(1, ...months.map(m => m.tss));
        const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        container.innerHTML = `<div class="cal-ytd-grid">${months.map((m, i) => `
          <button type="button" class="cal-ytd-card" data-year="${year}" data-month="${i}" title="Open ${names[i]}">
            <div class="ytd-month-title"><span>${names[i]}</span><span class="chip chip-ghost num">${m.rides} ${m.rides === 1 ? 'ride' : 'rides'}</span></div>
            <div class="ytd-stats">
              <div><small>TSS</small><b class="num">${Math.round(m.tss)}</b></div>
              <div><small>Hours</small><b class="num">${(m.sec / 3600).toFixed(1)}</b></div>
              <div><small>Distance</small><b class="num">${m.dist.toFixed(0)} km</b></div>
              <div><small>Avg NP</small><b class="num">${m.avgNp ? Math.round(m.avgNp) + 'W' : '--'}</b></div>
            </div>
            <div class="ytd-progress-wrap"><div class="ytd-progress-bar"><div class="ytd-progress-fill" style="width:${(m.tss / best) * 100}%"></div></div><small class="num">${Math.round((m.tss / best) * 100)}% of best month</small></div>
          </button>`).join('')}</div>`;
        const r = this.rollup(yearRides);
        this.updateCalendarRollups('YEAR TSS', r.tss, r.sec, r.kj, r.dist, r.rides, r.avgNp);
        this.updateRecoveryRollup(`${year}-01-01`, `${year}-12-31`, 'year');
      } else {
        if (btnPrev) btnPrev.style.display = 'none';
        if (btnNext) btnNext.style.display = 'none';
        if (btnToday) btnToday.style.display = 'none';
        const r = this.rollup(this.completedWorkouts);
        if (titleEl) titleEl.textContent = `All-time (${r.rides} rides)`;
        const peak = this.cyclingRides().reduce((m, x) => Math.max(m, x.maxWatts || 0), 0);
        const years = {};
        this.completedWorkouts.forEach(x => { const yy = new Date(x.date).getFullYear(); (years[yy] = years[yy] || []).push(x); });
        const hrs = Math.floor(r.sec / 3600);
        container.innerHTML = `
          <div class="alltime-hero-grid">
            <div class="alltime-tile"><div class="tile-lbl">Career rides</div><div class="tile-val num">${r.rides}</div><div class="tile-sub">logged sessions</div></div>
            <div class="alltime-tile"><div class="tile-lbl">Distance</div><div class="tile-val num">${r.dist > 0 ? Math.round(r.dist).toLocaleString() + '<small> km</small>' : '--'}</div><div class="tile-sub">${r.dist > 0 ? 'recorded distance' : 'indoor rides without distance'}</div></div>
            <div class="alltime-tile"><div class="tile-lbl">Saddle time</div><div class="tile-val num">${hrs.toLocaleString()}<small> h</small></div><div class="tile-sub">${Math.floor((r.sec % 3600) / 60)} min extra</div></div>
            <div class="alltime-tile"><div class="tile-lbl">Mechanical work</div><div class="tile-val num">${(r.kj / 1000).toFixed(1)}<small> MJ</small></div><div class="tile-sub">~${Math.round(r.kj).toLocaleString()} kcal burned</div></div>
            <div class="alltime-tile"><div class="tile-lbl">Career TSS</div><div class="tile-val num">${Math.round(r.tss).toLocaleString()}</div><div class="tile-sub">training stress</div></div>
            <div class="alltime-tile"><div class="tile-lbl">Avg NP</div><div class="tile-val num">${r.avgNp ? Math.round(r.avgNp) : '--'}<small> W</small></div><div class="tile-sub">peak ${peak || '--'} W</div></div>
          </div>
          <div class="card"><div class="card-title"><span>Year by year</span></div>
            <div class="year-grid">${Object.keys(years).sort((a, b) => b - a).map(yy => {
              const q = this.rollup(years[yy]);
              return `<div class="cal-ytd-card static"><div class="ytd-month-title"><span class="num">${yy}</span><span class="chip chip-ghost num">${q.rides} rides</span></div>
                <div class="ytd-stats"><div><small>TSS</small><b class="num">${Math.round(q.tss).toLocaleString()}</b></div><div><small>Hours</small><b class="num">${(q.sec / 3600).toFixed(1)}</b></div>
                <div><small>Distance</small><b class="num">${q.dist.toFixed(0)} km</b></div><div><small>Avg NP</small><b class="num">${q.avgNp ? Math.round(q.avgNp) + 'W' : '--'}</b></div></div></div>`;
            }).join('')}</div></div>`;
        this.updateCalendarRollups('CAREER TSS', r.tss, r.sec, r.kj, r.dist, r.rides, r.avgNp);
        this.updateRecoveryRollup('1970-01-01', '2999-12-31', null);
      }
    },

    jumpToCalendarMonth(year, monthIdx) {
      const now = new Date();
      this.calendarMonthOffset = (year - now.getFullYear()) * 12 + (monthIdx - now.getMonth());
      this.calendarViewPreset = '1month';
      document.querySelectorAll('#calPresetPills .preset-pill').forEach(p => p.classList.toggle('active', p.dataset.preset === '1month'));
      this.renderCalendarView();
    }
  });
})();
