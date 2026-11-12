"""Reads ../timeline.json and resolves every sync point the score needs.

Cues carry no ids, so each is found by a stable phrase in its description; if a
phrase disappears the documented default time is used (and reported).
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
TIMELINE = os.path.normpath(os.path.join(HERE, '..', 'timeline.json'))
OUT_DIR = os.path.normpath(os.path.join(HERE, '..', 'out', 'audio'))

# key, phrase in the cue description, default time (s)
_CUES = [
    ('amb', 'High mountain night', 0.0),
    ('star_fall', 'Falling star:', 0.9),
    ('star_land', 'Star lands', 1.6),
    ('theme1', 'first statement', 2.0),
    ('darken', 'Pad darkens', 4.0),
    ('more_stars', 'More falling stars', 5.0),
    ('reveal', 'REVEAL', 7.5),
    ('antic', 'Anticipation', 11.5),
    ('launch', 'LAUNCH', 12.2),
    ('cloud', 'Inside cloud', 14.5),
    ('burst', 'Burst out', 15.6),
    ('wonder', 'Slow motion wonder', 18.0),
    ('canyon', 'Canyon of light', 20.5),
    ('dive', 'Dive:', 23.0),
    ('pierce1', 'PIERCE.', 24.3),
    ('drive', 'Whipstitch run', 26.0),
    ('majestic', 'Majestic wide', 31.0),
    ('collapse', 'tremolo cluster', 34.0),
    ('snap', 'whips free', 35.2),
    ('pops', 'Stitches popping', 35.6),
    ('slowmo', 'sound sucked out', 37.0),
    ('knot', 'Macro knot', 40.0),
    ('redrun', 'Red run', 42.5),
    ('last_pierce', 'Last pierce', 47.6),
    ('pull', 'THE PULL', 48.2),
    ('close', 'SKY CLOSES', 50.6),
    ('quiet', 'Gentle wind', 52.0),
    ('final', 'Final wide', 55.5),
]

_NUM = r'(\d+(?:\.\d+)?)'


def _one(desc, pattern, default):
    m = re.search(pattern, desc)
    return float(m.group(1)) if m else default


def _pair(desc, pattern, default):
    m = re.search(pattern, desc)
    return (float(m.group(1)), float(m.group(2))) if m else default


def _list(desc, default):
    for grp in re.findall(r'\(([^()]*)\)', desc):
        vals = re.findall(_NUM, grp)
        if len(vals) >= 3 and re.fullmatch(r'[\d.,\s]+', grp):
            return [float(v) for v in vals]
    return default


def _steps(a, b, step):
    out, t = [], a
    while t <= b + 1e-6:
        out.append(round(t, 4))
        t += step
    return out


class Timeline:
    def __init__(self, path=TIMELINE):
        with open(path) as f:
            data = json.load(f)
        self.duration = float(data.get('duration', 60))
        self.bpm = float(data.get('bpm', 120))
        self.beat = 60.0 / self.bpm
        cues = data.get('audio_cues', [])
        self.t, self.missing = {}, []
        d = {}
        for key, phrase, default in _CUES:
            hit = next((c for c in cues if phrase in c.get('desc', '')), None)
            if hit is None:
                self.missing.append(key)
            self.t[key] = float(hit['t']) if hit else default
            d[key] = hit['desc'] if hit else ''
        t, b = self.t, self.beat

        # sync points that live inside cue descriptions
        self.stars = _list(d['more_stars'], [5.0, 5.6, 6.1, 6.5, 6.9])
        t['drone'] = _one(d['darken'], r'from ' + _NUM, 6.0)
        a = _pair(d['drive'], r'from ' + _NUM + r' to ' + _NUM,
                  (t['drive'] + b, t['majestic'] - b))
        self.pierces_a = _steps(a[0], a[1], b)
        t['rattle_stop'] = _one(d['collapse'], r'stops at ' + _NUM, t['collapse'] + 1.0)
        self.pops = _list(d['pops'], [35.6, 35.9, 36.15, 36.35, 36.5, 36.62, 36.72,
                                      36.8, 36.87, 36.93])
        t['catch'] = _one(d['slowmo'], r'At ' + _NUM + r' the catch', t['slowmo'] + 1.2)
        t['tone'] = _one(d['slowmo'], r'From ' + _NUM + r' one sustained', t['slowmo'] + 1.5)
        t['tok'] = _one(d['knot'], r'tight at ' + _NUM, t['knot'] + 1.6)
        a = _pair(d['redrun'], _NUM + r'\s*\.\.\.\s*' + _NUM,
                  (t['redrun'] + b, t['redrun'] + 8 * b))
        self.pierces_b = _steps(a[0], a[1], b)
        self.chime_win = _pair(d['close'], r'\(' + _NUM + r'\s*-\s*' + _NUM + r'\)',
                               (t['close'] + 0.3, t['quiet']))
        t['exhale'] = _one(d['quiet'], r'breath \(' + _NUM + r'\)', t['quiet'] + 0.4)
        t['chime'] = _one(d['quiet'], r'chime \(' + _NUM + r'\)', t['quiet'] + 1.2)
        t['shimmer'] = _one(d['final'], r'shimmer at ' + _NUM, t['final'] + 1.5)
        t['last_note'] = _one(d['final'], r'Last note at ' + _NUM, t['final'] + 3.0)
        t['silence'] = _one(d['final'], r'silence by ' + _NUM, self.duration - 0.2)

    def sync_points(self):
        """(label, time) pairs that must show a transient within 20 ms."""
        t = self.t
        pts = [('star lands', t['star_land']), ('reveal', t['reveal']),
               ('launch', t['launch']), ('burst', t['burst']),
               ('first pierce', t['pierce1'])]
        pts += [('pierce', p) for p in self.pierces_a]
        pts += [('whip-snap', t['snap']), ('catch', t['catch']), ('knot tok', t['tok'])]
        pts += [('red pierce', p) for p in self.pierces_b]
        pts += [('last pierce', t['last_pierce']), ('sky closes', t['close'])]
        return pts
