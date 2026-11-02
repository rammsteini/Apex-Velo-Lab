/**
 * APEX VELO // LAB - Ask: free questions about your own training, answered by Claude or Gemini (mixin on VeloApp).
 *
 * Separate from the Coach (which builds workouts) and training blocks: pick a period, ask in your own
 * words, get a short plain-English answer with the numbers behind it. The question, the conversation and
 * a text summary of that period (js/velo-ask.js) go to POST /api/ask on the local server, which holds the
 * API key; the engine is the one chosen in Settings > AI engine. The chat stays in this browser.
 */
(function () {
  const DAY = 86400000;
  const STORE_KEY = 'apex_ask_v1';
  const ASK_URL = 'api/ask';
  const TIMEOUT_MS = 190000;
  const MAX_HISTORY = 20;
  const MEANING_KEYS = [['TSS', 'tss'], ['NP', 'np'], ['IF', 'if'], ['CTL', 'ctl'], ['ATL', 'atl'], ['TSB', 'tsb'], ['EF', 'ef'], ['CP', 'cp'], ["W'", 'wprime'], ['VI', 'vi']];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDay = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

  Object.assign(VeloApp.prototype, {
    initAskUi() {
      this.askMessages = [];
      this.askPeriod = '6w';
      this.askFrom = '';
      this.askTo = '';
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (s && typeof s === 'object') {
          if (VeloAsk.PERIODS.some(p => p.key === s.period)) this.askPeriod = s.period;
          this.askFrom = typeof s.from === 'string' ? s.from : '';
          this.askTo = typeof s.to === 'string' ? s.to : '';
          if (Array.isArray(s.messages)) this.askMessages = s.messages.filter(m => m && ['user', 'assistant', 'note'].includes(m.role) && typeof m.content === 'string').slice(-60);
        }
      } catch (e) { /* storage unavailable: start empty */ }
      const pills = document.getElementById('askPeriodPills');
      if (pills) {
        pills.innerHTML = VeloAsk.PERIODS.map(p => `<button type="button" class="ask-period" data-period="${p.key}" aria-pressed="false">${esc(p.short)}</button>`).join('');
        pills.querySelectorAll('.ask-period').forEach(b => this.on(b, 'click', () => this.setAskPeriod(b.dataset.period)));
      }
      const from = document.getElementById('askFrom'), to = document.getElementById('askTo');
      if (from) { from.value = this.askFrom; this.on(from, 'change', () => { this.askFrom = from.value; this.askPeriodChanged(); }); }
      if (to) { to.value = this.askTo; this.on(to, 'change', () => { this.askTo = to.value; this.askPeriodChanged(); }); }
      const form = document.getElementById('askForm'), input = document.getElementById('askInput');
      if (form) this.on(form, 'submit', (e) => { e.preventDefault(); this.sendAsk(input ? input.value : ''); });
      if (input) {
        this.on(input, 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendAsk(input.value); } });
        this.on(input, 'input', () => this.sizeAskInput());
      }
      this.on(document.getElementById('btnAskStop'), 'click', () => { if (this._askAbort) this._askAbort.abort('stop'); });
      this.on(document.getElementById('btnAskNew'), 'click', () => this.newAskChat());
      this.on(document.getElementById('btnAskClear'), 'click', () => {
        if (this.askMessages.length && confirm('Clear this chat? The questions and answers are removed from this device.')) this.newAskChat();
      });
      this.on(document.getElementById('btnAskEngine'), 'click', () => this.openSettings && this.openSettings('ai'));
      this.on(document.getElementById('btnAskEngineWarn'), 'click', () => this.openSettings && this.openSettings('ai'));
      const thread = document.getElementById('askThread');
      if (thread) this.on(thread, 'click', (e) => {
        const chip = e.target.closest('[data-suggest]');
        if (chip) { this.sendAsk(chip.dataset.suggest); return; }
        const copy = e.target.closest('[data-copy]');
        if (copy) {
          const m = this.askMessages[Number(copy.dataset.copy)];
          if (m && this.copyText) this.copyText(m.content, 'Answer copied.');
        }
      });
      const peek = document.getElementById('askDataPeek');
      if (peek) this.on(peek, 'toggle', () => { if (peek.open) this.renderAskPeek(); });
      this.renderAskPeriod();
      this.updateAskEngine();
      this.renderAskThread();
    },

    /** Called when the Ask tab opens: fresh scope line, engine state and focus in the question box. */
    onAskTab() {
      this.renderAskPeriod();
      this.updateAskEngine();
      const input = document.getElementById('askInput');
      if (input && !this._askBusy) requestAnimationFrame(() => input.focus({ preventScroll: true }));
    },

    askRange(now = new Date()) {
      const first = this.cyclingRides().reduce((m, r) => { const t = Date.parse(r.date); return Number.isFinite(t) && (m === null || t < m) ? t : m; }, null);
      return VeloAsk.range(this.askPeriod, now, { fromKey: this.askFrom, toKey: this.askTo, firstTs: first });
    },

    setAskPeriod(key) {
      if (!VeloAsk.PERIODS.some(p => p.key === key) || key === this.askPeriod) { if (key === 'custom') this.renderAskPeriod(); return; }
      this.askPeriod = key;
      if (key === 'custom' && !this.askFrom) {
        const r = VeloAsk.range('6w');
        this.askFrom = VeloAsk.dayKey(r.from); this.askTo = VeloAsk.dayKey(r.to);
        const from = document.getElementById('askFrom'), to = document.getElementById('askTo');
        if (from) from.value = this.askFrom;
        if (to) to.value = this.askTo;
      }
      this.askPeriodChanged();
    },

    /** A new period applies from the next question; mid-chat, a note in the thread says so. */
    askPeriodChanged() {
      const r = this.askRange();
      if (this.askMessages.some(m => m.role === 'user')) {
        const last = this.askMessages[this.askMessages.length - 1];
        const note = { role: 'note', content: `Now looking at: ${r.label} (${VeloAsk.dayKey(r.from)} to ${VeloAsk.dayKey(r.to)})` };
        if (last && last.role === 'note') this.askMessages[this.askMessages.length - 1] = note; else this.askMessages.push(note);
        this.renderAskThread();
      } else this.renderAskThread();
      this.saveAsk();
      this.renderAskPeriod();
    },

    renderAskPeriod() {
      document.querySelectorAll('#askPeriodPills .ask-period').forEach(b => {
        const on = b.dataset.period === this.askPeriod;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      const custom = document.getElementById('askCustom');
      if (custom) custom.hidden = this.askPeriod !== 'custom';
      const r = this.askRange();
      const rides = this.cyclingRides().filter(x => { const t = Date.parse(x.date); return t >= r.from.getTime() && t <= r.to.getTime(); });
      const hours = rides.reduce((a, x) => a + (Number(x.duration) || 0), 0) / 3600;
      const withPower = rides.filter(x => VeloInsight.hasSamples(x) || Number(x.np) > 0 || Number(x.avgWatts) > 0).length;
      const scope = document.getElementById('askScope');
      if (scope) {
        scope.innerHTML = rides.length
          ? `<b class="num">${rides.length}</b> ride${rides.length === 1 ? '' : 's'} &middot; <b class="num">${hours.toFixed(1)}</b> h &middot; ${esc(fmtDay(r.from))} - ${esc(fmtDay(r.to))}${withPower < rides.length ? ` &middot; ${withPower} with power` : ''}`
          : `No rides from ${esc(fmtDay(r.from))} to ${esc(fmtDay(r.to))} - pick a longer period`;
      }
      const peek = document.getElementById('askDataPeek');
      if (peek && peek.open) this.renderAskPeek();
      if (!this.askMessages.length) this.renderAskThread();
    },

    renderAskPeek() {
      const pre = document.getElementById('askDataText');
      if (!pre) return;
      const text = this.askContext();
      pre.textContent = text;
      this.setText('askDataSize', `about ${Math.round(text.length / 4).toLocaleString()} tokens`);
    },

    updateAskEngine() {
      const c = this.aiCoach;
      if (!c) return;
      const m = c.model;
      this.setText('askEngineLabel', `${VeloAiCoach.labelFor(m)}${VeloAiCoach.supportsEffort(m) ? ` · ${c.effort} effort` : ''}`);
      const warn = document.getElementById('askEngineWarn');
      if (warn) {
        warn.hidden = c.isLive;
        this.setText('askEngineWarnText', c.engine.reachable
          ? `${c.providerLabel} is not ready yet. ${VeloAiCoach.setupHint(c.provider)}`
          : 'Ask uses Claude, Gemini, ChatGPT or Claude Code through the local server: open the app with Launch-Apex-Velo.bat (your API key stays on this PC).');
      }
    },

    /** The text summary of the chosen period the AI answers from (memoised until the data changes). */
    askContext(range = this.askRange()) {
      const p = this.activeProfile || {};
      const key = [range.key, VeloAsk.dayKey(range.from), VeloAsk.dayKey(range.to), this.historySignature(), (this.healthDays || []).length, p.ftp, p.weightKg, p.maxHr, VeloAsk.dayKey(new Date())].join('|');
      if (this._askCtx && this._askCtx.key === key) return this._askCtx.text;
      const text = VeloAsk.build(this.askInput(range));
      this._askCtx = { key, text };
      return text;
    },

    /** Plain numbers for VeloAsk.build(): only measured values, from the app's cached ride analysis. */
    askInput(range) {
      const p = this.activeProfile || {};
      const fromT = range.from.getTime(), toT = range.to.getTime();
      const span = toT - fromT + 1;
      const when = (r) => Date.parse(r.date);
      const within = (r, a, b) => { const t = when(r); return Number.isFinite(t) && t >= a && t <= b; };
      const cycling = this.cyclingRides();
      const rides = cycling.filter(r => within(r, fromT, toT)).sort((a, b) => when(b) - when(a));
      const prev = cycling.filter(r => within(r, fromT - span, fromT - 1));
      const totals = (list) => {
        let sec = 0, km = 0, tss = 0, kj = 0, npSum = 0, npN = 0, longest = 0, withPower = 0, withHr = 0;
        list.forEach(r => {
          const d = Number(r.duration) || 0;
          sec += d; km += Number(r.distanceKm) || 0; tss += Number(r.tss) || 0; kj += Number(r.kj) || 0; longest = Math.max(longest, d);
          const np = Number(r.np) || 0;
          if (np > 0) { npSum += np; npN++; }
          if (VeloInsight.hasSamples(r) || np > 0 || Number(r.avgWatts) > 0) withPower++;
          if (Number(r.avgHr) > 0) withHr++;
        });
        return { rides: list.length, hours: sec / 3600, km, tss: Math.round(tss), kj: Math.round(kj), avgNp: npN ? Math.round(npSum / npN) : 0, longestSec: longest, withPower, withHr };
      };

      // Form today and fitness at each week end (PMC over the whole history).
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, 0, this.pmcOpts());
      const keys = pmc.dateKeys || [];
      const ctlOn = (k) => { let v = null; for (let i = 0; i < keys.length && keys[i] <= k; i++) v = pmc.ctlData[i]; return v; };
      let form = null;
      if (keys.length && cycling.length) {
        const ramp = VeloTrends.rampRate(pmc.ctlData);
        form = { ctl: pmc.currentCtl, atl: pmc.currentAtl, tsb: pmc.currentTsb, formLabel: VeloMetrics.formZone(pmc.currentTsb).label, ramp, rampLabel: VeloTrends.rampVerdict(ramp).label.toLowerCase() };
      }
      const weeks = [];
      for (let ws = VeloProgress.weekStart(range.from); ws.getTime() <= toT; ws = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7)) {
        const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7).getTime() - 1;
        const list = rides.filter(r => within(r, Math.max(ws.getTime(), fromT), Math.min(we, toT)));
        const t = totals(list);
        weeks.push({ start: VeloAsk.dayKey(ws), rides: t.rides, hours: t.hours, tss: t.tss, kj: t.kj, ctl: ctlOn(VeloAsk.dayKey(new Date(Math.min(we, toT)))) });
      }

      // Power bests: this period (1 Hz curves) vs all-time (archive included).
      const env = this.powerEnvelope(fromT - 1, toT);
      const all = this.getAllTimeMmpBests();
      const bests = [[5, '5 s', 0], [60, '1 min', 3], [300, '5 min', 5], [1200, '20 min', 7], [3600, '60 min', 8]]
        .map(([sec, label, i]) => ({ label, period: env.watts[VeloPower.gridIndex(sec)] || null, allTime: all[i] || null }))
        .filter(b => b.period || b.allTime);

      // Zones, aerobic signs, balance.
      const z = [0, 0, 0, 0, 0, 0, 0];
      rides.forEach(r => { const zs = this.rideZoneSeconds(r); if (zs) zs.forEach((v, i) => { z[i] += v; }); });
      const zt = z.reduce((a, b) => a + b, 0);
      const zones = zt ? { pct: z.map(v => Math.round((v / zt) * 100)), hours: (zt / 3600).toFixed(1), seiler: VeloPower.seiler(z) } : null;
      const oldestFirst = rides.slice().reverse();
      const efs = oldestFirst.map(r => this.rideEf(r)).filter(Boolean).map(e => e.ef);
      const drifts = oldestFirst.map(r => this.askDrift(r)).filter(v => v !== null);
      const aerobic = efs.length || drifts.length ? {
        efN: efs.length, efFirst: efs.length ? efs[0] : null, efLast: efs.length ? efs[efs.length - 1] : null,
        driftN: drifts.length, driftAvg: drifts.length ? drifts.reduce((a, b) => a + b, 0) / drifts.length : null
      } : null;
      const bal = VeloTrends.balancePoints(rides);
      const balance = bal.length ? { avgLeft: Math.round((bal.reduce((a, b) => a + b.v, 0) / bal.length) * 10) / 10, n: bal.length } : null;

      // Recovery (Apple Health) by week.
      const health = [];
      const hd = (this.healthDays || []).filter(d => { const t = new Date(`${d.day}T12:00:00`).getTime(); return t >= fromT && t <= toT; });
      if (hd.length) {
        const byWeek = new Map();
        hd.forEach(d => { const k = VeloAsk.dayKey(VeloProgress.weekStart(new Date(`${d.day}T12:00:00`))); if (!byWeek.has(k)) byWeek.set(k, []); byWeek.get(k).push(d); });
        const avg = (list, f) => { const v = list.map(x => Number(x[f])).filter(x => Number.isFinite(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
        [...byWeek.keys()].sort().forEach(k => { const list = byWeek.get(k); health.push({ week: k, rhr: avg(list, 'rhr'), hrv: avg(list, 'hrv'), sleep: avg(list, 'sleepH') }); });
      }

      const others = (this.completedWorkouts || []).filter(r => !VeloMetrics.isCycling(r) && within(r, fromT, toT)).sort((a, b) => when(b) - when(a))
        .map(r => ({ date: VeloAsk.dayKey(new Date(r.date)), type: r.sportType || r.activityType || 'activity', title: r.title || '', dur: Number(r.duration) || 0 }));
      const ftpChanges = (Array.isArray(p.ftpHistory) ? p.ftpHistory : []).filter(e => { const t = Date.parse(e.date); return t >= fromT && t <= toT; })
        .map(e => ({ date: VeloAsk.dayKey(new Date(e.date)), from: e.from, to: e.ftp }));

      const rideRows = rides.map(r => {
        const pk = this.rideMedalPeaks(r);
        const zs = this.rideZoneSeconds(r);
        const ef = this.rideEf(r);
        const sei = zs ? VeloPower.seiler(zs) : null;
        return {
          date: VeloAsk.dayKey(new Date(r.date)), title: r.title, dur: Number(r.duration) || 0, km: Number(r.distanceKm) || null,
          avgW: Number(r.avgWatts) || null, np: Number(r.np) || null, ifac: parseFloat(r.if) || null, tss: Number(r.tss) || null, kj: Number(r.kj) || null,
          avgHr: Number(r.avgHr) || null, maxHr: Number(r.maxHr) || null, cad: Number(r.avgCadence) || null, left: Number(r.leftBal) > 0 ? Number(r.leftBal) : null,
          ef: ef ? ef.ef : null, drift: this.askDrift(r), p5: pk ? pk[2] : null, p20: pk ? pk[3] : null, zone3: sei ? sei.pct.map(v => Math.round(v)) : null
        };
      });

      const model = this.powerModelAt(toT);
      const r = this.healthReadiness ? this.healthReadiness() : null;
      const readiness = r && r.level && !['none', 'baseline'].includes(r.level) ? `${r.label || r.level}${r.advice ? ` - ${r.advice}` : ''}${Array.isArray(r.reasons) && r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}` : null;
      const prevFrom = new Date(fromT - span), prevTo = new Date(fromT - 1);
      return {
        today: VeloAsk.dayKey(new Date()),
        period: { label: range.label, from: VeloAsk.dayKey(range.from), to: VeloAsk.dayKey(range.to), days: range.days },
        rider: { name: p.name, ftp: p.ftp, weightKg: p.weightKg, maxHr: p.maxHr, lthr: p.lthr },
        form, readiness,
        model: model && model.ok ? { cp: model.cp, w: model.w, pmax: model.pmax, from: VeloAsk.dayKey(new Date(model.from)), to: VeloAsk.dayKey(new Date(model.to)) } : null,
        modelNote: model && model.reason === 'coverage' ? 'needs a ride of 20 min or more with hard efforts in the 90 days up to the end of the period' : 'not enough maximal efforts with power in the 90 days up to the end of the period',
        totals: { cur: totals(rides), prev: range.key === 'all' ? null : totals(prev), prevFrom: VeloAsk.dayKey(prevFrom), prevTo: VeloAsk.dayKey(prevTo) },
        weeks, bests, zones, aerobic, balance, health, others, ftpChanges,
        rides: rideRows,
        meanings: MEANING_KEYS.map(([a, k]) => [a, VeloGlossary.plain(k)])
      };
    },

    /** Heart-rate drift (Pw:HR, %) of a steady ride, or null; cached per ride. */
    askDrift(r) {
      if (!VeloInsight.hasSamples(r)) return null;
      const cache = this._askDrift || (this._askDrift = new Map());
      const key = `${r.id}|${r.samples.length}`;
      if (!cache.has(key)) {
        if (cache.size > 2 * (this.completedWorkouts || []).length + 50) cache.clear();
        const d = VeloInsight.decoupling(r.samples);
        cache.set(key, d && d.status === 'ok' ? d.pct : null);
      }
      return cache.get(key);
    },

    /** User / assistant turns for the API: the last 20, alternating and starting with the rider. */
    askHistoryForApi() {
      const out = [];
      this.askMessages.forEach(m => {
        if (m.role !== 'user' && m.role !== 'assistant') return;
        if (out.length && out[out.length - 1].role === m.role) out[out.length - 1] = { role: m.role, content: m.content };
        else out.push({ role: m.role, content: m.content });
      });
      let list = out.slice(-MAX_HISTORY);
      while (list.length && list[0].role !== 'user') list = list.slice(1);
      return list;
    },

    async sendAsk(raw) {
      const text = String(raw || '').trim();
      const input = document.getElementById('askInput');
      if (!text || this._askBusy) return;
      if (text.length > 4000) { this.showToast('Please keep a question under 4000 characters.', 'warning'); return; }
      const range = this.askRange();
      let context;
      try { context = this.askContext(range); } catch (e) { context = ''; console.warn('Ask: could not build the data summary', e); }
      this.askMessages.push({ role: 'user', content: text, at: Date.now() });
      if (input) { input.value = ''; this.sizeAskInput(); }
      this._askBusy = true;
      this._askStarted = performance.now();
      this.renderAskThread();
      this.saveAsk();
      this.setAskBusyUi(true);
      const c = this.aiCoach;
      const ac = new AbortController();
      this._askAbort = ac;
      const timer = setTimeout(() => ac.abort('timeout'), TIMEOUT_MS);
      this._askTick = setInterval(() => this.setText('askElapsed', `${Math.round((performance.now() - this._askStarted) / 1000)} s`), 1000);
      try {
        const res = await fetch(ASK_URL, {
          method: 'POST', cache: 'no-store', signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: this.askHistoryForApi(), context, provider: c.provider, model: c.model, effort: c.effort })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.error || `The local server answered ${res.status}.`), { server: true });
        const secs = ((performance.now() - this._askStarted) / 1000).toFixed(1);
        this.askMessages.push({ role: 'assistant', content: String(data.text || '').trim() || 'No answer came back - try asking again.', meta: `${VeloAiCoach.labelFor(data.model || c.model)} · ${secs} s`, at: Date.now() });
      } catch (e) {
        const reason = ac.signal.aborted ? ac.signal.reason : null;
        const last = this.askMessages[this.askMessages.length - 1];
        if (last && last.role === 'user') this.askMessages.pop();
        if (input && !input.value) { input.value = text; this.sizeAskInput(); }
        const msg = reason === 'stop' ? null
          : reason === 'timeout' ? 'No answer after 3 minutes. Try again, or ask a shorter question.'
            : e.server ? e.message
              : 'Can\'t reach the local server. Open the app with Launch-Apex-Velo.bat - Ask needs it for your API key.';
        if (msg) this.askMessages.push({ role: 'error', content: msg });
      } finally {
        clearTimeout(timer);
        clearInterval(this._askTick);
        this._askBusy = false;
        this._askAbort = null;
        this.setAskBusyUi(false);
        this.renderAskThread();
        this.saveAsk();
      }
    },

    setAskBusyUi(busy) {
      const send = document.getElementById('btnAskSend'), stop = document.getElementById('btnAskStop');
      if (send) send.hidden = busy;
      if (stop) stop.hidden = !busy;
      const input = document.getElementById('askInput');
      if (input) input.setAttribute('aria-busy', String(busy));
    },

    newAskChat() {
      if (this._askAbort) this._askAbort.abort('stop');
      this.askMessages = [];
      this.saveAsk();
      this.renderAskThread();
      const input = document.getElementById('askInput');
      if (input) input.focus();
    },

    saveAsk() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          period: this.askPeriod, from: this.askFrom, to: this.askTo,
          messages: this.askMessages.filter(m => m.role !== 'error').slice(-60)
        }));
      } catch (e) { /* storage full or blocked: the chat lives in memory only */ }
    },

    sizeAskInput() {
      const input = document.getElementById('askInput');
      if (!input) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    },

    renderAskThread() {
      const thread = document.getElementById('askThread');
      if (!thread) return;
      const newBtn = document.getElementById('btnAskNew');
      if (newBtn) newBtn.hidden = !this.askMessages.length;
      const clearBtn = document.getElementById('btnAskClear');
      if (clearBtn) clearBtn.hidden = !this.askMessages.length;
      if (!this.askMessages.length && !this._askBusy) {
        const r = this.askRange();
        thread.innerHTML = `
          <div class="ask-empty">
            <div class="ask-empty-icon"><svg class="ic"><use href="#i-chat"/></svg></div>
            <h3>What would you like to know?</h3>
            <p>Ask in your own words about <b>${esc(r.label.toLowerCase())}</b>. Answers come from your own rides, power, heart rate and recovery data.</p>
            <div class="ask-suggest" role="list">${VeloAsk.SUGGESTIONS.map(s => `<button type="button" class="ask-chip" role="listitem" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          </div>`;
        return;
      }
      const md = (t) => (window.VeloMarkdown ? window.VeloMarkdown.render(t) : `<p>${esc(t)}</p>`);
      thread.innerHTML = this.askMessages.map((m, i) => {
        if (m.role === 'note') return `<div class="ask-note"><span>${esc(m.content)}</span></div>`;
        if (m.role === 'error') return `<div class="ask-msg ask-error" role="alert"><div class="ask-bubble">${esc(m.content)}</div></div>`;
        if (m.role === 'user') return `<div class="ask-msg ask-user"><div class="ask-bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
        return `<div class="ask-msg ask-ai">
            <div class="ask-avatar" aria-hidden="true"><svg class="ic"><use href="#i-sparkles"/></svg></div>
            <div class="ask-body"><div class="ask-bubble md">${md(m.content)}</div>
            <div class="ask-meta"><span>${esc(m.meta || '')}</span><button type="button" class="link-btn" data-copy="${i}">Copy</button></div></div>
          </div>`;
      }).join('') + (this._askBusy ? `
          <div class="ask-msg ask-ai pending">
            <div class="ask-avatar" aria-hidden="true"><svg class="ic"><use href="#i-sparkles"/></svg></div>
            <div class="ask-body"><div class="ask-bubble"><span class="ask-dots" aria-hidden="true"><i></i><i></i><i></i></span> Looking through your data<span class="ask-elapsed num" id="askElapsed">0 s</span></div></div>
          </div>` : '');
      const last = thread.lastElementChild;
      if (last && this.activeTab === 'ask') requestAnimationFrame(() => last.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
  });
})();
