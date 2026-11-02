/**
 * APEX VELO // LAB - "Describe a workout" box on the Workouts tab (mixin on VeloApp).
 *
 * The rider types the session they want; the AI engine builds it from that request and the FTP only
 * (js/velo-describe.js). The result shows as a workout card to ride, save to the library or rebuild.
 */
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TIMEOUT_MS = 180000;

  Object.assign(VeloApp.prototype, {
    initDescribeUi() {
      const input = document.getElementById('describeInput');
      if (!input) return;
      this.on(document.getElementById('btnDescribeCreate'), 'click', () => this.createDescribedWorkout());
      this.on(input, 'keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.createDescribedWorkout(); } });
      document.querySelectorAll('#describeExamples [data-example]').forEach(b => this.on(b, 'click', () => { input.value = b.dataset.example; input.focus(); }));
      this.on(document.getElementById('describeResult'), 'click', (e) => {
        const act = e.target.closest('[data-describe]');
        const w = this._describedWorkout;
        if (!act || !w) return;
        if (act.dataset.describe === 'ride') this.loadWorkoutObjectIntoCockpit(w);
        else if (act.dataset.describe === 'save') { this.saveWorkoutPermanently(w); act.disabled = true; act.textContent = 'Saved'; }
        else if (act.dataset.describe === 'again') this.createDescribedWorkout();
        else if (act.dataset.describe === 'settings' && this.openSettings) this.openSettings('ai');
      });
      this.updateDescribeEngine();
    },

    /** The model line under the box (the coach's provider and model are used). */
    updateDescribeEngine() {
      const el = document.getElementById('describeEngine');
      const c = this.aiCoach;
      if (!el || !c) return;
      el.textContent = c.isLive
        ? `${VeloAiCoach.labelFor(c.model)} · only your request and FTP are sent, no ride history`
        : 'Needs an AI API key or Claude Code (Settings > AI engine). Only your request and FTP are sent, no ride history.';
    },

    async createDescribedWorkout() {
      const input = document.getElementById('describeInput');
      const out = document.getElementById('describeResult');
      const btn = document.getElementById('btnDescribeCreate');
      const request = (input && input.value || '').trim();
      if (!out || this._describeBusy) return;
      if (request.length < 3) { this.showToast('Describe the workout you want first.', 'warning'); if (input) input.focus(); return; }
      const c = this.aiCoach;
      if (!c.isLive) await c.detectEngine();
      this.updateDescribeEngine();
      if (!c.isLive) {
        out.innerHTML = `<div class="describe-note">Building a workout from a description needs an AI API key or Claude Code. <button type="button" class="link-btn" data-describe="settings">Open Settings &gt; AI engine</button></div>`;
        return;
      }
      this._describeBusy = true;
      if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
      out.innerHTML = '<div class="describe-note"><span class="spinner"></span> Building your workout...</div>';
      const model = c.model;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(VeloAiCoach.COACH_URL, {
          method: 'POST', cache: 'no-store', signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          // Low effort: the request already says what to build, so speed matters more than deep reasoning.
          body: JSON.stringify({ prompt: VeloDescribe.buildPrompt(request, this.activeProfile.ftp), provider: c.provider, model, effort: VeloAiCoach.supportsEffort(model) ? 'low' : null })
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error || `${VeloAiCoach.labelFor(model)} answered ${resp.status}`);
        if (json.stopReason === 'max_tokens') throw new Error('the answer was cut off; try a shorter description');
        const workout = VeloDescribe.toWorkout(json.text, VeloAiCoach.estimateLoad);
        workout.request = request;
        this._describedWorkout = workout;
        this.renderDescribedWorkout();
      } catch (e) {
        const msg = ac.signal.aborted ? 'No answer after 3 minutes. Try again.' : `Could not build the workout: ${e.message}`;
        out.innerHTML = `<div class="describe-note describe-error">${esc(msg)}</div>`;
      } finally {
        clearTimeout(timer);
        this._describeBusy = false;
        if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); }
      }
    },

    renderDescribedWorkout() {
      const out = document.getElementById('describeResult');
      const w = this._describedWorkout;
      if (!out || !w) return;
      const ftp = this.activeProfile.ftp;
      const maxPct = Math.max(...w.intervals.map(i => i.pctFtp || 0));
      out.innerHTML = `
        <article class="workout-preset-card describe-card">
          <div class="w-card-tags"><span class="w-card-tag tag-ai">AI · YOUR REQUEST</span></div>
          <div class="w-card-title">${esc(w.title)}</div>
          <canvas class="w-card-profile"></canvas>
          <div class="w-card-desc">${esc(w.desc)}</div>
          <div class="w-card-footer">
            <div class="w-card-meta num"><span><b>${w.durationMin}</b>m</span><span><b>${w.tss}</b> TSS</span><span>IF <b>${w.if}</b></span><span>peak <b>${Math.round(ftp * maxPct / 100)}</b>W</span></div>
            <div class="btn-row btn-row-tight">
              <button type="button" class="btn btn-sm btn-ghost" data-describe="again">Try again</button>
              <button type="button" class="btn btn-sm" data-describe="save">Save</button>
              <button type="button" class="btn btn-sm btn-primary" data-describe="ride">Ride</button>
            </div>
          </div>
        </article>`;
      const canvas = out.querySelector('canvas');
      if (canvas) requestAnimationFrame(() => this.drawMiniProfile(canvas, w.intervals));
    }
  });
})();
