"""Log-frequency spectrogram PNG of a time range, with note and cue gridlines.

    python audio/specplot.py out.png [t0 t1 [fmin fmax [wav]]]
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import signal
from scipy.io import wavfile

from cues import OUT_DIR, Timeline
from synth import hz

W, H, ML, MB = 1500, 640, 60, 24


def main():
    a = sys.argv[1:]
    out = a[0]
    t0, t1 = (float(a[1]), float(a[2])) if len(a) > 2 else (0.0, 60.0)
    fmin, fmax = (float(a[3]), float(a[4])) if len(a) > 4 else (30.0, 12000.0)
    path = a[5] if len(a) > 5 else os.path.join(OUT_DIR, 'score.wav')
    sr, x = wavfile.read(path)
    x = x.astype(np.float64).mean(axis=1) / (2.0 ** 31 if x.dtype == np.int32 else 2.0 ** 15)
    seg = x[int(t0 * sr):int(t1 * sr)]
    nfft = 8192 if (t1 - t0) > 6 else 4096
    hop = max(64, int(len(seg) / W))
    f, t, S = signal.spectrogram(seg, sr, window='hann', nperseg=nfft, noverlap=nfft - hop,
                                 mode='magnitude', scaling='spectrum')
    S = 20 * np.log10(S * np.sqrt(2) + 1e-9)
    fy = fmin * (fmax / fmin) ** (np.arange(H)[::-1] / (H - 1))
    tx = np.linspace(t[0], t[-1], W)
    ix = np.clip(np.searchsorted(t, tx), 0, len(t) - 1)
    img = np.empty((H, W))
    for r, fr in enumerate(fy):   # max over the bins each pixel row covers
        lo = np.searchsorted(f, fr * 0.985)
        hi = max(lo + 1, np.searchsorted(f, fr * 1.015))
        img[r] = S[lo:hi].max(axis=0)[ix]
    v = np.clip((img + 95.0) / 85.0, 0, 1)        # -95 .. -10 dBFS
    rgb = np.stack([np.clip(3 * v - 0.6, 0, 1), np.clip(3 * v - 1.5, 0, 1),
                    np.clip(np.where(v < 0.35, 2.2 * v, 2.6 * v - 1.6), 0, 1)], axis=2)
    canvas = Image.new('RGB', (W + ML, H + MB), (0, 0, 0))
    canvas.paste(Image.fromarray((rgb * 255).astype(np.uint8)), (ML, 0))
    d = ImageDraw.Draw(canvas)

    def ypix(fr):
        return int((1 - np.log(fr / fmin) / np.log(fmax / fmin)) * (H - 1))

    for name in ('D2', 'A2', 'D3', 'A3', 'D4', 'F#4', 'A4', 'B4', 'D5', 'E5', 'F#5', 'A5', 'D6',
                 'F#6', 'A6', 'D7'):
        fr = hz(name)
        if fmin < fr < fmax:
            d.line([(ML - 5, ypix(fr)), (ML, ypix(fr))], fill=(255, 255, 255))
            d.text((2, ypix(fr) - 5), '%s %d' % (name, fr), fill=(200, 200, 200))
    for fr in (50, 100, 1000, 3000, 5000, 9000):
        if fmin < fr < fmax:
            d.text((2, ypix(fr) - 5), '%d Hz' % fr, fill=(120, 200, 255))
            d.line([(ML - 5, ypix(fr)), (ML, ypix(fr))], fill=(120, 200, 255))
    step = 1.0 if (t1 - t0) <= 20 else 5.0
    for k in np.arange(np.ceil(t0 / step) * step, t1 + 1e-6, step):
        xx = ML + int((k - t0) / (t1 - t0) * (W - 1))
        d.line([(xx, H), (xx, H + 4)], fill=(255, 255, 255))
        d.text((xx - 8, H + 8), '%g' % k, fill=(220, 220, 220))
    for _, tc in Timeline().sync_points():       # cue ticks along the top edge
        if t0 <= tc <= t1:
            xx = ML + int((tc - t0) / (t1 - t0) * (W - 1))
            d.line([(xx, 0), (xx, 10)], fill=(0, 255, 120))
    canvas.save(out)
    print('wrote', out)


if __name__ == '__main__':
    main()
