/**
 * APEX VELO // LAB - AI Coach UI + Workout Architect preview mixin.
 */
(function () {
  const esc = (s) => VeloApp.esc(s);

  /** Tiny, safe markdown renderer for the reasoning trace (escape first, then format). */
  function renderMarkdown(src) {
    const text = String(src || '').replace(/\r/g, '');
    const blocks = [];
    // Fenced code blocks
    let body = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push(highlight(code, lang));
      return `\u0000${blocks.length - 1}\u0000`;
    });
    body = esc(body);
    const inline = (s) => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\b(\d{2,4}\s?W|\d{1,3}%\s?FTP|TSB|CTL|ATL|FTP|VO2\s?max|Z[1-7])\b/g, '<mark>$1</mark>');
    const out = [];
    let list = null;
    body.split('\n').forEach(line => {
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
      const code = line.match(/^\u0000(\d+)\u0000$/);
      if (!li && list) { out.push(`</${list}>`); list = null; }
      if (code) out.push(blocks[Number(code[1])]);
      else if (h) out.push(`<h${Math.min(6, h[1].length + 3)}>${inline(h[2])}</h${Math.min(6, h[1].length + 3)}>`);
      else if (li) {
        const type = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
        if (!list) { list = type; out.push(`<${type}>`); }
        out.push(`<li>${inline(li[1])}</li>`);
      } else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    });
    if (list) out.push(`</${list}>`);
    return out.join('');
  }

  function highlight(code, lang) {
    let h = esc(code);
    if (!lang || /json|js|javascript/i.test(lang)) {
      h = h.replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tk-key">$1</span>$2')
        .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="tk-str">$1</span>')
        .replace(/(?<![#\w])(-?\d+(?:\.\d+)?)\b/g, '<span class="tk-num">$1</span>')
        .replace(/\b(true|false|null)\b/g, '<span class="tk-kw">$1</span>');
    }
    return `<pre class="code"><code>${h}</code></pre>`;
  }

  Object.assign(VeloApp.prototype, {
    initAiCoachUi() {
      const providerSelect = document.getElementById('selectCoachProvider');
      const modelSelect = document.getElementById('selectCoachModel');
      const effortSelect = document.getElementById('selectCoachEffort');
      const lookbackSelect = document.getElementById('selectAiCoachLookback');
      const generateBtn = document.getElementById('btnGenerateAiCoachRecommendation');
      if (providerSelect) providerSelect.value = this.aiCoach.provider;
      this.fillCoachModelOptions();
      if (effortSelect) effortSelect.value = this.aiCoach.effortOverride;
      if (lookbackSelect) {
        lookbackSelect.value = String(this.aiCoach.lookbackDays);
        this.on(lookbackSelect, 'change', () => {
          const d = this.aiCoach.setLookback(lookbackSelect.value);
          this.showToast(`Coach will look back ${d} days.`, 'success');
        });
      }
      // Switching provider applies at once (and resets the model to that provider's default).
      this.on(providerSelect, 'change', () => {
        this.aiCoach.saveConfig({ provider: providerSelect.value, model: '' });
        this.fillCoachModelOptions();
        this.updateCoachEngineStatus();
        const c = this.aiCoach;
        this.showToast(c.isLive ? `Coach switched to ${VeloAiCoach.labelFor(c.model)}.` : `${c.providerLabel} selected, but it is not ready yet - ${VeloAiCoach.setupHint(c.provider)}`, c.isLive ? 'success' : 'warning');
      });
      try { this.coachGoal = localStorage.getItem('apex_coach_goal') || 'ftp'; } catch (e) { /* ignore */ }
      document.querySelectorAll('#aiCoachGoalPills .goal-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.goal === this.coachGoal);
        this.on(p, 'click', () => {
          document.querySelectorAll('#aiCoachGoalPills .goal-pill').forEach(x => x.classList.toggle('active', x === p));
          this.coachGoal = p.dataset.goal;
          try { localStorage.setItem('apex_coach_goal', this.coachGoal); } catch (e) { /* ignore */ }
          this.updateCoachGoButton();
        });
      });

      // One builder for both: a single workout or a multi-week plan.
      this.enhanceChipSelects();
      document.querySelectorAll('#coachModePills [data-coach-mode]').forEach(b => this.on(b, 'click', () => this.setCoachMode(b.dataset.coachMode)));
      const builder = document.getElementById('coachBuilder');
      if (builder) {
        this.on(builder, 'change', () => this.updateCoachGoButton());
        this.on(builder, 'input', () => this.updateCoachGoButton());
        this.on(builder, 'click', (e) => { if (e.target.closest('[data-dow]')) this.updateCoachGoButton(); });
      }
      this.on(document.getElementById('coachPlanToday'), 'click', (e) => {
        const load = e.target.closest('[data-block-load]');
        if (load) this.loadBlockSession(load.dataset.blockLoad);
        else if (e.target.closest('[data-show-plan]')) this.setCoachMode('plan');
      });
      let savedMode = null;
      try { savedMode = localStorage.getItem('apex_coach_mode'); } catch (e) { /* ignore */ }
      this.setCoachMode(savedMode === 'plan' ? 'plan' : 'session', { persist: false });

      this.on(document.getElementById('btnSaveAiCoachConfig'), 'click', () => {
        this.aiCoach.saveConfig({
          provider: providerSelect ? providerSelect.value : this.aiCoach.providerOverride,
          model: modelSelect ? modelSelect.value : '',
          effort: effortSelect ? effortSelect.value : ''
        });
        this.updateCoachEngineStatus();
        const m = this.aiCoach.model;
        this.showToast(`Coach set to ${VeloAiCoach.labelFor(m)}${VeloAiCoach.supportsEffort(m) ? `, ${this.aiCoach.effort} effort` : ''}.`, 'success');
      });
      this.on(document.getElementById('btnRecheckAiEngine'), 'click', () => this.refreshCoachEngine(true));

      this.on(generateBtn, 'click', async () => {
        if (this.coachMode === 'plan') { if (this.buildTrainingBlock) await this.buildTrainingBlock(); return; }
        const focus = document.getElementById('selectAiCoachFocus')?.value || 'auto';
        const durVal = document.getElementById('selectAiCoachDuration')?.value || '45';
        const duration = durVal === 'auto' ? 'auto' : parseInt(durVal, 10);
        const notes = document.getElementById('inputAiCoachNotes')?.value || '';
        const timerEl = document.getElementById('aiCoachThinkTimer');
        generateBtn.disabled = true;
        generateBtn.classList.add('is-loading');
        const t0 = performance.now();
        const label = this.aiCoach.isLive ? `Thinking with ${esc(VeloAiCoach.labelFor(this.aiCoach.model))}` : 'Analysing your history';
        if (timerEl) { timerEl.hidden = false; timerEl.innerHTML = `<span class="spinner"></span>${label}... 0.0 s`; }
        const tick = setInterval(() => { if (timerEl) timerEl.innerHTML = `<span class="spinner"></span>${label}... ${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
        try {
          const rec = await this.aiCoach.generateRecommendation(focus, duration, this.coachGoal, notes);
          this.renderAiCoachRecommendation(rec);
          if (rec.apiError) this.showToast(rec.apiError, 'warning');
          else this.showToast('Prescription ready.', 'success');
          if (timerEl) timerEl.textContent = `Done in ${((rec.elapsedMs || 0) / 1000).toFixed(1)} s`;
        } catch (e) {
          console.error('AI Coach error', e);
          this.showToast('AI Coach error: ' + e.message, 'error');
          if (timerEl) timerEl.hidden = true;
        } finally {
          clearInterval(tick);
          generateBtn.disabled = false;
          generateBtn.classList.remove('is-loading');
        }
      });

      this.on(document.getElementById('btnClearAiCoachRecommendation'), 'click', () => this.clearAiCoachRecommendation());
      this.on(document.getElementById('btnClearAiCoachRecTop'), 'click', () => this.clearAiCoachRecommendation());
      this.on(document.getElementById('btnToggleCoachThoughts'), 'click', () => {
        const content = document.getElementById('aiCoachThoughtsContent');
        if (!content) return;
        const show = content.style.display === 'none';
        content.style.display = show ? 'block' : 'none';
        this.setText('coachThoughtsToggleIcon', show ? 'Hide reasoning' : 'Show reasoning');
      });
      this.on(document.getElementById('btnLoadAiCoachWorkout'), 'click', () => {
        const wk = this.aiCoach.currentRecommendation?.workout;
        if (!wk) return;
        this.loadWorkoutObjectIntoCockpit(wk);
        this.showToast('Prescribed session loaded - press START when ready.', 'success');
      });
      this.on(document.getElementById('btnSaveAiCoachWorkout'), 'click', () => {
        const wk = this.aiCoach.currentRecommendation?.workout;
        if (wk) this.saveWorkoutPermanently(wk);
      });
      this.on(document.getElementById('aiCoachWeekPlan'), 'click', (e) => {
        const b = e.target.closest('[data-plan-focus]');
        if (!b) return;
        const sel = document.getElementById('selectAiCoachFocus');
        const dur = document.getElementById('selectAiCoachDuration');
        if (sel) sel.value = b.dataset.planFocus === 'endurance-long' ? 'endurance' : b.dataset.planFocus;
        if (dur && b.dataset.planMin) {
          const want = parseInt(b.dataset.planMin, 10);
          const opts = Array.from(dur.options).map(o => parseInt(o.value, 10)).filter(Number.isFinite);
          dur.value = String(opts.reduce((a, c) => (Math.abs(c - want) < Math.abs(a - want) ? c : a), opts[0]));
          dur.dispatchEvent(new Event('change', { bubbles: true }));
        }
        this.setCoachMode('session');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        this.showToast("Request updated from the outlook - press Prescribe today's workout.");
      });

      this.updateCoachEngineStatus();
      if (this.initTrainingBlockUi) this.initTrainingBlockUi();
      this.refreshCoachEngine(false);
    },

    /** Fills the model list for the chosen provider ("Default" = the server's default for that provider). */
    fillCoachModelOptions() {
      const sel = document.getElementById('selectCoachModel');
      if (!sel) return;
      const c = this.aiCoach;
      const p = c.provider;
      const ep = c.engine.providers && c.engine.providers[p];
      const def = (ep && ep.model) || VeloAiCoach.PROVIDERS[p].defaultModel;
      const opts = [`<option value="">Default (${esc(VeloAiCoach.labelFor(def))})</option>`]
        .concat(VeloAiCoach.modelsFor(p).map(id => `<option value="${esc(id)}">${esc(VeloAiCoach.labelFor(id))}</option>`));
      sel.innerHTML = opts.join('');
      sel.value = c.modelOverride && VeloAiCoach.providerOf(c.modelOverride) === p ? c.modelOverride : '';
    },

    /** Re-reads the local server's status (which keys are present, default models) and updates the UI. */
    async refreshCoachEngine(announce) {
      await this.aiCoach.detectEngine(3000, !!announce);  // "Re-check server" also re-reads every provider's model list
      const providerSelect = document.getElementById('selectCoachProvider');
      if (providerSelect) providerSelect.value = this.aiCoach.provider;
      this.fillCoachModelOptions();
      this.updateCoachEngineStatus();
      if (!announce) return;
      const c = this.aiCoach;
      if (c.isLive) this.showToast(`${c.providerLabel} ready - ${VeloAiCoach.labelFor(c.model)}.`, 'success');
      else if (c.engine.reachable) this.showToast(`Server found, but ${c.providerLabel} is not ready yet. ${VeloAiCoach.setupHint(c.provider)}`, 'warning');
      else this.showToast(`Local server not running - open the app with Launch-Apex-Velo.bat to use ${c.providerLabel}.`, 'warning');
    },

    /** Turns each <select data-chips> into a row of tappable chips; the select stays the source of truth. */
    enhanceChipSelects() {
      document.querySelectorAll('select[data-chips]').forEach(sel => {
        if (sel.dataset.chipsReady) return;
        sel.dataset.chipsReady = '1';
        sel.classList.add('sr-only');
        sel.tabIndex = -1;
        const row = document.createElement('div');
        row.className = 'chip-select';
        row.setAttribute('role', 'radiogroup');
        if (sel.getAttribute('aria-labelledby')) row.setAttribute('aria-labelledby', sel.getAttribute('aria-labelledby'));
        row.innerHTML = Array.from(sel.options).map(o => `<button type="button" role="radio" data-value="${esc(o.value)}" title="${esc(o.textContent)}">${esc(o.dataset.chip || o.textContent)}</button>`).join('');
        const sync = () => row.querySelectorAll('button').forEach(b => {
          const on = b.dataset.value === sel.value;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        this.on(row, 'click', (e) => {
          const b = e.target.closest('button[data-value]');
          if (!b || b.dataset.value === sel.value) return;
          sel.value = b.dataset.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        this.on(sel, 'change', sync);
        sel.insertAdjacentElement('afterend', row);
        sync();
      });
    },

    /** Switches the builder between one workout ('session') and a multi-week plan ('plan'). */
    setCoachMode(mode, { persist = true } = {}) {
      this.coachMode = mode === 'plan' ? 'plan' : 'session';
      const view = document.getElementById('view-ai-coach');
      if (view) view.dataset.coachMode = this.coachMode;
      document.querySelectorAll('#coachModePills [data-coach-mode]').forEach(b => {
        const on = b.dataset.coachMode === this.coachMode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      this.setText('coachBuilderChip', this.coachMode === 'plan' ? 'Training plan' : 'One workout');
      const notes = document.getElementById('inputAiCoachNotes');
      if (notes) notes.placeholder = this.coachMode === 'plan' ? 'e.g. gran fondo in 10 weeks, no rides on Friday' : 'e.g. legs heavy after yesterday, want low cadence work';
      if (persist) try { localStorage.setItem('apex_coach_mode', this.coachMode); } catch (e) { /* ignore */ }
      this.updateCoachGoButton();
      this.renderCoachPlanToday();
    },

    /** One action button: its label and a one-line summary of what will be built follow the form. */
    updateCoachGoButton() {
      const c = this.aiCoach;
      if (!c) return;
      const val = (id) => (document.getElementById(id) || {}).value || '';
      const goal = (VeloAiCoach.GOALS[this.coachGoal] || VeloAiCoach.GOALS.ftp).label;
      const engine = c.isLive ? VeloAiCoach.labelFor(c.model) : 'built-in engine';
      const hint = document.getElementById('coachGoHint');
      if (this.coachMode === 'plan') {
        const weeks = parseInt(val('selectBlockWeeks') || '8', 10);
        const days = document.querySelectorAll('#blockDays [data-dow].active').length;
        const hours = val('inputBlockHours').trim();
        const existing = this.blockPlanner && this.blockPlanner.block;
        this.setText('coachGoLabel', existing ? `Build new ${weeks}-week plan` : `Build ${weeks}-week plan`);
        if (hint) hint.textContent = `${goal} · ${days} ride day${days === 1 ? '' : 's'} a week · ${hours ? `up to ${hours} h` : 'coach picks the hours'} · ${engine}${existing ? ' · replaces your current plan' : ''}`;
      } else {
        const focusSel = document.getElementById('selectAiCoachFocus');
        const focus = focusSel && focusSel.value !== 'auto' ? focusSel.options[focusSel.selectedIndex].textContent.split(' (')[0] : 'Auto focus';
        const dur = val('selectAiCoachDuration');
        this.setText('coachGoLabel', "Prescribe today's workout");
        if (hint) hint.textContent = `${goal} · ${focus} · ${dur === 'auto' ? 'coach picks the length' : `${dur} min`} · ${engine}`;
      }
    },

    /** In workout mode, a strip for today's session from the active plan (load it, or prescribe something else). */
    renderCoachPlanToday() {
      const el = document.getElementById('coachPlanToday');
      if (!el) return;
      const bp = this.blockPlanner;
      const today = bp && bp.block ? VeloBlockPlanner.today() : null;
      const s = today ? (bp.sessionsByDate().get(today) || []).find(x => x.status === 'planned') : null;
      if (!bp || !bp.block || this.coachMode !== 'session') { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = s
        ? `<svg class="ic"><use href="#i-calendar"/></svg><div><small>Today in your plan</small><b>${esc(s.title)}</b> <span class="num">${s.durationMin} min</span></div>
           <div class="btn-row btn-row-tight"><button type="button" class="btn btn-sm btn-primary" data-block-load="${esc(s.id)}"><svg class="ic"><use href="#i-play"/></svg>Load</button><button type="button" class="btn btn-sm" data-show-plan>View plan</button></div>`
        : `<svg class="ic"><use href="#i-calendar"/></svg><div><small>Your plan</small><b>Nothing scheduled today</b></div><div class="btn-row btn-row-tight"><button type="button" class="btn btn-sm" data-show-plan>View plan</button></div>`;
    },

    updateCoachEngineStatus() {
      if (this.updateAskEngine) this.updateAskEngine();
      if (this.updateDescribeEngine) this.updateDescribeEngine();
      this.updateCoachGoButton();
      const el = document.getElementById('aiCoachEngineStatus');
      const detail = document.getElementById('aiCoachEngineDetail');
      const c = this.aiCoach;
      const m = c.model;
      const pLabel = c.providerLabel;
      const modelText = `${VeloAiCoach.labelFor(m)}${VeloAiCoach.supportsEffort(m) ? ` - ${c.effort} effort` : ''}`;
      const state = c.isLive ? 'live' : c.engine.reachable ? 'warn' : '';
      if (el) {
        el.className = `engine-pill ${state}`;
        el.innerHTML = `<span class="status-indicator-dot"></span>${c.isLive ? esc(modelText) : c.engine.reachable ? `${esc(pLabel)}: ${VeloAiCoach.missingLabel(c.provider)}` : 'Offline physiology engine'}`;
      }
      if (detail) {
        const keys = Object.entries(c.engine.providers || {})
          .map(([id, p]) => `${esc(p.label)} ${VeloAiCoach.PROVIDERS[id] && VeloAiCoach.PROVIDERS[id].local ? (p.configured ? 'found' : 'not found') : (p.configured ? 'key found' : 'no key')}`).join(' &middot; ');
        detail.innerHTML = c.isLive
          ? `<strong>Connected.</strong> Requests go to ${esc(modelText)} through the local server. <span style="opacity:.7">(${keys})</span>`
          : c.engine.reachable
            ? (VeloAiCoach.PROVIDERS[c.provider].local
              ? `<strong>Claude Code not found.</strong> Install Claude Code, sign in once by running <code>claude</code> in a terminal, then restart <code>Launch-Apex-Velo.bat</code>. It answers with your Claude subscription, no API key needed. <span style="opacity:.7">(${keys})</span>`
              : `<strong>No ${esc(pLabel)} API key.</strong> Paste your key after <code>${VeloAiCoach.PROVIDERS[c.provider].keyName}=</code> in the <code>.env</code> file, then restart <code>Launch-Apex-Velo.bat</code>. <span style="opacity:.7">(${keys})</span>`)
            : '<strong>Local server not running.</strong> Open the app with <code>Launch-Apex-Velo.bat</code> (it serves the app and holds your keys). Until then the offline engine is used.';
      }
    },

    clearAiCoachRecommendation() {
      if (this.aiCoach) this.aiCoach.clearRecommendation();
      const panel = document.getElementById('aiCoachResultPanel');
      const welcome = document.getElementById('aiCoachWelcomeCard');
      if (panel) panel.style.display = 'none';
      if (welcome) welcome.style.display = 'block';
      ['aiCoachIntervalTableBody', 'aiCoachPhaseCards', 'aiCoachWeekPlan'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
      const canvas = document.getElementById('aiCoachIntervalCanvas');
      if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      const wrap = document.getElementById('aiCoachThinkingWrap');
      const content = document.getElementById('aiCoachThoughtsContent');
      if (wrap) wrap.style.display = 'none';
      if (content) { content.innerHTML = ''; content.style.display = 'none'; }
      this.setText('coachThoughtsToggleIcon', 'Show reasoning');
      const timer = document.getElementById('aiCoachThinkTimer');
      if (timer) timer.hidden = true;
      this.showToast('Recommendation cleared. Ready for a new prompt.');
    },

    updateAiCoachTelemetry() {
      const profile = this.activeProfile;
      const pmc = this.analytics.calculatePmcHistory(this.completedWorkouts, 0, this.pmcOpts());
      this.setText('aiCoachFtpVal', `${profile.ftp}W`);
      this.setText('aiCoachCtlVal', pmc.currentCtl.toFixed(1));
      this.setText('aiCoachAtlVal', pmc.currentAtl.toFixed(1));
      const tsbEl = document.getElementById('aiCoachTsbVal');
      if (tsbEl) {
        tsbEl.textContent = `${pmc.currentTsb > 0 ? '+' : ''}${pmc.currentTsb.toFixed(1)}`;
        tsbEl.dataset.form = VeloMetrics.formZone(pmc.currentTsb).key;
      }
      const since = Date.now() - 7 * 86400000;
      const tss7 = Math.round(this.cyclingRides().filter(w => new Date(w.date).getTime() >= since).reduce((s, w) => s + (w.tss || 0), 0));
      this.setText('aiCoach7DayTssVal', `${tss7} TSS`);

      const h = VeloProgress.coachProfile(this.cyclingRides(), profile.ftp);
      const ins = document.getElementById('aiCoachInsights');
      if (ins) {
        const chip = (label, val) => `<span class="insight"><small>${label}</small><b class="num">${val}</b></span>`;
        ins.innerHTML = [
          chip('Form', VeloMetrics.formZone(pmc.currentTsb).label),
          chip('4-week volume', `${h.hoursPerWeek4w} h/wk`),
          chip('Rides (28 d)', h.rides28),
          chip('Easy / mid / hard', h.lowIntensityPct === null ? 'n/a' : `${h.lowIntensityPct}/${h.midIntensityPct}/${h.highIntensityPct}%`),
          chip('Last hard ride', h.daysSinceHard === null ? 'none' : `${h.daysSinceHard} d ago`),
          chip('Last 90+ min ride', h.daysSinceLong === null ? 'none' : `${h.daysSinceLong} d ago`),
          h.profileType ? chip('Power profile', h.profileType.split(' [')[0]) : ''
        ].join('');
      }
      this.updateCoachEngineStatus();
    },

    /** "The science behind this": plain-language findings, their evidence grade and the source study. */
    evidenceHtml(list) {
      const S = typeof VeloSportScience !== 'undefined' ? VeloSportScience : null;
      const items = (Array.isArray(list) ? list : []).map(e => {
        const full = S && e.ref ? S.REFERENCES[e.ref] || '' : '';
        const grade = e.grade && S ? `<span class="chip chip-ghost chip-xs" title="Evidence grade ${esc(e.grade)}: ${esc(S.GRADES[e.grade] || '')}">Grade ${esc(e.grade)}</span>` : '';
        const ref = e.ref ? `<small class="evidence-ref" title="${esc(full)}">${esc(e.ref)}</small>` : '';
        return `<li><b>${esc(e.principle)}</b> ${grade}<span class="evidence-why">${esc(e.why)}</span>${ref}</li>`;
      }).join('');
      if (!items) return '';
      const foot = S ? `<p class="evidence-foot">Evidence base reviewed ${esc(S.REVIEWED)}. Grade A: ${esc(S.GRADES.A)}; B: ${esc(S.GRADES.B)}; C: ${esc(S.GRADES.C)}. Hover a source for the full reference.</p>` : '';
      return `<ul class="evidence-list">${items}</ul>${foot}`;
    },

    renderAiCoachRecommendation(rec) {
      if (!rec || !rec.workout) return;
      const panel = document.getElementById('aiCoachResultPanel');
      const welcome = document.getElementById('aiCoachWelcomeCard');
      if (!panel) return;
      panel.style.display = 'block';
      if (welcome) welcome.style.display = 'none';
      const a = rec.coachAssessment || {};
      const wk = rec.workout;

      const badge = document.getElementById('aiCoachFormBadge');
      if (badge) {
        const zone = String(a.formZone || 'Productive');
        const key = /fresh/i.test(zone) ? 'fresh' : /optimal/i.test(zone) ? 'optimal' : /overtrain|overreach/i.test(zone) ? 'overtraining' : /fatigue/i.test(zone) ? 'fatigue' : 'productive';
        badge.textContent = zone;
        badge.className = `ai-coach-status-badge form-badge form-${key}`;
      }
      const src = document.getElementById('aiCoachSourceBadge');
      if (src) {
        const goal = VeloAiCoach.GOALS[rec.goal] ? VeloAiCoach.GOALS[rec.goal].label : '';
        const who = rec.source && rec.source !== 'offline_heuristic' ? (rec.modelLabel || VeloAiCoach.labelFor(rec.model)) : 'Offline engine';
        src.textContent = `${who}${goal ? ' - ' + goal : ''}${rec.lookbackDays ? ` - ${rec.lookbackDays} d history` : ''}`;
      }
      this.setText('aiCoachDiagnosisText', a.fitnessDiagnosis || '--');
      this.setText('aiCoachFatigueText', a.fatigueStatus || '--');
      this.setText('aiCoachAdviceText', a.trainingAdvice || '--');
      const evBox = document.getElementById('aiCoachEvidence');
      const evList = document.getElementById('aiCoachEvidenceList');
      if (evBox && evList) {
        const html = this.evidenceHtml(rec.evidence);
        evList.innerHTML = html;
        evBox.hidden = !html;
      }

      const wrap = document.getElementById('aiCoachThinkingWrap');
      const content = document.getElementById('aiCoachThoughtsContent');
      if (wrap && content) {
        if (rec.coachThoughts) {
          wrap.style.display = 'block';
          content.innerHTML = renderMarkdown(rec.coachThoughts);
          content.style.display = 'none';
          this.setText('coachThoughtsToggleIcon', 'Show reasoning');
          const words = rec.coachThoughts.split(/\s+/).length;
          this.setText('aiCoachThoughtMeta', `${((rec.elapsedMs || 0) / 1000).toFixed(1)} s - ${words} words - ${rec.thinkingLevel || 'thinking'}`);
        } else {
          wrap.style.display = 'none';
          content.innerHTML = '';
        }
      }

      this.setText('aiCoachWorkoutTitle', wk.title);
      this.setText('aiCoachWorkoutDesc', wk.desc || '');
      this.setText('aiCoachWorkoutDur', `${wk.durationMin} min`);
      this.setText('aiCoachWorkoutTss', `${wk.tss} TSS`);
      this.setText('aiCoachWorkoutIf', `${wk.if} IF`);
      this.renderAiCoachWorkoutCanvas(wk);
      this.renderPhaseCards(wk);

      const tbody = document.getElementById('aiCoachIntervalTableBody');
      if (tbody) {
        const ftp = this.activeProfile.ftp || 185;
        tbody.innerHTML = wk.intervals.map((iv, i) => {
          const z = VeloMetrics.zoneForPct(iv.pctFtp);
          return `<tr><td class="num">${i + 1}</td><td><b>${esc(iv.name)}</b></td><td><span class="zone-dot" style="--zc:${z.color}"></span><span class="num">${iv.pctFtp}% FTP</span> <small>${z.short}</small></td><td class="num strong">${Math.round(ftp * iv.pctFtp / 100)}W</td><td class="num">${iv.cadence || this.getCurrentTargetCadence(iv)} RPM</td><td class="num">${this.fmtTime(iv.duration)}</td></tr>`;
        }).join('');
      }
      this.renderWeekPlan(rec.weekPlan);
    },

    /** Groups the prescription into warm-up / main set / recovery / cool-down cards with zone time. */
    renderPhaseCards(wk) {
      const el = document.getElementById('aiCoachPhaseCards');
      if (!el) return;
      const ivs = wk.intervals;
      const phaseOf = (iv, i) => {
        const n = (iv.name || '').toLowerCase();
        if (i === 0 || n.includes('warm') || n.includes('opener')) return 'Warm-up';
        if (i === ivs.length - 1 || n.includes('cool')) return 'Cool-down';
        if (iv.pctFtp <= 60) return 'Recovery';
        return 'Main set';
      };
      const groups = {};
      ivs.forEach((iv, i) => {
        const p = phaseOf(iv, i);
        const g = groups[p] || (groups[p] = { sec: 0, steps: 0, maxPct: 0, zoneSec: {} });
        g.sec += iv.duration; g.steps++; g.maxPct = Math.max(g.maxPct, iv.pctFtp);
        const z = VeloMetrics.zoneForPct(iv.pctFtp);
        g.zoneSec[z.short] = (g.zoneSec[z.short] || 0) + iv.duration;
      });
      const total = ivs.reduce((a, b) => a + b.duration, 0) || 1;
      el.innerHTML = ['Warm-up', 'Main set', 'Recovery', 'Cool-down'].filter(p => groups[p]).map(p => {
        const g = groups[p];
        const zones = Object.entries(g.zoneSec).sort((a, b) => b[1] - a[1]).map(([z, s]) => `<span class="zone-chip zone-${z.toLowerCase()}">${z} ${this.fmtTime(s)}</span>`).join('');
        return `<div class="phase-card"><div class="phase-head"><b>${p}</b><span class="num">${this.fmtTime(g.sec)} - ${Math.round((g.sec / total) * 100)}%</span></div>
          <div class="phase-meta num">${g.steps} step${g.steps === 1 ? '' : 's'} - peak ${g.maxPct}% (${Math.round(this.activeProfile.ftp * g.maxPct / 100)} W)</div><div class="phase-zones">${zones}</div></div>`;
      }).join('');
    },

    renderWeekPlan(plan) {
      const el = document.getElementById('aiCoachWeekPlan');
      if (!el) return;
      if (!plan || !Array.isArray(plan.days) || !plan.days.length) { el.innerHTML = '<div class="mix-note">No weekly outlook.</div>'; this.setText('aiCoachWeekTss', '--'); return; }
      const total = plan.days.reduce((a, d) => a + (Number(d.tss) || 0), 0);
      this.setText('aiCoachWeekTss', `${Math.round(total)} TSS${plan.ramp !== undefined ? ` - CTL ramp +${plan.ramp}/wk` : ''}`);
      const maxT = Math.max(1, ...plan.days.map(d => Number(d.tss) || 0));
      const colorFor = { recovery: '#7c8aa5', endurance: '#3b82f6', 'endurance-long': '#3b82f6', sweetspot: '#eab308', threshold: '#f97316', vo2max: '#ef4444', vo2: '#ef4444', off: '#334155' };
      el.innerHTML = plan.days.slice(0, 7).map((d, i) => {
        const off = d.focus === 'off' || !d.durationMin;
        return `<button type="button" class="plan-day ${i === 0 ? 'today' : ''} ${off ? 'off' : ''}" ${off ? '' : `data-plan-focus="${esc(d.focus)}" data-plan-min="${Number(d.durationMin) || 45}"`} title="${off ? 'Rest day' : 'Use this as the next request'}">
          <span class="plan-dow">${esc(d.dayLabel || '')}</span>
          <span class="plan-bar"><span style="height:${Math.max(4, ((Number(d.tss) || 0) / maxT) * 100)}%;background:${colorFor[d.focus] || '#64748b'}"></span></span>
          <b class="plan-title">${esc(d.title || d.focus)}</b>
          <span class="plan-meta num">${off ? 'Rest' : `${Math.round(Number(d.durationMin)) || 0} min - ${Math.round(Number(d.tss) || 0)} TSS`}</span>
        </button>`;
      }).join('');
    },

    renderAiCoachWorkoutCanvas(workout) {
      const canvas = document.getElementById('aiCoachIntervalCanvas');
      if (canvas) this.drawMiniProfile(canvas, workout.intervals || [], { width: 600, height: 150 });
    }
  });

  if (typeof window !== 'undefined') window.VeloMarkdown = { render: renderMarkdown };
})();
