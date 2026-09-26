#!/usr/bin/env python3
"""Generates the Omoeba logo SVGs (assets/).

The "O" of Omoeba is an ammonite shell: a logarithmic spiral (the "knowledge spiral").
  assets/icon.svg      app icon: an ammonite on an ocean-blue rounded square
  assets/logo-mark.svg the ammonite alone (transparent background)
  assets/logo.svg      wordmark: ammonite "O" followed by "moeba"

Usage: npm run logo  (or python3 scripts/generate-logo.py)

The PNG and .icns files in assets/ were rendered from these SVGs; after changing the design,
re-render them with any SVG renderer (e.g. `rsvg-convert -w 1024 assets/icon.svg -o assets/icon.png`)
and rebuild icon.icns (e.g. with `iconutil` from an .iconset folder on macOS).
"""
import math
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')

# Palette
SHELL_LIGHT = '#FFC58A'
SHELL_DARK = '#FF8A5C'
LINE = '#7A3524'
RIB = '#D9653F'
SEA_TOP = '#5CD0D6'
SEA_BOTTOM = '#2C7FC2'

G = 1.85  # growth of the radius per turn (lower = rounder, more whorls)
K = math.log(G) / (2 * math.pi)


def set_growth(g):
    global G, K
    G = g
    K = math.log(g) / (2 * math.pi)


def R(theta, a):
    return a * math.exp(K * theta)


def pt(c, theta, a):
    r = R(theta, a)
    return (c[0] + r * math.cos(theta), c[1] + r * math.sin(theta))


def path_from(points, close=False):
    d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in points)
    return d + (' Z' if close else '')


def smooth_path(points, close=False):
    """Catmull-Rom through points -> cubic Béziers."""
    pts = points[:]
    if close:
        pts = [pts[-1]] + pts + [pts[0], pts[1]]
    else:
        pts = [pts[0]] + pts + [pts[-1]]
    d = f'M{pts[1][0]:.2f} {pts[1][1]:.2f}'
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f' C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}'
    return d + (' Z' if close else '')


def ammonite(c, a, theta_end, stroke, detail=True, uid='a'):
    """SVG for an ammonite whose outer whorl ends (aperture) at theta_end.

    `a` is the outer radius at the aperture."""
    a = a / math.exp(K * theta_end)
    t0 = theta_end - 2 * math.pi
    n = 120
    outline = [pt(c, t0 + (theta_end - t0) * i / n, a) for i in range(n + 1)]
    # Inner spiral (suture between whorls), down to a small radius.
    t_min = t0 - 3.2 * 2 * math.pi
    m = 240
    spiral = [pt(c, t_min + (t0 - t_min) * i / m, a) for i in range(m + 1)]
    parts = []
    parts.append(
        f'<defs><radialGradient id="shell-{uid}" cx="42%" cy="38%" r="70%">'
        f'<stop offset="0" stop-color="{SHELL_LIGHT}"/><stop offset="1" stop-color="{SHELL_DARK}"/>'
        f'</radialGradient></defs>'
    )
    parts.append(
        f'<path d="{smooth_path(outline, close=True)}" fill="url(#shell-{uid})" stroke="{LINE}" '
        f'stroke-width="{stroke}" stroke-linejoin="round"/>'
    )
    if detail:
        # Ribs across the two outer whorls.
        for band, (lo, hi, step, w) in enumerate([(t0, theta_end, 0.34, 0.55), (t0 - 2 * math.pi, t0, 0.42, 0.45)]):
            t = lo + step * 0.8
            while t < hi - step * 0.4:
                inner = R(t - 2 * math.pi, a)
                outer = R(t, a)
                r1 = inner + (outer - inner) * 0.18
                r2 = inner + (outer - inner) * 0.82
                # slightly curved rib (bends forward)
                mid_t = t + 0.06
                p1 = (c[0] + r1 * math.cos(t), c[1] + r1 * math.sin(t))
                p2 = (c[0] + r2 * math.cos(t + 0.02), c[1] + r2 * math.sin(t + 0.02))
                pm = (
                    c[0] + (r1 + r2) / 2 * math.cos(mid_t),
                    c[1] + (r1 + r2) / 2 * math.sin(mid_t),
                )
                parts.append(
                    f'<path d="M{p1[0]:.2f} {p1[1]:.2f} Q{pm[0]:.2f} {pm[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}" '
                    f'fill="none" stroke="{RIB}" stroke-width="{stroke * w:.2f}" stroke-linecap="round" opacity="0.8"/>'
                )
                t += step
    parts.append(
        f'<path d="{smooth_path(spiral)}" fill="none" stroke="{LINE}" stroke-width="{stroke}" '
        f'stroke-linecap="round" stroke-linejoin="round"/>'
    )
    # Glossy highlight on the outer whorl.
    hl = [pt(c, t0 + 2.9 + 0.9 * i / 20, a * 0.93) for i in range(21)]
    parts.append(
        f'<path d="{smooth_path(hl)}" fill="none" stroke="#FFFFFF" stroke-width="{stroke * 0.9:.2f}" '
        f'stroke-linecap="round" opacity="0.55"/>'
    )
    return '\n'.join(parts), outline


def bbox(points):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def icon_svg():
    set_growth(1.85)
    size = 1024
    # macOS icon grid: 824×824 rounded square centered in 1024 (radius ≈ 185).
    theta_end = math.radians(118)  # aperture at the lower left
    a = 300
    stroke = 16
    c0 = (0, 0)
    shell, outline = ammonite(c0, a, theta_end, stroke, uid='icon')
    bx0, by0, bx1, by1 = bbox(outline)
    # Center the shell in the tile.
    dx = size / 2 - (bx0 + bx1) / 2
    dy = size / 2 - (by0 + by1) / 2
    c = (dx, dy)
    shell, outline = ammonite(c, a, theta_end, stroke, uid='icon')
    bubbles = ''.join(
        f'<circle cx="{x}" cy="{y}" r="{r}" fill="#FFFFFF" opacity="{o}"/>'
        f'<circle cx="{x - r * 0.3:.1f}" cy="{y - r * 0.3:.1f}" r="{r * 0.28:.1f}" fill="#FFFFFF" opacity="0.8"/>'
        for x, y, r, o in [(752, 248, 26, 0.35), (806, 330, 15, 0.3), (716, 322, 10, 0.3)]
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
<defs>
  <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{SEA_TOP}"/><stop offset="1" stop-color="{SEA_BOTTOM}"/>
  </linearGradient>
  <filter id="drop" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
  </filter>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="14" stdDeviation="12" flood-color="#0B3D66" flood-opacity="0.35"/>
  </filter>
  <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#sea)" filter="url(#drop)"/>
<g clip-path="url(#tile)">
  <ellipse cx="512" cy="930" rx="520" ry="150" fill="#1E6AA8" opacity="0.45"/>
  <ellipse cx="300" cy="170" rx="360" ry="120" fill="#FFFFFF" opacity="0.12"/>
  {bubbles}
</g>
<g filter="url(#soft)">
{shell}
</g>
</svg>
'''


def mark_svg():
    set_growth(1.6)
    theta_end = math.radians(-50)
    a = 120
    stroke = 11
    shell, outline = ammonite((0, 0), a, theta_end, stroke, uid='mark')
    bx0, by0, bx1, by1 = bbox(outline)
    pad = stroke
    w, h = bx1 - bx0 + 2 * pad, by1 - by0 + 2 * pad
    c = (-bx0 + pad, -by0 + pad)
    shell, _ = ammonite(c, a, theta_end, stroke, uid='mark')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}">
{shell}
</svg>
''', (w, h)


def wordmark_svg():
    """Ammonite "O" + "moeba" drawn as rounded monoline strokes (no font needed)."""
    mark, (mw, mh) = mark_svg()
    inner = mark.split('\n', 1)[1].rsplit('</svg>', 1)[0]
    cap = 150.0  # height of the O
    s = cap / mh
    x_h = 88.0  # x-height
    sw = 17.0  # stroke width
    base = cap  # baseline (bottom of the O)
    top = base - x_h
    asc = base - cap * 0.98
    x = mw * s + 20
    strokes = []

    def letter_m(x):
        r = x_h * 0.3
        w = 4 * r
        d = (
            f'M{x:.1f} {base} V{top + r:.1f} '
            f'A{r:.1f} {r:.1f} 0 0 1 {x + 2 * r:.1f} {top + r:.1f} V{base} '
            f'M{x + 2 * r:.1f} {top + r:.1f} A{r:.1f} {r:.1f} 0 0 1 {x + 4 * r:.1f} {top + r:.1f} V{base}'
        )
        return d, w

    def letter_o(x):
        r = x_h / 2
        cx, cy = x + r, base - r
        return f'M{cx - r:.1f} {cy:.1f} a{r:.1f} {r:.1f} 0 1 0 {2 * r:.1f} 0 a{r:.1f} {r:.1f} 0 1 0 {-2 * r:.1f} 0', 2 * r

    def letter_e(x):
        r = x_h / 2
        cx, cy = x + r, base - r
        # horizontal bar + arc from the bar's right end, counter-clockwise, stopping at lower right
        end_ang = math.radians(40)
        ex, ey = cx + r * math.cos(end_ang), cy + r * math.sin(end_ang)
        d = f'M{cx - r:.1f} {cy:.1f} H{cx + r:.1f} A{r:.1f} {r:.1f} 0 1 0 {ex:.1f} {ey:.1f}'
        return d, 2 * r

    def letter_b(x):
        r = x_h / 2
        cx, cy = x + r, base - r
        d = f'M{x:.1f} {asc:.1f} V{base - r:.1f} ' + f'M{cx - r:.1f} {cy:.1f} a{r:.1f} {r:.1f} 0 1 0 {2 * r:.1f} 0 a{r:.1f} {r:.1f} 0 1 0 {-2 * r:.1f} 0'
        return d, 2 * r

    def letter_a(x):
        r = x_h / 2
        cx, cy = x + r, base - r
        d = f'M{cx - r:.1f} {cy:.1f} a{r:.1f} {r:.1f} 0 1 0 {2 * r:.1f} 0 a{r:.1f} {r:.1f} 0 1 0 {-2 * r:.1f} 0 M{x + 2 * r:.1f} {top:.1f} V{base}'
        return d, 2 * r

    gap = sw * 1.25
    for fn in (letter_m, letter_o, letter_e, letter_b, letter_a):
        d, w = fn(x)
        strokes.append(d)
        x += w + gap
    total_w = x - gap + sw
    pad = sw
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{-pad:.0f} {-pad:.0f} {total_w + pad:.0f} {cap + 2 * pad:.0f}" width="{total_w + 2 * pad:.0f}" height="{cap + 2 * pad:.0f}">
<g transform="scale({s:.4f})">
{inner}
</g>
<path d="{' '.join(strokes)}" fill="none" stroke="{LINE}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
'''


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'icon.svg'), 'w') as f:
        f.write(icon_svg())
    with open(os.path.join(OUT, 'logo-mark.svg'), 'w') as f:
        f.write(mark_svg()[0])
    with open(os.path.join(OUT, 'logo.svg'), 'w') as f:
        f.write(wordmark_svg())
    print('wrote', os.path.abspath(OUT))
