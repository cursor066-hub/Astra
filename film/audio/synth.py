"""DSP primitives and synthesised orchestral instruments for the STARMENDER score.

Everything is generated from oscillators and noise; there are no samples.
All functions return float64 arrays at SR, mono (n,) or stereo (n, 2).
"""
import numpy as np
from scipy import signal
from scipy.ndimage import uniform_filter1d

SR = 48000
TAU = 2.0 * np.pi
_SEMI = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


# ----------------------------------------------------------------- helpers

def hz(name):
    """'F#4' -> frequency in Hz (A4 = 440). Numbers pass through."""
    if not isinstance(name, str):
        return float(name)
    p = _SEMI[name[0]]
    i = 1
    while name[i] in '#b':
        p += 1 if name[i] == '#' else -1
        i += 1
    midi = 12 * (int(name[i:]) + 1) + p
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def db(x):
    return 10.0 ** (x / 20.0)


def secs(t):
    return int(round(t * SR))


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-20))


def lp(x, fc, order=2):
    sos = signal.butter(order, min(fc, 0.45 * SR), 'low', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)


def hp(x, fc, order=2):
    sos = signal.butter(order, fc, 'high', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)


def bp(x, lo, hi, order=2):
    sos = signal.butter(order, [lo, min(hi, 0.45 * SR)], 'band', fs=SR, output='sos')
    return signal.sosfilt(sos, x, axis=0)


def reson(x, f, q):
    """Two-pole resonator with unity gain at f."""
    b, a = signal.iirpeak(min(f, 0.45 * SR), q, fs=SR)
    return signal.lfilter(b, a, x, axis=0)


def peq(x, f, gain_db, q=1.0):
    """RBJ peaking EQ."""
    A = 10.0 ** (gain_db / 40.0)
    w = TAU * f / SR
    al = np.sin(w) / (2.0 * q)
    b = np.array([1 + al * A, -2 * np.cos(w), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w), 1 - al / A])
    return signal.lfilter(b / a[0], a / a[0], x, axis=0)


def env_ar(n, a, r):
    """Raised-cosine attack and release (seconds) over n samples."""
    e = np.ones(n)
    na = max(1, min(secs(a), n))
    nr = max(1, min(secs(r), n))
    e[:na] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(na) / na)
    e[n - nr:] *= 0.5 + 0.5 * np.cos(np.pi * (np.arange(nr) + 1) / nr)
    return e


def curve(n, pts):
    """Breakpoint envelope: pts = [(seconds, value), ...]."""
    xs, ys = zip(*pts)
    return np.interp(np.arange(n) / SR, xs, ys)


def fade(x, a=0.002, r=0.01):
    e = env_ar(len(x), a, r)
    return x * (e[:, None] if x.ndim == 2 else e)


def pan(x, p):
    """Mono -> stereo, constant power. p in [-1, 1], scalar or per-sample."""
    a = (np.clip(p, -1.0, 1.0) + 1.0) * (np.pi / 4.0)
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)


def slow_rand(n, rate, rng):
    """Smooth random control signal in about [-1, 1] moving at ~rate Hz."""
    step = max(1, int(SR / rate))
    k = n // step + 3
    x = np.interp(np.arange(n) / step, np.arange(k), rng.uniform(-1, 1, k))
    return uniform_filter1d(x, size=step, mode='nearest')


def saw(f, n=None, ph0=0.0):
    """Band-limited (polyBLEP) sawtooth. f is Hz, scalar (needs n) or per-sample."""
    dt = np.full(n, f / SR) if np.isscalar(f) else np.asarray(f) / SR
    ph = (ph0 + np.cumsum(dt)) % 1.0
    y = 2.0 * ph - 1.0
    m = ph < dt
    x = ph[m] / dt[m]
    y[m] -= x + x - x * x - 1.0
    m = ph > 1.0 - dt
    x = (ph[m] - 1.0) / dt[m]
    y[m] -= x * x + x + x + 1.0
    return y


def swept_noise(n, fc, bw, rng):
    """Band of noise `bw` Hz wide whose centre follows fc (heterodyned), unit RMS."""
    z = lp(rng.standard_normal(n), bw / 2.0) + 1j * lp(rng.standard_normal(n), bw / 2.0)
    ph = TAU * np.cumsum(np.broadcast_to(np.asarray(fc, dtype=float), (n,))) / SR
    y = (z * np.exp(1j * ph)).real
    return y / rms(y)


# ------------------------------------------------------------- instruments

def ensemble(freq, n, rng, voices=6, detune=9.0, spread=0.7, center=0.0,
             vib=1.0, vib_delay=0.2, trem=0.0, bend=None):
    """Section of detuned saw voices, each with its own vibrato, drift and seat."""
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    vib_env = np.clip((t - vib_delay) / 0.4, 0.0, 1.0)
    for v in range(voices):
        c = float(np.clip(rng.normal(0, detune), -2.2 * detune, 2.2 * detune))
        c = c + 2.5 * np.sin(TAU * rng.uniform(0.15, 0.6) * t + rng.uniform(0, TAU))
        if vib > 0:
            c = c + (rng.uniform(4, 9) * vib * vib_env
                     * np.sin(TAU * rng.uniform(4.9, 6.3) * t + rng.uniform(0, TAU)))
        if bend is not None:
            c = c + bend
        s = saw(freq * 2.0 ** (c / 1200.0), ph0=rng.random())
        if trem > 0:  # every player bows a tremolo at their own speed
            s *= (1 - trem) + trem * np.abs(
                np.sin(np.pi * rng.uniform(11, 15) * t + rng.uniform(0, TAU)))
        p = center + (spread * (2.0 * v / (voices - 1) - 1.0) if voices > 1 else 0.0)
        out += pan(s, p + rng.uniform(-0.08, 0.08))
    return out / np.sqrt(voices)


def strings(freq, dur, vel, rng, attack=0.2, release=0.3, voices=6, bright=None,
            detune=9.0, spread=0.7, center=0.0, vib=1.0, trem=0.0, dyn=None, bend=None):
    """Bowed string section. dyn = [(seconds, level)] swells level and brightness."""
    n = secs(dur + release)
    x = ensemble(freq, n, rng, voices, detune, spread, center, vib, 0.2, trem, bend)
    if bright is None:
        bright = float(np.clip(freq * 5.0, 1200.0, 4200.0)) * (0.55 + 0.75 * vel)
    e = env_ar(n, attack, release)
    if dyn is not None:
        d = curve(n, dyn)
        b = (np.clip(d / max(d.max(), 1e-9), 0, 1) ** 0.7)[:, None]
        x = lp(x, bright * 0.45) * (1 - b) + lp(x, bright) * b
        e = e * d
    else:
        x = lp(x, bright)
    x = hp(x, freq * 0.6, 1)
    return x * e[:, None] * vel


def spicc(freq, vel, rng, length=0.1, voices=3, spread=0.5, center=0.0):
    """Short bowed stroke for ostinati: bright bite that closes quickly."""
    n = secs(length + 0.07)
    t = np.arange(n) / SR
    x = ensemble(freq, n, rng, voices, 7.0, spread, center, vib=0.0)
    b = float(np.clip(freq * 6.0, 1500.0, 5000.0)) * (0.6 + 0.7 * vel)
    w = np.exp(-t / 0.035)[:, None]
    x = lp(x, b * 0.35) * (1 - w) + lp(x, b) * w
    x += pan(bp(rng.standard_normal(n), 1800, 5200) * np.exp(-t / 0.01) * 0.12, center)
    e = (1 - np.exp(-t / 0.004)) * np.exp(-t / (length * 0.65))
    return fade(x * e[:, None], 0.001, 0.02) * vel


def brass(freq, dur, vel, rng, voices=3, attack=0.05, release=0.12, bright=1900.0,
          dark=450.0, spread=0.25, center=0.0, vib=0.6, dyn=None, horn=True):
    """Horn / brass: saws through a filter that opens with the envelope."""
    n = secs(dur + release)
    t = np.arange(n) / SR
    x = ensemble(freq, n, rng, voices, 4.0, spread, center, vib, 0.3)
    e = env_ar(n, attack, release)
    if dyn is not None:
        e = e * curve(n, dyn)
    b = np.clip(e ** 1.4 * (0.72 + 0.45 * np.exp(-t / 0.12)), 0, 1) * (0.45 + 0.55 * vel)
    b = b[:, None]
    x = lp(x, dark) * (1 - b) + lp(lp(x, bright), bright * 1.6, 1) * b
    if horn:
        x = peq(x, 480.0, 4.0, 1.4)
    return x * e[:, None] * vel


_VOWELS = {
    'ah_f': [(800, 1.0, 8), (1150, 0.6, 10), (2900, 0.12, 13), (3900, 0.05, 13)],
    'oo_f': [(380, 1.0, 6), (800, 0.22, 9), (2700, 0.04, 13)],
    'ah_m': [(650, 1.0, 7), (1080, 0.55, 10), (2650, 0.13, 13), (3300, 0.05, 13)],
    'oo_m': [(330, 1.0, 6), (760, 0.22, 9), (2400, 0.04, 13)],
}


def _formants(src, freq, vowel):
    y = 0.16 * lp(src, 1200.0)
    for i, (f, g, q) in enumerate(_VOWELS[vowel]):
        if i == 0:
            f = max(f, freq * 1.02)  # first formant tracks high notes
        y = y + g * reson(src, f, q)
    return y


def choir(freq, dur, vel, rng, vowel='ah', attack=0.35, release=0.5, voices=5,
          spread=0.85, center=0.0, dyn=None, morph=None):
    """Wordless choir. morph = [(seconds, 0..1)] glides from 'oo' to 'ah'."""
    n = secs(dur + release)
    x = ensemble(freq, n, rng, voices, 12.0, spread, center, vib=1.6, vib_delay=0.1)
    src = lp(x, 4500.0, 1) + 0.035 * rng.standard_normal((n, 2))
    g = 'f' if freq > 300.0 else 'm'
    if morph is not None:
        m = curve(n, morph)[:, None]
        y = _formants(src, freq, 'oo_' + g) * (1 - m) + _formants(src, freq, 'ah_' + g) * m
    else:
        y = _formants(src, freq, vowel + '_' + g)
    y = lp(y, 6000.0) * (0.25 / rms(y))
    e = env_ar(n, attack, release)
    if dyn is not None:
        e = e * curve(n, dyn)
    return y * e[:, None] * vel


def musicbox(freq, vel, rng, dur=2.6, warm=0.0):
    """Music box / celesta: struck tine with a few fast inharmonic partials."""
    n = secs(dur)
    t = np.arange(n) / SR
    k = (440.0 / freq) ** 0.5
    y = np.zeros(n)
    hi = 1.0 - 0.6 * warm
    for r, a, tau in ((1.0, 1.0, 1.5), (2.0, 0.22, 0.8), (3.01, 0.07 * hi, 0.4),
                      (5.43, 0.11 * hi, 0.10), (8.21, 0.05 * hi, 0.05)):
        f = freq * r
        if f > 9000.0:
            continue
        y += a * np.exp(-t / (tau * k)) * (np.sin(TAU * f * t)
                                          + 0.5 * np.sin(TAU * f * 1.0017 * t))
    y += bp(rng.standard_normal(n), 3000, 6500) * np.exp(-t / 0.002) * 0.05 * hi
    return fade(y, 0.0015, 0.03) * vel * 0.6


def piano(freq, vel, rng, dur=3.0):
    """Felt piano: stretched partials, soft hammer, two slightly detuned strings."""
    n = secs(dur)
    t = np.arange(n) / SR
    B = 0.00035
    tau0 = float(np.clip(2.4 * (261.6 / freq) ** 0.6, 0.7, 4.0))
    y = np.zeros(n)
    for k in range(1, min(18, int(7000.0 / freq)) + 1):
        fk = k * freq * np.sqrt(1.0 + B * k * k)
        ak = k ** -1.2 * np.exp(-k / (3.5 + 7.0 * vel))
        tk = tau0 / (1.0 + 0.35 * (k - 1))
        dec = 0.65 * np.exp(-t / (tk * 0.3)) + 0.35 * np.exp(-t / tk)
        ph = rng.uniform(0, TAU)
        y += ak * dec * 0.5 * (np.sin(TAU * fk * t) + np.sin(TAU * fk * 1.0005 * t + ph * 0.1))
    y += lp(rng.standard_normal(n), 180.0) * np.exp(-t / 0.02) * 0.25
    y = lp(y, 3200.0 * (0.6 + vel), 1)
    return fade(y, 0.005, 0.15) * vel


def pizz(freq, vel, rng, dur=0.9):
    n = secs(dur)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for k in range(1, 11):
        if k * freq > 6000.0:
            break
        y += np.sin(TAU * k * freq * t) * k ** -1.1 * np.exp(-t * k ** 0.8 / 0.3)
    return fade(lp(y, 2600.0), 0.001, 0.05) * vel


def pure_tone(freq, dur, rng, attack=0.8, release=0.6, dyn=None):
    """Glassy sustained tone (sine plus faint harmonics) with slow-blooming vibrato."""
    n = secs(dur + release)
    t = np.arange(n) / SR
    vib = np.clip((t - 0.5) / 1.0, 0, 1) * 6.0 * np.sin(TAU * 5.2 * t)
    ph = TAU * np.cumsum(freq * 2.0 ** (vib / 1200.0)) / SR
    y = np.sin(ph) + 0.14 * np.sin(2 * ph + 0.4) + 0.05 * np.sin(3 * ph + 1.1)
    y *= 1.0 + 0.06 * slow_rand(n, 2.0, rng)
    e = env_ar(n, attack, release)
    if dyn is not None:
        e = e * curve(n, dyn)
    return y * e


def sub(freq, dur, vel, attack=0.02, release=0.1, dyn=None):
    """Sub bass: sine with a little second/third harmonic so it reads on small speakers."""
    n = secs(dur + release)
    t = np.arange(n) / SR
    ph = TAU * freq * t
    y = np.tanh(1.2 * (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph))) / 0.83
    e = env_ar(n, attack, release)
    if dyn is not None:
        e = e * curve(n, dyn)
    return y * e * vel


_TAIKO = {  # f0, pitch sweep, decay, skin noise, stick click
    'big': (50.0, 2.4, 0.50, 0.7, 0.30),
    'low': (66.0, 2.2, 0.30, 0.6, 0.30),
    'mid': (104.0, 1.8, 0.19, 0.6, 0.35),
    'hi': (255.0, 1.3, 0.065, 0.9, 0.60),
}


def taiko(kind, vel, rng):
    """Big drum: pitch-swept sine body, membrane overtones, skin noise, stick click."""
    f0, sweep, decay, noise, click = _TAIKO[kind]
    decay *= 0.75 + 0.25 * vel
    n = secs(decay * 5.0 + 0.05)
    t = np.arange(n) / SR
    ph = TAU * np.cumsum(f0 * (1.0 + (sweep - 1.0) * np.exp(-t / 0.022))) / SR
    y = (np.sin(ph) * np.exp(-t / decay)
         + 0.40 * np.sin(1.58 * ph + 0.3) * np.exp(-t / (decay * 0.45))
         + 0.20 * np.sin(2.30 * ph + 0.9) * np.exp(-t / (decay * 0.25)))
    y += bp(rng.standard_normal(n), 90, 1400) * np.exp(-t / 0.045) * noise
    y += bp(rng.standard_normal(n), 1500, 6000) * np.exp(-t / 0.003) * click
    y = np.tanh(1.5 * y * (0.5 + 0.5 * vel)) / 0.9
    return fade(y, 0.0005, 0.03) * vel


def _cymbal_noise(n, rng):
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for ch in range(2):
        x = lp(hp(rng.standard_normal(n), 2600.0), 9000.0, 4)
        m = np.zeros(n)
        for f in rng.uniform(2600.0, 8600.0, 28):
            m += np.sin(TAU * f * t + rng.uniform(0, TAU))
        out[:, ch] = x / rms(x) + 0.5 * m / rms(m)
    return out * 0.5


def crash(rng, dur=2.2):
    n = secs(dur)
    t = np.arange(n) / SR
    x = _cymbal_noise(n, rng)
    w = np.exp(-t / 0.5)[:, None]
    x = lp(x, 4200.0) * (1 - w) + x * w
    e = 0.6 * np.exp(-t / 0.22) + 0.4 * np.exp(-t / 0.85)
    return fade(x * e[:, None], 0.001, 0.2)


def swell(rng, dur, shape=3.0, tail=0.12):
    """Cymbal roll crescendo peaking at dur, then a short tail."""
    n = secs(dur + tail)
    t = np.arange(n) / SR
    x = _cymbal_noise(n, rng)
    e = np.where(t < dur, (t / dur) ** shape, np.exp(-(t - dur) / (tail * 0.3)))
    return fade(x * e[:, None], 0.01, 0.03)


def shepard(n, rng, octs=2.0, fmin=55.0, n_oct=7, c0=300.0, c1=1400.0, width=1.1):
    """Endlessly rising tone stack; the spectral centre climbs from c0 to c1."""
    u = np.arange(n) / n
    cpos = np.log2(c0 * (c1 / c0) ** u / fmin)
    y = np.zeros(n)
    for k in range(n_oct):
        pos = (k + octs * u) % n_oct
        w = np.exp(-0.5 * ((pos - cpos) / width) ** 2) * np.sin(np.pi * pos / n_oct) ** 2
        y += w * np.sin(TAU * np.cumsum(fmin * 2.0 ** pos) / SR + rng.uniform(0, TAU))
    return y / max(1e-9, np.max(np.abs(y)))


def make_ir(rng, rt60, predelay, hf=0.45, lo_cut=160.0, hi_cut=7000.0, n_early=7):
    """Synthetic stereo room: decaying noise with faster HF decay plus sparse early taps."""
    n = secs(rt60 * 1.35 + predelay + 0.1)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for ch in range(2):
        w = rng.standard_normal(n)
        low = lp(w, 400.0)
        high = hp(w, 3000.0)
        mid = w - low - high
        k = 6.91 / rt60
        y = (low * np.exp(-k * t / 1.15) + mid * np.exp(-k * t)
             + high * np.exp(-k * t / hf))
        ir[:, ch] = y * (1.0 - np.exp(-t / 0.015))
    ir = lp(hp(ir, lo_cut), hi_cut, 1)
    ir /= np.sqrt(np.sum(ir ** 2, axis=0, keepdims=True))
    for _ in range(n_early):
        d = secs(rng.uniform(0.004, 0.06))
        g = rng.uniform(0.08, 0.2) * rng.choice([-1.0, 1.0])
        p = rng.uniform(-1, 1)
        ir[d, 0] += g * np.cos((p + 1) * np.pi / 4)
        ir[d, 1] += g * np.sin((p + 1) * np.pi / 4)
    pd = secs(predelay)
    out = np.zeros((n + pd, 2))
    out[pd:] = ir
    return out
