/**
 * APEX VELO // LAB - AI Cycling Coach.
 *
 * Goal-driven prescriptions (Raise FTP, Longevity / aerobic durability, VO2 max,
 * Balanced) built from the rider's real history: Banister PMC (CTL/ATL/TSB),
 * last 7 days plus a chosen look-back window (7-90 days) of load, volume and
 * intensity mix, recency of hard and long rides, and the power-duration profile.
 *
 * When the app is served by the local server and it has an API key for the chosen
 * provider (Claude, Gemini or ChatGPT) - or a signed-in Claude Code on this PC - the context is sent through the local /api/coach
 * endpoint (keys never reach the browser) and the summarized reasoning is shown.
 * Without the server or a key - or if the call fails - the built-in physiology
 * engine produces an equivalent, fully deterministic plan.
 *
 * Both paths follow the graded research in VeloSportScience: the AI gets an evidence brief
 * for the goal and rider and may cite only its references; the offline engine applies the
 * same findings and shows them as "The science behind this".
 */
class VeloAiCoach {
  static GOALS = {
    ftp:       { label: 'Raise FTP',  ctlRampPerWeek: 4, summary: 'Progressive threshold and SweetSpot overload on an aerobic base.' },
    longevity: { label: 'Longevity',  ctlRampPerWeek: 3, summary: 'Cardiorespiratory fitness and durability: mostly Zone 2 volume, one short VO2 session (4 x 4 min) a week and strength work.' },
    vo2:       { label: 'VO2 max',    ctlRampPerWeek: 3, summary: 'Raise the aerobic ceiling with 30/15s and 3-5 min efforts at 106-120% FTP.' },
    balanced:  { label: 'Balanced',   ctlRampPerWeek: 3, summary: 'Polarised mix: ~80% easy, ~20% hard, touching every energy system.' }
  };

  static DEFAULT_MODEL = 'claude-opus-5-5';
  static DEFAULT_EFFORT = 'low';
  static PROVIDERS = {
    claude: { label: 'Claude', keyName: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5' },
    gemini: { label: 'Gemini', keyName: 'GEMINI_API_KEY', defaultModel: 'gemini-3.8-flash' },
    openai: { label: 'ChatGPT', keyName: 'OPENAI_API_KEY', defaultModel: 'gpt-6.1-sol' },
    'claude-code': { label: 'Claude Code', keyName: null, defaultModel: 'claude-code-opus', local: true }
  };
  /** Live model list from the local server ({ id: { label, provider, effort } }); fills the pickers once detected. */
  static SERVER_MODELS = {};
  static MODEL_LABELS = {
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (preview)',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
    'gpt-6.1-sol': 'GPT-6.1 Sol',
    'claude-code-opus': 'Opus (Claude Code)',
    'claude-code-sonnet': 'Sonnet (Claude Code)',
    'claude-code-haiku': 'Haiku (Claude Code)'
  };
  /** Look-back choices (days) for the history sent to the coach, and the cap on individually listed rides. */
  static LOOKBACK_OPTIONS = [7, 14, 28, 42, 90];
  static DEFAULT_LOOKBACK = 28;
  static MAX_LISTED_RIDES = 30;
  static STATUS_URL = 'api/coach/status';
  static COACH_URL = 'api/coach';

  constructor(app) {
    this.app = app;
    // Status of the local AI proxy (start_server.ps1 / server.js); filled by detectEngine().
    this.engine = VeloAiCoach.offlineEngine();
    // Per-browser overrides; empty = use the server's default from .env.
    this.providerOverride = '';
    this.modelOverride = '';
    this.effortOverride = '';
    this.lookbackDays = VeloAiCoach.DEFAULT_LOOKBACK;
    try {
      this.providerOverride = localStorage.getItem('apex_coach_provider') || '';
      this.modelOverride = localStorage.getItem('apex_coach_model') || localStorage.getItem('apex_claude_model') || '';
      if (this.modelOverride === 'claude-sonnet-5') this.modelOverride = 'claude-sonnet-5-5'; // renamed model
      this.effortOverride = localStorage.getItem('apex_coach_effort') || localStorage.getItem('apex_claude_effort') || '';
      const lb = parseInt(localStorage.getItem('apex_coach_lookback_days') || '', 10);
      if (VeloAiCoach.LOOKBACK_OPTIONS.includes(lb)) this.lookbackDays = lb;
      // Keys are never kept in the browser: remove anything an old version stored.
      localStorage.removeItem('apex_gemini_api_key');
      localStorage.removeItem('apex_gemini_model');
    } catch (e) { /* storage unavailable */ }
    if (!VeloAiCoach.PROVIDERS[this.providerOverride]) this.providerOverride = '';
    // Models now come from the server's live list, so any saved id is kept; the server falls back if it is gone.
    if (typeof this.modelOverride !== 'string') this.modelOverride = '';
    this.currentRecommendation = null;
  }

  static offlineEngine() {
    const providers = {};
    for (const [id, p] of Object.entries(VeloAiCoach.PROVIDERS)) providers[id] = { label: p.label, configured: false, model: p.defaultModel };
    return { reachable: false, provider: 'claude', providers, model: VeloAiCoach.DEFAULT_MODEL, effort: VeloAiCoach.DEFAULT_EFFORT, models: [], efforts: ['low', 'medium', 'high'] };
  }

  static providerOf(model) {
    const sm = VeloAiCoach.SERVER_MODELS[model];
    if (sm && VeloAiCoach.PROVIDERS[sm.provider]) return sm.provider;
    if (/^claude-code-/i.test(model || '')) return 'claude-code';
    if (/^gemini/i.test(model || '')) return 'gemini';
    if (/^(gpt|o\d|chatgpt)/i.test(model || '')) return 'openai';
    return 'claude';
  }

  /** Provider, model and effort that will be used for the next request. */
  get provider() {
    if (this.providerOverride) return this.providerOverride;
    if (this.modelOverride) return VeloAiCoach.providerOf(this.modelOverride);
    return VeloAiCoach.PROVIDERS[this.engine.provider] ? this.engine.provider : 'claude';
  }
  get model() {
    const p = this.provider;
    if (this.modelOverride && VeloAiCoach.providerOf(this.modelOverride) === p) return this.modelOverride;
    const ep = this.engine.providers && this.engine.providers[p];
    return (ep && ep.model) || VeloAiCoach.PROVIDERS[p].defaultModel;
  }
  get effort() { return this.effortOverride || this.engine.effort || VeloAiCoach.DEFAULT_EFFORT; }
  get providerLabel() { return VeloAiCoach.PROVIDERS[this.provider].label; }
  /** True when the server is up and has a key for the chosen provider. */
  get isLive() {
    const ep = this.engine.providers && this.engine.providers[this.provider];
    return !!(this.engine.reachable && ep && ep.configured);
  }
  static labelFor(model) {
    const sm = VeloAiCoach.SERVER_MODELS[model];
    return (sm && sm.label) || VeloAiCoach.MODEL_LABELS[model] || model;
  }
  /** What is missing for a provider, in a sentence: an API key in .env, or Claude Code on this PC. */
  static setupHint(provider) {
    const p = VeloAiCoach.PROVIDERS[provider] || VeloAiCoach.PROVIDERS.claude;
    return p.local
      ? 'Install Claude Code, sign in once by running "claude" in a terminal, then restart Launch-Apex-Velo.bat.'
      : `Add ${p.keyName} to the .env file and restart Launch-Apex-Velo.bat.`;
  }
  /** Short state of a provider for status lines ("key found" / "ready"). */
  static missingLabel(provider) {
    return VeloAiCoach.PROVIDERS[provider] && VeloAiCoach.PROVIDERS[provider].local ? 'not found' : 'API key missing';
  }
  static supportsEffort(model) {
    const sm = VeloAiCoach.SERVER_MODELS[model];
    return sm ? !!sm.effort : !/haiku/i.test(model);
  }
  /** The server's live list for a provider (newest first), or the built-in list when the server is offline. */
  static modelsFor(provider) {
    const live = Object.keys(VeloAiCoach.SERVER_MODELS).filter(m => VeloAiCoach.SERVER_MODELS[m].provider === provider);
    return live.length ? live : Object.keys(VeloAiCoach.MODEL_LABELS).filter(m => VeloAiCoach.providerOf(m) === provider);
  }

  /** Asks the local server which providers have keys. Never throws. */
  async detectEngine(timeoutMs = 3000, refresh = false) {
    if (refresh) timeoutMs = Math.max(timeoutMs, 15000);
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const resp = await fetch(VeloAiCoach.STATUS_URL + (refresh ? '?refresh=1' : ''), { cache: 'no-store', signal: ac ? ac.signal : undefined });
      const json = resp.ok ? await resp.json() : null;
      if (json && (json.providers || json.provider === 'claude')) {
        const providers = VeloAiCoach.offlineEngine().providers;
        if (json.providers) {
          for (const id of Object.keys(providers)) {
            const sp = json.providers[id];
            if (sp) providers[id] = { label: sp.label || providers[id].label, configured: !!sp.configured, model: sp.model || providers[id].model };
          }
        } else {
          // Older server (Claude only).
          providers.claude = { ...providers.claude, configured: !!json.configured, model: json.model || providers.claude.model };
        }
        const sm = {};
        for (const m of (Array.isArray(json.models) ? json.models : [])) if (m && m.id) sm[m.id] = { label: m.label || m.id, provider: m.provider, effort: m.effort !== false };
        VeloAiCoach.SERVER_MODELS = sm;
        this.engine = {
          reachable: true,
          provider: VeloAiCoach.PROVIDERS[json.provider] ? json.provider : 'claude',
          providers,
          model: json.model || VeloAiCoach.DEFAULT_MODEL,
          effort: json.effort || VeloAiCoach.DEFAULT_EFFORT,
          models: Array.isArray(json.models) ? json.models : [],
          catalog: json.catalog || null,
          efforts: Array.isArray(json.efforts) ? json.efforts : ['low', 'medium', 'high']
        };
      } else {
        this.engine = { ...VeloAiCoach.offlineEngine(), reachable: false };
      }
    } catch (e) {
      this.engine = { ...VeloAiCoach.offlineEngine(), reachable: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.engine;
  }

  /** Saves the per-browser engine choice. Empty strings mean "server default". */
  saveConfig({ provider = this.providerOverride, model = this.modelOverride, effort = this.effortOverride } = {}) {
    this.providerOverride = VeloAiCoach.PROVIDERS[provider] ? provider : '';
    this.modelOverride = VeloAiCoach.MODEL_LABELS[model] ? model : '';
    // A model from the other provider makes no sense: drop it.
    if (this.providerOverride && this.modelOverride && VeloAiCoach.providerOf(this.modelOverride) !== this.providerOverride) this.modelOverride = '';
    this.effortOverride = ['low', 'medium', 'high'].includes(effort) ? effort : '';
    try {
      localStorage.setItem('apex_coach_provider', this.providerOverride);
      localStorage.setItem('apex_coach_model', this.modelOverride);
      localStorage.setItem('apex_coach_effort', this.effortOverride);
      localStorage.removeItem('apex_claude_model');
      localStorage.removeItem('apex_claude_effort');
    } catch (e) { /* ignore */ }
  }

  setLookback(days) {
    const d = parseInt(days, 10);
    this.lookbackDays = VeloAiCoach.LOOKBACK_OPTIONS.includes(d) ? d : VeloAiCoach.DEFAULT_LOOKBACK;
    try { localStorage.setItem('apex_coach_lookback_days', String(this.lookbackDays)); } catch (e) { /* ignore */ }
    return this.lookbackDays;
  }

  clearRecommendation() {
    this.currentRecommendation = null;
  }

  // ---------------------------------------------------------------- context --
  getPhysiologicalContext(targetFocus = 'auto', durationMin = 45, goal = 'ftp', notes = '', lookbackDays = this.lookbackDays) {
    const profile = this.app.activeProfile || { name: 'Rider', ftp: 185, weightKg: 75, maxHr: 175 };
    const all = this.app.completedWorkouts || [];
    // Strength sessions add fatigue (per the app's toggle) but are not rides.
    const pmc = this.app.analytics.calculatePmcHistory(all, 0, this.app.pmcOpts ? this.app.pmcOpts() : {});
    const workouts = all.filter(w => VeloMetrics.isCycling(w));
    const ctl = pmc.currentCtl || 0;
    const atl = pmc.currentAtl || 0;
    const tsb = pmc.currentTsb || 0;

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
    const recentWorkouts = workouts
      .filter(w => new Date(w.date) >= sevenDaysAgo)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const sevenDayTss = Math.round(recentWorkouts.reduce((s, w) => s + (Number(w.tss) || 0), 0));
    const sevenDayHours = recentWorkouts.reduce((s, w) => s + (Number(w.duration) || 0), 0) / 3600;

    // Consecutive riding days leading into today (local calendar days)
    const rideDays = new Set(workouts.map(w => VeloMetrics.localDateKey(w.date)));
    let consecutiveDays = 0;
    for (let d = 1; d <= 14; d++) {
      const k = VeloMetrics.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - d));
      if (rideDays.has(k)) consecutiveDays++; else break;
    }

    const form = VeloMetrics.formZone(tsb);
    const lookback = VeloAiCoach.LOOKBACK_OPTIONS.includes(Number(lookbackDays)) ? Number(lookbackDays) : VeloAiCoach.DEFAULT_LOOKBACK;
    const history = VeloProgress.coachProfile(workouts, profile.ftp, now, lookback);

    // Rides listed one by one in the prompt: the look-back window, newest first, capped so it stays lean.
    const windowRides = workouts
      .filter(w => now - new Date(w.date) <= lookback * 86400000)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const listedRides = windowRides.slice(0, VeloAiCoach.MAX_LISTED_RIDES);
    const strength = typeof VeloStravaSync !== 'undefined'
      ? VeloStravaSync.strengthSummary(all, lookback, now)
      : { count: 0, sessions: [], line: '' };
    // Raw facts about runs, gym, walks, yoga... for the AI prompts (the offline engine uses `strength` above).
    const otherActivities = typeof VeloStravaSync !== 'undefined' && VeloStravaSync.otherActivitiesSummary
      ? VeloStravaSync.otherActivitiesSummary(all, lookback, now)
      : { count: 0, line: '' };
    const yesterday = VeloMetrics.localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const today = VeloMetrics.localDateKey(now);
    const heavyLegsRecent = strength.sessions.some(s => s.heavyLegs && (s.date === yesterday || s.date === today));
    const recentList = listedRides.map(w => {
      return `- ${VeloMetrics.localDateKey(w.date)}: "${w.title}" (${Math.round((w.duration || 0) / 60)} min, TSS ${w.tss || 0}, NP ${w.np || 0}W, IF ${w.if || 0})`;
    }).join('\n') || `- No rides logged in the past ${lookback} days.`;

    // Post-ride insight (interval diagnosis, drift, PR medals, FTP) from rides with recorded power.
    let insight = { lines: [] };
    try { if (this.app.coachInsight) insight = this.app.coachInsight(lookback, now); } catch (e) { /* insight is optional */ }

    // Daily readiness from Apple Health (resting HR, HRV, sleep) - advisory, only when there is a verdict.
    let readiness = null;
    try {
      const r = this.app.healthReadiness ? this.app.healthReadiness() : null;
      if (r && ['green', 'amber', 'red'].includes(r.level)) readiness = r;
    } catch (e) { /* optional */ }

    return {
      profile, ctl, atl, tsb, insight, readiness,
      formZone: form.label, formKey: form.key, formDesc: form.desc,
      sevenDayTss, sevenDayHours, recentWorkouts, recentList, consecutiveDays,
      lookbackDays: lookback, windowRideCount: windowRides.length, listedRideCount: listedRides.length,
      history, strength, heavyLegsRecent, otherActivities,
      goal: VeloAiCoach.GOALS[goal] ? goal : 'ftp',
      notes: String(notes || '').slice(0, 280),
      targetFocus,
      autoDuration: String(durationMin).toLowerCase() === 'auto',
      durationMin: parseInt(durationMin, 10) || 60
    };
  }

  // ----------------------------------------------------------- focus logic --
  decideFocus(ctx) {
    if (ctx.targetFocus && ctx.targetFocus !== 'auto') return ctx.targetFocus;
    const h = ctx.history || {};
    // A heavy leg strength day yesterday (or today) counts like a hard ride: no key session now.
    const hardRecently = (h.daysSinceHard !== null && h.daysSinceHard !== undefined && h.daysSinceHard <= 1) || !!ctx.heavyLegsRecent;
    if (ctx.tsb < -25 || (ctx.consecutiveDays >= 3 && ctx.tsb < -10)) return 'recovery';
    // Poor recovery (Apple Health): red = recovery spin, amber = no key session today.
    if (ctx.readiness && ctx.readiness.level === 'red') return 'recovery';
    if (ctx.readiness && ctx.readiness.level === 'amber') return 'endurance';
    if (ctx.tsb < -12 || hardRecently) return 'endurance';
    switch (ctx.goal) {
      case 'longevity':
        // Cardiorespiratory fitness is the strongest fitness link to longevity: one short 4 x 4 when fresh.
        return (h.daysSinceHard === null || h.daysSinceHard >= 5) && ctx.tsb > -5 ? 'vo2max' : 'endurance';
      case 'vo2':
        return ctx.tsb > -8 ? 'vo2max' : 'endurance';
      case 'balanced':
        return (h.lowIntensityPct !== null && h.lowIntensityPct < 70) ? 'endurance' : (ctx.tsb > 5 ? 'vo2max' : 'threshold');
      case 'ftp':
      default:
        if (ctx.tsb > 5) return 'threshold';
        return (h.highIntensityPct !== null && h.highIntensityPct < 15) ? 'threshold' : 'sweetspot';
    }
  }

  // --------------------------------------------------------- workout maths --
  /** IF and TSS computed from the prescribed intervals (not guessed multipliers). */
  /**
   * Most effective session length for a focus, from form, fitness (CTL), goal and the rider's usual ride length.
   * Quality sessions are capped by what the rider can execute well; easy rides grow with training age.
   */
  optimalDuration(focus, ctx) {
    const h = ctx.history || {};
    const ctl = ctx.ctl || 0;
    const tired = ctx.tsb < -15;
    const fresh = ctx.tsb > 5;
    const r5 = (m) => Math.round(m / 5) * 5;
    const usual = h.ridesWin ? (h.hoursPerWeekWin * 60 * (ctx.lookbackDays / 7)) / h.ridesWin : 60;
    let min;
    switch (focus) {
      case 'recovery': min = tired ? 30 : 40; break;
      case 'endurance':
        // Aerobic durability: a bit longer than usual, longer still for the longevity goal.
        min = Math.max(60, usual * 1.15) + (ctx.goal === 'longevity' ? 20 : 0);
        if (tired) min = Math.min(min, 60);
        min = Math.min(min, 150);
        break;
      case 'sweetspot': min = ctl >= 40 ? 90 : ctl >= 25 ? 75 : 60; break;
      case 'threshold': min = ctl >= 40 ? 75 : 60; break;
      case 'vo2max': min = ctl >= 30 && fresh ? 60 : 50; break;
      default: min = 60;
    }
    if (tired && focus !== 'recovery') min -= 10;
    return Math.max(30, Math.min(150, r5(min)));
  }

  /**
   * Planned duration, IF and TSS of a list of intervals, computed the way NP is from a ride: the 1 Hz
   * target is smoothed over 30 s before the 4th-power mean, so 15/15 s surges count as the ~100% FTP the
   * body sees rather than as 150% bursts.
   */
  static estimateLoad(intervals) {
    const pct = [];
    for (const iv of intervals || []) {
      const n = Math.max(0, Math.round(Number(iv.duration) || 0)), p = (Number(iv.pctFtp) || 0) / 100;
      for (let k = 0; k < n; k++) pct.push(p);
    }
    const totalSec = pct.length || 1;
    let p4;
    if (pct.length >= 30) {
      let sum = 0, acc = 0, count = 0;
      for (let i = 0; i < pct.length; i++) {
        sum += pct[i];
        if (i >= 30) sum -= pct[i - 30];
        if (i >= 29) { acc += Math.pow(sum / 30, 4); count++; }
      }
      p4 = acc / count;
    } else p4 = pct.reduce((a, p) => a + Math.pow(p, 4), 0) / totalSec;
    const ifac = Math.pow(p4, 0.25);
    return { durationMin: Math.round(totalSec / 60), if: ifac.toFixed(2), tss: Math.round((totalSec / 3600) * ifac * ifac * 100) };
  }

  static fill(mainSec, blockSec, restSec, maxReps = 12) {
    return Math.max(1, Math.min(maxReps, Math.floor((mainSec + restSec) / (blockSec + restSec))));
  }

  buildWorkout(focus, ctx) {
    const ftp = ctx.profile.ftp || 185;
    const dur = Math.max(30, ctx.durationMin);
    const wuSec = dur >= 60 ? 600 : 480;
    const cdSec = 300;
    const main = dur * 60 - wuSec - cdSec;
    const ctlLevel = ctx.ctl;
    const iv = [];
    const W = (pct) => Math.round(ftp * pct / 100);
    // Position in a training block's load weeks (0 early, 1 middle, 2 late): repetitions grow or rests shorten so
    // more time is spent in the target zone as the weeks go on (volume before intensity). No step = a stand-alone session.
    const step = [0, 1, 2].includes(ctx.progressionStep) ? ctx.progressionStep : null;
    const byStep = (base, steps) => (step === null ? base : steps[step]);
    let title = '', desc = '', notes = '';

    const warmup = (openers) => {
      iv.push({ name: 'Warmup', duration: wuSec - (openers ? 180 : 0), pctFtp: 55, cadence: 88 });
      if (openers) {
        iv.push({ name: 'Opener', duration: 60, pctFtp: 95, cadence: 95 });
        iv.push({ name: 'Opener Recovery', duration: 120, pctFtp: 50, cadence: 85 });
      }
    };
    const cooldown = () => iv.push({ name: 'Cooldown', duration: cdSec, pctFtp: 45, cadence: 85 });

    if (focus === 'recovery') {
      warmup(false);
      iv.push({ name: 'Recovery Spin (high cadence)', duration: main, pctFtp: 50, cadence: 95 });
      cooldown();
      title = `Active Recovery Flush (${dur}m)`;
      desc = 'An easy spin to keep moving while giving your legs a break.';
      notes = 'Pedal lightly and smoothly. If your legs still feel heavy, stop early.';
    } else if (focus === 'endurance') {
      warmup(false);
      const cadenceDrills = main >= 1800;
      if (cadenceDrills) {
        const chunk = Math.floor(main / 3);
        iv.push({ name: 'Zone 2 Aerobic', duration: chunk, pctFtp: 68, cadence: 88 });
        iv.push({ name: 'Zone 2 Low-Cadence Torque', duration: chunk, pctFtp: 70, cadence: 72 });
        const finish = ctx.goal === 'longevity' && ctx.tsb > -5 && main >= 2700;
        iv.push({ name: finish ? 'Durability Tempo Finish' : 'Zone 2 Aerobic', duration: main - 2 * chunk, pctFtp: finish ? 80 : 68, cadence: 90 });
      } else {
        iv.push({ name: 'Zone 2 Aerobic', duration: main, pctFtp: 68, cadence: 88 });
      }
      cooldown();
      title = `Zone 2 Durability Builder (${dur}m)`;
      desc = 'A steady, easy ride to help you ride longer without tiring.';
      notes = 'Keep the effort easy enough to hold a conversation. During the slower-pedalling section, stay smooth and avoid straining.';
    } else if (focus === 'sweetspot') {
      warmup(true);
      let block = ctlLevel >= 45 ? 1200 : ctlLevel >= 30 ? 900 : ctlLevel >= 18 ? 600 : 480;
      const rest = block >= 900 ? byStep(300, [300, 240, 180]) : byStep(180, [180, 150, 120]);
      const avail = main;
      const reps = VeloAiCoach.fill(avail, block, rest, 4);
      // Stretch the blocks (up to +50%) so the main set fills the available time.
      block = Math.min(Math.round(block * 1.5), Math.floor((avail - (reps - 1) * rest) / reps / 30) * 30);
      for (let r = 1; r <= reps; r++) {
        iv.push({ name: `SweetSpot ${r}`, duration: block, pctFtp: 88 + byStep(0, [0, 1, 2]) + Math.min(4, r - 1) * 1, cadence: 92 });
        if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 50, cadence: 85 });
      }
      const used = reps * block + (reps - 1) * rest;
      if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 65, cadence: 90 });
      cooldown();
      title = `Progressive SweetSpot ${reps}x${Math.round(block / 60)} (${dur}m)`;
      desc = 'Sustained efforts to help you hold a stronger pace for longer. The effort lengths suit your recent training.';
      notes = 'Stay seated and pedal smoothly. It should feel comfortably hard, with enough left to finish well.';
    } else if (focus === 'threshold') {
      warmup(true);
      const rest = byStep(240, [300, 240, 180]);
      const avail = main;
      const reps = VeloAiCoach.fill(avail, 540, rest, 4);
      // 3-5 under/over cycles (2 min @95% + 1 min @106%) per set, sized to the time available.
      const cycles = Math.max(3, Math.min(5, Math.floor((avail - (reps - 1) * rest) / reps / 180)));
      const set = cycles * 180;
      for (let r = 1; r <= reps; r++) {
        for (let c = 1; c <= cycles; c++) {
          iv.push({ name: `Set ${r} Under ${c}`, duration: 120, pctFtp: 95, cadence: 92 });
          iv.push({ name: `Set ${r} Over ${c}`, duration: 60, pctFtp: 106, cadence: 98 });
        }
        if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 50, cadence: 85 });
      }
      const used = reps * set + (reps - 1) * rest;
      if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 65, cadence: 90 });
      cooldown();
      title = `Threshold Over-Unders ${reps}x${cycles * 3} (${dur}m)`;
      desc = 'Switch between a strong, steady effort and a short harder push to practise handling changes in pace.';
      notes = `Unders at ${W(95)}W, overs at ${W(106)}W. Don't surge the overs - smooth the transition and keep cadence up.`;
    } else {
      // VO2 max
      warmup(true);
      const avail = main;
      if (ctx.goal === 'longevity') {
        // Norwegian 4 x 4 (Helgerud 2007; Generation 100): 4 min at 85-95% of max heart rate, 3 min easy.
        const block = 240, rest = 180;
        const reps = VeloAiCoach.fill(avail, block, rest, 4);
        const pct = ctlLevel >= 25 ? 110 : 106;
        for (let r = 1; r <= reps; r++) {
          iv.push({ name: `Aerobic Power ${r}`, duration: block, pctFtp: pct, cadence: 95 });
          if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 55, cadence: 85 });
        }
        const used = reps * block + (reps - 1) * rest;
        if (avail - used >= 120) iv.push({ name: 'Zone 2 Top-up', duration: avail - used, pctFtp: 65, cadence: 90 });
        title = `Health 4x4 Aerobic Power (${dur}m)`;
        desc = 'Four-minute hard efforts with easy breaks: a proven way to grow the aerobic fitness linked to long-term health.';
      } else if (dur >= 60 && ctlLevel >= 25) {
        // Through a block: add repetitions first (4 -> 5 -> 6 x 4 min), then shorter rests.
        const block = 240, rest = byStep(240, [240, 240, 210]);
        const reps = VeloAiCoach.fill(avail, block, rest, byStep(6, [4, 5, 6]));
        for (let r = 1; r <= reps; r++) {
          iv.push({ name: `VO2 Effort ${r}`, duration: block, pctFtp: 112, cadence: 100 });
          if (r < reps) iv.push({ name: `Recovery ${r}`, duration: rest, pctFtp: 50, cadence: 85 });
        }
        const used = reps * block + (reps - 1) * rest;
        if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 62, cadence: 90 });
        title = `VO2 Max ${reps}x4 min (${dur}m)`;
        desc = 'Hard efforts with easy breaks to help you handle faster riding.';
      } else {
        const setSec = 13 * 45 - 15, setRest = byStep(300, [300, 300, 180]);
        const sets = VeloAiCoach.fill(avail, setSec, setRest, byStep(3, [2, 3, 3]));
        for (let s = 1; s <= sets; s++) {
          for (let r = 1; r <= 13; r++) {
            iv.push({ name: `Set ${s} On ${r}`, duration: 30, pctFtp: 120, cadence: 105 });
            if (r < 13) iv.push({ name: `Set ${s} Off ${r}`, duration: 15, pctFtp: 50, cadence: 90 });
          }
          if (s < sets) iv.push({ name: `Set Recovery ${s}`, duration: setRest, pctFtp: 50, cadence: 85 });
        }
        const used = sets * setSec + (sets - 1) * setRest;
        if (avail - used >= 120) iv.push({ name: 'Endurance Top-up', duration: avail - used, pctFtp: 62, cadence: 90 });
        title = `Ronnestad 30/15 x ${sets} (${dur}m)`;
        desc = 'Short hard pushes with brief easy breaks to build your ability to ride hard.';
      }
      cooldown();
      const maxHr = Number(ctx.profile.maxHr) || 0;
      notes = ctx.goal === 'longevity' && maxHr
        ? `By the end of each effort your heart rate should reach about ${Math.round(maxHr * 0.85)}-${Math.round(maxHr * 0.95)} bpm. Use the easy breaks to recover. Stop the set if you cannot hold the target smoothly.`
        : 'Use the easy breaks to catch your breath. End the set if you can no longer hold the target smoothly.';
    }

    const load = VeloAiCoach.estimateLoad(iv);
    const category = focus === 'vo2max' ? 'vo2' : (focus === 'recovery' ? 'endurance' : focus);
    return {
      workout: { id: `ai_coach_${focus}_${Date.now()}`, title: `AI Coach: ${title}`, category, desc, durationMin: load.durationMin, tss: load.tss, if: load.if, intervals: iv },
      notes
    };
  }

  /** 7-day outlook sized to a CTL ramp appropriate for the goal and current form. */
  buildWeekPlan(ctx, todayFocus, todayWorkout) {
    const goal = VeloAiCoach.GOALS[ctx.goal] || VeloAiCoach.GOALS.ftp;
    let ramp = goal.ctlRampPerWeek;
    if (ctx.formKey === 'fatigue' || ctx.formKey === 'overtraining') ramp = 0;
    else if (ctx.formKey === 'optimal') ramp = Math.min(ramp, 2);
    // Daily TSS that lifts CTL by `ramp` per week: dCTL/day ~= (TSS - CTL) / 42  ->  TSS = CTL + 6 * ramp
    const dailyTarget = Math.max(20, ctx.ctl + 6 * ramp);
    const weekTarget = Math.round(dailyTarget * 7);

    const templates = {
      ftp:       ['endurance', 'threshold', 'recovery', 'sweetspot', 'off', 'endurance-long'],
      longevity: ['endurance', 'endurance', 'recovery', 'sweetspot', 'off', 'endurance-long'],
      vo2:       ['endurance', 'vo2max', 'recovery', 'threshold', 'off', 'endurance-long'],
      balanced:  ['endurance', 'vo2max', 'recovery', 'endurance', 'off', 'sweetspot']
    };
    const weights = { recovery: 0.35, endurance: 0.75, 'endurance-long': 1.5, sweetspot: 1.0, threshold: 1.05, vo2max: 0.95, off: 0 };
    const seq = [todayFocus, ...(templates[ctx.goal] || templates.ftp)];
    // Longevity: one short 4 x 4 a week for aerobic fitness; if today is the 4 x 4, keep the second hard day steady.
    if (ctx.goal === 'longevity') seq[4] = todayFocus === 'vo2max' ? 'sweetspot' : 'vo2max';
    // Never stack the same hard stimulus within 48 h of today's session.
    const hard = ['threshold', 'vo2max', 'sweetspot'];
    for (let i = 1; i <= 2; i++) if (hard.includes(todayFocus) && hard.includes(seq[i])) seq[i] = 'endurance';
    if (ctx.formKey === 'fatigue' || ctx.formKey === 'overtraining') { seq[1] = 'recovery'; seq[2] = 'off'; }
    const remaining = Math.max(0, weekTarget - (todayWorkout.tss || 0));
    const restWeight = seq.slice(1).reduce((a, f) => a + (weights[f] || 0), 0) || 1;
    const labels = { recovery: 'Recovery spin', endurance: 'Zone 2 endurance', 'endurance-long': 'Long Zone 2 ride', sweetspot: 'SweetSpot', threshold: 'Threshold over-unders', vo2max: 'VO2 max', off: 'Rest day' };
    const ifFor = { recovery: 0.5, endurance: 0.68, 'endurance-long': 0.68, sweetspot: 0.86, threshold: 0.9, vo2max: 0.88, off: 0 };

    const now = new Date();
    return {
      weekTargetTss: weekTarget,
      ramp,
      days: seq.map((f, i) => {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const tss = i === 0 ? todayWorkout.tss : Math.round(remaining * (weights[f] || 0) / restWeight);
        const ifac = ifFor[f] || 0;
        const minutes = f === 'off' || !ifac ? 0 : Math.round((tss / (ifac * ifac * 100)) * 60 / 5) * 5;
        return {
          date: VeloMetrics.localDateKey(d),
          dayLabel: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
          focus: f,
          title: i === 0 ? todayWorkout.title.replace(/^AI Coach: /, '') : labels[f],
          durationMin: i === 0 ? todayWorkout.durationMin : minutes,
          tss
        };
      })
    };
  }

  /** One or two sentences for the offline engine's advice, from the recent-ride insight. */
  insightAdvice(ctx, focus) {
    const ins = ctx.insight || {};
    const out = [];
    const faded = ins.lastHard && ins.lastHard.diag.some(l => /faded|under target|drift/.test(l));
    if (faded && ['vo2max', 'threshold', 'sweetspot'].includes(focus)) out.push('You faded towards the end of your last hard ride. Start steadily and eat before you run low on energy.');
    const d = ins.drift || [];
    if (d.length >= 2) {
      const avg = d.reduce((a, x) => a + x.pct, 0) / d.length;
      if (avg > 8) out.push('Your heart rate has been rising during steady efforts. Keep easy rides comfortable and check your cooling, drinks and food.');
      else if (avg < 5) out.push('Your heart rate has stayed fairly steady on easy rides, suggesting you are handling them well.');
    }
    if (ins.ftp) out.push('Your recent rides suggest your sustainable power may have changed. Review the suggested power setting in your ride review.');
    return out.join(' ');
  }

  generateOfflineHeuristic(ctx) {
    const focus = this.decideFocus(ctx);
    if (ctx.autoDuration) ctx.durationMin = this.optimalDuration(focus, ctx);
    const { workout, notes } = this.buildWorkout(focus, ctx);
    const h = ctx.history || {};
    const weekPlan = this.buildWeekPlan(ctx, focus, workout);

    const mixText = h.lowIntensityPct !== null && h.lowIntensityPct !== undefined
      ? (h.lowIntensityPct >= 70 ? 'Most of your recent riding has been easy.' : 'Your recent riding includes plenty of harder work. Keep room for easy days.')
      : 'There is not enough recent power data to judge the balance of easy and hard riding.';
    const why = {
      recovery: 'Take it easy today so your body can recover from recent training.',
      endurance: h.daysSinceHard !== null && h.daysSinceHard !== undefined && h.daysSinceHard <= 1 ? 'You recently rode hard, so keep today comfortable.' : 'Easy, steady riding helps you build the stamina for longer rides.',
      sweetspot: 'Today uses comfortably hard efforts to help you hold a stronger pace for longer.',
      threshold: 'Today practises holding a strong pace and handling short harder pushes.',
      vo2max: ctx.goal === 'longevity' ? 'Today uses four hard efforts with easy breaks to grow the aerobic fitness most closely linked to long-term health.' : 'Today uses hard efforts with easy breaks to build your ability to ride faster.'
    }[focus] || '';
    const fitnessText = {
      fresh: 'Your recent training suggests you may be ready for a harder ride if you feel well.',
      productive: 'Your recent training and recovery appear fairly balanced.',
      optimal: 'You have been building fitness, with some tiredness expected. Pay attention to how your legs feel.',
      fatigue: 'Your recent training suggests you may be carrying quite a bit of tiredness.',
      overtraining: 'Your recent training suggests you need more recovery. This estimate cannot tell us whether you are overtrained.'
    }[ctx.formKey] || 'Your recent rides help estimate how much training you can comfortably handle.';
    const fuelText = ctx.durationMin >= 90 && focus !== 'recovery'
      ? 'For a ride this long, take in about 60-90 g of carbohydrate per hour (drink mix, gels or food) so you finish strongly.'
      : '';
    const recoveryText = ctx.readiness
      ? ({ red: 'Your recovery readings suggest taking it easy today.', amber: 'Your recovery readings suggest keeping today comfortable.', green: 'Your recovery readings look encouraging; check how you feel before riding hard.' }[ctx.readiness.level] || '')
      : 'Check how you feel before starting; training records cannot measure every part of recovery.';

    return {
      source: 'offline_heuristic',
      goal: ctx.goal,
      lookbackDays: ctx.lookbackDays,
      focus,
      coachAssessment: {
        formZone: ctx.formZone,
        fitnessDiagnosis: fitnessText,
        fatigueStatus: `${recoveryText} ${ctx.consecutiveDays >= 2 ? 'You have ridden several days in a row, so allow time to recover. ' : ''}${mixText}`,
        trainingAdvice: `${why} ${this.insightAdvice(ctx, focus)} ${ctx.autoDuration ? `Allow about ${ctx.durationMin} minutes for this ride. ` : ''}${notes} ${fuelText}`.replace(/\s+/g, ' ').trim()
      },
      evidence: typeof VeloSportScience !== 'undefined' ? VeloSportScience.notesFor(ctx.goal, ctx, { focus }) : [],
      workout,
      weekPlan
    };
  }

  // ------------------------------------------------------------ Claude / Gemini --
  buildPrompt(ctx) {
    const h = ctx.history || {};
    const goal = VeloAiCoach.GOALS[ctx.goal] || VeloAiCoach.GOALS.ftp;
    const evidence = typeof VeloSportScience !== 'undefined' ? `${VeloSportScience.brief(ctx.goal, ctx, 'session')}\n\n` : '';
    return `You are the app's sport scientist: an elite cycling coach and exercise physiologist. Prescribe today's indoor ERG session and a 7-day outlook for rider "${ctx.profile.name}".

RIDER: FTP ${ctx.profile.ftp} W, weight ${ctx.profile.weightKg} kg, max HR ${ctx.profile.maxHr} bpm.
PRIMARY GOAL: ${goal.label} - ${goal.summary}
TODAY'S FOCUS REQUEST: ${ctx.targetFocus} (auto = decide). ${ctx.autoDuration ? 'Duration: YOU choose the most effective length (30-150 min) for this session given its focus, the goal, current form/fatigue and the rider\'s usual ride length - long enough for a real stimulus, short enough to execute with quality; explain the choice in trainingAdvice.' : `Time available: ${ctx.durationMin} minutes.`}
${ctx.notes ? `RIDER NOTES: ${ctx.notes}\n` : ''}
PERFORMANCE MANAGEMENT (Banister model):
- CTL (fitness) ${ctx.ctl.toFixed(1)}, ATL (fatigue) ${ctx.atl.toFixed(1)}, TSB (form) ${ctx.tsb.toFixed(1)} -> ${ctx.formZone}
- Last 7 days: ${ctx.sevenDayTss} TSS, ${ctx.sevenDayHours.toFixed(1)} h, ${ctx.recentWorkouts.length} rides; consecutive riding days: ${ctx.consecutiveDays}
- Last ${ctx.lookbackDays} days (look-back window): ${h.ridesWin} rides, ${h.tssWin} TSS, ${h.hoursPerWeekWin} h/week, longest ride ${h.longestRideMinWin} min
- Intensity mix (${ctx.lookbackDays} d, by ride IF): easy ${h.lowIntensityPct ?? 'n/a'}%, tempo/SweetSpot ${h.midIntensityPct ?? 'n/a'}%, threshold+ ${h.highIntensityPct ?? 'n/a'}%
- Days since last hard ride (IF>=0.85): ${h.daysSinceHard ?? 'none on record'}; days since last ride >= 90 min: ${h.daysSinceLong ?? 'none on record'}
- Power profile: ${h.profileType || 'n/a'}
NON-CYCLING ACTIVITIES (from Strava, last ${ctx.lookbackDays} days, newest first; today is ${VeloMetrics.localDateKey(new Date())}):
${ctx.otherActivities && ctx.otherActivities.line ? ctx.otherActivities.line : '- None recorded.'}
${ctx.readiness ? `DAILY READINESS (Apple Watch, vs the rider's own baselines): ${ctx.readiness.level.toUpperCase()} - ${ctx.readiness.label}.${ctx.readiness.hrv ? ` HRV 7-day ${ctx.readiness.hrv.avg7} ms (normal ${ctx.readiness.hrv.normalLow}-${ctx.readiness.hrv.normalHigh}).` : ''}${ctx.readiness.rhr ? ` Resting HR ${ctx.readiness.rhr.today} bpm (baseline ${ctx.readiness.rhr.base}).` : ''}${ctx.readiness.sleep ? ` Sleep ${ctx.readiness.sleep.last} h.` : ''}${ctx.readiness.reasons.length ? ' Flags: ' + ctx.readiness.reasons.join('; ') + '.' : ''} Amber = no key session today (endurance or shortened sets); red = Z1-Z2 recovery spin. Say so in fatigueStatus.
` : ''}${ctx.insight && ctx.insight.lines.length ? `RECENT RIDE INSIGHT (computed from recorded power and heart rate - use it, e.g. ease or re-pace a session type that faded, keep aerobic work steady while drift is high, build on new bests):
${ctx.insight.lines.map(l => `- ${l}`).join('\n')}
` : ''}RIDES IN THE LAST ${ctx.lookbackDays} DAYS (newest first${ctx.windowRideCount > ctx.listedRideCount ? `, ${ctx.listedRideCount} most recent of ${ctx.windowRideCount}` : ''}):
${ctx.recentList}

${evidence}METHOD: 1) needs analysis - what limits this rider for the goal, given the data above; 2) choose today's session type and its dose (interval length, intensity, recovery length, total time in the target zone) from the goal model and evidence; 3) safety check - recent hard days, fatigue, recovery readings and strength sessions; adjust before answering.

RULES: scale all targets as % of FTP; include warmup and cooldown; interval durations in seconds; every interval needs a cadence target (rpm); ${ctx.autoDuration ? 'total duration 30-150 min as you judge optimal' : `total duration must be within 3 minutes of ${ctx.durationMin} min`}; respect fatigue (TSB < -25 -> recovery). The weekPlan must contain 7 days starting today; use focus "off" for rest days.

WRITING STYLE: Write for a beginner in plain language. Each assessment field should be one or two short sentences explaining what to do and why. Say fitness base, recent training strain, and freshness instead of CTL, ATL, and TSB. Explain any essential technical term immediately. Do not repeat the input scores, percentages, or statistics in prose. Use numbers only for an actionable duration or target. Give workout and day titles simple, descriptive names. Keep all numeric workout fields, enum values and JSON keys exact; these control the workout.

Return ONLY JSON matching:
{
  "coachAssessment": { "formZone": "Fresh" | "Productive" | "Optimal" | "High Fatigue" | "Overtraining", "fitnessDiagnosis": "...", "fatigueStatus": "...", "trainingAdvice": "..." },
  "workout": { "title": "...", "category": "sweetspot" | "vo2" | "threshold" | "endurance", "desc": "...", "intervals": [ { "name": "Warmup", "duration": 600, "pctFtp": 55, "cadence": 88 } ] },
  "weekPlan": { "days": [ { "dayLabel": "Today", "focus": "sweetspot", "title": "...", "durationMin": 45, "tss": 50 } ] }${evidence ? `,
  ${VeloSportScience.OUTPUT_FIELD}` : ''}
}${evidence ? '\nevidence: 2-4 items, in the same plain language as the assessment.' : ''}`;
  }

  async generateRecommendation(targetFocus = 'auto', durationMin = 45, goal = 'ftp', notes = '') {
    const ctx = this.getPhysiologicalContext(targetFocus, durationMin, goal, notes);
    const t0 = performance.now();
    const finish = (rec) => {
      rec.elapsedMs = Math.round(performance.now() - t0);
      rec.generatedAt = new Date().toISOString();
      this.currentRecommendation = rec;
      return rec;
    };

    // The server may have been started (or the key added) after the page loaded.
    if (!this.isLive) await this.detectEngine();
    if (!this.isLive) return finish(this.generateOfflineHeuristic(ctx));

    const provider = this.provider;
    const model = this.model;
    const effort = VeloAiCoach.supportsEffort(model) ? this.effort : null;
    const label = VeloAiCoach.labelFor(model);
    try {
      const resp = await fetch(VeloAiCoach.COACH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: this.buildPrompt(ctx), provider, model, effort })
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.warn(`${this.providerLabel} coach call failed:`, resp.status, json.error);
        const fb = this.generateOfflineHeuristic(ctx);
        fb.apiError = `${json.error || `${label} error (${resp.status})`} Used the built-in physiology engine instead.`;
        return finish(fb);
      }
      if (json.stopReason === 'max_tokens') throw new Error('the answer was cut off (max tokens)');
      const thoughtText = json.thinking || '';
      const rawText = json.text || '';
      if (!rawText) throw new Error(`empty response from ${label}`);

      let parsed;
      try {
        parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());
      } catch (pe) {
        const m = rawText.match(/\{[\s\S]*\}/);
        if (!m) throw pe;
        parsed = JSON.parse(m[0]);
      }
      const ivs = parsed.workout && Array.isArray(parsed.workout.intervals) ? parsed.workout.intervals : [];
      const clean = ivs
        .map(iv => ({ name: String(iv.name || 'Step').slice(0, 60), duration: Math.max(5, Math.round(Number(iv.duration) || 0)), pctFtp: Math.max(30, Math.min(250, Math.round(Number(iv.pctFtp) || 0))), cadence: Math.max(50, Math.min(130, Math.round(Number(iv.cadence) || 0))) || undefined }))
        .filter(iv => iv.duration > 0 && iv.pctFtp > 0);
      if (clean.length < 3) throw new Error('the response did not contain a valid interval list');

      const load = VeloAiCoach.estimateLoad(clean);
      parsed.workout = {
        id: 'ai_rec_' + Date.now(),
        title: String(parsed.workout.title || 'AI Coach Session'),
        category: parsed.workout.category || 'custom',
        desc: String(parsed.workout.desc || ''),
        durationMin: load.durationMin,
        tss: load.tss,
        if: load.if,
        intervals: clean
      };
      if (!parsed.weekPlan || !Array.isArray(parsed.weekPlan.days) || !parsed.weekPlan.days.length) {
        parsed.weekPlan = this.buildWeekPlan(ctx, this.decideFocus(ctx), parsed.workout);
      }
      parsed.coachAssessment = parsed.coachAssessment || {};
      parsed.coachAssessment.formZone = parsed.coachAssessment.formZone || ctx.formZone;
      // Only references from the evidence base survive, so the app never shows an invented study.
      parsed.evidence = typeof VeloSportScience !== 'undefined' ? VeloSportScience.sanitise(parsed.evidence) : [];
      if (!parsed.evidence.length && typeof VeloSportScience !== 'undefined') parsed.evidence = VeloSportScience.notesFor(ctx.goal, ctx, { max: 3 });
      parsed.source = json.provider || provider;
      parsed.model = json.model || model;
      parsed.modelLabel = label;
      parsed.goal = ctx.goal;
      parsed.lookbackDays = ctx.lookbackDays;
      parsed.thinkingLevel = effort ? `${effort} effort` : 'thinking';
      parsed.usage = json.usage || null;
      if (thoughtText.trim()) parsed.coachThoughts = thoughtText.trim();
      return finish(parsed);
    } catch (err) {
      console.warn('VeloAiCoach: falling back to the offline engine:', err);
      const fb = this.generateOfflineHeuristic(ctx);
      fb.apiError = `${label} unavailable (${err.message}). Used the built-in physiology engine instead.`;
      return finish(fb);
    }
  }
}

if (typeof window !== 'undefined') window.VeloAiCoach = VeloAiCoach;
