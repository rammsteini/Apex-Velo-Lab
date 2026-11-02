/**
 * APEX VELO // LAB - Post-ride insight UI (mixin on VeloApp).
 *
 * Ride review: PR medals (gold all-time / silver this year / bronze 90 days), aerobic decoupling,
 * and - only when a ride proves it - a suggestion to raise FTP with a one-click update.
 * History: medal chips on each ride. The maths lives in VeloInsight (js/velo-insight.js).
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DISMISS_KEY = 'apex_ftp_suggest_dismissed';
  const FRESH_DAYS = 21; // an FTP suggestion is only offered from recent rides
  const ARCHIVE_INDEX = [0, 3, 5, 7, 8]; // MEDAL_DURATIONS -> VeloMetrics.MMP_DURATIONS

  Object.assign(VeloApp.prototype, {
    /** Best powers for the medal durations, from the ride's cached power curve (js/app-power.js). */
    ridePeaks(r) {
      return this.rideMedalPeaks(r);
    },

    medalHistory() {
      return this.cyclingRides().filter(VeloInsight.hasSamples).map(r => ({ id: r.id, date: r.date, peaks: this.ridePeaks(r) }));
    },

    medalArchive() {
      const a = (typeof APEX_LOCAL_HISTORY !== 'undefined' && APEX_LOCAL_HISTORY && APEX_LOCAL_HISTORY.allTimeMmp && Array.isArray(APEX_LOCAL_HISTORY.allTimeMmp.watts))
        ? APEX_LOCAL_HISTORY.allTimeMmp.watts : null;
      return a ? ARCHIVE_INDEX.map(i => Number(a[i]) || 0) : null;
    },

    rideMedals(r, history = null) {
      const peaks = this.ridePeaks(r);
      if (!peaks || !VeloMetrics.isCycling(r)) return [];
      return VeloInsight.medals({ id: r.id, date: r.date, peaks }, history || this.medalHistory(), this.medalArchive());
    },

    medalChips(medals, date, compact = false) {
      if (!medals.length) return '';
      const year = new Date(date).getFullYear();
      return medals.map(m => `<span class="chip chip-xs medal medal-${m.medal}" title="${esc(VeloInsight.medalTitle(m, year))}">${compact ? '' : '<i class="medal-dot"></i>'}${esc(m.label)}${compact ? '' : ` ${m.watts} W`}</span>`).join('');
    },

    // -------------------------------------------------------------- FTP --
    ftpEvidenceOf(r) {
      if (!VeloInsight.hasSamples(r) || !VeloMetrics.isCycling(r)) return null;
      const p = this.activeProfile || {};
      this._ftpEvCache = this._ftpEvCache || new Map();
      const key = `${r.id}|${r.samples.length}|${p.maxHr || 0}|${p.lthr || 0}`;
      if (!this._ftpEvCache.has(key)) this._ftpEvCache.set(key, (r.rampTest
        ? VeloInsight.rampEvidence(r.samples, { maxHr: p.maxHr })
        : VeloInsight.ftpEvidence(r.samples, { maxHr: p.maxHr, lthr: p.lthr })));
      return this._ftpEvCache.get(key);
    },

    /** Latest FTP implied by each method (20 min, 60 min, ramp test, CP model) and the most recent of them. */
    renderFtpMethods() {
      const body = document.getElementById('ftpMethodsBody');
      if (!body) return;
      const found = {};
      [...this.cyclingRides()].filter(r => r.date).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).forEach(r => {
        const ev = this.ftpEvidenceOf(r);
        if (!ev) return;
        [['ramp', ev.ramp], ['m20', ev.from20], ['m60', ev.from60]].forEach(([k, v]) => { if (v > 0 && !found[k]) found[k] = { watts: v, t: Date.parse(r.date) }; });
      });
      const cp = this._cpModelForFtp;
      const rows = [
        { k: 'ramp', label: 'Ramp test (best minute x 0.75)' },
        { k: 'm20', label: '20 min best x 0.95' },
        { k: 'm60', label: '60 min best' }
      ].map(x => ({ ...x, ...(found[x.k] || {}) }));
      if (cp) rows.push({ k: 'cp', label: 'CP model (FTP is about 95-100% of CP)', watts: Math.round(cp.cp * 0.975), t: cp.to });
      const dated = rows.filter(x => x.watts > 0 && Number.isFinite(x.t)).sort((a, b) => b.t - a.t);
      // The CP model's date is the end of its 90-day window, so it only leads when no ride implied an FTP.
      const latest = dated.find(x => x.k !== 'cp') || dated[0];
      const ftp = Number(this.activeProfile.ftp) || 0;
      const day = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
      this.setText('ftpImpliedChip', latest ? `${latest.watts} W` : '--');
      body.innerHTML = (latest ? `<div class="cp-row"><span><b>Most recent implied FTP</b> <small>${esc(latest.label)} &middot; ${day(latest.t)}</small></span><b class="num">${latest.watts} W${ftp ? ` <small>(${latest.watts >= ftp ? '+' : ''}${latest.watts - ftp} vs ${ftp})</small>` : ''}</b></div>` : '')
        + rows.map(x => `<div class="cp-row"><span>${esc(x.label)}${x.t ? ` <small>${day(x.t)}</small>` : ''}</span><b class="num">${x.watts > 0 ? x.watts + ' W' : '--'}</b></div>`).join('');
    },

    dismissedFtp() {
      try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {})[this.activeProfileId || 'default'] || 0; } catch (e) { return 0; }
    },

    /** A higher-FTP suggestion from this ride (and, if needed, a confirming ride), or null. */
    ftpSuggestionFor(record) {
      if (!record || !VeloInsight.hasSamples(record) || Date.now() - Date.parse(record.date) > FRESH_DAYS * VeloInsight.DAY) return null;
      const t = Date.parse(record.date);
      const rides = this.cyclingRides().filter(r => VeloInsight.hasSamples(r) && Date.parse(r.date) <= t && t - Date.parse(r.date) <= FRESH_DAYS * VeloInsight.DAY)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      const list = rides.filter(r => r.id !== record.id).concat([record]).map(r => ({ id: r.id, date: r.date, evidence: this.ftpEvidenceOf(r) }));
      return VeloInsight.ftpSuggestion(list, this.activeProfile.ftp, { dismissed: this.dismissedFtp() });
    },

    /** Remembers FTP changes on the profile (shown on the FTP history chart; kept in backups). */
    logFtpChange(from, to, source) {
      const p = this.activeProfile;
      if (!p || !(Number(to) > 0) || Number(from) === Number(to)) return;
      p.ftpHistory = [...(Array.isArray(p.ftpHistory) ? p.ftpHistory : []), { date: new Date().toISOString(), ftp: Number(to), from: Number(from) || null, source }].slice(-100);
    },

    acceptFtpSuggestion(value) {
      const v = Math.round(Number(value));
      if (!(v >= 50)) return;
      const from = this.activeProfile.ftp;
      this.activeProfile.ftp = v;
      this.logFtpChange(from, v, 'ride suggestion');
      this.applyProfileChange();
      this.showToast(`FTP updated ${from} -> ${v} W. Zones and ERG targets now use ${v} W.`, 'success');
      document.getElementById('ftpSuggestBanner')?.remove();
    },

    dismissFtpSuggestion(value) {
      try {
        const all = JSON.parse(localStorage.getItem(DISMISS_KEY) || '{}') || {};
        all[this.activeProfileId || 'default'] = Math.max(Number(all[this.activeProfileId || 'default']) || 0, Math.round(Number(value)) || 0);
        localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
      } catch (e) { /* ignore */ }
      document.getElementById('ftpSuggestBanner')?.remove();
      this.showToast('OK - FTP stays as it is. You will only be asked again for a higher value.', 'info');
    },

    // ----------------------------------------------------------- review --
    /** Insight block for the ride review (medals, decoupling, FTP suggestion). */
    rideInsightHtml(record) {
      if (!VeloMetrics.isCycling(record) || !VeloInsight.hasSamples(record)) return '';
      const medals = this.rideMedals(record);
      const dec = VeloInsight.decoupling(record.samples);
      const sug = this.ftpSuggestionFor(record);
      const decHtml = dec.status === 'ok'
        ? `<span class="chip decoupling decoupling-${dec.level} decoupling-${dec.tier}" title="Power per heartbeat, first vs second half of ${dec.minutes} min after the warm-up. 3.5% or less = base consolidated, under 5% = coupled, 5-8% = mild drift, over 8% = decoupled.">Heart-rate drift (Pw:HR) ${dec.pct}% &middot; ${esc(dec.label)}</span>`
        : dec.status === 'not-steady' ? '<span class="chip chip-ghost" title="Decoupling is measured on steady rides (Z2, tempo, sweet spot)">Heart-rate drift (Pw:HR): not a steady ride - not measured</span>'
          : '';
      const ftpHtml = sug ? `
        <div class="ftp-suggest" id="ftpSuggestBanner" role="status">
          <div class="fs-main">
            <svg class="ic ic-lg"><use href="#i-trophy"/></svg>
            <div>
              <div class="fs-title">Your FTP looks higher: <b class="num">${sug.ftp} W</b> <span class="delta up num">+${sug.gain} W</span></div>
              <div class="fs-sub">${esc(sug.method)}${sug.p20 ? ` (best 20 min ${sug.p20} W)` : ''}${sug.hrPct ? `, heart rate ${sug.hrPct}% of max` : ''} - ${esc(sug.basis)}.</div>
            </div>
          </div>
          <div class="btn-row btn-row-tight">
            <button type="button" class="btn btn-start" data-ftp="accept" data-value="${sug.ftp}">Update FTP to ${sug.ftp} W</button>
            <button type="button" class="btn btn-ghost" data-ftp="dismiss" data-value="${sug.ftp}">Not now</button>
          </div>
        </div>` : '';
      if (!medals.length && !decHtml && !ftpHtml) return '';
      return `${ftpHtml}
        <div class="review-block ride-insight">
          <div class="sub-title"><span>Highlights</span><span class="hint">gold = all-time best &middot; silver = best this year &middot; bronze = best in 90 days</span></div>
          <div class="btn-row btn-row-tight insight-chips">${medals.length ? this.medalChips(medals, record.date) : '<span class="hint">No new power bests on this ride.</span>'}${decHtml}</div>
        </div>`;
    },

    // ------------------------------------------------------ drift trend --
    /**
     * Decoupling of every steady ride with heart rate, oldest first. Cached per ride. A ride whose date
     * cannot be read is left out (it would otherwise scramble the order); limit keeps the latest ones.
     */
    driftTrendData(limit = 400) {
      this._decCache = this._decCache || new Map();
      const pts = [];
      this.cyclingRides().filter(VeloInsight.hasSamples).map(r => ({ r, t: Date.parse(r.date) })).filter(e => Number.isFinite(e.t))
        .sort((a, b) => a.t - b.t).forEach(({ r, t }) => {
        const key = `${r.id}|${r.samples.length}`;
        if (!this._decCache.has(key)) this._decCache.set(key, VeloInsight.decoupling(r.samples));
        const d = this._decCache.get(key);
        if (d.status === 'ok') pts.push({ id: r.id, t, date: r.date, title: r.title, pct: d.pct, level: d.level, minutes: d.minutes, np: r.np || r.avgWatts || null });
        });
      return pts.slice(-limit);
    },

    initDriftChart() {
      const cv = document.getElementById('driftTrendCanvas');
      if (!cv || typeof Chart === 'undefined') return;
      const color = { good: '#3ddc97', mild: '#ffae3d', high: '#ff5c86' };
      const ink = getComputedStyle(document.documentElement).getPropertyValue('--text-2').trim() || '#94a3b8';
      const grid = 'rgba(148,163,184,0.12)';
      this.driftChart = new Chart(cv.getContext('2d'), {
        type: 'line',
        data: { datasets: [
          { label: 'Pw:HR drift %', data: [], borderColor: 'rgba(148,163,184,0.5)', borderWidth: 1.5, tension: 0.25, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: [], pointBorderColor: [] },
          { label: '5% (coupled below)', data: [], borderColor: 'rgba(101,163,13,0.7)', borderDash: [6, 5], borderWidth: 1, pointRadius: 0 }
        ] },
        options: {
          responsive: true, maintainAspectRatio: false,
          onClick: (e, els) => { const el = els && els[0]; if (el && el.datasetIndex === 0 && this._driftPts && this._driftPts[el.index]) this.showRideSummaryById(this._driftPts[el.index].id); },
          scales: {
            // A time axis: rides sit at their dates, so gaps between them are real gaps.
            x: { type: 'linear', ticks: { color: ink, maxRotation: 0, maxTicksLimit: 8, callback: (v) => new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) }, grid: { display: false } },
            y: { suggestedMin: 0, suggestedMax: 10, ticks: { color: ink, callback: (v) => `${v}%` }, grid: { color: grid } }
          },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title: (items) => { const p = this._driftPts && this._driftPts[items[0].dataIndex]; return p ? `${p.title} - ${new Date(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}` : ''; },
              label: (c) => { if (c.datasetIndex !== 0) return ' 5% line'; const p = this._driftPts[c.dataIndex]; return ` Drift ${p.pct}% over ${p.minutes} min${p.np ? ` at ${p.np} W` : ''} - click to open`; }
            } }
          }
        }
      });
      this._driftColor = color;
      this.updateDriftChart();
    },

    updateDriftChart() {
      if (!this.driftChart) return;
      // The page range applies here as on the other time charts.
      const now = Date.now(), start = this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * 86400000;
      const pts = this.driftTrendData().filter(p => p.t >= start && p.t <= now);
      this._driftPts = pts;
      const ds = this.driftChart.data.datasets;
      ds[0].data = pts.map(p => ({ x: p.t, y: p.pct }));
      ds[0].pointBackgroundColor = pts.map(p => this._driftColor[p.level]);
      ds[0].pointBorderColor = pts.map(p => this._driftColor[p.level]);
      ds[1].data = [{ x: start, y: 5 }, { x: now, y: 5 }];
      this.driftChart.options.scales.x.min = start;
      this.driftChart.options.scales.x.max = now;
      this.driftChart.update();
      const label = document.getElementById('driftTrendLabel');
      if (label) {
        if (!pts.length) label.textContent = 'no steady rides with HR yet';
        else {
          const recent = pts.slice(-5), avg = recent.reduce((a, p) => a + p.pct, 0) / recent.length;
          label.textContent = `last ${recent.length}: avg ${avg.toFixed(1)}%`;
        }
      }
    },

    // ---------------------------------------------------- coach context --
    /**
     * What the recorded rides say, for the AI coach: the last hard session's interval diagnosis
     * (and its saved AI breakdown), the Pw:HR drift of recent steady rides, new PR medals and a
     * pending FTP suggestion. Returns { lines: [...], ... } - lines are ready for the prompt.
     */
    coachInsight(lookbackDays = 28, now = new Date()) {
      const within = (r, days) => now - new Date(r.date) <= days * VeloInsight.DAY && now >= new Date(r.date);
      const rides = this.cyclingRides().filter(r => VeloInsight.hasSamples(r) && within(r, lookbackDays))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      const out = { lines: [], lastHard: null, drift: [], medals: [], ftp: null };
      if (!rides.length) return out;
      const day = (r) => VeloMetrics.localDateKey(r.date);

      // Last hard session (at least one step at 88% FTP or more)
      for (const r of rides) {
        const rows = VeloInsight.intervalRows(r.samples, r.ftpAtRide || this.activeProfile.ftp);
        if (!rows.some(x => x.work)) continue;
        const diag = VeloInsight.offlineBreakdown(rows).slice(0, 4);
        out.lastHard = { id: r.id, date: day(r), title: r.title, diag, ai: r.aiBreakdown && r.aiBreakdown.text ? r.aiBreakdown.text.replace(/\s+/g, ' ').slice(0, 320) : null };
        out.lines.push(`Last hard session ${day(r)} "${r.title}": ${diag.join(' ')}`);
        if (out.lastHard.ai) out.lines.push(`Coach notes on it: ${out.lastHard.ai}`);
        break;
      }

      // Aerobic decoupling of steady rides (newest first, up to 5)
      this._decCache = this._decCache || new Map();
      for (const r of rides) {
        const key = `${r.id}|${r.samples.length}`;
        if (!this._decCache.has(key)) this._decCache.set(key, VeloInsight.decoupling(r.samples));
        const d = this._decCache.get(key);
        if (d.status === 'ok') out.drift.push({ date: day(r), pct: d.pct, label: d.label });
        if (out.drift.length >= 5) break;
      }
      if (out.drift.length) {
        const avg = Math.round(out.drift.reduce((a, d) => a + d.pct, 0) / out.drift.length * 10) / 10;
        out.lines.push(`Pw:HR drift on steady rides (newest first): ${out.drift.map(d => `${d.date} ${d.pct}%`).join(', ')} - average ${avg}% (under 5% = aerobically coupled).`);
      }

      // New PR medals in the last 14 days: real improvements (an earlier best existed) for 5 min and
      // longer - short ERG peaks only mirror the targets, and a new history's first rides are "bests" anyway.
      const hist = this.medalHistory();
      rides.filter(r => within(r, 14)).forEach(r => {
        this.rideMedals(r, hist).filter(m => m.medal !== 'bronze' && m.prev && m.i >= 2).forEach(m => out.medals.push({ date: day(r), ...m }));
      });
      if (out.medals.length) {
        out.lines.push(`New power bests (14 days): ${out.medals.slice(0, 4).map(m => `${m.date} ${m.label} ${m.watts} W (${m.medal === 'gold' ? 'all-time best' : 'best this year'}, was ${m.prev} W)`).join('; ')}.`);
      }

      // FTP suggestion not applied yet
      const sug = this.ftpSuggestionFor(rides[0]);
      if (sug) {
        out.ftp = sug;
        out.lines.push(`Recent power suggests FTP about ${sug.ftp} W (profile still ${sug.from} W, ${sug.basis}) - targets are still based on ${sug.from} W.`);
      }
      return out;
    },

    // ------------------------------------------------- interval diagnosis --
    /** Offline breakdown (always) + the AI coach's breakdown (saved with the ride) or a button for it. */
    intervalBreakdownHtml(record) {
      if (!VeloInsight.hasSamples(record)) return '';
      const ftp = record.ftpAtRide || this.activeProfile.ftp;
      const rows = VeloInsight.intervalRows(record.samples, ftp);
      if (rows.length < 2 || !rows.some(r => r.work)) return '';
      const lines = VeloInsight.offlineBreakdown(rows);
      const ai = record.aiBreakdown;
      const coach = this.aiCoach;
      const live = !!(coach && coach.isLive);
      const md = (t) => (window.VeloMarkdown ? window.VeloMarkdown.render(t) : `<p>${esc(t)}</p>`);
      const aiHtml = ai && ai.text
        ? `<div class="ai-breakdown md-body">${md(ai.text)}</div><div class="hint">AI coach: ${esc(ai.label || ai.model)}${ai.effort ? `, ${esc(ai.effort)} effort` : ''} &middot; ${esc(new Date(ai.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} <button type="button" class="link-btn" data-ai-breakdown="${esc(record.id)}">Ask again</button></div>`
        : live
          ? `<button type="button" class="btn btn-sm" data-ai-breakdown="${esc(record.id)}"><svg class="ic"><use href="#i-sparkles"/></svg>Ask the AI coach (${esc(VeloAiCoach.labelFor(coach.model))}, low effort)</button>`
          : '<span class="hint">Add an Anthropic, Gemini or OpenAI key to .env (or sign in to Claude Code) for an AI coach breakdown - the summary above is computed offline.</span>';
      return `
        <div class="review-block interval-diagnosis" id="intervalDiagnosis">
          <div class="sub-title"><span>Interval diagnosis</span><span class="hint">hard steps (88% FTP+): target, cadence fade, heart-rate drift</span></div>
          <ul class="diag-list">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
          <div class="ai-breakdown-area" id="aiBreakdownArea">${aiHtml}</div>
        </div>`;
    },

    /** Sends the step table (not raw samples) to /api/coach at low effort and saves the answer on the ride. */
    async requestAiBreakdown(rideId) {
      const record = this.completedWorkouts.find(r => r.id === rideId);
      const area = document.getElementById('aiBreakdownArea');
      if (!record || this._aiBreakdownBusy) return null;
      const coach = this.aiCoach;
      if (coach && !coach.isLive) await coach.detectEngine();
      if (!coach || !coach.isLive) { this.showToast('The AI coach is offline - start Launch-Apex-Velo.bat and add an API key (or sign in to Claude Code).', 'warning'); return null; }
      const ftp = record.ftpAtRide || this.activeProfile.ftp;
      const rows = VeloInsight.intervalRows(record.samples, ftp);
      const prompt = VeloInsight.breakdownPrompt(rows, { title: record.title, ftp, minutes: Math.round((record.duration || record.samples.length) / 60), avgHr: record.avgHr, maxHr: this.activeProfile.maxHr });
      const model = coach.model;
      const effort = VeloAiCoach.supportsEffort(model) ? 'low' : null; // always the cheapest reasoning level
      this._aiBreakdownBusy = true;
      if (area) area.innerHTML = `<span class="hint is-busy">Asking ${esc(VeloAiCoach.labelFor(model))} (low effort)...</span>`;
      try {
        const resp = await fetch(VeloAiCoach.COACH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, provider: coach.provider, model, effort }) });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok || !json.text) throw new Error(json.error || `AI coach error (${resp.status})`);
        record.aiBreakdown = { text: String(json.text).trim().slice(0, 4000), model: json.model || model, label: VeloAiCoach.labelFor(json.model || model), effort: json.effort || effort, at: Date.now() };
        this.persistHistoryLocal();
        await VeloDB.saveRide(record);
        return record.aiBreakdown;
      } catch (e) {
        this.showToast(`AI breakdown failed: ${e.message}`, 'error');
        return null;
      } finally {
        this._aiBreakdownBusy = false;
        const block = document.getElementById('intervalDiagnosis');
        if (block && this._reviewRideId === rideId) block.outerHTML = this.intervalBreakdownHtml(record);
      }
    },

    bindInsightActions(container) {
      if (!container) return;
      this.on(container, 'click', (e) => {
        const ai = e.target.closest('[data-ai-breakdown]');
        if (ai) { this.requestAiBreakdown(ai.dataset.aiBreakdown); return; }
        const b = e.target.closest('[data-ftp]');
        if (!b) return;
        if (b.dataset.ftp === 'accept') this.acceptFtpSuggestion(b.dataset.value);
        else this.dismissFtpSuggestion(b.dataset.value);
      });
    }
  });
})();
