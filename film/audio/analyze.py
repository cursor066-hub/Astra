"""Objective checks on out/audio/score.wav: format, levels, dynamic arc, cue sync, stereo, spectrum.

    python audio/analyze.py [path.wav]
"""
import os
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d

from cues import OUT_DIR, Timeline
from score import THEME_A, THEME_Q, lufs, true_peak_db
from synth import hz

FAILS = []


def check(ok, label):
    print('  [%s] %s' % ('PASS' if ok else 'FAIL', label))
    if not ok:
        FAILS.append(label)


def load(path):
    sr, x = wavfile.read(path)
    x = x.astype(np.float64) / (2.0 ** 31 if x.dtype == np.int32 else 2.0 ** 15)
    return sr, x


def dbv(v):
    return 20 * np.log10(v + 1e-12)


def rms_win(x, sr, a, b):
    seg = x[int(round(a * sr)):int(round(b * sr))]
    return dbv(np.sqrt(np.mean(seg ** 2))) if len(seg) else -200.0


def onset_offsets(x, sr, points, tol=0.02, wide=0.06):
    """Onset strength = jump in band energy (dB) from just before to just after an instant.

    For each cue returns the strongest onset peak within +/-tol (offset ms, rise dB) and,
    for context, the strongest anywhere within +/-wide.
    """
    mono = x.mean(axis=1)
    # (band, window after, window before); the sub band needs windows longer than one cycle
    bands = [((40, 150), 0.030, 0.050), ((150, 500), 0.015, 0.028), ((500, 2000), 0.015, 0.028),
             ((2000, 5000), 0.015, 0.028), ((5000, 10000), 0.015, 0.028)]
    gap = int(0.002 * sr)
    rises = []
    for (lo, hi), post, pre in bands:
        post, pre = int(post * sr), int(pre * sr)
        sos = signal.butter(4, [lo, hi], 'band', fs=sr, output='sos')
        e = signal.sosfiltfilt(sos, mono) ** 2
        cs = np.concatenate([[0.0], np.cumsum(e)])
        i = np.arange(len(e))
        after = (cs[np.minimum(i + post, len(e))] - cs[i]) / post
        before = (cs[np.maximum(i - gap, 0)] - cs[np.maximum(i - gap - pre, 0)]) / pre
        floor = 1e-9  # ignore jumps out of digital silence in an empty band
        rises.append(10 * np.log10((after + floor) / (before + floor)))
    rise = uniform_filter1d(np.max(rises, axis=0), size=int(0.002 * sr))
    peaks = np.zeros(len(rise), dtype=bool)
    peaks[1:-1] = (rise[1:-1] >= rise[:-2]) & (rise[1:-1] > rise[2:])
    out = []
    for label, t in points:
        c = int(round(t * sr))
        res = []
        for w in (int(tol * sr), int(wide * sr)):
            a = max(1, c - w)
            idx = a + np.nonzero(peaks[a:c + w + 1])[0]
            if len(idx):
                k = idx[np.argmax(rise[idx])]
                res += [(k - c) / sr * 1000.0, float(rise[k])]
            else:
                res += [float('nan'), 0.0]
        out.append((label, t) + tuple(res))
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(OUT_DIR, 'score.wav')
    tl = Timeline()
    T = tl.t
    sr, x = load(path)
    dur = len(x) / sr

    print('== 1. format / levels ==')
    print('  %s: %d Hz, %d ch, %.4f s' % (path, sr, x.shape[1], dur))
    check(sr == 48000 and x.shape[1] == 2 and abs(dur - tl.duration) < 1e-4,
          '48 kHz stereo, exactly %.3f s' % tl.duration)
    peak, tp, il = dbv(np.max(np.abs(x))), true_peak_db(x), lufs(x)
    print('  sample peak %.2f dBFS, true peak %.2f dBTP, integrated %.2f LUFS, DC %.1e'
          % (peak, tp, il, np.abs(x.mean(axis=0)).max()))
    check(tp <= -1.0, 'true peak <= -1.0 dBTP')
    check(abs(il + 16.0) <= 1.5, 'integrated loudness -16 LUFS +/- 1.5')
    check(np.mean(np.abs(x) > 0.999) == 0, 'no clipped samples')

    print('\n== 3. dynamics: RMS dBFS per 0.5 s window ==')
    w = np.array([rms_win(x, sr, a, a + 0.5) for a in np.arange(0, dur, 0.5)])
    for row in range(0, len(w), 10):
        print('  %5.1fs | ' % (row * 0.5) + ' '.join('%6.1f' % v for v in w[row:row + 10]))

    def sec(a, b):  # energy-mean level of a span
        return rms_win(x, sr, a, b)

    drive, quiet_mid = sec(T['drive'], T['collapse']), sec(T['collapse'], T['redrun'])
    opening = sec(0, T['reveal'] - 0.5)
    reveal_jump = sec(T['reveal'], T['reveal'] + 0.5) - sec(T['reveal'] - 0.5, T['reveal'])
    peak_win = max(rms_win(x, sr, a, a + 0.5) for a in np.arange(T['close'] - 0.5, T['close'] + 0.01, 0.05))
    loudest = max((rms_win(x, sr, a, a + 0.5), a) for a in np.arange(0, dur - 0.5, 0.05))
    after = max(rms_win(x, sr, a, a + 0.1) for a in np.arange(tl.chime_win[0], tl.chime_win[1] - 0.09, 0.05))
    pull = [sec(a, a + 0.6) for a in np.arange(T['pull'], T['close'] - 0.59, 0.6)]
    tail = sec(T['silence'], dur)
    print('  opening %.1f | reveal jump +%.1f dB | drive 26-34 %.1f | 34-42.5 %.1f | red run %.1f'
          % (opening, reveal_jump, drive, quiet_mid, sec(T['redrun'], T['last_pierce'])))
    print('  pull (0.6 s steps) %s | close peak window %.1f | loudest 0.5 s window %.1f at %.2fs'
          % (' '.join('%.1f' % v for v in pull), peak_win, loudest[0], loudest[1]))
    print('  after the close (max 100 ms window, %.1f-%.1f s) %.1f = %.1f dB below peak | '
          'ending %.1f-end %.1f' % (tl.chime_win[0], tl.chime_win[1], after, peak_win - after,
                                    T['silence'], tail))
    climax = max(drive, peak_win)
    check(climax - opening >= 18, 'opening at least 18 dB under the climaxes (%.1f)' % (climax - opening))
    check(reveal_jump >= 8, 'reveal at 7.5 jumps clearly (+%.1f dB)' % reveal_jump)
    check(drive - quiet_mid >= 10, '34-42.5 much quieter than 26-34 (%.1f dB)' % (drive - quiet_mid))
    check(all(b > a for a, b in zip(pull[:-1], pull[1:])), 'pull rises monotonically')
    check(abs(loudest[1] + 0.25 - T['close']) <= 0.5 and peak_win >= loudest[0] - 0.1,
          'loudest point of the film is the close at %.1f s' % T['close'])
    check(peak_win - after >= 25, 'near-silence after the close is >= 25 dB below the peak')
    check(tail < -90, 'silent from %.1f s' % T['silence'])

    print('\n== 4. sync: strongest energy onset near each cue (limit +/- 20 ms) ==')
    runs = [('full mix', x)]
    sp, pp = (os.path.join(OUT_DIR, 'stems', s + '.wav') for s in ('sfx', 'post'))
    if os.path.exists(sp) and os.path.exists(pp):   # effects alone, without the music
        runs.append(('effects stems only (score.py --stems)', load(sp)[1] + load(pp)[1]))
    for name, sig in runs:
        res = onset_offsets(sig, sr, tl.sync_points())
        strict = sig is not x   # effects alone: the cue must also be the strongest onset nearby
        print('  -- %s --   [onset within 20 ms] [strongest within 60 ms]' % name)
        bad = 0
        for label, t, off, rise, woff, wrise in res:
            ok = rise >= (6 if strict else 3) and (not strict or abs(woff) <= 20)
            bad += not ok
            print('  %6.2fs %-13s %+6.1f ms %5.1f dB   | %+6.1f ms %5.1f dB%s'
                  % (t, label, off, rise, woff, wrise, '' if ok else '   <-- CHECK'))
        weak = min(r[3] for r in res)
        worst = np.nanmax([abs(r[2]) for r in res])
        check(bad == 0, '%s: every cue has an onset within 20 ms (largest offset %.1f ms, '
                        'weakest rise %.1f dB)' % (name, worst, weak))

    print('\n== 5. spectrum: share of energy per band ==')
    f, p = signal.welch(x.mean(axis=1), sr, nperseg=16384)
    tot = p.sum()
    edges = [0, 40, 80, 160, 320, 640, 1250, 2500, 5000, 9000, 24000]
    share = []
    for a, b in zip(edges[:-1], edges[1:]):
        share.append(10 * np.log10(p[(f >= a) & (f < b)].sum() / tot + 1e-12))
        print('  %5d-%5d Hz  %6.1f dB' % (a, b, share[-1]))
    check(share[0] <= -20, 'little energy below 40 Hz (%.1f dB)' % share[0])
    check(share[-1] <= -25, 'little energy above 9 kHz (%.1f dB)' % share[-1])
    check(max(share) <= -3.0, 'no single band dominates')

    print('\n== 5b. theme: prominence of each expected melody note (dB over 200-4000 Hz median) ==')

    def prominence(t, f0, win=0.2):
        seg = x[int((t + 0.02) * sr):int((t + 0.02 + win) * sr)].mean(axis=1)
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 1 << 16))
        fr = np.fft.rfftfreq(1 << 16, 1 / sr)
        band = sp[(fr > 200) & (fr < 4000)]
        return dbv(sp[(fr > f0 * 0.985) & (fr < f0 * 1.015)].max() / np.median(band))

    beat = tl.beat
    full = THEME_Q + [(s, b + 8, l) for s, b, l in THEME_A]
    sets = [('music box, 2.0 s', 'D5', T['theme1'], beat / 2,
             THEME_Q + [(s, b + 4, l) for s, b, l in THEME_A]),
            ('heroic, 26 s', 'D4', T['drive'], beat, THEME_Q),
            ('broad, 31 s', 'D4', T['majestic'], beat, [(7, 0, 1), (12, 1, 1), (9, 2, 1), (16, 3, 1)]),
            ('tender, 53 s', 'D4', T['last_note'] - 11 * beat, beat, full)]
    for name, tonic, t0, unit, notes in sets:
        vals = [prominence(t0 + b * unit, hz(tonic) * 2 ** (st / 12), min(0.2, unit * 0.9))
                for st, b, _ in notes]
        print('  %-18s %s' % (name, ' '.join('%5.1f' % v for v in vals)))
        check(min(vals) >= 12, 'theme audible: %s (weakest note %.1f dB)' % (name, min(vals)))

    print('\n== 6. stereo ==')
    lo = signal.sosfiltfilt(signal.butter(4, 150, 'low', fs=sr, output='sos'), x, axis=0)

    def corr(a):
        d = np.sqrt(np.sum(a[:, 0] ** 2) * np.sum(a[:, 1] ** 2))
        return float(np.sum(a[:, 0] * a[:, 1]) / d) if d > 1e-12 else 1.0

    cw = [corr(x[int(a * sr):int((a + 2) * sr)]) for a in np.arange(0, T['silence'] - 2, 2)]
    cl = [corr(lo[int(a * sr):int((a + 2) * sr)]) for a in np.arange(0, T['silence'] - 2, 2)]
    print('  full-band L/R correlation per 2 s: ' + ' '.join('%.2f' % c for c in cw))
    print('  below 150 Hz:                      ' + ' '.join('%.2f' % c for c in cl))
    mid, side = x.mean(axis=1), (x[:, 0] - x[:, 1]) / 2
    print('  whole film: correlation %.2f, side/mid %.1f dB, mono fold-down loss %.1f dB'
          % (corr(x), dbv(np.sqrt(np.mean(side ** 2)) / np.sqrt(np.mean(mid ** 2))),
             dbv(np.sqrt(np.mean(x ** 2))) - dbv(np.sqrt(np.mean(mid ** 2)))))
    check(min(cw) > 0.0, 'correlation never negative (min %.2f)' % min(cw))
    check(np.mean(np.array(cw) > 0.97) < 0.25, 'not pinned at +1 (stereo width present)')
    check(min(cl) > 0.9, 'lows are mono-compatible (min %.2f)' % min(cl))

    print('\n%s' % ('ALL CHECKS PASSED' if not FAILS else 'FAILED: ' + '; '.join(FAILS)))


if __name__ == '__main__':
    main()
