// Favilla's music renderer, run in a page the music tool serves to a headless browser. It plays recorded samples into
// one stem per part (OfflineAudioContext), mixes them by role through one room, brings the whole to its loudness
// target under a true-peak ceiling, and measures what a mix engineer would check: how far each part sits under the
// tune where the ear follows it, loudness, its range, peaks and brightness. The WAV goes back by POST.
(() => {
  const SR = 48000;

  // ---------- small DSP ----------

  /** RBJ cookbook biquad coefficients. */
  function biquad(type, f, q, gainDb = 0) {
    const w = (2 * Math.PI * f) / SR;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'bandpass') [b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
    else if (type === 'highpass') [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    else if (type === 'lowpass') [b0, b1, b2, a0, a1, a2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
    else [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function filter(x, c) {
    const [b0, b1, b2, a1, a2] = c;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  const mono = (buf) => {
    const a = buf.getChannelData(0);
    const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
    const m = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) m[i] = 0.5 * (a[i] + b[i]);
    return m;
  };

  /** Level in dB over windows of `win` seconds every `hop` seconds. */
  function levels(x, win, hop) {
    const n = Math.floor(win * SR);
    const h = Math.floor(hop * SR);
    const out = [];
    for (let i = 0; i + n <= x.length; i += h) {
      let s = 0;
      for (let j = i; j < i + n; j++) s += x[j] * x[j];
      out.push(10 * Math.log10(s / n + 1e-12));
    }
    return out;
  }

  // ITU-R BS.1770 K-weighting at 48 kHz.
  const K1 = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585];
  const K2 = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621];

  /** Mean square of K-weighted channels summed, in 400 ms blocks every 100 ms (or windows given). */
  function kBlocks(chans, win = 0.4, hop = 0.1) {
    const k = chans.map((c) => filter(filter(c, K1), K2));
    const n = Math.floor(win * SR);
    const h = Math.floor(hop * SR);
    const out = [];
    for (let i = 0; i + n <= k[0].length; i += h) {
      let z = 0;
      for (const c of k) {
        let s = 0;
        for (let j = i; j < i + n; j++) s += c[j] * c[j];
        z += s / n;
      }
      out.push(z);
    }
    return out;
  }
  const lufs = (z) => -0.691 + 10 * Math.log10(z + 1e-12);

  function integrated(chans) {
    const z = kBlocks(chans).filter((b) => lufs(b) > -70);
    if (!z.length) return -70;
    const mean = z.reduce((a, b) => a + b, 0) / z.length;
    const gated = z.filter((b) => lufs(b) > lufs(mean) - 10);
    return lufs(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length));
  }

  /** Short-term (3 s) loudness every second: the range between its 10th and 95th percentiles (EBU Tech 3342, simplified). */
  function shortTerm(chans) {
    return kBlocks(chans, 3, 0.5).map(lufs);
  }

  // A 4x polyphase interpolator (windowed sinc, 48 taps) for true peak.
  const PHASES = 4;
  const TAPS = 12;
  const FIR = (() => {
    const out = [];
    for (let p = 0; p < PHASES; p++) {
      const row = [];
      for (let t = -TAPS / 2; t < TAPS / 2; t++) {
        const x = t + p / PHASES;
        const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (TAPS / 2 + 1));
        row.push(sinc * w);
      }
      out.push(row);
    }
    return out;
  })();

  /** The true-peak estimate around each sample: the largest of its four interpolated neighbours. */
  function truePeaks(x) {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let m = Math.abs(x[i]);
      for (let p = 1; p < PHASES; p++) {
        const row = FIR[p];
        let s = 0;
        for (let t = 0; t < TAPS; t++) {
          const j = i + t - TAPS / 2 + 1;
          if (j >= 0 && j < x.length) s += row[t] * x[j];
        }
        const a = Math.abs(s);
        if (a > m) m = a;
      }
      out[i] = m;
    }
    return out;
  }

  /** Gain that keeps every true peak under `ceiling`: 5 ms of look-ahead, 80 ms to let go. */
  function limit(chans, ceiling) {
    const n = chans[0].length;
    const peaks = chans.map(truePeaks);
    const need = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (const q of peaks) if (q[i] > p) p = q[i];
      need[i] = p > ceiling ? ceiling / p : 1;
    }
    const look = Math.floor(0.005 * SR);
    const gain = new Float32Array(n);
    // A sliding minimum over the look-ahead, then a smooth return.
    const dq = [];
    for (let i = n - 1; i >= 0; i--) {
      while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
      dq.push(i);
      while (dq[0] > i + look) dq.shift();
      gain[i] = need[dq[0]];
    }
    const rel = 1 - Math.exp(-1 / (0.08 * SR));
    let g = 1;
    let reduced = 0;
    for (let i = 0; i < n; i++) {
      g = gain[i] < g ? gain[i] : g + (1 - g) * rel;
      if (g < 0.999) reduced++;
      for (const c of chans) c[i] *= g;
    }
    return reduced / n;
  }

  // ---------- the room ----------

  /** A stereo room: early reflections, then a decaying tail that darkens as it dies. */
  function roomIR(room) {
    const rt = { dry: 0.35, studio: 0.7, salon: 1.3, chamber: 1.3, hall: 2.2, church: 3.4 }[room] ?? 1.3;
    const len = Math.floor(Math.min(4, rt * 1.2) * SR);
    const ctx = new OfflineAudioContext(2, len, SR);
    const buf = ctx.createBuffer(2, len, SR);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const pre = Math.floor(0.012 * SR);
      for (let k = 0; k < 9; k++) {
        const at = pre + Math.floor((0.004 + 0.07 * Math.abs(rnd())) * SR);
        if (at < len) d[at] += 0.5 * rnd() * (1 - k / 12);
      }
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / SR;
        const decay = Math.exp((-6.9 * t) / rt);
        const dark = Math.min(0.92, 0.2 + t / rt);
        lp = (1 - dark) * rnd() + dark * lp;
        d[i] += lp * decay * 0.6;
      }
    }
    return buf;
  }

  // ---------- rendering ----------

  async function decodeAll(urls) {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const out = new Map();
    await Promise.all(
      urls.map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`could not load ${u}: ${r.status}`);
        out.set(u, await ctx.decodeAudioData(await r.arrayBuffer()));
      }),
    );
    return out;
  }

  /** One part: every note a sample at its pitch, its gain shaped by attack and release; long sustains crossfade a fresh take. */
  async function stem(part, buffers, length) {
    const ctx = new OfflineAudioContext(2, Math.ceil(length * SR), SR);
    for (const n of part.notes) {
      const buf = buffers.get(n.url);
      if (!buf) continue;
      const peak = Math.pow(10, n.gainDb / 20);
      const release = Math.max(0.03, n.release);
      const usable = buf.duration / n.rate - 0.05;
      const takes = [];
      if (part.sustained && n.dur > usable - 0.4) {
        // A held string note longer than its sample: a new take fades in as the old fades out.
        const fade = 0.6;
        for (let t = n.t; t < n.t + n.dur; t += usable - fade) takes.push([t, Math.min(n.t + n.dur, t + usable - fade) - t, t > n.t ? fade : n.attack]);
      } else takes.push([n.t, Math.min(n.dur, usable), n.attack]);
      takes.forEach(([t0, d, attack], k) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = n.rate;
        const g = ctx.createGain();
        const start = Math.max(0, t0);
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(peak, start + Math.max(0.002, attack));
        const end = start + Math.max(0.01, d);
        g.gain.setValueAtTime(peak, end);
        const last = k === takes.length - 1;
        g.gain.setTargetAtTime(0, end, (last ? release : 0.6) / 3);
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, n.pan));
        src.connect(g).connect(p).connect(ctx.destination);
        src.start(start);
        src.stop(Math.min(length, end + (last ? release : 0.6) * 2.5 + 0.02));
      });
    }
    return ctx.startRendering();
  }

  /** A part's gain over time: down by depthDb while a tune note sounds (30 ms to lean back, 300 ms to return). */
  function duckCurve(job, length, depthDb, base) {
    const rate = 100;
    const n = Math.max(2, Math.ceil(length * rate));
    const env = new Float32Array(n).fill(1);
    const down = Math.pow(10, -depthDb / 20);
    for (const [a, d] of job.tuneNotes ?? []) for (let i = Math.max(0, Math.floor((a - 0.03) * rate)); i < Math.min(n, Math.ceil((a + d) * rate)); i++) env[i] = down;
    const att = 1 - Math.exp(-1 / (0.03 * rate));
    const rel = 1 - Math.exp(-1 / (0.3 * rate));
    let g = 1;
    for (let i = 0; i < n; i++) {
      const t = env[i];
      g += (t - g) * (t < g ? att : rel);
      env[i] = g * base;
    }
    return env;
  }

  async function mix(parts, stems, length, job) {
    const ctx = new OfflineAudioContext(2, Math.ceil(length * SR), SR);
    const bus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 8;
    comp.ratio.value = 2;
    comp.attack.value = 0.02;
    comp.release.value = 0.25;
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = roomIR(job.room);
    const wet = ctx.createGain();
    wet.gain.value = { dry: 0.08, studio: 0.18, salon: 0.26, chamber: 0.26, hall: 0.34, church: 0.4 }[job.room] ?? 0.26;
    conv.connect(wet).connect(bus);
    bus.connect(comp).connect(ctx.destination);
    parts.forEach((part, i) => {
      const src = ctx.createBufferSource();
      src.buffer = stems[i];
      const g = ctx.createGain();
      const level = Math.pow(10, part.levelDb / 20);
      if (part.duck) g.gain.setValueCurveAtTime(duckCurve(job, length, part.duck, level), 0, length);
      else g.gain.value = level;
      let node = src.connect(g);
      if (part.carve) {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = 2500;
        f.Q.value = 0.9;
        f.gain.value = -part.carve;
        node = node.connect(f);
      }
      if (part.lowpass) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = part.lowpass;
        f.Q.value = 0.6;
        node = node.connect(f);
      }
      node.connect(bus);
      const send = ctx.createGain();
      send.gain.value = part.send;
      node.connect(send).connect(conv);
      src.start(0);
    });
    return ctx.startRendering();
  }

  function wav24(chans) {
    const n = chans[0].length;
    const bytes = 44 + n * chans.length * 3;
    const buf = new ArrayBuffer(bytes);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, bytes - 8, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, chans.length, true);
    v.setUint32(24, SR, true);
    v.setUint32(28, SR * chans.length * 3, true);
    v.setUint16(32, chans.length * 3, true);
    v.setUint16(34, 24, true);
    str(36, 'data');
    v.setUint32(40, n * chans.length * 3, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (const c of chans) {
        const s = Math.max(-1, Math.min(1, c[i]));
        const q = Math.round(s * 8388607);
        v.setUint8(o, q & 255);
        v.setUint8(o + 1, (q >> 8) & 255);
        v.setUint8(o + 2, (q >> 16) & 255);
        o += 3;
      }
    }
    return buf;
  }

  const pct = (xs, p) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  };

  window.__music = async (job) => {
    const t0 = performance.now();
    const urls = [...new Set(job.parts.flatMap((p) => p.notes.map((n) => n.url)))];
    const buffers = await decodeAll(urls);
    const stems = [];
    for (const part of job.parts) stems.push(await stem(part, buffers, job.length));

    // Where the ear follows a tune (1-4 kHz): each part's level against the tune's, after its fader and carve.
    const band = biquad('bandpass', 2000, 0.7);
    // The fader with its duck, at each window's middle.
    const fader = (p) => {
      if (!p.duck) return () => p.levelDb;
      const c = duckCurve(job, job.length, p.duck, 1);
      return (w) => p.levelDb + 20 * Math.log10(c[Math.min(c.length - 1, Math.round((w * 0.2 + 0.2) * 100))]);
    };
    const faders = job.parts.map(fader);
    const bandLevels = job.parts.map((p, i) => levels(filter(mono(stems[i]), band), 0.4, 0.2).map((d, w) => d + faders[i](w) - (p.carve ?? 0) * 0.6));
    const fullLevels = job.parts.map((p, i) => levels(mono(stems[i]), 0.4, 0.2).map((d, w) => d + faders[i](w)));
    const tuneIdx = job.parts.findIndex((p) => p.role === 'tune');
    const front = [];
    const apart = [];
    if (tuneIdx >= 0) {
      const tune = bandLevels[tuneIdx];
      // While a tune note sounds, its first half, where the ear holds it: the score says when, not a level guessed from the sound.
      const heard = tune.map((_, w) => {
        const t = w * 0.2 + 0.2;
        return (job.tuneSpans ?? []).some(([a, b]) => t >= a && t <= b);
      });
      const tuneHeld = fullLevels[tuneIdx].filter((_, w) => heard[w]);
      const tuneFull = pct(tuneHeld.length ? tuneHeld : fullLevels[tuneIdx], 0.5);
      job.parts.forEach((p, i) => {
        if (i === tuneIdx || p.role === 'hits') return;
        // Only where both sound: a part that answers now and then is measured while it answers.
        const own = Math.max(...bandLevels[i]);
        const ownFull = Math.max(...fullLevels[i]);
        const margins = [];
        const overall = [];
        tune.forEach((d, w) => {
          if (heard[w] && bandLevels[i][w] > own - 25) margins.push(d - bandLevels[i][w]);
          if (heard[w] && fullLevels[i][w] > ownFull - 25) overall.push(fullLevels[tuneIdx][w] - fullLevels[i][w]);
        });
        // Two seconds together at least, or the comparison says nothing; parts that speak in the gaps report their own level against the tune.
        if (margins.length >= 10) front.push({ role: p.role, median: pct(margins, 0.5), worst: pct(margins, 0.1), over: margins.filter((m) => m < 0).length / margins.length, overall: pct(overall, 0.5) });
        else if (ownFull > -60) {
          const active = fullLevels[i].filter((v) => v > ownFull - 20);
          if (active.length) apart.push({ role: p.role, overall: tuneFull - pct(active, 0.5) });
        }
      });
    }

    const mixed = await mix(job.parts, stems, job.length, job);
    const L = new Float32Array(mixed.getChannelData(0));
    const R = new Float32Array(mixed.getChannelData(1));
    // The ending: the last chord rings, then fades.
    const fade = Math.floor((job.fade ?? 0.8) * SR);
    for (let i = 0; i < fade && i < L.length; i++) {
      const g = i / fade;
      L[L.length - 1 - i] *= g;
      R[R.length - 1 - i] *= g;
    }
    const before = integrated([L, R]);
    const gain = Math.pow(10, (job.lufs - before) / 20);
    for (let i = 0; i < L.length; i++) {
      L[i] *= gain;
      R[i] *= gain;
    }
    const ceiling = Math.pow(10, job.peak / 20);
    const limited = limit([L, R], ceiling);
    const after = integrated([L, R]);
    const top = (x) => x.reduce((m, v) => (v > m ? v : m), 0);
    const peakDb = 20 * Math.log10(Math.max(top(truePeaks(L)), top(truePeaks(R))) + 1e-12);
    const st = shortTerm([L, R]);
    const gated = st.filter((v) => v > after - 20);
    const range = gated.length ? pct(gated, 0.95) - pct(gated, 0.1) : 0;
    const m = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) m[i] = 0.5 * (L[i] + R[i]);
    const hi = filter(filter(m, biquad('highpass', 8000, 0.7)), biquad('highpass', 8000, 0.7));
    let eAll = 0;
    let eHi = 0;
    for (let i = 0; i < m.length; i++) {
      eAll += m[i] * m[i];
      eHi += hi[i] * hi[i];
    }
    // Clicks: a jump between neighbouring samples far beyond the music around it.
    const res = await fetch(job.out, { method: 'POST', body: wav24([L, R]) });
    if (!res.ok) throw new Error(`could not hand the render back: ${res.status}`);
    return {
      seconds: (performance.now() - t0) / 1000,
      lufs: after,
      truePeak: peakDb,
      range,
      limited,
      highShare: eHi / Math.max(1e-12, eAll),
      front,
      apart,
      shortTerm: st.map((v, i) => [i * 0.5 + 1.5, Math.round(v * 10) / 10]),
      samples: urls.length,
    };
  };
})();
