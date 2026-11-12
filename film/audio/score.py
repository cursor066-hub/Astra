"""STARMENDER - complete synthesised soundtrack (music, effects, ambience, mix, master).

    python audio/score.py            -> out/audio/score.wav (48 kHz, 24-bit stereo)
    python audio/score.py --debug    also prints per-stem RMS per section
    python audio/score.py --stems    also writes out/audio/stems/{music,sfx,post}.wav

Cue times come from ../timeline.json (see cues.py); nudge a time there and re-run.
Deterministic: every section owns a seeded RNG.
"""
import os
import sys
import time
import wave
import zlib

import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d, uniform_filter1d

import sfx
from cues import OUT_DIR, Timeline
from synth import (SR, brass, choir, crash, curve, db, fade, hp, hz, lp, make_ir, musicbox,
                   pan, piano, pizz, pure_tone, rms, secs, shepard, spicc, strings, sub,
                   swell, taiko)

TARGET_LUFS = -16.0
CEILING_DB = -1.6          # sample-peak ceiling; leaves room for inter-sample peaks
GAP = 0.045                # breath of near-silence before each big hit, so it lands

GROUP = {'pad': 'music', 'ost': 'music', 'mel': 'music', 'keys': 'music', 'choir': 'music',
         'bass': 'music', 'drums': 'music', 'cym': 'music',
         'amb': 'sfx', 'sfx': 'sfx', 'hit': 'sfx', 'post': 'post'}
STEM_GAIN = {'pad': 0.20, 'ost': 0.38, 'mel': 0.46, 'keys': 0.30, 'choir': 0.42,
             'bass': 0.19, 'drums': 0.40, 'cym': 0.30, 'amb': 0.035, 'sfx': 0.40,
             'hit': 0.48, 'post': 0.40}
HALL_RET, ROOM_RET = 0.9, 0.9

# Her theme, as (semitones above the tonic, beat, length in beats).
THEME_Q = [(7, 0.0, 1.0), (12, 1.0, 1.5), (9, 2.5, 0.5), (16, 3.0, 5.0)]   # A  D' B  F#'
THEME_A = [(14, 0.0, 1.0), (12, 1.0, 1.5), (9, 2.5, 0.5), (12, 3.0, 5.0)]  # E' D' B  D'
PENTA_HI = [hz(x) for x in ('D6', 'E6', 'F#6', 'A6', 'B6', 'D7', 'E7', 'F#7', 'A7')]


def _aslist(x):
    return x if isinstance(x, (list, tuple)) else [x]


class Mix:
    def __init__(self, n):
        self.n = n
        self.dry = {s: np.zeros((n, 2)) for s in GROUP}
        self.hall = {g: np.zeros((n, 2)) for g in ('music', 'sfx', 'post')}
        self.room = {g: np.zeros((n, 2)) for g in ('music', 'sfx', 'post')}
        self.ducks = []      # (time, depth dB, release s) applied to the music group

    def add(self, stem, sig, t, gain=1.0, pan_=0.0, hall=0.0, room=0.0):
        if sig.ndim == 1:
            sig = pan(sig, pan_)
        elif pan_:
            sig = sig * np.array([min(1.0, 1.0 - pan_), min(1.0, 1.0 + pan_)])
        i0 = secs(t)
        if i0 < 0:
            sig, i0 = sig[-i0:], 0
        i1 = min(self.n, i0 + len(sig))
        if i1 <= i0:
            return
        seg = sig[:i1 - i0] * (gain * STEM_GAIN[stem])
        self.dry[stem][i0:i1] += seg
        if hall:
            self.hall[GROUP[stem]][i0:i1] += seg * hall
        if room:
            self.room[GROUP[stem]][i0:i1] += seg * room


# =====================================================================
# The film, section by section
# =====================================================================

def build(mix, tl):
    T, beat = tl.t, tl.beat

    def R(name):
        return np.random.default_rng(zlib.crc32(name.encode()))

    def seat(f):  # orchestral seating: violins left, celli right, basses centre
        return float(np.interp(np.log2(f), np.log2([110.0, 260.0, 700.0, 1500.0]),
                               [0.0, 0.22, -0.12, -0.3]))

    def STR(rng, notes, t, dur, vel, stem='pad', gain=1.0, hall=0.4, **kw):
        for nm in _aslist(notes):
            f = hz(nm)
            mix.add(stem, strings(f, dur, vel, rng, center=seat(f), **kw), t, gain, hall=hall)

    def BRS(rng, notes, t, dur, vel, kind='horn', gain=1.0, hall=0.35, **kw):
        preset = {'horn': dict(bright=1900.0, dark=450.0, horn=True, center=-0.2, voices=4),
                  'trumpet': dict(bright=3600.0, dark=700.0, horn=False, center=0.2),
                  'bone': dict(bright=1500.0, dark=350.0, horn=False, center=0.3)}[kind]
        preset.update(kw)
        for nm in _aslist(notes):
            mix.add('mel', brass(hz(nm), dur, vel, rng, **preset), t, gain, hall=hall)

    def CHO(rng, notes, t, dur, vel, gain=1.0, hall=0.5, **kw):
        for nm in _aslist(notes):
            mix.add('choir', choir(hz(nm), dur, vel, rng, **kw), t, gain, hall=hall)

    def SUB(note, t, dur, vel, **kw):
        mix.add('bass', sub(hz(note), dur, vel, **kw), t)

    def DRUM(rng, kind, t, vel):
        p = {'big': 0.0, 'low': 0.0, 'mid': rng.choice([-0.25, 0.25]),
             'hi': rng.choice([-0.4, 0.4])}[kind]
        mix.add('drums', taiko(kind, vel, rng), t, pan_=p, hall=0.10, room=0.35)

    def SPC(rng, f, t, vel, length=0.1, gain=1.0):
        f = hz(f)
        mix.add('ost', spicc(f, vel, rng, length, center=seat(f)), t, gain, hall=0.22)

    def SFX(sig, t, gain=1.0, pan_=0.0, hall=0.2, room=0.0, stem='sfx'):
        mix.add(stem, sig, t, gain, pan_, hall, room)

    def SWELL(rng, t_hit, dur, gain, shape=3.0):  # cymbal roll that stops just before the hit
        mix.add('cym', swell(rng, dur, shape, tail=0.04), t_hit - GAP - dur, gain, hall=0.3)

    def voicing(root, minor=False):
        r = hz(root)
        third = 2.0 ** ((3 if minor else 4) / 12.0)
        return dict(strs=[r, r * 1.5, r * 2, r * 2 * third, r * 3],
                    cho_f=[r * 2 * third, r * 3, r * 4], cho_m=[r, r * 1.5],
                    bass=r / 2 if r / 2 >= 44.0 else r)

    def cell(root, minor, variant):  # one beat of ostinato 16ths
        r = hz(root)
        top = r * 2.0 ** ((15 if minor else 16) / 12.0) if variant else r * 2.0
        return [r, r * 1.5, top, r * 1.5]

    def th(tonic, st):
        return hz(tonic) * 2.0 ** (st / 12.0)

    def PIERCE(rng, t, twang, size=1.0, gain=1.0, pan_=0.0, duck=-1.5):
        SFX(sfx.pierce(rng, hz(twang), size), t, gain * 1.4, pan_, hall=0.16, room=0.3)
        mix.ducks.append((t, duck, 0.12))

    # ---------------------------------------------------------------- ambience
    n = mix.n
    pts = [(0, 0, 0), (0.4, .5, 0), (T['reveal'] - .1, .55, 0), (T['reveal'] + 1.5, .9, .15),
           (T['antic'], 1.0, .2), (T['launch'] - .05, .8, .2), (T['launch'] + .15, 1.7, .5),
           (T['cloud'], 1.4, .3), (T['burst'], 1.1, .4), (T['wonder'] - .2, .7, .2),
           (T['wonder'] + .3, .22, 0), (T['canyon'], .3, .1), (T['canyon'] + .8, 1.3, .8),
           (T['dive'], 1.6, 1.0), (T['pierce1'], 1.5, .8), (T['pierce1'] + .15, .35, .2),
           (T['drive'], .45, .2), (T['collapse'], .5, .2), (T['pops'], .8, .3),
           (T['slowmo'] - .03, 2.2, .7), (T['slowmo'] + .08, .3, 0), (T['knot'], .22, 0),
           (T['redrun'], .45, .2), (T['pull'], .6, .3), (T['close'] - .02, 1.0, .5),
           (T['close'] + .03, 0, 0), (T['quiet'] - .3, 0, 0), (T['quiet'] + 1.0, .3, 0),
           (T['last_note'], .28, 0), (T['silence'], 0, 0)]
    tt = np.arange(n) / SR
    xs = [p[0] for p in pts]
    gust = np.interp(tt, xs, [p[1] for p in pts])
    bright = np.interp(tt, xs, [p[2] for p in pts])
    mix.add('amb', sfx.wind(n, R('wind'), gust, bright), 0.0, hall=0.1)

    # ------------------------------------------------- 0.0-7.5  a star in the palm
    rng = R('open')
    t_dark, t_drone, t_rev = T['darken'], T['drone'], T['reveal']
    STR(rng, ['B2', 'F#3', 'D4', 'A4', 'C#5'], 0.3, t_dark - 0.3 + 0.5, 0.24,
        attack=1.6, release=1.6, bright=1500.0, voices=5)                 # Bm9
    STR(rng, ['B2', 'G3', 'D4', 'F#4'], t_dark, t_drone - t_dark + 0.6, 0.24,
        attack=1.3, release=1.3, bright=1250.0, voices=5)                 # darkens: G/B
    d = t_rev - t_drone
    STR(rng, ['F#2', 'C#3', 'B3', 'C#4', 'F#4'], t_drone, d - GAP, 0.6, attack=0.8, release=0.04,
        bright=2200.0, dyn=[(0, .3), (d, 1.0)])                           # F#sus, crescendo
    SUB('B1', t_drone, d - GAP, 0.8, attack=0.5, release=0.04, dyn=[(0, .15), (d, 1.0)])
    SWELL(rng, t_rev, 1.3, 0.25, shape=3.5)

    # her theme, first statement: music box, double speed, pp
    for (st, b, _), v in zip(THEME_Q + [(s, bb + 4, l) for s, bb, l in THEME_A],
                             (.7, .8, .6, .95, .75, .8, .6, .9)):
        mix.add('keys', musicbox(th('D5', st), v, rng), T['theme1'] + b * beat / 2,
                0.55, pan_=rng.uniform(-0.25, 0.25), hall=0.7)

    d = T['star_land'] - T['star_fall']
    w = sfx.star_whistle(rng, d)
    SFX(pan(w, np.linspace(0.85, 0.05, len(w))), T['star_fall'], 0.22, hall=0.5)
    SFX(sfx.star_tink(rng), T['star_land'], 0.45, pan_=0.05, hall=0.5)
    SFX(sfx.sparkle(rng, 1.0, 20, PENTA_HI), T['star_land'] + 0.03, 0.10, hall=0.7)
    for i, ts in enumerate(tl.stars):
        dur = rng.uniform(0.36, 0.5)
        p0 = rng.uniform(0.4, 0.9) * (-1 if i % 2 else 1)
        w = sfx.star_whistle(rng, dur, rng.uniform(4600, 6200), rng.uniform(2000, 2800))
        SFX(pan(w, np.linspace(p0, p0 * 0.4, len(w))), ts, 0.10, hall=0.6)
        SFX(sfx.glass_ting(rng, rng.choice(PENTA_HI[2:7]), 0.6, 0.6), ts + dur, 0.09,
            pan_=p0 * 0.4, hall=0.7)

    # ------------------------------------------------------- 7.5-11.5  the tear
    rng = R('reveal')
    t0, t1, t2 = T['reveal'], T['reveal'] + 2.0, T['antic']
    SFX(sfx.sub_boom(rng), t0, 1.0, hall=0.12, stem='hit')
    DRUM(rng, 'big', t0, 0.9)
    mix.add('cym', crash(rng, 2.5), t0, 0.5, hall=0.4)
    mix.ducks.append((t0, -4.0, 0.5))
    sw = [(0, 1.0), (0.6, .75), (t2 - t0, 1.0)]
    # G lydian: the "awe" chord, returning (bigger) at the canyon of light
    STR(rng, ['G2', 'D3', 'G3', 'B3', 'D4', 'F#4'], t0, t2 - t0, 0.55, attack=0.03,
        release=0.5, dyn=sw)
    STR(rng, ['A4', 'D5', 'F#5'], t0, t1 - t0 + 0.2, 0.5, attack=0.03, release=0.6)
    STR(rng, ['A4', 'C#5', 'E5', 'A5'], t1, t2 - t1, 0.5, attack=0.5, release=0.5,
        dyn=[(0, .7), (t2 - t1, 1.0)])                                    # A/G: lydian glow
    CHO(rng, ['B3', 'D4', 'F#4', 'A4', 'D5'], t0, t1 - t0, 0.5, attack=0.08, release=0.7)
    CHO(rng, ['B3', 'E4', 'A4', 'C#5', 'E5'], t1, t2 - t1, 0.5, attack=0.5, release=0.6,
        dyn=[(0, .7), (t2 - t1, 1.0)])
    BRS(rng, ['G2', 'D3'], t0, t2 - t0, 0.5, kind='bone', attack=0.08, release=0.4, dyn=sw)
    SUB('G1', t0, t2 - t0, 0.38, attack=0.05, release=0.3, dyn=sw)
    SFX(sfx.rip(rng, t2 - t0), t0 + 0.02, 0.6, hall=0.45)

    # ------------------------------------------------- 11.5-12.2  anticipation
    rng = R('antic')
    d = T['launch'] - T['antic']
    STR(rng, ['F#4', 'F#5'], T['antic'], d - GAP, 0.35, attack=0.15, release=0.03, trem=0.6,
        dyn=[(0, .4), (d, 1.0)])
    SFX(sfx.needle_ring(rng, d - GAP + 0.01), T['antic'], 0.22, pan_=-0.1, hall=0.4)
    SFX(sfx.snow_crunch(rng), T['antic'] + 0.08, 0.5, pan_=0.15, hall=0.1)
    SFX(sfx.snow_crunch(rng, 0.11), T['antic'] + 0.4, 0.4, pan_=-0.1, hall=0.1)

    # ------------------------------------------- 12.2-15.6  launch, into cloud
    rng = R('launch')
    t0 = T['launch']
    g = lambda b: t0 + b * (T['burst'] - t0) / 7.0   # 7 beats, tempo-mapped to the hits
    bl = (T['burst'] - t0) / 7.0
    SFX(sfx.sub_boom(rng, 48.0, 70.0, 0.35, 0.6), t0, 0.8, hall=0.08, room=0.2, stem='hit')
    DRUM(rng, 'big', t0, 1.0)
    SFX(sfx.whoosh(rng, 1.7, [(0, 350), (0.18, 3200), (1.7, 700)], 1400.0,
                   [(0, 0), (0.006, 1.0), (0.4, .6), (1.7, 0)]), t0, 0.5, hall=0.3)
    mix.ducks.append((t0, -3.5, 0.35))
    chords = [('B3', 'D4', 'F#4'), ('C#4', 'E4', 'A4'), ('D4', 'F#4', 'A4'), ('E4', 'G4', 'B4'),
              ('F#4', 'A4', 'D5'), ('G4', 'B4', 'D5'), ('A4', 'C#5', 'E5')]
    basses = ['B1', 'C#2', 'D2', 'E2', 'F#2', 'G2', 'A2']
    for b in range(7):
        lvl = 0.55 + 0.45 * b / 6.0
        c = chords[b]
        for s in range(4):
            v = (1.0, .62, .8, .62)[s] * lvl
            f = hz((c[0], c[1], c[2], c[1])[s])
            SPC(rng, f, g(b + s / 4), v, bl / 4 * 0.85)
            if b >= 2:
                SPC(rng, f * 2, g(b + s / 4), v * 0.8, bl / 4 * 0.85, gain=0.5)
        SUB(basses[b], g(b), bl * 0.95, 0.55 * lvl + 0.2, release=0.05)
        for h in (0.0, 0.5):
            SPC(rng, hz(basses[b]) * 2, g(b + h), 0.8 * lvl, bl * 0.4)
        STR(rng, [hz(x) * 2 for x in c], g(b), bl, 0.4 * lvl, attack=0.1, release=0.3)
        BRS(rng, hz(basses[b]) * 4, g(b), bl * 1.02, 0.45 + 0.4 * b / 6, attack=0.06,
            release=0.1)                                   # horns climb B3 ... A4
        if b:
            DRUM(rng, 'low', g(b), 0.45 + 0.3 * lvl)
        DRUM(rng, 'hi', g(b + 0.5), 0.3 + 0.3 * lvl)
    for s in range(1, 4):
        DRUM(rng, 'mid', g(6 + s / 4), 0.5 + 0.12 * s)
    d = T['burst'] - T['cloud']
    SFX(sfx.whoosh(rng, d + 0.1, [(0, 180), (d, 320)], 300.0, [(0, 0), (0.2, 1), (d, 1), (d + 0.1, 0)]),
        T['cloud'], 0.3, hall=0.1)                         # dull rushing air in the cloud
    SWELL(rng, T['burst'], 0.9, 0.9)

    # ------------------------------------------ 15.6-18  above the cloud sea
    rng = R('burst')
    t0 = T['burst']
    bl = (T['wonder'] - t0) / 5.0                           # 5 beats
    h = lambda b: t0 + b * bl
    DRUM(rng, 'big', t0, 1.0)
    SFX(sfx.sub_boom(rng, 48.0, 60.0, 0.3, 0.3), t0, 0.5, stem='hit')
    mix.add('cym', crash(rng, 2.4), t0, 0.9, hall=0.4)
    mix.ducks.append((t0, -2.0, 0.25))
    prog = [('D3', False), ('D3', False), ('B2', True), ('G2', False), ('G2', False)]
    for b, (root, minor) in enumerate(prog):
        vc = voicing(root, minor)
        lvl = (1.0, .95, .9, .8, .45)[b]
        if b != 4:
            STR(rng, vc['strs'], h(b), bl * (2.0 if b == 3 else 1.0), 0.55 * lvl,
                attack=0.05, release=0.5 if b < 3 else 1.2)
            SUB(vc['bass'], h(b), bl * (2.0 if b == 3 else 0.95), 0.6 * lvl, release=0.3)
        c = [hz('D4'), hz('F#4'), hz('A4'), hz('F#4')] if b < 2 else \
            ([hz('D4'), hz('F#4'), hz('B4'), hz('F#4')] if b == 2 else
             [hz('G4'), hz('B4'), hz('D5'), hz('B4')])
        for s in range(4 if b < 4 else 2):
            v = (1.0, .62, .8, .62)[s] * lvl
            SPC(rng, c[s], h(b + s / 4), v, bl / 4 * 0.85)
            SPC(rng, c[s] * 2, h(b + s / 4), v * 0.8, bl / 4 * 0.85, gain=0.5)
        if 0 < b < 4:
            DRUM(rng, 'low', h(b), 0.75 - 0.12 * b)
            DRUM(rng, 'hi', h(b + 0.5), 0.45 - 0.07 * b)
    for st, b, ln in THEME_Q:   # soaring phrase of her theme: horns + violins 8va
        ln = min(ln, 2.0)
        last = st == 16
        BRS(rng, th('D4', st), h(b), ln * bl, 0.85, attack=0.05, release=0.9 if last else 0.12,
            dyn=[(0, 1), (ln * bl, 0.45 if last else 1)])
        STR(rng, th('D5', st), h(b), ln * bl, 0.75, stem='mel', gain=0.55, attack=0.06,
            release=0.6 if last else 0.15, voices=5)

    # --------------------------------------------- 18-20.5  the sky is cloth
    rng = R('wonder')
    t0 = T['wonder']
    d = T['canyon'] - t0
    STR(rng, ['D5', 'A5', 'E6', 'F#6'], t0 - 0.2, d + 0.2, 0.26, attack=0.7, release=0.9,
        bright=5200.0, detune=5.0, voices=4, trem=0.35)
    STR(rng, ['D3', 'A3'], t0, d, 0.22, attack=0.9, release=0.9, bright=900.0)
    CHO(rng, ['A4', 'D5', 'F#5'], t0 - 0.1, d + 0.1, 0.32, vowel='oo', attack=0.8, release=1.0)
    for i in range(9):
        tc = t0 + 0.12 + (d - 0.3) * (i + rng.uniform(0, 0.8)) / 9.0
        mix.add('sfx', sfx.chime(rng, rng.choice(PENTA_HI[:7]) * 2 ** (rng.normal(0, 10) / 1200),
                                 rng.uniform(1.6, 2.6)), tc, rng.uniform(0.07, 0.16),
                pan_=rng.uniform(-0.8, 0.8), hall=0.7)
    SFX(sfx.cloth_brush(rng, 0.5), t0 + 0.6, 0.35, pan_=-0.2, hall=0.2)
    SFX(sfx.cloth_brush(rng, 0.4), t0 + 1.55, 0.3, pan_=0.2, hall=0.2)
    for tb in (t0 + 0.45, t0 + 1.65):
        SFX(sfx.heartbeat(rng, 0.8), tb, 0.3, hall=0.0)

    # ------------------------------------------- 20.5-23  canyon of light
    rng = R('canyon')
    t0, t1 = T['canyon'], T['dive']
    d = t1 - t0
    sw = [(0, .35), (d * 0.65, 1.0), (d, .95)]
    DRUM(rng, 'big', t0, 0.7)
    SFX(sfx.sub_boom(rng, 46.0, 30.0, 0.6, 0.2), t0, 0.5, stem='hit')
    STR(rng, ['G2', 'D3', 'B3', 'D4', 'F#4', 'A4', 'C#5', 'F#5', 'A5'], t0, d, 0.6,
        attack=0.5, release=0.3, dyn=sw)
    BRS(rng, ['G2', 'D3'], t0, d, 0.8, kind='bone', attack=0.4, release=0.25, dyn=sw)
    BRS(rng, ['G3', 'B3', 'D4'], t0, d, 0.7, attack=0.5, release=0.25, dyn=sw)
    CHO(rng, ['B3', 'D4', 'F#4', 'A4', 'D5', 'F#5'], t0, d, 0.6, attack=0.5, release=0.4,
        dyn=sw, morph=[(0, 0.2), (d * 0.6, 1.0)])
    SUB('G1', t0, d, 0.5, attack=0.4, release=0.2, dyn=sw)
    mix.add('cym', swell(rng, d * 0.6, shape=2.0, tail=1.2), t0, 0.45, hall=0.4)

    # ------------------------------------------------- 23-24.3  the dive
    rng = R('dive')
    t0, t1 = T['dive'], T['pierce1']
    d = t1 - t0
    sw = [(0, .5), (d, 1.0)]
    STR(rng, ['A2', 'E3', 'A3', 'C#4', 'E4', 'A4', 'E5'], t0, d - GAP, 0.6, attack=0.12,
        release=0.05, trem=0.6, dyn=sw)
    BRS(rng, ['A2', 'E3', 'A3'], t0, d - GAP, 0.75, kind='bone', attack=0.1, release=0.05, dyn=sw)
    SUB('A1', t0, d - GAP, 0.7, attack=0.08, release=0.05, dyn=sw)
    SFX(sfx.whoosh(rng, d, [(0, 300), (d * 0.6, 900), (d, 5200)], 1000.0,
                   [(0, 0), (d * 0.5, .25), (d - GAP - 0.01, 1.0), (d - GAP, 0), (d, 0)]), t0, 0.5, hall=0.25)
    ny = secs(d - GAP)
    SFX(fade(shepard(ny, rng, octs=2.0) * curve(ny, [(0, 0), (d - GAP, 1)]) ** 2, 0.01, 0.01),
        t0, 0.16, hall=0.3)
    SWELL(rng, t1, d - 0.06, 0.8)
    for i in range(6):
        DRUM(rng, 'mid' if i < 4 else 'low', t1 - (6 - i) * beat / 4, 0.35 + 0.1 * i)

    # --------------------------------------------- 24.3-26  the first stitch
    rng = R('pierce1')
    t0, t1 = T['pierce1'], T['drive']
    d = t1 - t0
    PIERCE(rng, t0, 'D4', size=1.5, gain=1.3, duck=-5.0)
    DRUM(rng, 'big', t0, 1.0)
    SFX(sfx.sub_boom(rng, 46.0, 70.0, 0.3, 0.5), t0, 0.7, room=0.2, stem='hit')
    shim = np.zeros((secs(d + 1.2), 2))   # the light beyond: high choir, slightly muffled
    for nm in ('D5', 'E5', 'A5'):
        shim[:secs(d + 0.6)] += choir(hz(nm), d - 0.3, 0.7, rng, attack=0.25, release=0.9)[:secs(d + 0.6)]
    mix.add('choir', lp(shim, 2400.0), t0 + 0.05, 0.8, hall=0.7)
    STR(rng, ['D6', 'A6'], t0 + 0.05, d - 0.2, 0.2, attack=0.3, release=0.5, trem=0.5,
        bright=4200.0, detune=5.0, voices=4)
    SFX(sfx.sparkle(rng, d - 0.3, 26, PENTA_HI, front=1.0), t0 + 0.15, 0.05, hall=0.8)
    for s in range(4):
        DRUM(rng, 'mid', t1 - (4 - s) * beat / 4, 0.4 + 0.15 * s)
    SWELL(rng, t1, 0.8, 0.5)

    # ====================================================================
    # Shared machinery for the two stitching runs
    # ====================================================================
    def run(rng, t0, prog, melody, mel_tonic, pierces, twangs, urgent):
        """prog: one (root, minor, ostinato root, bass) per beat."""
        nb = len(prog)
        for b, (root, minor, ost, bass) in enumerate(prog):
            tb = t0 + b * beat
            new = b == 0 or prog[b - 1][:2] != (root, minor)
            if new:   # sustain pad/bass across repeated chords
                ln = 1
                while b + ln < nb and prog[b + ln][:2] == (root, minor):
                    ln += 1
                vc = voicing(root, minor)
                STR(rng, vc['strs'], tb, ln * beat, 0.6, attack=0.05, release=0.25)
                if urgent:
                    CHO(rng, vc['cho_f'] + vc['cho_m'], tb, ln * beat, 0.55, attack=0.1,
                        release=0.3)
            SUB(bass, tb, beat * 0.92, 0.75, attack=0.05, release=0.06)
            for hh in (0.0, 0.5):
                SPC(rng, hz(bass) * 2, tb + hh * beat, 0.85, 0.16)
            for s in range(4):
                v = (1.0, .6, .8, .6)[s]
                f = cell(ost, minor, b % 2)[s]
                SPC(rng, f, tb + s * beat / 4, v)
                SPC(rng, f * 2, tb + s * beat / 4, v * 0.85, gain=0.8 if urgent else 0.5)
            # taiko groove: DON . ka don | DON don don ka
            DRUM(rng, 'big' if b % 4 == 0 else 'low', tb, 1.0 if b % 4 == 0 else 0.85)
            pat = ((2, 'hi', .5), (3, 'mid', .7)) if b % 2 == 0 else \
                ((1, 'mid', .55), (2, 'mid', .75), (3, 'hi', .5))
            if urgent:
                pat = ((1, 'hi', .5), (2, 'mid', .8), (3, 'hi', .55), (3, 'mid', .6)) if b % 2 == 0 \
                    else ((1, 'mid', .65), (2, 'hi', .6), (2, 'mid', .8), (3, 'mid', .7))
            for s, kind, v in pat:
                DRUM(rng, kind, tb + s * beat / 4, v)
        for st, b, ln in melody:
            f = th(mel_tonic, st)
            BRS(rng, f, t0 + b * beat, ln * beat, 0.9, attack=0.05, release=0.12)
            if urgent:
                BRS(rng, f, t0 + b * beat, ln * beat, 0.8, kind='trumpet', gain=0.7,
                    attack=0.04, release=0.1)
            STR(rng, f * 2, t0 + b * beat, ln * beat, 0.8, stem='mel', gain=0.55,
                attack=0.05, release=0.15, voices=5)
        for i, tp in enumerate(pierces):
            PIERCE(rng, tp, twangs[i % len(twangs)], pan_=0.3 * (-1) ** i)

    # --------------------------------------------------- 26-31  whipstitch
    rng = R('drive')
    t0 = T['drive']
    nb = int(round((T['majestic'] - t0) / beat))                       # 10 beats
    prog = ([('D3', False, 'D4', 'D2')] * 4 + [('B2', True, 'B3', 'B1')] * 2
            + [('G2', False, 'G3', 'G1')] * 2 + [('A2', False, 'A3', 'A1')] * 2)
    prog = (prog + [prog[-1]] * nb)[:nb]                    # follows a nudged cut
    mix.add('cym', crash(rng, 2.2), t0, 0.7, hall=0.4)
    run(rng, t0, prog, [(s, b, min(ln, 4.6)) for s, b, ln in THEME_Q], 'D4', tl.pierces_a,
        ['D4', 'E4', 'F#4', 'A4', 'B4', 'D5', 'E5', 'F#5', 'A5'], urgent=False)
    t1 = T['majestic']
    for i, nm in enumerate(('A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'G5', 'A5')):   # lift
        STR(rng, nm, t1 - (8 - i) * beat / 4, beat / 4 * 0.9, 0.55 + 0.05 * i, stem='mel',
            gain=0.6, attack=0.02, release=0.06, voices=4, vib=0.0)
    BRS(rng, ['A3', 'E4', 'G4'], t1 - 2 * beat, 2 * beat, 0.8, attack=0.08, release=0.08,
        dyn=[(0, .5), (2 * beat, 1.0)])
    SWELL(rng, t1, 1.0, 0.8)
    for s in (5, 6, 7):
        DRUM(rng, 'low', t1 - (8 - s) * beat / 4, 0.6 + 0.08 * s)

    # -------------------------------------------------- 31-34  half mended
    rng = R('majestic')
    t0, t1 = T['majestic'], T['collapse']
    mix.add('cym', crash(rng, 2.6), t0, 1.0, hall=0.4)
    hold = t1 - (t0 + 3 * beat)
    mel = [(7, 0, 1.0), (12, 1, 1.0), (9, 2, 1.0), (16, 3, hold / beat)]   # theme, broad
    chords = [('D3', False, 1.0), ('B2', True, 1.0), ('G2', False, 1.0)]
    for b, (root, minor, ln) in enumerate(chords):
        vc = voicing(root, minor)
        STR(rng, vc['strs'], t0 + b * beat, beat, 0.75, attack=0.04, release=0.3)
        CHO(rng, vc['cho_f'] + vc['cho_m'], t0 + b * beat, beat, 0.7, attack=0.07, release=0.3)
        BRS(rng, vc['cho_m'], t0 + b * beat, beat, 0.8, kind='bone', attack=0.05, release=0.15)
        SUB(vc['bass'], t0 + b * beat, beat * 0.95, 0.85, release=0.08)
    ts = t0 + 3 * beat                                    # A sus4 -> A, never resolved
    sw = [(0, .8), (hold, 1.0)]
    cut = dict(release=0.04)
    STR(rng, ['A2', 'E3', 'A3', 'E4', 'A4'], ts, hold - 0.04, 0.75, attack=0.04, dyn=sw, **cut)
    STR(rng, 'D4', ts, hold / 2, 0.75, attack=0.04, release=0.2)
    STR(rng, 'C#4', ts + hold / 2, hold / 2 - 0.04, 0.75, attack=0.1, **cut)
    CHO(rng, ['A2', 'E3', 'A4', 'E5'], ts, hold - 0.04, 0.7, attack=0.07, dyn=sw, **cut)
    CHO(rng, 'D5', ts, hold / 2, 0.7, attack=0.07, release=0.2)
    CHO(rng, 'C#5', ts + hold / 2, hold / 2 - 0.04, 0.7, attack=0.12, **cut)
    BRS(rng, ['A2', 'E3'], ts, hold - 0.04, 0.85, kind='bone', attack=0.05, dyn=sw, **cut)
    SUB('A1', ts, hold - 0.04, 0.85, release=0.04, dyn=sw)
    for st, b, ln in mel:
        f = th('D4', st)
        last = st == 16
        kw = dict(attack=0.05, release=0.04 if last else 0.14)
        ln_s = ln * beat - (0.04 if last else 0.0)
        dy = [(0, .85), (ln_s, 1.0)]
        BRS(rng, f, t0 + b * beat, ln_s, 0.95, dyn=dy, **kw)
        BRS(rng, f, t0 + b * beat, ln_s, 0.9, kind='trumpet', gain=0.8, dyn=dy, **kw)
        BRS(rng, f / 2, t0 + b * beat, ln_s, 0.85, kind='bone', gain=0.7, dyn=dy, **kw)
        STR(rng, [f, f * 2], t0 + b * beat, ln_s, 0.85, stem='mel', gain=0.55, voices=5,
            dyn=dy, **kw)
    for b in range(int(round((t1 - t0) / beat))):         # half-time drums, heavy pulse
        tb = t0 + b * beat
        DRUM(rng, 'big' if b % 2 == 0 else 'low', tb, 1.0 if b % 2 == 0 else 0.7)
        DRUM(rng, 'hi', tb + beat / 2, 0.4)
        root = ('D3', 'B2', 'G2', 'A2', 'A2', 'A2')[min(b, 5)]
        for hh in (0.0, 0.5):
            for f in voicing(root, root == 'B2')['strs'][1:4]:
                SPC(rng, f, tb + hh * beat, 0.8, 0.2, gain=0.8)
    for s in range(8):                                    # roll into the cut
        DRUM(rng, 'mid' if s % 2 else 'low', t1 - (8 - s) * beat / 4, 0.45 + 0.07 * s)
    SWELL(rng, t1, 1.4, 0.7)

    # ------------------------------------------------ 34-37  out of thread
    rng = R('collapse')
    t0, t1 = T['collapse'], T['slowmo']
    d = t1 - t0
    nd = secs(d + 0.05)
    bend = -45.0 * np.arange(nd) / nd                     # the cluster sags
    dy = [(0, .9), (0.8, .55), (d, 1.0)]
    kw = dict(attack=0.03, release=0.05, trem=0.75, bend=bend, dyn=dy)
    STR(rng, ['Bb2', 'E3'], t0, d, 0.45, **kw)
    STR(rng, ['C#4', 'E4', 'G4', 'Bb4'], t0, d, 0.5, **kw)
    STR(rng, ['A5', 'Bb5'], t0, d, 0.3, bright=5200.0, **kw)
    SUB('Bb1', t0 + 0.3, d - 0.3, 0.35, attack=1.0, release=0.05, dyn=[(0, .4), (d - 0.3, 1.0)])
    dr = T['rattle_stop'] - t0
    SFX(sfx.spool_rattle(rng, dr), t0 + 0.02, 1.3, pan_=0.12, hall=0.1, room=0.3)
    snap, pre = sfx.whip_snap(rng)
    SFX(snap, T['snap'] - pre, 1.6, pan_=-0.1, hall=0.25, room=0.4)
    for i, tp in enumerate(tl.pops):
        f = hz('E4') * 2.0 ** (i * 1.0 / 12.0)            # each pop a semitone higher
        SFX(sfx.stitch_pop(rng, f), tp, 0.5 + 0.03 * i, pan_=0.5 - i * 0.1, hall=0.2, room=0.3)
    dw = t1 - T['pops']
    SFX(sfx.whoosh(rng, dw, [(0, 400), (dw, 1500)], 900.0, [(0, 0), (dw - 0.02, 1.0), (dw, 0)]),
        T['pops'], 0.3, hall=0.2)

    # -------------------------------------------------- 37-40  the catch
    # 'post' stem: stays clear while everything else is sucked under a low-pass.
    rng = R('catch')
    t0, tc, tn, t1 = T['slowmo'], T['catch'], T['tone'], T['knot']
    for k, tb in enumerate((tc - 1.0, tc, tc + 1.0)):
        if tb >= t0 + 0.05:
            mix.add('post', sfx.heartbeat(rng), tb, 1.2 if k != 1 else 1.4)
    mix.add('post', sfx.thwip(rng), tc, 0.9, pan_=0.05, hall=0.12, room=0.3)
    mix.add('post', pizz(hz('A3'), 0.8, rng), tc, 0.6, hall=0.4)
    d = t1 - tn
    # one pure note: the first note of her theme
    mix.add('post', pure_tone(hz('A4'), d + 0.6, rng, attack=0.9, release=1.2,
                              dyn=[(0, .4), (d, 1.0), (d + 0.6, .7)]), tn, 0.6, hall=0.6)
    for nm, tb, v in (('A4', tn + 0.4, 0.3), ('A3', tn + 0.9, 0.22)):
        f = hz(nm)
        mix.add('post', strings(f, t1 - tb + 0.4, v, rng, attack=1.0, release=1.0, voices=4,
                                center=seat(f), dyn=[(0, .4), (t1 - tb, 1.0), (t1 - tb + 0.4, .8)]),
                tb, 0.9, hall=0.5)

    # ------------------------------------------------ 40-42.5  red to gold
    rng = R('knot')
    t0, t1 = T['knot'], T['redrun']
    tp = t0 + 3 * beat                                   # pivot: B7, dominant of E
    STR(rng, ['D3', 'A3', 'D4', 'F#4', 'A4'], t0 - 0.3, tp - t0 + 0.3, 0.38, attack=0.6,
        release=0.5, bright=2200.0)
    d = t1 - tp
    sw = [(0, .45), (d, 1.0)]
    STR(rng, ['B2', 'F#3', 'B3', 'D#4', 'F#4', 'A4', 'F#5'], tp, d - GAP, 0.6, attack=0.2,
        release=0.04, dyn=sw)
    BRS(rng, ['B2', 'F#3', 'B3'], tp + 0.2, d - 0.2 - GAP, 0.75, attack=0.3, release=0.04, dyn=sw)
    SUB('B1', tp, d - GAP, 0.7, attack=0.2, release=0.04, dyn=sw)
    for st, b, _ in THEME_Q:                              # warm fragment of her theme
        tb = t0 + b * beat
        mix.add('keys', musicbox(th('D5', st), 0.8, rng, warm=0.6), tb, 0.7, pan_=-0.15, hall=0.5)
        mix.add('keys', piano(th('D4', st), 0.6, rng, 2.2), tb, 0.75, pan_=0.1, hall=0.4)
    mix.add('keys', piano(hz('D3'), 0.5, rng, 2.5), t0, 0.7, hall=0.4)
    dc = T['tok'] - t0 - 0.15
    SFX(sfx.creak(rng, dc, [(0, 18), (dc * 0.7, 30), (dc, 75)],
                  [(900, 9, 1.0), (1750, 11, 0.7), (2700, 12, 0.4)],
                  [(0, .25), (dc * 0.6, .6), (dc, 1.0)]), t0 + 0.12, 0.16, pan_=0.1, hall=0.08)
    SFX(sfx.tok(rng), T['tok'], 1.1, pan_=0.05, hall=0.1, room=0.35)
    dr = t1 - GAP - (t0 + 1.0)
    nr = secs(dr)
    SFX(fade(shepard(nr, rng, octs=1.5, c0=400.0, c1=1800.0) * curve(nr, [(0, 0), (dr, 1)]) ** 2,
             0.01, 0.01), t0 + 1.0, 0.2, hall=0.3)
    SFX(sfx.whoosh(rng, dr, [(0, 500), (dr, 4500)], 1200.0, [(0, 0), (dr - 0.01, 1.0), (dr, 0)]),
        t0 + 1.0, 0.3, hall=0.3)
    SWELL(rng, t1, 1.2, 0.9)
    for s in range(4):
        DRUM(rng, 'low' if s % 2 else 'mid', t1 - (4 - s) * beat / 4, 0.45 + 0.15 * s)

    # ------------------------------------- 42.5-47  the red run (E major)
    rng = R('redrun')
    t0, t1 = T['redrun'], T['last_pierce']
    prog = [('E3', False, 'E4', 'E2'), ('E3', False, 'E4', 'E2'), ('C#3', True, 'C#4', 'C#2'),
            ('E3', False, 'E4', 'G#2'), ('B2', False, 'B3', 'B1'), ('C#3', True, 'C#4', 'C#2'),
            ('A2', False, 'A3', 'A1'), ('B2', False, 'B3', 'B1'), ('B2', False, 'B3', 'B1')]
    mel = [(7, 0, 1.0), (12, 1, 1.5), (9, 2.5, 0.5), (16, 3, 1.0),      # B  E' C#' G#'
           (14, 4, 1.0), (12, 5, 1.5), (9, 6.5, 0.5), (19, 7, 2.0)]     # F#' E' C#' B' (lifts)
    mix.add('cym', crash(rng, 2.6), t0, 1.0, hall=0.4)
    DRUM(rng, 'big', t0, 1.0)
    run(rng, t0, prog, mel, 'E4', tl.pierces_b,
        ['E4', 'F#4', 'G#4', 'B4', 'C#5', 'E5', 'F#5', 'G#5'], urgent=True)
    tA = t0 + 9 * beat                                               # 47.0: A sus2, V of D
    SWELL(rng, tA, 0.8, 0.7)

    # ------------------------------------------------ 47-50.6  the pull
    rng = R('pull')
    tp, tc = T['pull'], T['close']
    end = tc - GAP
    d = end - tA
    mix.add('cym', crash(rng, 2.4), tA, 0.9, hall=0.4)
    DRUM(rng, 'big', tA, 1.0)
    sw = [(0, .85), (tp - tA, .7), (d, 1.0)]
    cut = dict(release=0.02)
    STR(rng, ['A2', 'E3', 'A3', 'B3', 'E4', 'A4', 'B4', 'E5'], tA, d, 0.7, attack=0.04,
        trem=0.5, dyn=sw, **cut)
    BRS(rng, ['A2', 'E3', 'A3'], tA, d, 0.9, kind='bone', attack=0.05, dyn=sw, **cut)
    BRS(rng, ['E4', 'A4'], tA, d, 0.85, attack=0.05, dyn=sw, **cut)
    SUB('A1', tA, d, 0.85, release=0.02, dyn=sw)
    PIERCE(rng, t1, 'A4', size=1.9, gain=1.5, duck=-4.0)             # last, biggest pierce
    DRUM(rng, 'big', t1, 1.0)
    SFX(sfx.sub_boom(rng, 46.0, 75.0, 0.3, 0.6), t1, 0.8, room=0.2, stem='hit')

    dp = end - tp
    bl = (tc - tp) / 5.0                                             # 5 beats to the close
    CHO(rng, ['A2', 'E3', 'A3', 'E4', 'A4', 'C#5', 'E5'], tp, dp, 0.85, attack=0.3,
        dyn=[(0, .3), (dp, 1.0)], morph=[(0, 0), (dp * 0.85, 1)], **cut)
    scale = ('A4', 'B4', 'C#5', 'D5', 'E5', 'F#5', 'G5', 'A5', 'B5', 'C#6')   # hauling upward
    for i, nm in enumerate(scale):
        tn_ = tp + i * bl / 2
        ln = min(bl / 2, end - tn_)
        v = 0.55 + 0.045 * i
        STR(rng, [hz(nm), hz(nm) * 2], tn_, ln, v, stem='mel', gain=0.95, attack=0.03,
            release=0.03 if i == 9 else 0.1, trem=0.5, voices=5)
        if i >= 4:
            BRS(rng, nm, tn_, ln, v, kind='trumpet', gain=0.9, attack=0.03,
                release=0.02 if i == 9 else 0.08)
    for b in (0, 1, 2, 2.5, 3, 3.25, 3.5, 3.75) + tuple(4 + k / 8 for k in range(8)):
        DRUM(rng, 'big' if b in (0, 1, 2, 3) else ('low' if b < 4 else 'mid'), tp + b * bl,
             min(1.0, 0.6 + 0.09 * b))
    npl = secs(dp)
    riser = shepard(npl, rng, octs=2.4, c0=250.0, c1=2200.0) * curve(npl, [(0, .15), (dp, 1)]) ** 1.5
    SFX(fade(riser, 0.02, 0.012), tp, 0.3, hall=0.3)
    SFX(sfx.whoosh(rng, dp, [(0, 300), (dp * 0.7, 1500), (dp, 6000)], 1300.0,
                   [(0, 0), (dp * 0.6, .3), (dp - 0.012, 1.0), (dp, 0)]), tp, 0.45, hall=0.3)
    SFX(sfx.creak(rng, dp, [(0, 9), (dp * 0.6, 22), (dp, 60)],
                  [(310, 8, 1.0), (760, 10, 0.8), (1350, 11, 0.5)],
                  [(0, .5), (dp * 0.8, 1.0), (dp - 0.01, 1.0), (dp, 0)]), tp, 0.3, pan_=-0.25,
        hall=0.15, room=0.2)
    near, far = sfx.zip_run(rng, dp)
    SFX(near, tp, 0.42, hall=0.1, room=0.2)
    SFX(far, tp, 0.30, hall=0.6)
    SWELL(rng, tc, dp - 0.01, 1.0, shape=2.5)

    # ------------------------------------------------ 50.6  the sky closes
    rng = R('close')
    # One composite impact, soft-clipped as a whole so it is dense rather than merely peaky.
    nb_ = secs(0.5)
    imp = pan(sfx.boom_close(rng), 0.0)[:nb_] * 2.2
    imp[:secs(0.3)] += pan(taiko("big", 1.0, rng)[:secs(0.3)] * np.linspace(1, 0, secs(0.3)) ** 2, 0.0)
    for nm, v in (("D2", 1.0), ("D3", 1.0), ("A3", .8), ("D4", .8)):   # the tonic arrives
        f = hz(nm)
        s = 0.55 * brass(f, 0.12, v, rng, attack=0.01, release=0.14, bright=1800.0, horn=False,
                         center=0.0) + 0.3 * strings(f, 0.12, v, rng, attack=0.01, release=0.14,
                                                     center=seat(f))
        imp[:len(s)] += s
    tg_ = np.arange(nb_) / SR                              # hard gate: silence must follow at once
    gate = np.cos(0.5 * np.pi * np.clip((tg_ - 0.17) / 0.1, 0, 1)) ** 2
    mix.add("post", lp(np.tanh(1.3 * imp), 5000.0) / 0.86 * gate[:, None], tc, 3.2, hall=0.07)
    c0, c1 = tl.chime_win
    for i, (u, nm) in enumerate(((0.05, 'A6'), (0.33, 'F#6'), (0.62, 'D7'), (0.86, 'E6'))):
        mix.add('post', sfx.chime(rng, hz(nm) * 2 ** (rng.normal(0, 8) / 1200), 2.4),
                c0 + u * (c1 - c0), 0.04, pan_=(-0.5, 0.4, -0.15, 0.6)[i], hall=0.5)

    # --------------------------------------------- 52-60  a new constellation
    rng = R('ending')
    t_last, t_fin = T['last_note'], T['final']
    SFX(sfx.exhale(rng), T['exhale'], 0.55, pan_=0.05, hall=0.08, room=0.15)
    SFX(sfx.chime(rng, hz('A6'), 2.8), T['chime'], 0.12, pan_=0.3, hall=0.6)
    t0 = t_last - 11 * beat                               # theme: question, then answer
    for phrase, off in ((THEME_Q, 0), (THEME_A, 8)):
        for i, (st, b, ln) in enumerate(phrase):
            tb = t0 + (off + b) * beat
            final = off == 8 and i == 3
            mix.add('keys', piano(th('D4', st), 0.55 if not final else 0.65, rng, 3.4), tb, 0.9,
                    pan_=0.08, hall=0.45)
            mix.add('keys', musicbox(th('D5', st), 0.6, rng, 3.0, warm=0.5), tb + 0.008,
                    0.55 if off else 0.35, pan_=-0.2, hall=0.6)
    for nm, b, v in (('D3', 0, .5), ('A3', 1, .4), ('B2', 3, .5), ('F#3', 4, .4), ('G2', 5, .5),
                     ('D3', 6, .4), ('A2', 7, .5), ('E3', 9, .4)):
        mix.add('keys', piano(hz(nm), v, rng, 3.0), t0 + b * beat, 0.8, pan_=0.12, hall=0.45)
    for k, nm in enumerate(('D2', 'A2', 'F#3', 'A3')):                 # rolled final chord
        mix.add('keys', piano(hz(nm), 0.5, rng, 3.0), t_last + 0.025 * k, 0.8, pan_=0.12, hall=0.45)
    tg, ta = t_fin, t0 + 7 * beat                         # G add9 -> A sus4 -> A -> D add9
    kw = dict(bright=2000.0, voices=5)
    STR(rng, ['G2', 'D3', 'B3', 'D4', 'A4'], tg, ta - tg, 0.34, attack=0.7, release=0.6, **kw)
    STR(rng, ['A2', 'E3', 'A3', 'E4'], ta, t_last - ta, 0.36, attack=0.4, release=0.5, **kw)
    STR(rng, 'D4', ta, t_last - ta - 1.0, 0.36, attack=0.4, release=0.4, **kw)
    STR(rng, 'C#4', t_last - 1.0, 1.0, 0.36, attack=0.3, release=0.4, **kw)
    de = T['silence'] - t_last + 0.3
    STR(rng, ['D3', 'A3', 'D4', 'E4', 'F#4', 'A4'], t_last - 0.05, de, 0.42, attack=0.3,
        release=0.3, **kw)                                # D add9: home
    CHO(rng, ['F#4', 'A4', 'D5'], t_last - 0.05, de, 0.3, vowel='oo', attack=0.4, release=0.3)
    SUB('D2', t_last, de, 0.35, attack=0.15, release=0.3)
    SFX(sfx.sparkle(rng, 1.5, 34, PENTA_HI, decay=(0.2, 0.8), front=1.2), T['shimmer'], 0.085,
        hall=0.8)


# =====================================================================
# Mixdown and mastering
# =====================================================================

def convolve(x, ir, n):
    return np.stack([signal.fftconvolve(x[:, c], ir[:, c])[:n] for c in range(2)], axis=1)


def shelf_hi(x, f, gain_db):
    """RBJ high shelf."""
    A, w = 10.0 ** (gain_db / 40.0), 2 * np.pi * f / SR
    c, al = np.cos(w), np.sin(w) / np.sqrt(2.0)
    b = [A * ((A + 1) + (A - 1) * c + 2 * np.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * c),
         A * ((A + 1) + (A - 1) * c - 2 * np.sqrt(A) * al)]
    a = [(A + 1) - (A - 1) * c + 2 * np.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * c),
         (A + 1) - (A - 1) * c - 2 * np.sqrt(A) * al]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def duck_gain(n, events):
    g = np.zeros(n)
    for t, depth, rel in events:
        a, r = secs(0.008), secs(rel)
        seg = np.concatenate([np.linspace(0, depth, a),
                              depth * (0.5 + 0.5 * np.cos(np.pi * np.arange(r) / r))])
        i0 = max(0, secs(t) - a)
        i1 = min(n, i0 + len(seg))
        g[i0:i1] = np.minimum(g[i0:i1], seg[:i1 - i0])
    return db(g)


def lufs(x):
    """Integrated loudness, ITU-R BS.1770-4 (48 kHz K-weighting, gated)."""
    y = signal.lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285],
                       [1.0, -1.69065929318241, 0.73248077421585], x, axis=0)
    y = signal.lfilter([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621], y, axis=0)
    blk, hop = secs(0.4), secs(0.1)
    cs = np.vstack([np.zeros((1, 2)), np.cumsum(y * y, axis=0)])
    starts = np.arange(0, len(y) - blk + 1, hop)
    z = ((cs[starts + blk] - cs[starts]) / blk).sum(axis=1)
    lk = -0.691 + 10 * np.log10(z + 1e-12)
    z = z[lk > -70.0]
    rel = -0.691 + 10 * np.log10(z.mean()) - 10.0
    z = z[-0.691 + 10 * np.log10(z + 1e-12) > rel]
    return -0.691 + 10 * np.log10(z.mean())


def true_peak_db(x):
    return 20 * np.log10(np.max(np.abs(signal.resample_poly(x, 4, 1, axis=0))) + 1e-12)


def limiter(x, ceil, hold=0.05):
    """Look-ahead peak limiter: gain is the smoothed running minimum, so it never overshoots."""
    g = np.minimum(1.0, ceil / np.maximum(np.max(np.abs(x), axis=1), 1e-9))
    g = minimum_filter1d(g, size=secs(hold) | 1, mode='nearest')
    g = uniform_filter1d(g, size=secs(hold * 0.6) | 1, mode='nearest')
    g = uniform_filter1d(g, size=secs(hold * 0.3) | 1, mode='nearest')
    return x * g[:, None], float(20 * np.log10(g.min()))


def write_wav(path, x, bits=24):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    full = 2 ** (bits - 1) - 1
    q = np.clip(np.round(x * full), -full, full).astype('<i4')
    raw = q.astype('<i2').tobytes() if bits == 16 else \
        q.reshape(-1, 1).view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(bits // 8)
        w.setframerate(SR)
        w.writeframes(raw)


def render(debug=False, stems=False):
    t_start = time.time()
    tl = Timeline()
    if tl.missing:
        print('WARNING: cues not found in timeline.json, defaults used:', tl.missing)
    T = tl.t
    n = secs(tl.duration)
    mix = Mix(n)
    build(mix, tl)
    print('synthesis %.1fs' % (time.time() - t_start))

    rng = np.random.default_rng(7)
    hall = make_ir(rng, 2.7, 0.022)
    room = make_ir(rng, 0.7, 0.006, hf=0.6, lo_cut=110.0, hi_cut=9000.0)
    vast = make_ir(rng, 5.0, 0.03, hf=0.35, lo_cut=140.0, hi_cut=4500.0)   # tail of the boom
    grp = {}
    for g in ('music', 'sfx', 'post'):
        dry = sum(mix.dry[s] for s in GROUP if GROUP[s] == g)
        grp[g] = (dry + HALL_RET * convolve(mix.hall[g], vast if g == 'post' else hall, n)
                  + ROOM_RET * convolve(mix.room[g], room, n))
    tt = np.arange(n) / SR

    # music ducks under the big hits; after the sky closes everything else is cut away
    grp['music'] *= duck_gain(n, mix.ducks)[:, None]
    cut = np.interp(tt, [T['close'], T['close'] + 0.12, T['quiet'] - 0.3, T['quiet'] + 0.2],
                    [1.0, 0.05, 0.05, 1.0])
    pre = (grp['music'] + grp['sfx']) * cut[:, None]
    # cloud passage and slow motion: the world goes under a low-pass
    m = np.interp(tt, [T['cloud'] - 0.05, T['cloud'] + 0.12, T['burst'] - 0.004, T['burst'] + 0.012,
                       T['slowmo'] - 0.02, T['slowmo'] + 0.15, T['knot'] - 0.5, T['knot'] + 0.15],
                  [0, 1, 1, 0, 0, 1, 1, 0])[:, None]
    sos = signal.butter(1, 520.0, 'low', fs=SR, output='sos')
    muffled = signal.sosfiltfilt(sos, pre, axis=0)        # zero-phase: clean crossfade
    pre = pre * (1 - m) + muffled * m
    mixd = pre + grp['post']

    # fader rides: keep the quiet scenes quiet and let each climax top the last
    ride = [(0, -1), (T['reveal'] - .05, -1), (T['reveal'], -.5), (T['antic'], -1.5),
            (T['launch'] - .05, -1.5), (T['launch'], .5), (T['burst'], 1), (T['wonder'], 0), (T['wonder'] + .5, -2),
            (T['canyon'], -2), (T['canyon'] + 1, -.5), (T['pierce1'], 0), (T['drive'] - .05, 0),
            (T['drive'], 2.5), (T['majestic'], 3), (T['collapse'], 3), (T['collapse'] + .05, -3), (T['slowmo'], -3), (T['slowmo'] + .3, -1),
            (T['knot'], -1.5), (T['redrun'] - .5, -1), (T['redrun'], 3.5), (T['last_pierce'], 3.5), (T['pull'], 2), (T['close'] - .03, 4),
            (T['close'], 6), (T['close'] + .3, 0), (T['quiet'], 0), (tl.duration, 0)]
    mixd *= db(np.interp(tt, [p[0] for p in ride], [p[1] for p in ride]))[:, None]

    # master: clean the bottom, mono the lows, a little air, normalise, limit
    mixd = hp(mixd, 32.0, 4)
    mixd = shelf_hi(mixd - 0.3 * lp(mixd, 95.0, 1), 4500.0, 2.5)     # -3 dB low shelf
    mid, side = mixd.mean(axis=1), (mixd[:, 0] - mixd[:, 1]) / 2
    side = hp(side, 190.0, 4)
    mixd = np.stack([mid + side, mid - side], axis=1)
    fo = np.interp(tt, [T['silence'] - 0.7, T['silence']], [0.0, 1.0])
    mixd *= (np.cos(0.5 * np.pi * fo) ** 2)[:, None]
    # Soft-clip transients (4x oversampled, so no aliasing) before the limiter: drums and the
    # final boom become dense instead of merely peaky. Then iterate gain to the loudness target.
    up = signal.resample_poly(mixd, 4, 1, axis=0)
    knee, ceil = db(CEILING_DB - 4.5), db(CEILING_DB)
    gain, red, out = 1.0, 0.0, mixd
    for _ in range(6):
        gain *= db(TARGET_LUFS - lufs(out))
        a = np.abs(up) * gain
        clipped = np.where(a > knee, knee + (ceil - knee) * np.tanh((a - knee) / (ceil - knee)), a)
        out = lp(signal.resample_poly(np.sign(up) * clipped, 1, 4, axis=0)[:n], 13000.0)
        out, red = limiter(out, ceil)
    over = float(np.mean(np.abs(up) * gain > knee)) * 100.0
    tp = true_peak_db(out)
    if tp > -1.0:
        out *= db(-1.05 - tp)
    path = os.path.join(OUT_DIR, 'score.wav')
    write_wav(path, out)
    print('wrote %s  %.3fs  LUFS %.2f  true peak %.2f dBTP  max limiting %.1f dB  gain %.1f dB  soft-clipped %.2f%% of samples  (%.1fs)'
          % (path, len(out) / SR, lufs(out), true_peak_db(out), red, 20 * np.log10(gain), over,
             time.time() - t_start))

    if stems:
        for g in ('music', 'sfx', 'post'):
            x = grp[g] * (cut[:, None] if g != 'post' else 1.0) * gain
            write_wav(os.path.join(OUT_DIR, 'stems', g + '.wav'), np.clip(x, -1, 1), 16)
    if debug:
        edges = [0, 2, 4, 7.5, 11.5, 12.2, 14.5, 15.6, 18, 20.5, 23, 24.3, 26, 31, 34, 37, 40,
                 42.5, 47, 48.2, 50.6, 52, 55.5, 58.5, 60]
        print('\nper-stem dry RMS (dBFS, pre-master) by section')
        print('%-7s' % 't0' + ''.join('%7s' % s for s in GROUP))
        for a, b in zip(edges[:-1], edges[1:]):
            row = '%-7.1f' % a
            for s in GROUP:
                v = rms(mix.dry[s][secs(a):secs(b)])
                row += '%7s' % ('.' if v < 1e-6 else '%.0f' % (20 * np.log10(v)))
            print(row)


if __name__ == '__main__':
    render(debug='--debug' in sys.argv, stems='--stems' in sys.argv)
