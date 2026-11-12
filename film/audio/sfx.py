"""Synthesised sound effects for STARMENDER: glass, cloth, thread, wind, impacts."""
import numpy as np

from synth import (SR, TAU, bp, curve, env_ar, fade, hp, lp, pan, reson, rms, secs,
                   slow_rand, swept_noise)


def _t(n):
    return np.arange(n) / SR


def _stereo(mid, side, width=0.5):
    return np.stack([mid + width * side, mid - width * side], axis=1)


# ------------------------------------------------------------------ glass

def bar_tone(f, n, ratios, amps, taus, beat=0.0):
    """Struck bar/bead: inharmonic sine partials; `beat` adds a slow shimmer."""
    t = _t(n)
    y = np.zeros(n)
    for r, a, tau in zip(ratios, amps, taus):
        fr = f * r
        if fr > 9200.0:
            continue
        y += a * np.sin(TAU * fr * t) * np.exp(-t / tau)
        if beat:
            y += 0.6 * a * np.sin(TAU * fr * (1.0 + beat) * t) * np.exp(-t / tau)
    return y


def glass_ting(rng, f, dur=0.9, bright=1.0):
    n = secs(dur)
    y = bar_tone(f, n, (1.0, 2.71, 5.13, 7.9),
                 (1.0, 0.5 * bright, 0.25 * bright, 0.1 * bright),
                 (dur * 0.3, dur * 0.16, dur * 0.07, dur * 0.035))
    y += bp(rng.standard_normal(n), 3000, 7000) * np.exp(-_t(n) / 0.0015) * 0.12 * bright
    return fade(y, 0.0008, 0.03)


def chime(rng, f, dur=2.6):
    """Glass bead swinging on a thread: long ring with slow beating."""
    n = secs(dur)
    k = dur / 2.6
    y = bar_tone(f, n, (1.0, 2.76, 5.40, 8.93), (1.0, 0.4, 0.18, 0.06),
                 (0.9 * k, 0.45 * k, 0.2 * k, 0.1 * k), beat=rng.uniform(0.0008, 0.002))
    y += bp(rng.standard_normal(n), 3500, 7500) * np.exp(-_t(n) / 0.001) * 0.08
    return fade(y, 0.0008, 0.05) * 0.6


def sparkle(rng, dur, count, freqs, decay=(0.15, 0.6), front=1.6):
    """Cloud of tiny tuned glass tings scattered across the stereo field."""
    n = secs(dur + decay[1] + 0.1)
    out = np.zeros((n, 2))
    for _ in range(count):
        t0 = dur * rng.random() ** front
        f = rng.choice(freqs) * 2.0 ** (rng.normal(0, 8) / 1200.0)
        y = glass_ting(rng, f, rng.uniform(*decay), bright=0.6)
        y *= rng.uniform(0.3, 1.0) * (1.0 - 0.6 * t0 / dur)
        i0 = secs(t0)
        out[i0:i0 + len(y)] += pan(y, rng.uniform(-0.85, 0.85))[:n - i0]
    return out


def star_whistle(rng, dur, f_hi=5600.0, f_lo=2300.0):
    """Thin glassy descending whistle of a falling star."""
    n = secs(dur)
    t = _t(n)
    f = f_hi * (f_lo / f_hi) ** ((t / dur) ** 0.8)
    ph = TAU * np.cumsum(f) / SR
    y = np.sin(ph) + 0.28 * np.sin(1.5 * ph + 0.7) + 0.45 * swept_noise(n, f, 260.0, rng)
    y *= 0.78 + 0.22 * np.sin(TAU * 17.0 * t + rng.uniform(0, TAU))
    return y * env_ar(n, dur * 0.3, dur * 0.12) * 0.5


def star_tink(rng):
    """Glass bead landing on wool: bright tink over a soft padded thud."""
    y = glass_ting(rng, 2637.0, 0.7)
    n = len(y)
    y[:] += 0.5 * glass_ting(rng, 3951.0, 0.7, bright=0.5)
    y += lp(rng.standard_normal(n), 320.0) * np.exp(-_t(n) / 0.03) * 0.5
    return fade(y, 0.0006, 0.03)


def needle_ring(rng, dur):
    """Metallic ring of the great needle with a whine that climbs into the launch."""
    n = secs(dur)
    t = _t(n)
    y = 0.5 * bar_tone(1480.0, n, (1.0, 2.76, 5.4), (1.0, 0.5, 0.25),
                       (dur * 0.8, dur * 0.5, dur * 0.25), beat=0.004)
    f = 1480.0 * 2.0 ** ((t / dur) ** 2)
    ph = TAU * np.cumsum(f) / SR
    whine = (np.sin(ph) + 0.3 * np.sin(2 * ph)) * (t / dur) ** 2.5
    whine *= 1.0 + 0.2 * np.sin(TAU * 23.0 * t)
    return fade(y + 0.6 * whine, 0.001, 0.03)


# ------------------------------------------------------------- air / cloth

def wind(n, rng, gust, bright):
    """Mountain wind: band noise with slow independent motion per band and channel."""
    bands = ((90, 320, 1.0, 0.0), (320, 900, 0.75, 0.6),
             (900, 2400, 0.32, 2.2), (2400, 5200, 0.10, 5.0))
    out = np.zeros((n, 2))
    for lo, hi, g, bk in bands:
        ref = None
        shared = bp(rng.standard_normal(n), lo, hi)
        mod = np.clip(1.0 + 0.45 * slow_rand(n, 0.7, rng) + 0.2 * slow_rand(n, 3.0, rng),
                      0.2, None)
        gain = g * (1.0 + bk * bright) * mod
        for ch in range(2):
            x = 0.55 * shared + 0.85 * bp(rng.standard_normal(n), lo, hi)
            ref = ref or rms(x)
            out[:, ch] += x / ref * gain
    for _ in range(2):  # faint whistling gusts
        fc = 650.0 * 2.0 ** (0.6 * slow_rand(n, 0.25, rng))
        a = np.clip(slow_rand(n, 0.35, rng), 0, 1) ** 2
        out += pan(swept_noise(n, fc, 45.0, rng) * a * 0.35, rng.uniform(-0.6, 0.6))
    return out * gust[:, None]


def whoosh(rng, dur, f_pts, bw, a_pts, width=0.5):
    """Noise band whose centre follows f_pts [(s, Hz)] and level follows a_pts."""
    n = secs(dur)
    fc = np.exp(curve(n, [(t, np.log(f)) for t, f in f_pts]))
    y = _stereo(swept_noise(n, fc, bw, rng), swept_noise(n, fc, bw, rng), width)
    return fade(y * curve(n, a_pts)[:, None], 0.003, 0.02)


def rip(rng, dur):
    """Slow, enormous cloth tear: a low roughened roar under clouds of fibre-snap grains."""
    n = secs(dur)
    t = _t(n)
    surge = np.full(n, 0.22)
    for ts in (0.0, 0.95, 1.8, 2.55, 3.2):
        ts *= dur / 4.0
        d = t - ts
        surge += np.where(d >= 0, (1 - np.exp(-d / 0.03)) * np.exp(-d / 0.6), 0.0)
    surge *= np.clip((dur - t) / 0.7, 0, 1) ** 1.5
    drift = np.interp(t, [0, dur], [-0.45, 0.45])  # the tear travels across the sky

    bands = ((70, 220), (150, 450), (300, 900), (600, 1800), (1200, 3500))
    probs = np.array([0.30, 0.30, 0.20, 0.14, 0.06])
    bank = []
    for lo, hi in bands:
        x = bp(rng.standard_normal(n + SR), lo, hi)
        bank.append(x / rms(x))
    out = np.zeros((n, 2))
    tg = 0.0
    while tg < dur - 0.1:
        i0 = secs(tg)
        s = surge[i0]
        k = rng.choice(len(bands), p=probs)
        ln = secs(rng.uniform(0.012, 0.06) * (1.6 if k < 2 else 1.0))
        off = rng.integers(0, SR)
        e = np.exp(-_t(ln) / (ln / SR * 0.3)) * (1 - np.exp(-_t(ln) / 0.0006))
        g = s * rng.lognormal(0.0, 0.5) * 0.45
        seg = fade(bank[k][off:off + ln] * e * g, 0.0005, 0.004)
        out[i0:i0 + ln] += pan(seg, drift[i0] + rng.uniform(-0.4, 0.4))[:n - i0]
        tg += rng.exponential(1.0 / (22.0 + 95.0 * s))

    rough = np.abs(lp(rng.standard_normal(n), 28.0))
    rough = (0.25 + rough / rms(rough)) ** 2
    for ch in range(2):
        roar = bp(rng.standard_normal(n), 60, 480)
        hiss = bp(rng.standard_normal(n), 800, 3000)
        out[:, ch] += (0.5 * roar / rms(roar) + 0.1 * hiss / rms(hiss)) * rough * surge * 0.5
    return fade(out, 0.002, 0.3)


def cloth_brush(rng, dur=0.45):
    """Soft brush of a hand across velvet."""
    n = secs(dur)
    y = bp(rng.standard_normal(n), 500, 3200) * (0.6 + 0.4 * np.abs(slow_rand(n, 40.0, rng)))
    return y / rms(y) * np.sin(np.pi * _t(n) / dur) ** 2 * 0.3


def snow_crunch(rng, dur=0.14):
    n = secs(dur)
    rough = lp(rng.standard_normal(n), 300.0) ** 2
    y = bp(rng.standard_normal(n), 500, 4200) * rough / rms(rough)
    return y / rms(y) * np.sin(np.pi * _t(n) / dur) * 0.3


def exhale(rng, dur=0.75):
    """One soft breath out."""
    n = secs(dur)
    t = _t(n)
    x = rng.standard_normal(n)
    y = bp(x, 350, 4200) + 1.5 * reson(x, 1500.0, 2.0) + 0.8 * reson(x, 2400.0, 3.0)
    w = np.clip(t / dur, 0, 1)
    y = y * (1 - w) + lp(y, 1100.0) * w * 1.5
    e = np.where(t < 0.14, np.sin(0.5 * np.pi * t / 0.14) ** 2,
                 np.cos(0.5 * np.pi * (t - 0.14) / (dur - 0.14)) ** 2)
    return y / rms(y) * e * 0.3


# ----------------------------------------------------------- needle / thread

def _harm(ph, n_h, roll, t, tau):
    y = np.zeros(len(ph))
    for k in range(1, n_h + 1):
        y += np.sin(k * ph) * k ** -roll * np.exp(-t * k / tau)
    return y


def pierce(rng, twang, size=1.0):
    """Needle through cloth: low thud, cloth burst, then the thread zips taut (rising twang)."""
    n = secs(0.34 + 0.2 * size)
    t = _t(n)
    thud = np.sin(TAU * np.cumsum(58.0 + 95.0 * np.exp(-t / 0.02)) / SR) \
        * np.exp(-t / (0.065 * size))
    grain = np.abs(lp(rng.standard_normal(n), 180.0))
    grain = 0.5 + 0.5 * grain / rms(grain)
    cloth = bp(rng.standard_normal(n), 350, 3200) * grain \
        * (np.exp(-t / 0.035) + 0.3 * size * np.exp(-t / (0.11 * size)))
    tick = bp(rng.standard_normal(n), 2000, 6500) * np.exp(-t / 0.0025)
    u = np.clip((t - 0.025) / 0.2, 0, 1)
    zz = swept_noise(n, 700.0 * 5.2 ** u, 450.0, rng) * np.sin(np.pi * u) ** 1.5
    d = np.clip(t - 0.02, 0, None)
    ph = TAU * np.cumsum(twang * (1.0 - 0.3 * np.exp(-d / 0.05))) / SR
    tw = _harm(ph, 5, 1.2, d, 0.16) * (t > 0.02) * (1 - np.exp(-d / 0.003))
    y = 0.9 * size * thud + 0.6 * cloth + 0.3 * tick + 0.36 * zz + 0.55 * tw
    return fade(y * (1 - np.exp(-t / 0.0004)), 0.0, 0.03)


def spool_rattle(rng, dur):
    """Spool clicking fast, then slower, then stopping."""
    n = secs(dur)
    t = _t(n)
    rate = 46.0 * np.clip(1.0 - t / dur, 0, 1) ** 1.6 + 2.5
    idx = np.nonzero(np.diff(np.floor(np.cumsum(rate) / SR)) > 0)[0]
    imp = np.zeros(n)
    imp[idx] = rng.uniform(0.55, 1.0, len(idx))
    y = reson(imp, 1150.0, 9.0) + 0.6 * reson(imp, 2350.0, 10.0) + 0.3 * reson(imp, 640.0, 6.0)
    y += 0.35 * bp(imp, 2500, 6000)
    return y / np.max(np.abs(y)) * (0.75 + 0.25 * (1 - t / dur))


def whip_snap(rng):
    """Thread end whipping free. Returns (signal, seconds of lead-in before the crack)."""
    pre = 0.09
    n = secs(pre + 0.3)
    t = _t(n)
    u = np.clip(t / pre, 0, 1)
    y = swept_noise(n, 600.0 * 8.0 ** u, 700.0, rng) * u ** 3 * (t < pre) * 0.22
    d = np.clip(t - pre, 0, None)
    on = t >= pre
    crack = hp(rng.standard_normal(n), 1200.0) * np.exp(-d / 0.012) * on
    pap = np.sin(TAU * 210.0 * d) * np.exp(-d / 0.014) * on
    d2 = np.clip(t - pre - 0.038, 0, None)
    slap = hp(rng.standard_normal(n), 2000.0) * np.exp(-d2 / 0.008) * (t >= pre + 0.038)
    y += 0.5 * crack + 0.8 * pap + 0.15 * slap
    return fade(y, 0.002, 0.02), pre


def stitch_pop(rng, f):
    """A stitch letting go: pop plus a twang whose pitch sags as tension is lost."""
    n = secs(0.3)
    t = _t(n)
    ph = TAU * np.cumsum(f * (1.0 + 0.45 * np.exp(-t / 0.03)) * 2.0 ** (-t * 0.6)) / SR
    tw = _harm(ph, 6, 1.0, t, 0.14)
    pop = np.sin(TAU * np.cumsum(90.0 + 110.0 * np.exp(-t / 0.012)) / SR) * np.exp(-t / 0.028)
    tick = bp(rng.standard_normal(n), 1800, 6000) * np.exp(-t / 0.003)
    return fade(0.5 * tw + 0.9 * pop + 0.35 * tick, 0.0004, 0.03)


def heartbeat(rng, strength=1.0):
    """Lub-dub; the lub starts at sample 0."""
    n = secs(0.62)
    t = _t(n)

    def thump(d, f0, amp):
        on = d >= 0
        d = np.clip(d, 0, None)
        ph = TAU * np.cumsum(f0 * (1.0 + 0.35 * np.exp(-d / 0.03))) / SR
        return amp * on * (np.sin(ph) + 0.3 * np.sin(2 * ph)) * np.exp(-d / 0.06) \
            * (1 - np.exp(-d / 0.004))

    y = thump(t, 52.0, 1.0) + thump(t - 0.28, 60.0, 0.7)
    y += lp(rng.standard_normal(n), 140.0) * 0.4 * (np.exp(-t / 0.03)
                                                    + 0.6 * (t > 0.28) * np.exp(-np.clip(t - 0.28, 0, None) / 0.03))
    return fade(y, 0.001, 0.05) * strength


def thwip(rng):
    """The catch: a tight snatch of thread into a mitten."""
    n = secs(0.16)
    t = _t(n)
    u = np.clip(t / 0.05, 0, 1)
    zz = swept_noise(n, 1300.0 * 4.6 ** u, 900.0, rng) * np.sin(np.pi * u) ** 0.7 * (t < 0.05)
    thump = np.sin(TAU * np.cumsum(95.0 + 80.0 * np.exp(-t / 0.012)) / SR) * np.exp(-t / 0.03)
    tick = bp(rng.standard_normal(n), 1500, 5500) * np.exp(-t / 0.004)
    wool = lp(rng.standard_normal(n), 900.0) * np.exp(-t / 0.02)
    y = 0.35 * zz + 0.9 * thump + 0.5 * tick + 0.3 * wool
    return fade(y * (1 - np.exp(-t / 0.0004)), 0.0, 0.02)


def creak(rng, dur, rate_pts, res, amp_pts):
    """Stick-slip creak (yarn, rope): irregular pulses through body resonances."""
    n = secs(dur)
    rate = curve(n, rate_pts) * (1.0 + 0.3 * slow_rand(n, 9.0, rng))
    idx = np.nonzero(np.diff(np.floor(np.cumsum(np.clip(rate, 1, None)) / SR)) > 0)[0]
    imp = np.zeros(n)
    imp[idx] = rng.uniform(0.4, 1.0, len(idx))
    y = np.zeros(n)
    for f, q, g in res:
        y += g * reson(imp, f, q)
    y += 0.15 * bp(imp, 1500, 5000)
    return fade(y / np.max(np.abs(y)) * curve(n, amp_pts), 0.005, 0.03)


def tok(rng):
    """Knot snapping tight: small, taut, woody."""
    n = secs(0.2)
    t = _t(n)
    y = (np.sin(TAU * 830.0 * t) * np.exp(-t / 0.018)
         + 0.6 * np.sin(TAU * 1740.0 * t) * np.exp(-t / 0.009)
         + 0.3 * np.sin(TAU * 2950.0 * t) * np.exp(-t / 0.004)
         + 0.7 * np.sin(TAU * np.cumsum(120.0 + 90.0 * np.exp(-t / 0.01)) / SR) * np.exp(-t / 0.022))
    y += bp(rng.standard_normal(n), 2000, 6000) * np.exp(-t / 0.002) * 0.4
    return fade(y * (1 - np.exp(-t / 0.0003)), 0.0, 0.02)


def zip_run(rng, dur):
    """Seam cinching shut and racing away: accelerating click train becoming a rising buzz.

    Returns (near, far) stereo layers; `far` is meant for a wetter send.
    """
    n = secs(dur)
    t = _t(n)
    u = t / dur
    rate = 26.0 * 17.0 ** u
    idx = np.nonzero(np.diff(np.floor(np.cumsum(rate) / SR)) > 0)[0]
    imp = np.zeros(n)
    imp[idx] = rng.uniform(0.7, 1.0, len(idx))
    lo = reson(imp, 2100.0, 5.0) + 0.5 * reson(imp, 950.0, 4.0)
    hi_ = reson(imp, 4300.0, 5.0) + 0.5 * reson(imp, 2700.0, 5.0)
    y = lo * (1 - u) + hi_ * u + 0.3 * bp(imp, 3000, 7000)
    y = y / np.max(np.abs(y)) / np.sqrt(1.0 + rate / 60.0) * 2.0
    y = pan(y, 0.75 * u ** 1.3)
    d = (u ** 0.8)[:, None]
    return fade(y * (1 - d), 0.002, 0.01), fade(y * d, 0.002, 0.01)


# ------------------------------------------------------------------ impacts

def sub_boom(rng, f_end=44.0, f_drop=50.0, decay=0.8, noise=0.5):
    """Deep reveal boom with a slow tail."""
    n = secs(decay * 4.5)
    t = _t(n)
    ph = TAU * np.cumsum(f_end + f_drop * np.exp(-t / 0.08)) / SR
    y = (np.sin(ph) + 0.4 * np.sin(2 * ph + 0.5) * np.exp(-t / (decay * 0.4))) * np.exp(-t / decay)
    y += lp(rng.standard_normal(n), 900.0) * np.exp(-t / 0.05) * noise
    y += bp(rng.standard_normal(n), 60, 300) * np.exp(-t / 0.25) * noise * 0.6
    return fade(np.tanh(1.4 * y) / 0.89, 0.0008, 0.2)


def boom_close(rng):
    """The sky shutting: colossal but gated, so silence can follow almost at once."""
    n = secs(0.5)
    t = _t(n)
    g = np.where(t < 0.15, 1.0, np.exp(-(t - 0.15) / 0.04))
    ph = TAU * np.cumsum(45.0 + 85.0 * np.exp(-t / 0.045)) / SR
    y = (np.sin(ph) + 0.5 * np.sin(2 * ph + 0.4) * g) * g
    y += lp(rng.standard_normal(n), 2600.0) * np.exp(-t / 0.03) * 0.8
    y += bp(rng.standard_normal(n), 90, 700) * np.exp(-t / 0.06) * 0.9
    return fade(np.tanh(2.2 * y) / 0.97, 0.0004, 0.05)
