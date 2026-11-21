// Sounds, all synthesised with the Web Audio API (no audio files). Imports under Node: the
// AudioContext is only touched inside createSound(), and only after unlock().
//
// soundsForEvents / soundsForPrompt map game events to sound names (pure, unit-tested).
// createSound() plays them. createGameAudio() is the page glue for the controller hooks.

const HUMAN = 0;
export const MAX_BATCH = 4; // sounds per applyAction batch
const MASTER_GAIN = 0.25;
const GAP_MS = 100; // spacing between queued sounds
const MAX_BACKLOG_MS = 400; // a sound that would start later than this is dropped
const WARN_MS = 5000; // claim-window warning ticks: last 5 seconds

// Each sound is a list of voices. Oscillator voice: { wave, freq, to?, at?, dur, peak }
// (`to` glides the pitch). Noise voice: { noise: band-pass Hz, q, at?, dur, peak }.
// Times in seconds, peak relative to the master gain.
export const SOUND_RECIPES = Object.freeze({
  draw: [{ wave: 'sine', freq: 1500, to: 1150, dur: 0.04, peak: 0.12 }],
  discard: [
    { noise: 2200, q: 2.5, dur: 0.05, peak: 0.9 },
    { wave: 'triangle', freq: 560, to: 420, dur: 0.09, peak: 0.35 },
  ],
  'discard-other': [
    { noise: 1500, q: 2.5, dur: 0.05, peak: 0.7 },
    { wave: 'triangle', freq: 440, to: 330, dur: 0.09, peak: 0.28 },
  ],
  chi: [
    { wave: 'triangle', freq: 660, dur: 0.07, peak: 0.35 },
    { wave: 'triangle', freq: 880, at: 0.07, dur: 0.09, peak: 0.35 },
  ],
  pong: [
    { noise: 1600, q: 3, dur: 0.04, peak: 0.6 },
    { wave: 'triangle', freq: 392, dur: 0.16, peak: 0.35 },
    { wave: 'sine', freq: 587, dur: 0.16, peak: 0.25 },
  ],
  kong: [
    { noise: 1200, q: 3, dur: 0.04, peak: 0.7 },
    { noise: 1000, q: 3, at: 0.08, dur: 0.05, peak: 0.7 },
    { wave: 'triangle', freq: 294, dur: 0.22, peak: 0.35 },
    { wave: 'sine', freq: 440, dur: 0.22, peak: 0.25 },
    { wave: 'sine', freq: 147, dur: 0.22, peak: 0.3 },
  ],
  flower: [
    { wave: 'sine', freq: 1568, dur: 0.08, peak: 0.15 },
    { wave: 'sine', freq: 2093, at: 0.04, dur: 0.08, peak: 0.15 },
    { wave: 'sine', freq: 2637, at: 0.08, dur: 0.1, peak: 0.15 },
  ],
  hu: [
    { wave: 'triangle', freq: 523, dur: 0.2, peak: 0.3 },
    { wave: 'triangle', freq: 659, at: 0.1, dur: 0.2, peak: 0.3 },
    { wave: 'triangle', freq: 784, at: 0.2, dur: 0.2, peak: 0.3 },
    { wave: 'triangle', freq: 1047, at: 0.3, dur: 0.7, peak: 0.3 },
    { wave: 'sine', freq: 523, at: 0.3, dur: 0.7, peak: 0.15 },
    { wave: 'sine', freq: 659, at: 0.3, dur: 0.7, peak: 0.15 },
  ],
  'hu-other': [
    { wave: 'sine', freq: 440, dur: 0.25, peak: 0.2 },
    { wave: 'sine', freq: 554, at: 0.14, dur: 0.25, peak: 0.2 },
    { wave: 'sine', freq: 659, at: 0.28, dur: 0.5, peak: 0.2 },
  ],
  drawgame: [
    { wave: 'sine', freq: 587, dur: 0.11, peak: 0.3 },
    { wave: 'sine', freq: 440, at: 0.12, dur: 0.12, peak: 0.3 },
  ],
  'your-turn': [{ wave: 'sine', freq: 988, dur: 0.12, peak: 0.22 }],
  'claim-available': [
    { wave: 'triangle', freq: 784, dur: 0.08, peak: 0.3 },
    { wave: 'triangle', freq: 1175, at: 0.09, dur: 0.1, peak: 0.3 },
  ],
  'timer-warning': [{ wave: 'triangle', freq: 1250, dur: 0.035, peak: 0.18 }],
  click: [{ wave: 'sine', freq: 2200, dur: 0.015, peak: 0.08 }],
  error: [{ wave: 'triangle', freq: 200, to: 160, dur: 0.12, peak: 0.4 }],
});

export const SOUND_NAMES = Object.freeze(Object.keys(SOUND_RECIPES));

// Total length of a sound in seconds.
export const soundDuration = (name) => Math.max(...SOUND_RECIPES[name].map((v) => (v.at ?? 0) + v.dur));

// At most `max` sounds; when cutting, the last one (a win, draw or prompt) is kept.
export function capSounds(names, max = MAX_BATCH) {
  return names.length <= max ? names : [...names.slice(0, max - 1), names[names.length - 1]];
}

// Engine events of one applyAction batch -> ordered sound names (at most MAX_BATCH).
export function soundsForEvents(events, { humanPlayer = HUMAN } = {}) {
  const out = [];
  for (const e of events ?? []) {
    if (!e) continue;
    const mine = e.player === humanPlayer;
    if (e.type === 'draw' && mine) out.push('draw');
    else if (e.type === 'discard') out.push(mine ? 'discard' : 'discard-other');
    else if (e.type === 'flower' || e.type === 'chi' || e.type === 'pong' || e.type === 'kong') out.push(e.type);
    else if (e.type === 'hu') out.push(mine ? 'hu' : 'hu-other');
    else if (e.type === 'drawgame') out.push('drawgame');
  }
  return capSounds(out);
}

// The human was asked to act: your-turn when a discard is due, claim-available otherwise.
export function soundsForPrompt(actions) {
  if (!actions || !actions.length) return [];
  return [actions.some((a) => a.type === 'discard') ? 'your-turn' : 'claim-available'];
}

function defaultAudioContext() {
  return globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
}

/**
 * createSound({ AudioContextImpl, now }) -> { play, setEnabled, enabled, unlock, names, stats }
 *   play(name, { immediate })  queues the sound ~100 ms after the previous one (immediate:
 *                              now, for UI clicks and timer ticks); returns true if scheduled.
 *   unlock()                   creates/resumes the AudioContext; call from a user gesture.
 * Never throws: without Web Audio, before unlock(), or when disabled, play() does nothing.
 */
export function createSound({ AudioContextImpl = defaultAudioContext(), now = () => Date.now() } = {}) {
  let ctx = null;
  let master = null;
  let noise = null;
  let broken = !AudioContextImpl;
  let nextSlot = 0; // ms (now clock) when the next queued sound may start
  const active = new Set();
  const stats = { started: 0, released: 0 };

  const sound = {
    enabled: true,
    names: SOUND_NAMES,
    stats,
    get context() {
      return ctx;
    },

    unlock() {
      if (broken) return false;
      try {
        if (!ctx) {
          ctx = new AudioContextImpl();
          master = ctx.createGain();
          master.gain.value = MASTER_GAIN;
          master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended' && ctx.resume) {
          const p = ctx.resume();
          if (p && p.catch) p.catch(() => {});
        }
        return true;
      } catch {
        broken = true;
        ctx = null;
        return false;
      }
    },

    setEnabled(on) {
      sound.enabled = Boolean(on);
      if (!sound.enabled) {
        for (const src of active) stopNow(src);
        nextSlot = 0;
      }
    },

    play(name, { immediate = false } = {}) {
      if (!sound.enabled || !ctx || broken || !SOUND_RECIPES[name]) return false;
      try {
        const t = now();
        const start = immediate ? t : Math.max(t, nextSlot);
        if (start - t > MAX_BACKLOG_MS) return false;
        if (!immediate) nextSlot = start + GAP_MS;
        const t0 = ctx.currentTime + (start - t) / 1000 + 0.005;
        for (const v of SOUND_RECIPES[name]) voice(v, t0);
        return true;
      } catch {
        return false;
      }
    },
  };

  function stopNow(src) {
    try {
      src.stop(ctx.currentTime);
    } catch {
      /* already stopped */
    }
  }

  function noiseBuffer() {
    if (!noise) {
      const len = Math.floor(ctx.sampleRate * 0.25);
      noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      let s = 12345;
      for (let i = 0; i < len; i++) {
        s = (Math.imul(s, 1103515245) + 12345) >>> 0;
        data[i] = s / 2147483648 - 1;
      }
    }
    return noise;
  }

  // One voice: source -> (band-pass) -> envelope gain -> master; released when it ends.
  function voice(v, t0) {
    const t = t0 + (v.at ?? 0);
    const end = t + v.dur;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(v.peak, t + Math.min(0.005, v.dur / 3));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    let src;
    let filter = null;
    if (v.noise) {
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer();
      filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(v.noise, t);
      filter.Q.setValueAtTime(v.q ?? 1, t);
      src.connect(filter);
      filter.connect(env);
    } else {
      src = ctx.createOscillator();
      src.type = v.wave;
      src.frequency.setValueAtTime(v.freq, t);
      if (v.to) src.frequency.exponentialRampToValueAtTime(v.to, end);
      src.connect(env);
    }
    env.connect(master);
    src.onended = () => {
      if (!active.delete(src)) return;
      stats.released += 1;
      src.disconnect();
      if (filter) filter.disconnect();
      env.disconnect();
    };
    active.add(src);
    stats.started += 1;
    src.start(t);
    src.stop(end + 0.02);
  }

  return sound;
}

/**
 * Unlocks Web Audio on a gesture anywhere in the document (iPhone plays no sound until a tap has
 * been seen). pointerdown and touchend both count, whichever comes first; keydown too, for a
 * keyboard. The listeners stay on: iOS may suspend the context again (a phone call, the screen
 * locking), and only a later gesture can resume it. They are cheap: while the context runs a
 * gesture returns at once without touching it. Without Web Audio they are removed on the first
 * gesture, since nothing will ever unlock.
 * target: the element to listen on (default document). Returns a function that removes them.
 */
export function unlockSoundOnGesture(sound, target = globalThis.document) {
  if (!sound || !target || typeof target.addEventListener !== 'function') return () => {};
  const events = ['pointerdown', 'touchend', 'keydown'];
  const on = () => {
    const ctx = sound.context;
    if (ctx && ctx.state === 'running') return; // nothing to do: a cheap no-op
    sound.unlock();
    if (!sound.context) off(); // no AudioContext in this browser: nothing to unlock
  };
  const off = () => {
    for (const name of events) target.removeEventListener(name, on, true);
  };
  for (const name of events) target.addEventListener(name, on, true);
  return off;
}

/**
 * Glue between the controller hooks and a createSound() instance. Never throws into the game.
 *   onEvents(events, c)        plays the batch (skipped while paused)
 *   onHumanPrompt(c, actions)  your-turn / claim-available, after that batch's sounds
 *   tick(c, nowMs)             call often (~100 ms): one tick per second in the claim
 *                              window's last 5 seconds; silent while paused or answered
 * defer(fn) runs fn after the current call stack (default queueMicrotask): a prompt raised
 * outside an applyAction batch (game start, resume) still sounds.
 */
export function createGameAudio(sound, { humanPlayer = HUMAN, defer = (fn) => queueMicrotask(fn) } = {}) {
  let pendingPrompt = null;
  let tickClaim = null;
  let tickSecond = null;

  const playAll = (names) => {
    for (const n of capSounds(names)) sound.play(n);
  };

  return {
    onEvents(events, c) {
      try {
        const prompt = pendingPrompt ?? [];
        pendingPrompt = null;
        if (c && c.paused) return;
        playAll([...soundsForEvents(events, { humanPlayer }), ...prompt]);
      } catch {
        /* sound must never break the game */
      }
    },

    onHumanPrompt(c, actions) {
      try {
        if (c && c.paused) return;
        // apply() opens the decision before onEvents: hold the prompt for that batch.
        pendingPrompt = soundsForPrompt(actions);
        defer(() => {
          if (!pendingPrompt) return;
          const p = pendingPrompt;
          pendingPrompt = null;
          playAll(p);
        });
      } catch {
        /* ignore */
      }
    },

    tick(c, nowMs) {
      try {
        if (!c || c.paused || c.isOver || c.stopped || c.claimDeadline == null || !c.state.claim) return;
        if (c.state.claim !== tickClaim) {
          tickClaim = c.state.claim;
          tickSecond = null;
        }
        const remain = c.claimDeadline - nowMs;
        if (remain <= 0 || remain > WARN_MS) return;
        const second = Math.ceil(remain / 1000);
        if (second === tickSecond) return;
        tickSecond = second;
        sound.play('timer-warning', { immediate: true });
      } catch {
        /* ignore */
      }
    },
  };
}
