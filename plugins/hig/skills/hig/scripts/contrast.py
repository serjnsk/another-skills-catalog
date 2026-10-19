#!/usr/bin/env python3
"""WCAG contrast check against the HIG minimums.

    python3 contrast.py "#0088FF" "#FFFFFF"            # one pair
    python3 contrast.py "#0088FF" white --size 15      # with text size (pt)
    python3 contrast.py "rgba(60,60,67,.6)" "#FFF" --bold --size 13

Colors: #RGB, #RRGGBB, rgb(), rgba() (alpha is composited over the background), or
black/white. HIG thresholds: text up to 17 pt → 4.5:1; 18 pt+ or bold → 3:1.
"""
import argparse
import re
import sys

NAMED = {"white": "#ffffff", "black": "#000000"}


def parse(s):
    s = NAMED.get(s.strip().lower(), s.strip())
    if s.startswith("#"):
        h = s[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return [int(h[i:i + 2], 16) for i in (0, 2, 4)], a
    m = re.match(r"rgba?\(([^)]*)\)", s, re.I)
    if not m:
        sys.exit("Не понимаю цвет: %s" % s)
    parts = [p for p in re.split(r"[\s,/]+", m.group(1)) if p]
    rgb = [float(p) for p in parts[:3]]
    a = float(parts[3].rstrip("%")) / (100 if parts[3].endswith("%") else 1) if len(parts) > 3 else 1.0
    return rgb, a


def lum(rgb):
    c = [x / 255 for x in rgb]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fg")
    ap.add_argument("bg")
    ap.add_argument("--size", type=float, help="text size in pt")
    ap.add_argument("--bold", action="store_true")
    a = ap.parse_args()
    bg, bga = parse(a.bg)
    if bga < 1:
        bg = [c * bga + 255 * (1 - bga) for c in bg]  # assume white page under a translucent bg
    fg, fga = parse(a.fg)
    fg = [f * fga + b * (1 - fga) for f, b in zip(fg, bg)]
    l1, l2 = sorted([lum(fg), lum(bg)], reverse=True)
    ratio = (l1 + 0.05) / (l2 + 0.05)
    need = 3.0 if a.bold or (a.size and a.size >= 18) else 4.5
    verdict = "OK" if ratio >= need else "FAIL"
    size = ("%g pt" % a.size) if a.size else "текст до 17 pt"
    print("%.2f:1  %s  (порог %.1f:1 для: %s%s)" % (ratio, verdict, need, size, ", bold" if a.bold else ""))
    sys.exit(0 if ratio >= need else 1)


if __name__ == "__main__":
    main()
