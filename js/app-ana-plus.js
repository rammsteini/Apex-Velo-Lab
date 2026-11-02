/**
 * APEX VELO // LAB - Analytics extras (mixin on VeloApp).
 *
 *  - Tap a day: a click on any time chart (or a heatmap cell, a timeline bar, a correlation dot) opens
 *    that day: rides, training load, readiness and every health value against your normal.
 *  - Linked crosshair: hovering one time chart marks the same date, with its values, on every chart of
 *    the module.
 *  - Readiness ring (0-100 from HRV, resting HR and sleep) and "Your week" in three sentences: written
 *    from the page's numbers, or by the AI engine on request (cached per week).
 *  - Training year heatmap (TSS per day, recovery flags), sleep timeline (hypnogram and bed / wake
 *    times when the data has them, else how each night was split) and a correlation explorer.
 *  - Polish: skeletons until the first render, counting tile values, and pinned charts on Overview.
 * Numbers come from js/velo-wellness.js and js/velo-health.js; nothing here guesses a missing value.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400000;
  const PIN_KEY = 'apex_ana_pins';
  const STORY_KEY = 'apex_ana_story';
  const MAX_PINS = 4;
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const noon = (day) => new Date(day + 'T12:00:00').getTime();
  const longDay = (day) => new Date(day + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shortDay = (day) => new Date(day + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const clock = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const LEVEL_TEXT = { green: 'Ready', amber: 'Go easier', red: 'Recover' };
  const STAGE = { deep: ['Deep', 'violet'], core: ['Light (core)', 'cyan'], rem: ['REM', 'amber'], awake: ['Awake', 'grey'] };

  let app = null;            // the VeloApp instance, for the chart plugins
  let sync = null;           // { x (ms), src (chart) } while a time chart is hovered

  /** A chart on the Analytics page whose x axis is dates: { kind: 'time' | 'pmc' } or null. */
  function timeKind(chart) {
    if (!app && window.app instanceof VeloApp) app = window.app;
    if (!app || !chart || !chart.canvas || !chart.canvas.closest('#view-analytics, #anaZoomDialog')) return null;
    if (chart === app.pmcChart) return { kind: 'pmc' };
    const x = chart.scales && chart.scales.x;
    if (!x || x.type !== 'linear') return null;
    const v = x.min;
    return Number.isFinite(v) && v > 1e12 ? { kind: 'time' } : null;
  }
  const dayFromX = (chart, kind, value) => {
    if (kind === 'pmc') { const keys = app._pmcKeys || []; const i = Math.round(value); return keys[Math.max(0, Math.min(keys.length - 1, i))] || null; }
    return app.localDayKey(new Date(value));
  };
  const xForDay = (chart, kind, day) => {
    if (kind === 'pmc') { const i = (app._pmcKeys || []).indexOf(day); return i < 0 ? null : i; }
    return noon(day);
  };

  /** Tap a day (click) and the linked crosshair (hover), for every date chart on the page. */
  const dayPlugin = {
    id: 'anaDays',
    afterEvent(chart, args) {
      const tk = timeKind(chart);
      if (!tk) return;
      const e = args.event;
      if (e.type === 'click' && args.inChartArea && typeof chart.options.onClick !== 'function') {
        const b = chart.$brush;
        if (b && (b.drag || (b.dragEnd && Date.now() - b.dragEnd < 400))) return;
        const day = dayFromX(chart, tk.kind, chart.scales.x.getValueForPixel(e.x));
        if (day) app.openAnaDay(day);
        return;
      }
      if (e.type === 'mousemove' || e.type === 'touchmove' || e.type === 'touchstart') {
        if (!args.inChartArea) return;
        const day = dayFromX(chart, tk.kind, chart.scales.x.getValueForPixel(e.x));
        if (!day || (sync && sync.day === day && sync.src === chart)) return;
        sync = { day, src: chart };
        peers(chart).forEach(c => c.draw());
      } else if (e.type === 'mouseout' && sync && sync.src === chart) {
        sync = null;
        peers(chart).forEach(c => c.draw());
      }
    },
    afterDatasetsDraw(chart) {
      if (!sync || sync.src === chart) return;
      const tk = timeKind(chart);
      if (!tk || !peers(sync.src).includes(chart)) return;
      const xv = xForDay(chart, tk.kind, sync.day);
      if (xv === null) return;
      const xs = chart.scales.x, a = chart.chartArea;
      const px = xs.getPixelForValue(xv);
      if (!(px >= a.left && px <= a.right)) return;
      const c = chart.ctx;
      c.save();
      c.strokeStyle = 'rgba(241,244,255,0.42)'; c.lineWidth = 1; c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(px + 0.5, a.top); c.lineTo(px + 0.5, a.bottom); c.stroke();
      c.setLineDash([]);
      // A dot where each visible line crosses that day (within half a day), ringed in the surface colour.
      chart.data.datasets.forEach((ds, i) => {
        if (!chart.isDatasetVisible(i) || ds.hlHidden || ds.type === 'bar' || chart.config.type === 'bar') return;
        const meta = chart.getDatasetMeta(i);
        let best = null;
        (meta.data || []).forEach((el, j) => {
          const raw = ds.data[j];
          const x = tk.kind === 'pmc' ? j : (raw && typeof raw === 'object' ? raw.x : null);
          if (x === null || x === undefined) return;
          const d = Math.abs(x - xv);
          if ((tk.kind === 'pmc' ? d < 0.5 : d < DAY / 2) && el && Number.isFinite(el.y) && (!best || d < best.d)) best = { d, el };
        });
        if (!best || best.el.y < a.top || best.el.y > a.bottom) return;
        c.beginPath(); c.arc(best.el.x, best.el.y, 4, 0, Math.PI * 2);
        c.fillStyle = typeof ds.borderColor === 'string' && ds.borderColor !== 'transparent' ? ds.borderColor : '#f1f4ff';
        c.strokeStyle = '#0b1020'; c.lineWidth = 2; c.fill(); c.stroke();
      });
      // Date pill at the top of the line.
      const label = shortDay(sync.day);
      c.font = "600 10.5px 'Figtree', system-ui, sans-serif";
      const w = c.measureText(label).width + 12;
      const lx = Math.max(a.left, Math.min(a.right - w, px - w / 2));
      c.fillStyle = 'rgba(12,16,34,0.92)'; c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 1;
      c.beginPath(); if (c.roundRect) c.roundRect(lx, a.top + 2, w, 18, 9); else c.rect(lx, a.top + 2, w, 18); c.fill(); c.stroke();
      c.fillStyle = '#f1f4ff'; c.textBaseline = 'middle'; c.fillText(label, lx + 6, a.top + 11);
      c.restore();
    }
  };

  /** Other date charts in the same module (or pinned row) as `chart`. */
  function peers(chart) {
    if (!chart || !chart.canvas || typeof Chart === 'undefined') return [];
    const scope = chart.canvas.closest('.ana-panel, #anaZoomDialog');
    if (!scope) return [];
    return [...scope.querySelectorAll('canvas')].map(cv => Chart.getChart(cv)).filter(c => c && c !== chart && timeKind(c));
  }

  // Registered now, before any chart exists: a chart only picks up plugins registered before it is built.
  if (typeof Chart !== 'undefined' && Chart.register) Chart.register(dayPlugin);

  const baseInitNav = VeloApp.prototype.initAnalyticsNav;
  const baseOverview = VeloApp.prototype.renderAnaOverview;
  const baseDashboard = VeloApp.prototype.renderDashboard;
  const baseHealthTiles = VeloApp.prototype.renderHealthTiles;
  const baseShowPanel = VeloApp.prototype.showAnalyticsPanel;

  Object.assign(VeloApp.prototype, {
    initAnalyticsNav(...args) {
      app = this;
      const r = baseInitNav ? baseInitNav.apply(this, args) : undefined;
      this.initAnaPlus();
      return r;
    },

    initAnaPlus() {
      const $ = (id) => document.getElementById(id);
      this.on($('btnAnaDayClose'), 'click', () => this.closeModal('anaDayModal'));
      this.on($('btnAnaDayPrev'), 'click', () => this._anaDay && this.openAnaDay(VeloWellness.addDays(this._anaDay, -1)));
      this.on($('btnAnaDayNext'), 'click', () => this._anaDay && this.openAnaDay(VeloWellness.addDays(this._anaDay, 1)));
      this.on($('anaDayBody'), 'click', (e) => {
        const b = e.target.closest('[data-ride]');
        if (b && this.showRideSummaryById) { this.closeModal('anaDayModal'); this.showRideSummaryById(b.dataset.ride); }
      });
      this.on($('anaReadyRing'), 'click', () => this.openAnaDay(this.localDayKey(new Date())));
      this.on($('btnAnaStory'), 'click', () => this.writeAnaStory());
      // Heatmap, sleep bars: any [data-day] opens it.
      ['anaYearGrid', 'sleepBars'].forEach(id => this.on($(id), 'click', (e) => { const c = e.target.closest('[data-day]'); if (c) this.openAnaDay(c.dataset.day); }));
      this.on($('anaYearGrid'), 'keydown', (e) => {
        const c = e.target.closest('[data-day]');
        if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.openAnaDay(c.dataset.day); }
      });
      ['corrX', 'corrY', 'corrLag'].forEach(id => this.on($(id), 'change', () => this.renderCorrelation()));
      this.initAnaPins();
    },

    renderDashboard(...args) {
      const r = baseDashboard ? baseDashboard.apply(this, args) : undefined;
      this.renderReadinessHero();
      this.renderAnaStory();
      this.renderYearHeatmap();
      this.renderSleepTimeline();
      this.renderCorrelation();
      if (this.activeTab === 'analytics') this.countUpTiles(document.getElementById('anaTiles'));
      return r;
    },

    renderAnaOverview(...args) {
      const r = baseOverview ? baseOverview.apply(this, args) : undefined;
      document.querySelectorAll('#anaSectionNav .ana-mod-stat.skel').forEach(el => el.classList.remove('skel'));
      return r;
    },

    renderHealthTiles(...args) {
      const r = baseHealthTiles ? baseHealthTiles.apply(this, args) : undefined;
      if (this.activeTab === 'analytics' && this.anaPanel === 'health') this.countUpTiles(document.getElementById('anaHealthTiles'));
      return r;
    },

    /** A pinned card lives on Overview: drill-downs to it go there. */
    showAnalyticsPanel(key, opts = {}) {
      if (opts.spot) {
        const card = document.getElementById(opts.spot);
        if (card && card.closest('#anaPinnedGrid')) key = 'overview';
      }
      const r = baseShowPanel.call(this, key, opts);
      if (key === 'health') this.countUpTiles(document.getElementById('anaHealthTiles'));
      if (key === 'overview') this.countUpTiles(document.getElementById('anaTiles'));
      return r;
    },

    // -------------------------------------------------------------- one day --
    /** Everything about one day: readiness, rides, training load and every health value vs normal. */
    openAnaDay(day) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return;
      const W = VeloWellness;
      this._anaDay = day;
      const today = this.localDayKey(new Date());
      const days = this.healthDays || [];
      const rec = days.find(d => d.day === day) || null;
      const rides = this.cyclingRides().filter(r => this.localDayKey(new Date(r.date)) === day).sort((a, b) => new Date(a.date) - new Date(b.date));
      this.setText('anaDayEyebrow', day === today ? 'Today' : day === W.addDays(today, -1) ? 'Yesterday' : 'Day');
      this.setText('anaDayTitle', longDay(day));
      const next = document.getElementById('btnAnaDayNext');
      if (next) next.disabled = day >= today;

      const out = [];
      // Readiness that day.
      const rd = days.length ? VeloHealth.readiness(days, day) : null;
      const sc = rd && rd.day === day ? W.readinessScore(rd) : null;
      if (rd && rd.day === day && sc) {
        out.push(`<div class="day-ready" data-level="${esc(rd.level)}">${this.ringSvg(sc.score, rd.level, 64)}<div><b>${esc(LEVEL_TEXT[rd.level] || rd.label)}</b><p>${esc(rd.reasons && rd.reasons.length ? rd.reasons.join('. ') + '.' : rd.advice || '')}</p></div></div>`);
      } else if (rd && rd.day === day && rd.level === 'baseline') {
        out.push(`<p class="day-note">${esc(rd.label)}.</p>`);
      }
      // Training.
      const k = (this._pmcKeys || []).indexOf(day);
      const pmc = k >= 0 && this.pmcChart ? { ctl: this.pmcChart.data.datasets[0].data[k], atl: this.pmcChart.data.datasets[1].data[k], tsb: this.pmcChart.data.datasets[2].data[k] } : null;
      const num = (v, d = 0) => (Number.isFinite(Number(v)) ? (Math.round(Number(v) * 10 ** d) / 10 ** d + 0).toFixed(d) : '--'); // + 0 turns -0 into 0
      out.push(`<h4 class="day-h">Training</h4>`);
      out.push(rides.length ? `<div class="day-rides">${rides.map(r => `<button type="button" class="ride-chip" data-ride="${esc(r.id)}"><b>${esc(r.title || 'Ride')}</b><small class="num">${this.fmtTime(r.duration)}${r.tss ? ` · ${Math.round(r.tss)} TSS` : ''}${r.np ? ` · NP ${Math.round(r.np)} W` : ''}${r.if ? ` · IF ${Number(r.if).toFixed(2)}` : ''}</small></button>`).join('')}</div>` : '<p class="day-note">Rest day - no rides.</p>');
      if (pmc) out.push(`<div class="day-kv"><div><span>Fitness (CTL)</span><b class="num">${num(pmc.ctl)}</b></div><div><span>Fatigue (ATL)</span><b class="num">${num(pmc.atl)}</b></div><div><span>Form (TSB)</span><b class="num">${num(pmc.tsb)}</b></div></div>`);
      // Health values vs the 30 days before.
      if (rec) {
        out.push(`<h4 class="day-h">Health</h4>`);
        if (Number.isFinite(rec.sleepH)) out.push(this.sleepBarHtml(rec));
        const before = days.filter(d => d.day < day && d.day >= W.addDays(day, -30));
        const rows = W.METRICS.filter(m => !['deepH', 'coreH', 'remH', 'awakeH'].includes(m.key) && W.value(rec, m.key) !== null).map(m => {
          const v = W.value(rec, m.key);
          const prev = before.map(d => W.value(d, m.key)).filter(x => x !== null);
          const avg = prev.length >= 5 ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
          let cmp = '';
          if (avg !== null) {
            const d = v - avg, step = m.fmt === 'h' ? 0.1 : m.dec ? 10 ** -m.dec : 1;
            if (Math.abs(d) < step) cmp = '<small class="hl-d flat">≈ your normal</small>';
            else {
              const good = m.good ? (m.good === 'up') === (d > 0) : null;
              cmp = `<small class="hl-d ${good === null ? 'flat' : good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${W.fmt(m.key, Math.abs(d))} vs 30-day ${W.fmt(m.key, avg)}</small>`;
            }
          }
          const unit = m.unit && m.unit !== 'h' ? ` ${esc(m.unit)}` : '';
          return `<div><span>${esc(m.label)}</span><b class="num">${W.fmt(m.key, v)}${unit}</b>${cmp}</div>`;
        });
        out.push(`<div class="day-kv day-health">${rows.join('')}</div>`);
      } else if (days.length) {
        out.push('<p class="day-note">No health data for this day.</p>');
      }
      const body = document.getElementById('anaDayBody');
      if (body) body.innerHTML = out.join('');
      this.openModal('anaDayModal');
    },

    /** One night as a horizontal bar of its stages (or one block when the night has no stages). */
    sleepBarHtml(rec) {
      const W = VeloWellness;
      const parts = [['deepH', 'deep'], ['coreH', 'core'], ['remH', 'rem'], ['awakeH', 'awake']].filter(([k]) => Number.isFinite(rec[k]) && rec[k] > 0);
      const total = parts.reduce((a, [k]) => a + rec[k], 0);
      const seg = parts.length && total > 0
        ? parts.map(([k, s]) => `<i class="st-${s}" style="flex:${rec[k]}" title="${esc(STAGE[s][0])} ${W.fmt('sleepH', rec[k])}"></i>`).join('')
        : '<i class="st-none" style="flex:1"></i>';
      const legend = parts.map(([k, s]) => `<span><i class="lg st-${s}"></i>${esc(STAGE[s][0])} ${W.fmt('sleepH', rec[k])}</span>`).join('');
      return `<div class="day-sleep"><div class="day-sleep-head"><span>Sleep</span><b class="num">${W.fmt('sleepH', rec.sleepH)}</b>${Number.isFinite(rec.bed) && Number.isFinite(rec.wake) ? `<small>${clock(rec.bed)} - ${clock(rec.wake)}</small>` : ''}</div><div class="stage-bar">${seg}</div>${legend ? `<div class="legend-inline">${legend}</div>` : ''}</div>`;
    },

    // ------------------------------------------------------- readiness ring --
    /** SVG ring: the score as an arc in the verdict's status colour, the number and word in ink. */
    ringSvg(score, level, size = 148) {
      const r = 42, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, score / 100));
      return `<svg class="ring-svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Readiness ${score} of 100: ${esc(LEVEL_TEXT[level] || '')}">
        <circle cx="50" cy="50" r="${r}" class="ring-track"/>
        <circle cx="50" cy="50" r="${r}" class="ring-arc ring-${esc(level)}" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
        <text x="50" y="${size < 90 ? 57 : 52}" class="ring-num">${score}</text>${size >= 90 ? `<text x="50" y="68" class="ring-word">${esc(LEVEL_TEXT[level] || '')}</text>` : ''}
      </svg>`;
    },

    renderReadinessHero() {
      const ring = document.getElementById('anaReadyRing'), parts = document.getElementById('anaReadyParts');
      if (!ring || !parts || typeof VeloWellness === 'undefined') return;
      const r = this.healthReadiness ? this.healthReadiness() : null;
      const sc = VeloWellness.readinessScore(r);
      if (!sc) {
        ring.innerHTML = `<span class="ring-empty"><svg class="ic"><use href="#i-heart"/></svg></span>`;
        const msg = !r || r.level === 'none' ? (document.documentElement.classList.contains('apex-native') ? 'Add your intervals.icu API key in Settings > Health to see your readiness.' : 'Set up Apple Health in Settings to see your readiness.')
          : r.level === 'baseline' ? `${r.label}: readiness needs a week of HRV to know your normal.` : 'No health data from the last two days.';
        parts.innerHTML = `<p class="ready-empty">${esc(msg)}</p>`;
        return;
      }
      ring.innerHTML = this.ringSvg(sc.score, sc.level);
      ring.dataset.level = sc.level;
      const fmtVal = (p) => p.key === 'sleep' ? VeloWellness.fmt('sleepH', p.value) : `${Math.round(p.value)} ${p.unit}`;
      parts.innerHTML = `${r.stale ? '<p class="ready-stale">From yesterday - no data for today yet.</p>' : ''}${sc.parts.map(p => `
        <div class="ready-part">
          <div class="ready-part-head"><span>${esc(p.label)}</span><b class="num">${esc(fmtVal(p))}</b></div>
          <div class="ready-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.score}" aria-label="${esc(p.label)} ${p.score} of 100"><i style="width:${p.score}%"></i></div>
          <small>${esc(p.note)}</small>
        </div>`).join('')}<p class="ready-advice">${esc(r.advice || '')}</p>`;
    },

    // ------------------------------------------------------------ your week --
    /** The facts the week's story is written from (also sent to the AI engine). */
    anaWeekFacts() {
      const W = VeloWellness, today = this.localDayKey(new Date());
      const train = W.dailyTraining(this.cyclingRides(), (d) => this.localDayKey(new Date(d)));
      const sum = (from, to, k) => Object.entries(train).filter(([d]) => d > from && d <= to).reduce((a, [, e]) => a + (e[k] || 0), 0);
      const w0 = W.addDays(today, -7), w1 = W.addDays(today, -14);
      const pmcTxt = (id) => (document.getElementById(id)?.textContent || '').trim();
      const r = this.healthReadiness ? this.healthReadiness() : null;
      const avgH = (k, from, to) => { const v = (this.healthDays || []).filter(d => d.day > from && d.day <= to).map(d => W.value(d, k)).filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      return {
        tss: Math.round(sum(w0, today, 'tss')), tssPrev: Math.round(sum(w1, w0, 'tss')),
        hours: Math.round(sum(w0, today, 'hours') * 10) / 10, hoursPrev: Math.round(sum(w1, w0, 'hours') * 10) / 10,
        rides: sum(w0, today, 'rides'),
        ctl: pmcTxt('pmcValCtl'), tsb: pmcTxt('pmcValTsb'), form: pmcTxt('pmcFormStatus'), ftp: pmcTxt('pmcValFtp'),
        readiness: r && r.level && !['none', 'stale', 'baseline'].includes(r.level) ? { level: r.level, label: r.label, reasons: r.reasons } : null,
        hrv: r && r.hrv ? r.hrv : null, rhr: r && r.rhr ? r.rhr : null,
        sleep7: avgH('sleepH', w0, today), sleepPrev: avgH('sleepH', w1, w0)
      };
    },

    /** Three sentences from the numbers: what changed, why, what next. */
    anaStoryOffline(f) {
      const W = VeloWellness;
      const pct = f.tssPrev > 0 ? Math.round(((f.tss - f.tssPrev) / f.tssPrev) * 100) : null;
      const s1 = f.rides
        ? `In the last 7 days you rode ${f.rides} time${f.rides === 1 ? '' : 's'} for ${f.hours} h and ${f.tss} TSS${pct === null ? '' : `, ${Math.abs(pct) < 5 ? 'about the same as' : `${Math.abs(pct)}% ${pct > 0 ? 'more than' : 'less than'}`} the week before`}.`
        : `You did not ride in the last 7 days${f.tssPrev ? ` (${f.tssPrev} TSS the week before)` : ''}.`;
      const body = [];
      if (f.hrv) body.push(f.hrv.avg7 < f.hrv.normalLow ? `your HRV (${f.hrv.avg7} ms) is below your normal ${f.hrv.normalLow}-${f.hrv.normalHigh} ms` : f.hrv.avg7 > f.hrv.normalHigh ? `your HRV (${f.hrv.avg7} ms) is above your normal range` : `your HRV is inside your normal range (${f.hrv.avg7} ms)`);
      if (f.rhr) body.push(Math.abs(f.rhr.delta) < 3 ? `resting HR is at your usual ${f.rhr.base} bpm` : `resting HR is ${f.rhr.delta > 0 ? 'up' : 'down'} ${Math.abs(f.rhr.delta)} bpm on your normal`);
      if (f.sleep7 !== null) body.push(`sleep averaged ${W.fmt('sleepH', f.sleep7)} a night`);
      const s2 = body.length ? `${body[0][0].toUpperCase()}${body.join(', ').slice(1)}${f.tsb ? `, and form (TSB) is ${f.tsb}` : ''}.` : f.tsb && f.tsb !== '--' ? `Form (TSB) is ${f.tsb}${f.form && f.form !== '--' ? ` (${f.form.toLowerCase()})` : ''}.` : 'Add health data in Settings to see how your body is handling it.';
      const tsb = parseFloat(f.tsb);
      const lvl = f.readiness && f.readiness.level;
      const s3 = lvl === 'red' ? 'Next: keep the next day or two to easy spinning in Z1-Z2 and sleep more before the next key session.'
        : Number.isFinite(tsb) && tsb < -25 ? 'Next: fatigue is high - plan an easier week (about 30% less TSS) before adding load again.'
          : lvl === 'amber' ? 'Next: keep intensity in check - endurance or tempo, or shorten the hard sets, until HRV and resting HR settle.'
            : Number.isFinite(tsb) && tsb > 10 ? "Next: you're fresh - a good week for a hard block, a test or a long ride."
              : 'Next: keep building with two key sessions and easy riding in between.';
      return [s1, s2, s3];
    },

    weekId(d = new Date()) { return this.localDayKey(new Date(VeloWellness.weekOf(d.getTime()))); },

    renderAnaStory() {
      const box = document.getElementById('anaStoryText');
      if (!box || typeof VeloWellness === 'undefined') return;
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(STORY_KEY) || 'null'); } catch (e) { /* storage blocked */ }
      const btn = document.getElementById('btnAnaStory');
      if (this._storyBusy) return;
      if (saved && saved.week === this.weekId() && Array.isArray(saved.lines)) {
        box.innerHTML = saved.lines.map(l => `<p>${esc(l)}</p>`).join('');
        this.setText('anaStoryNote', `Written by ${saved.model || 'the AI engine'} on ${new Date(saved.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} from the numbers on this page.`);
        if (btn) btn.lastElementChild.textContent = 'Rewrite';
        return;
      }
      box.innerHTML = this.anaStoryOffline(this.anaWeekFacts()).map(l => `<p>${esc(l)}</p>`).join('');
      this.setText('anaStoryNote', 'Written from the numbers on this page. Press Write with AI for a coach-style summary.');
      if (btn) btn.lastElementChild.textContent = 'Write with AI';
    },

    /** Asks the AI engine for the three sentences (low effort) and keeps them for this week. */
    async writeAnaStory() {
      const box = document.getElementById('anaStoryText'), btn = document.getElementById('btnAnaStory');
      const c = this.aiCoach;
      if (!box || !c || this._storyBusy) return;
      if (!c.isLive) await c.detectEngine();
      if (!c.isLive) { this.showToast('Writing the week with AI needs an API key or Claude Code (Settings > AI engine).', 'warning'); return; }
      this._storyBusy = true;
      if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
      box.innerHTML = '<span class="skel skel-line"></span><span class="skel skel-line"></span><span class="skel skel-line short"></span>';
      const facts = this.anaWeekFacts();
      const prompt = `WEEKLY STORY. You are a cycling coach. From these numbers about the rider's last 7 days, write exactly three short sentences in plain English:
1) what changed in training, 2) how the body is handling it (recovery data) and why, 3) what to do next week.
Use the numbers, no headings, no lists, no markdown, no greeting. Under 70 words in total. Do not invent numbers.

FACTS (JSON): ${JSON.stringify(facts)}`;
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 120000);
        const resp = await fetch(VeloAiCoach.COACH_URL, { method: 'POST', cache: 'no-store', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, provider: c.provider, model: c.model, effort: VeloAiCoach.supportsEffort(c.model) ? 'low' : null }) });
        clearTimeout(timer);
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error || `answered ${resp.status}`);
        const text = String(json.text || '').replace(/[*#_`]/g, '').trim();
        if (!text) throw new Error('the answer was empty');
        const lines = (text.match(/[^.!?]+[.!?]+/g) || [text]).map(t => t.trim()).filter(Boolean).slice(0, 3);
        try { localStorage.setItem(STORY_KEY, JSON.stringify({ week: this.weekId(), lines, model: VeloAiCoach.labelFor(c.model), at: Date.now() })); } catch (e) { /* kept for this view only */ }
        this._storyBusy = false;
        this.renderAnaStory();
      } catch (e) {
        this._storyBusy = false;
        this.renderAnaStory();
        this.showToast(`Could not write the week: ${e.name === 'AbortError' ? 'no answer after 2 minutes' : e.message}`, 'warning');
      } finally {
        this._storyBusy = false;
        if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
      }
    },

    // ------------------------------------------------------- training year --
    /** 53 weeks x 7 days of TSS (Monday first), with amber / red readiness flags on the cells. */
    renderYearHeatmap() {
      const grid = document.getElementById('anaYearGrid'), months = document.getElementById('anaYearMonths');
      if (!grid || typeof VeloWellness === 'undefined') return;
      const W = VeloWellness, today = this.localDayKey(new Date());
      const train = W.dailyTraining(this.cyclingRides(), (d) => this.localDayKey(new Date(d)));
      const hd = this.healthDays || [];
      const start = this.localDayKey(new Date(W.weekOf(noon(W.addDays(today, -364)))));
      const cells = [], monthCols = [];
      let col = 0, total = 0, rideDays = 0, flagged = 0, lastMonth = null;
      for (let d = start; d <= today || (cells.length % 7); d = W.addDays(d, 1)) {
        const i = cells.length;
        if (i % 7 === 0) {
          col = i / 7;
          const m = new Date(d + 'T12:00:00').getMonth();
          if (m !== lastMonth) { monthCols.push({ col, label: new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short' }) }); lastMonth = m; }
        }
        if (d > today) { cells.push('<i class="yc yc-future"></i>'); continue; }
        const e = train[d], tss = e ? Math.round(e.tss) : 0;
        if (tss) { total += tss; rideDays++; }
        const rd = hd.length ? VeloHealth.readiness(hd, d) : null;
        const flag = rd && rd.day === d && (rd.level === 'amber' || rd.level === 'red') ? rd.level : '';
        if (flag) flagged++;
        const tip = `${shortDay(d)}: ${tss ? `${tss} TSS${e.rides > 1 ? ` (${e.rides} rides)` : ''}` : 'rest'}${flag ? ` · ${LEVEL_TEXT[flag]}` : ''}`;
        cells.push(`<i class="yc lv${W.tssLevel(tss)}${flag ? ' yc-' + flag : ''}${d === today ? ' yc-today' : ''}" data-day="${d}" role="gridcell" tabindex="-1" title="${esc(tip)}" aria-label="${esc(tip)}"></i>`);
      }
      grid.innerHTML = cells.join('');
      const first = grid.querySelector('[data-day]');
      if (first) first.tabIndex = 0;
      if (months) months.innerHTML = monthCols.map(m => `<span style="grid-column:${m.col + 1}">${esc(m.label)}</span>`).join('');
      this.setText('anaYearChip', `${rideDays} ride days · ${total.toLocaleString('en-GB')} TSS`);
      const legend = document.getElementById('anaYearLegend');
      if (legend) legend.innerHTML = `<span>Rest</span>${[0, 1, 2, 3, 4].map(l => `<i class="yc lv${l}" title="${['Rest', 'Under 50 TSS', '50-99 TSS', '100-149 TSS', '150+ TSS'][l]}"></i>`).join('')}<span>150+ TSS</span>${hd.length ? `<span class="yh-flags"><i class="yc lv0 yc-amber"></i>Go easier <i class="yc lv0 yc-red"></i>Recover <small>(${flagged} day${flagged === 1 ? '' : 's'})</small></span>` : ''}`;
      const wrap = document.getElementById('anaYearWrap');
      if (wrap) requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
    },

    // -------------------------------------------------------- sleep timeline --
    /**
     * Last night as a hypnogram when the raw stage segments are still stored (Apple Health keeps them for
     * a week), and the last 14 nights: on a clock from 20:00 to 12:00 when bed and wake times exist,
     * else as how each night was split between its stages (intervals.icu has no times).
     */
    renderSleepTimeline() {
      const card = document.getElementById('anaCardSleepTimeline');
      if (!card || typeof VeloWellness === 'undefined') return;
      const W = VeloWellness, today = this.localDayKey(new Date());
      const nights = (this.healthDays || []).filter(d => d.day > W.addDays(today, -14) && d.day <= today && Number.isFinite(d.sleepH));
      const timed = nights.filter(d => Number.isFinite(d.bed) && Number.isFinite(d.wake));
      const staged = nights.filter(d => ['deepH', 'coreH', 'remH'].some(k => Number.isFinite(d[k])));
      let segDay = null, segs = [];
      for (let i = 0; i < 7 && !segs.length; i++) { segDay = W.addDays(today, -i); segs = VeloHealth.sleepSegments(this.healthStore, segDay); }
      card.hidden = !segs.length && timed.length < 3 && !staged.length;
      if (card.hidden) return;

      const hyp = document.getElementById('sleepHypno');
      if (hyp) {
        if (segs.length) {
          const a = segs[0].a, b = Math.max(...segs.map(s => s.b)), span = Math.max(1, b - a);
          const ROW = { awake: 0, rem: 1, core: 2, deep: 3 };
          const ticks = [];
          for (let t = Math.ceil(a / 60) * 60; t <= b; t += 60) ticks.push(`<span style="left:${((t - a) / span) * 100}%">${clock(t).slice(0, 2)}</span>`);
          hyp.innerHTML = `<div class="hypno-head"><b>${esc(shortDay(segDay))}</b> <span class="num">${clock(a)} - ${clock(b)}</span></div>
            <div class="hypno"><div class="hypno-rows">${['Awake', 'REM', 'Light', 'Deep'].map(l => `<span>${l}</span>`).join('')}</div>
            <div class="hypno-plot">${segs.map(s => `<i class="st-${s.stage}" style="left:${((s.a - a) / span) * 100}%;width:${Math.max(0.3, ((s.b - s.a) / span) * 100)}%;top:${ROW[s.stage] * 25}%" title="${esc(STAGE[s.stage][0])} ${clock(s.a)}-${clock(s.b)}"></i>`).join('')}
            <div class="hypno-ticks">${ticks.join('')}</div></div></div>`;
          hyp.hidden = false;
        } else { hyp.innerHTML = ''; hyp.hidden = true; }
      }

      const bars = document.getElementById('sleepBars');
      const list = [];
      for (let i = 13; i >= 0; i--) { const d = W.addDays(today, -i); list.push(nights.find(n => n.day === d) || { day: d }); }
      const clockMode = timed.length >= 3;
      if (bars) {
        if (clockMode) {
          const LO = 20 * 60, HI = 36 * 60; // 20:00 to 12:00 next day
          const pos = (m) => { let v = m < 12 * 60 ? m + 1440 : m; return Math.max(0, Math.min(100, ((v - LO) / (HI - LO)) * 100)); };
          bars.innerHTML = `<div class="sb-axis">${[20, 22, 0, 2, 4, 6, 8, 10, 12].map((h, i) => `<span style="left:${(i * 2 * 60 / (HI - LO)) * 100}%">${String(h).padStart(2, '0')}</span>`).join('')}</div>` +
            list.map(n => {
              const has = Number.isFinite(n.bed) && Number.isFinite(n.wake);
              const l = has ? pos(n.bed) : 0, r = has ? pos(n.wake) : 0;
              return `<button type="button" class="sb-row" data-day="${n.day}" title="${esc(shortDay(n.day))}${has ? `: ${clock(n.bed)} - ${clock(n.wake)}, ${W.fmt('sleepH', n.sleepH)} asleep` : ': no times'}"><span class="sb-day">${esc(shortDay(n.day).replace(/ \w+$/, ''))}</span><span class="sb-track">${has ? `<i class="sb-sleep" style="left:${l}%;width:${Math.max(1, r - l)}%"></i>` : ''}</span><span class="sb-val num">${Number.isFinite(n.sleepH) ? W.fmt('sleepH', n.sleepH) : '--'}</span></button>`;
            }).join('');
          const beds = timed.map(n => (n.bed < 12 * 60 ? n.bed + 1440 : n.bed)), wakes = timed.map(n => n.wake);
          const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
          const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1)); };
          this.setText('sleepTlNote', `Average bedtime ${clock(mean(beds))} (varies ±${Math.round(sd(beds))} min), wake-up ${clock(mean(wakes))} (±${Math.round(sd(wakes))} min). Regular times, within about 30 minutes, help recovery as much as total hours.`);
        } else {
          bars.innerHTML = list.map(n => `<button type="button" class="sb-row" data-day="${n.day}" title="${esc(shortDay(n.day))}${Number.isFinite(n.sleepH) ? `: ${W.fmt('sleepH', n.sleepH)}` : ': no data'}"><span class="sb-day">${esc(shortDay(n.day).replace(/ \w+$/, ''))}</span><span class="sb-track sb-split">${Number.isFinite(n.sleepH) ? this.stageSplitHtml(n) : ''}</span><span class="sb-val num">${Number.isFinite(n.sleepH) ? W.fmt('sleepH', n.sleepH) : '--'}</span></button>`).join('') +
            `<div class="legend-inline sb-legend">${['deep', 'core', 'rem'].map(s => `<span><i class="lg st-${s}"></i>${STAGE[s][0]}</span>`).join('')}</div>`;
          const deep = staged.map(n => n.deepH / n.sleepH).filter(Number.isFinite);
          this.setText('sleepTlNote', `Each bar is one night split into its stages (bar length = time asleep, longest night = full width).${deep.length ? ` Deep sleep averaged ${Math.round(deep.reduce((a, b) => a + b, 0) / deep.length * 100)}% of the night.` : ''} Bed and wake times are not in intervals.icu, so the nights are not placed on a clock.`);
        }
      }
      this.setText('sleepTlTitle', segs.length ? 'Last night and the last 14 nights' : 'The last 14 nights');
      this.setText('sleepTlSub', clockMode ? 'When you slept: bedtime to wake-up on a clock - tap a night to open it' : 'How each night was split - tap a night to open it');
      this.setText('sleepTlChip', `${nights.length} night${nights.length === 1 ? '' : 's'}`);
    },

    stageSplitHtml(n) {
      const longest = Math.max(...(this.healthDays || []).slice(-14).map(d => d.sleepH || 0), n.sleepH);
      const width = Math.max(4, (n.sleepH / longest) * 100);
      const parts = [['deepH', 'deep'], ['coreH', 'core'], ['remH', 'rem']].filter(([k]) => Number.isFinite(n[k]) && n[k] > 0);
      const inner = parts.length ? parts.map(([k, s]) => `<i class="st-${s}" style="flex:${n[k]}"></i>`).join('') : '<i class="st-none" style="flex:1"></i>';
      return `<span class="stage-bar" style="width:${width}%">${inner}</span>`;
    },

    // ------------------------------------------------------------ correlation --
    /** The measures the explorer offers: training per day, then each health value with data. */
    corrVariables() {
      const W = VeloWellness;
      const train = [['tss', 'Training load (TSS)', 'TSS'], ['hours', 'Riding time (h)', 'h of riding'], ['kj', 'Work (kJ)', 'kJ'], ['np', 'Normalized power (W)', 'W of NP'], ['if', 'Intensity (IF)', 'IF']].map(([k, l, unit]) => ({ key: 't:' + k, label: l, unit, group: 'Training that day' }));
      const days = this.healthDays || [];
      const health = [{ key: 'h:hrv', label: 'HRV (readiness)' }].concat(W.METRICS.map(m => ({ key: 'h:' + m.key, label: m.label })))
        .filter(v => days.some(d => W.value(d, v.key.slice(2)) !== null)).map(v => ({ ...v, group: 'Health' }));
      return train.concat(health);
    },

    renderCorrelation() {
      const card = document.getElementById('anaCardCorr');
      const sx = document.getElementById('corrX'), sy = document.getElementById('corrY');
      if (!card || !sx || !sy || typeof VeloWellness === 'undefined' || typeof Chart === 'undefined') return;
      const W = VeloWellness, vars = this.corrVariables();
      const healthVars = vars.filter(v => v.group === 'Health');
      card.hidden = !healthVars.length || !this.cyclingRides().length;
      if (card.hidden) return;
      const opts = (sel, def) => {
        const keep = sel.value && vars.some(v => v.key === sel.value) ? sel.value : def;
        const groups = [...new Set(vars.map(v => v.group))];
        sel.innerHTML = groups.map(g => `<optgroup label="${esc(g)}">${vars.filter(v => v.group === g).map(v => `<option value="${esc(v.key)}">${esc(v.label)}</option>`).join('')}</optgroup>`).join('');
        sel.value = keep;
      };
      opts(sx, 't:tss');
      opts(sy, healthVars.some(v => v.key === 'h:hrv') ? 'h:hrv' : healthVars[0].key);
      const lag = document.getElementById('corrLag')?.checked ? 1 : 0;

      const train = W.dailyTraining(this.cyclingRides(), (d) => this.localDayKey(new Date(d)));
      const firstRide = Object.keys(train).sort()[0];
      const hmap = {}; (this.healthDays || []).forEach(d => { hmap[d.day] = d; });
      const now = Date.now();
      const from = this.localDayKey(new Date(this.anaRangeStart ? this.anaRangeStart(now) : now - 182 * DAY)), to = this.localDayKey(new Date());
      const read = (key, day) => {
        if (key.startsWith('t:')) {
          if (!firstRide || day < firstRide) return null;
          const e = train[day], k = key.slice(2);
          if (k === 'np' || k === 'if') return e && e[k] ? e[k] : null; // no ride = no power, not zero
          return e ? e[k] : 0;
        }
        return hmap[day] ? W.value(hmap[day], key.slice(2)) : null;
      };
      const pts = [];
      for (let d = from; d <= to; d = W.addDays(d, 1)) {
        const yd = W.addDays(d, lag);
        if (yd > to) break;
        const x = read(sx.value, d), y = read(sy.value, yd);
        if (x !== null && y !== null) pts.push({ x, y, day: yd });
      }
      const c = W.correlate(pts), words = W.linkWords(c);
      const lx = vars.find(v => v.key === sx.value).label, ly = vars.find(v => v.key === sy.value).label;
      const verdict = document.getElementById('corrVerdict');
      if (verdict) {
        if (!c) verdict.innerHTML = `<b>Not enough days</b> with both ${esc(lx.toLowerCase())} and ${esc(ly.toLowerCase())} in this range yet.`;
        else {
          const r = c.r.toFixed(2);
          const head = { none: 'No clear link', weak: 'Weak link', moderate: 'Moderate link', strong: 'Strong link', unclear: 'Too few days to tell' }[words.strength];
          const xs = pts.map(p => p.x), step = this.niceStep(Math.max(...xs) - Math.min(...xs));
          const yKey = sy.value.slice(2), yMeta = W.BY_KEY[yKey === 'hrv' ? 'hrvRmssd' : yKey] || {};
          const per = c.slope * step;
          const yUnit = sy.value.startsWith('t:') ? ' ' + vars.find(v => v.key === sy.value).unit : yMeta.fmt === 'h' ? ' h' : yMeta.unit && yMeta.unit !== 'score' ? ' ' + yMeta.unit : '';
          const xWhat = sx.value.startsWith('t:') ? vars.find(v => v.key === sx.value).unit : `${lx.replace(/ \(.*\)/, '')}${(W.BY_KEY[sx.value.slice(2)] || {}).unit ? ' ' + W.BY_KEY[sx.value.slice(2)].unit : ''}`;
          const amount = yMeta.fmt === 'h' ? W.fmt('sleepH', Math.abs(per)).replace(/ h$/, '') : Math.abs(per) < 10 ? Math.abs(per).toFixed(1) : String(Math.round(Math.abs(per)));
          const detail = ['none', 'unclear'].includes(words.strength) ? '' : ` On ${lag ? 'mornings after days' : 'days'} with ${step} more ${esc(xWhat)}, ${esc(ly.replace(/ \(.*\)/, ''))} tends to be ${per > 0 ? 'higher' : 'lower'} by about ${esc(amount)}${esc(yMeta.fmt === 'h' ? '' : yUnit)}.`;
          verdict.innerHTML = `<b>${head}</b> <span class="num">(r = ${r}, ${c.n} days)</span>.${detail}`;
        }
      }
      this.setText('anaCorrChip', `${pts.length} day${pts.length === 1 ? '' : 's'}`);

      const { VIZ, INK, axis } = VeloApp.CHART;
      if (!this.corrChart) {
        const ctx = document.getElementById('corrCanvas')?.getContext('2d');
        if (!ctx) return;
        this.corrChart = new Chart(ctx, {
          type: 'scatter', data: { datasets: [] },
          options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            onClick: (evt, els) => { const el = els && els.find(x => x.datasetIndex === 0); const p = el && this.corrChart.data.datasets[0].data[el.index]; if (p && p.day) this.openAnaDay(p.day); },
            plugins: { legend: { display: false }, tooltip: { filter: (i) => i.datasetIndex === 0, callbacks: { title: (items) => items[0] && items[0].raw.day ? shortDay(items[0].raw.day) : '', label: (cx) => ` ${this._corrLabels[0]} ${this.fmtCorr(this._corrKeys[0], cx.raw.x)} · ${this._corrLabels[1]} ${this.fmtCorr(this._corrKeys[1], cx.raw.y)}` } } }
          }
        });
      }
      this._corrLabels = [lx, ly]; this._corrKeys = [sx.value, sy.value];
      const xs = pts.map(p => p.x);
      const line = c ? [Math.min(...xs), Math.max(...xs)].map(x => ({ x, y: c.intercept + c.slope * x })) : [];
      this.corrChart.data.datasets = [
        { label: 'Day', data: pts, backgroundColor: 'rgba(155,123,255,0.55)', borderColor: VIZ.violet, pointRadius: 3.5, pointHoverRadius: 6, pointBorderWidth: 0 },
        { type: 'line', label: 'Trend', data: line, borderColor: '#f1f4ff', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, hidden: !c || ['none', 'unclear'].includes(words.strength) }
      ];
      this.corrChart.options.scales = {
        x: axis({ type: 'linear', title: { display: true, text: lx, color: INK.muted }, ticks: { color: INK.muted, maxTicksLimit: 7 } }),
        y: axis({ type: 'linear', title: { display: true, text: ly + (lag ? ' (next morning)' : ''), color: INK.muted }, ticks: { color: INK.muted } })
      };
      this.corrChart.update();
    },

    fmtCorr(key, v) {
      if (!Number.isFinite(v)) return '--';
      if (key.startsWith('h:')) return VeloWellness.fmt(key.slice(2) === 'hrv' ? 'hrvRmssd' : key.slice(2), v);
      return key === 't:hours' || key === 't:if' ? v.toFixed(key === 't:if' ? 2 : 1) : String(Math.round(v));
    },

    /** A round step (1, 2, 5 x 10^n) about a quarter of a span, for "per 50 TSS" phrasing. */
    niceStep(span) {
      if (!(span > 0)) return 1;
      const raw = span / 4, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
      return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
    },

    // ------------------------------------------------------------------ polish --
    /** Tile values count up to their new value (from the last shown one; from 0 the first time). */
    countUpTiles(root) {
      if (!root || reducedMotion()) return;
      this._tileVals = this._tileVals || {};
      root.querySelectorAll('.tile').forEach(tile => {
        const val = tile.querySelector('.tile-val');
        const node = val && val.firstChild;
        if (!node || node.nodeType !== 3) return;
        const text = node.textContent.trim();
        const key = (tile.dataset.tile || tile.querySelector('.tile-lbl')?.textContent || '').trim();
        const hm = /^(\d+):(\d{2})$/.exec(text);
        const m = /^-?[\d,]+(\.\d+)?$/.exec(text);
        if (!hm && !m) return;
        const target = hm ? Number(hm[1]) * 60 + Number(hm[2]) : Number(text.replace(/,/g, ''));
        const dec = m && m[1] ? m[1].length - 1 : 0;
        const from = this._tileVals[key] !== undefined ? this._tileVals[key] : 0;
        this._tileVals[key] = target;
        if (from === target) return;
        const t0 = performance.now(), dur = 700;
        const show = (v) => { node.textContent = hm ? `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}` : (dec ? v.toFixed(dec) : Math.round(v).toLocaleString('en-GB').replace(/,/g, text.includes(',') ? ',' : '')); };
        const step = (now) => {
          const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3;
          if (!node.isConnected) return;
          if (k < 1) { show(from + (target - from) * e); requestAnimationFrame(step); } else node.textContent = text;
        };
        requestAnimationFrame(step);
      });
    },

    /** Pin buttons on every expandable chart card; pinned cards move to Overview (up to 4). */
    initAnaPins() {
      const grid = document.getElementById('anaPinnedGrid');
      if (!grid) return;
      document.querySelectorAll('#view-analytics [data-expandable]').forEach(card => {
        const title = card.querySelector('.card-title');
        if (!title || title.querySelector('.ana-pin-btn') || !card.id) return;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ana-pin-btn'; b.title = 'Pin to Overview';
        b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Pin to Overview');
        b.innerHTML = '<svg class="ic"><use href="#i-pin"/></svg>';
        const expand = title.querySelector('.ana-expand-btn');
        expand ? expand.before(b) : title.appendChild(b);
        this.on(b, 'click', () => this.toggleAnaPin(card.id));
      });
      let pins = [];
      try { pins = JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch (e) { /* none */ }
      (Array.isArray(pins) ? pins : []).slice(0, MAX_PINS).forEach(id => this.pinAnaCard(id, false));
      this.updatePinnedRow();
    },

    pinnedIds() { return [...document.querySelectorAll('#anaPinnedGrid > [data-expandable]')].map(c => c.id); },

    toggleAnaPin(id) {
      const pinned = this.pinnedIds();
      if (pinned.includes(id)) this.unpinAnaCard(id);
      else if (pinned.length >= MAX_PINS) { this.showToast(`Up to ${MAX_PINS} charts can be pinned. Unpin one first.`, 'info'); return; }
      else { this.pinAnaCard(id, true); this.showToast('Pinned to Overview.', 'success'); }
      try { localStorage.setItem(PIN_KEY, JSON.stringify(this.pinnedIds())); } catch (e) { /* not kept */ }
      this.updatePinnedRow();
    },

    pinAnaCard(id, resize) {
      const card = document.getElementById(id), grid = document.getElementById('anaPinnedGrid');
      if (!card || !grid || card.closest('#anaPinnedGrid')) return;
      const home = document.createElement('div');
      home.className = 'ana-pin-home'; home.hidden = true; home.dataset.for = id;
      card.before(home);
      grid.appendChild(card);
      card.classList.add('is-pinned');
      const b = card.querySelector('.ana-pin-btn');
      if (b) { b.setAttribute('aria-pressed', 'true'); b.title = 'Unpin from Overview'; b.setAttribute('aria-label', 'Unpin from Overview'); }
      if (resize) requestAnimationFrame(() => this.anaChartsIn(card).forEach(c => c.resize()));
    },

    unpinAnaCard(id) {
      const card = document.getElementById(id), home = document.querySelector(`.ana-pin-home[data-for="${id}"]`);
      if (!card || !home) return;
      home.replaceWith(card);
      card.classList.remove('is-pinned');
      const b = card.querySelector('.ana-pin-btn');
      if (b) { b.setAttribute('aria-pressed', 'false'); b.title = 'Pin to Overview'; b.setAttribute('aria-label', 'Pin to Overview'); }
      requestAnimationFrame(() => this.anaChartsIn(card).forEach(c => c.resize()));
    },

    updatePinnedRow() {
      const box = document.getElementById('anaPinned');
      if (box) box.hidden = !this.pinnedIds().length;
    }
  });
})();
