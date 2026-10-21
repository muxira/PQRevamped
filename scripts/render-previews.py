#!/usr/bin/env python3
"""Render the README previews with Pillow.

These are drawings, not browser screenshots: this repo is deliberately build-free and has no
headless browser, so the pictures next to the README are composed from the same tokens
(core/templates/css/pq-tokens.css), the same font (assets/fonts), the same avatar PNGs and the
same markup order the pages use. Layout numbers are CSS pixels; the canvas is drawn at 2x and
saved at 1.5x, so text stays crisp on a HiDPI README.

    pip install pillow
    python3 scripts/render-previews.py

Writes docs/screenshots/*.png. The four emoji PNGs in docs/screenshots/emoji/ come from
emoji-datasource-google (Noto Color Emoji artwork, Apache-2.0; package MIT).
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots"
EMOJI = OUT / "emoji"
S = 2          # drawing scale
SAVE_SCALE = 3  # final = canvas * 3 / 4  (i.e. 1.5x CSS pixels)

# --- tokens, studio theme (core/templates/css/pq-tokens.css) ------------------------------
INK = "#1d1235"
MUTED = "#655a80"
PRIMARY = "#7b3fe4"
PANEL = "#ffffff"
BG_TOP = (241, 235, 248)
BG_BOTTOM = (233, 224, 245)
SOFT = (123, 63, 228, 41)          # rgba(123,63,228,.16)
SOFT_SOLID = "#efe4ff"
SUCCESS = "#1fa868"
SUCCESS_INK = "#127a4b"
DANGER = "#ef4343"
GOLD = "#f5c542"
SILVER = "#b9c1cc"
BRONZE = "#c98a4b"
TRACK = (29, 18, 53, 26)
DASHED = (29, 18, 53, 115)
WHITE = "#ffffff"

F700 = str(ROOT / "assets/fonts/party-quiz-sans-700.ttf")
F400 = str(ROOT / "assets/fonts/party-quiz-sans-400.ttf")
_fonts: dict[tuple[int, int], ImageFont.FreeTypeFont] = {}


def font(size: float, weight: int = 700) -> ImageFont.FreeTypeFont:
    key = (int(round(size * S)), weight)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(F700 if weight == 700 else F400, key[0])
    return _fonts[key]


def px(v: float) -> int:
    return int(round(v * S))


# --- primitives --------------------------------------------------------------------------

def text(d, xy, s, size, fill, weight=700, anchor="la", tracking=0.0):
    if tracking:
        x, y = xy
        for ch in s:
            d.text((x, y), ch, font=font(size, weight), fill=fill, anchor=anchor)
            x += d.textlength(ch, font=font(size, weight)) + px(tracking)
        return
    d.text(xy, s, font=font(size, weight), fill=fill, anchor=anchor)


def rrect(d, box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=px(radius), fill=fill, outline=outline, width=px(width))


def panel(d, box, radius=18, fill=PANEL, shadow=5, border=2.5):
    """.glass-card: 2.5px ink border, hard 5px offset shadow, 18px radius."""
    x0, y0, x1, y1 = box
    if shadow:
        rrect(d, (x0 + px(shadow), y0 + px(shadow), x1 + px(shadow), y1 + px(shadow)),
              radius, fill=INK)
    rrect(d, box, radius, fill=fill, outline=INK, width=border)


def dashed_ring(d, cx, cy, r, width=2):
    """The initials placeholder ring from .pq-avatar."""
    d.ellipse((px(cx - r), px(cy - r), px(cx + r), px(cy + r)),
              outline=DASHED, width=px(width))


def button(d, box, label, fill, size=18, shadow=4):
    x0, y0, x1, y1 = box
    if shadow:
        rrect(d, (x0 + px(shadow), y0 + px(shadow), x1 + px(shadow), y1 + px(shadow)),
              18, fill=INK)
    rrect(d, box, 18, fill=fill, outline=None)
    text(d, ((x0 + x1) // 2, (y0 + y1) // 2), label, size, WHITE, anchor="mm")


def avatar(img, rel_path, cx, cy, size):
    av = Image.open(ROOT / rel_path).convert("RGBA").resize((px(size), px(size)), Image.LANCZOS)
    mask = Image.new("L", av.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, av.size[0] - 1, av.size[1] - 1), fill=255)
    img.paste(av, (px(cx) - av.width // 2, px(cy) - av.height // 2), mask)


def emoji(img, name, cx, cy, size):
    e = Image.open(EMOJI / name).convert("RGBA").resize((px(size), px(size)), Image.LANCZOS)
    img.paste(e, (px(cx) - e.width // 2, px(cy) - e.height // 2), e)


def gear(d, cx, cy, r, color):
    """The settings glyph: a cog, drawn rather than shipped as an icon font."""
    for k in range(8):
        a = k * math.pi / 4 + math.pi / 8
        x0, y0 = cx + math.cos(a) * r * .58, cy + math.sin(a) * r * .58
        x1, y1 = cx + math.cos(a) * r * 1.0, cy + math.sin(a) * r * 1.0
        d.line((px(x0), px(y0), px(x1), px(y1)), fill=color, width=px(3.2))
    d.ellipse((px(cx - r * .62), px(cy - r * .62), px(cx + r * .62), px(cy + r * .62)),
              fill=color)
    d.ellipse((px(cx - r * .26), px(cy - r * .26), px(cx + r * .26), px(cy + r * .26)),
              fill=None, outline=(239, 228, 255), width=px(2.4))


def camera_glyph(d, cx, cy, color):
    d.rounded_rectangle((px(cx - 8), px(cy - 5.5), px(cx + 8), px(cy + 5.5)),
                        radius=px(2.5), outline=color, width=px(1.8))
    d.polygon(((px(cx + 8), px(cy - 2.5)), (px(cx + 13), px(cy - 6)),
               (px(cx + 13), px(cy + 6)), (px(cx + 8), px(cy + 2.5))), fill=color)


def smiley(d, cx, cy, r, color):
    d.ellipse((px(cx - r * .28), px(cy - r * .18), px(cx - r * .28) + px(1.8),
               px(cy - r * .18) + px(1.8)), fill=color)
    d.ellipse((px(cx + r * .22), px(cy - r * .18), px(cx + r * .22) + px(1.8),
               px(cy - r * .18) + px(1.8)), fill=color)
    d.arc((px(cx - r * .5), px(cy - r * .35), px(cx + r * .5), px(cy + r * .55)),
          start=20, end=160, fill=color, width=px(1.8))


def chevron(d, cx, cy, size, color, width=2.4):
    d.line((px(cx - size * .25), px(cy - size * .5), px(cx + size * .25), px(cy)),
           fill=color, width=px(width))
    d.line((px(cx + size * .25), px(cy), px(cx - size * .25), px(cy + size * .5)),
           fill=color, width=px(width))


def close_glyph(d, cx, cy, size, color):
    d.line((px(cx - size), px(cy - size), px(cx + size), px(cy + size)), fill=color, width=px(2))
    d.line((px(cx + size), px(cy - size), px(cx - size), px(cy + size)), fill=color, width=px(2))


# --- chrome ------------------------------------------------------------------------------

def backdrop(w, h):
    img = Image.new("RGB", (px(w), px(h)), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(img.height):
        t = y / img.height
        d.line([(0, y), (img.width, y)],
               fill=tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))

    # --pq-spot: one warm pool of light from above the fold
    glow = Image.new("RGBA", (img.width, img.height), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((px(w * .02), px(-h * .30), px(w * .98), px(h * .28)), fill=(255, 233, 186, 210))
    glow = glow.filter(ImageFilter.GaussianBlur(px(46)))
    img.paste(glow, (0, 0), glow)

    # the two blurred orbs from index.css
    for cx, cy, r, color, alpha in ((w + 20, -20, 118, (123, 63, 228), 92),
                                    (-30, h + 10, 108, (123, 63, 228), 26)):
        layer = Image.new("RGBA", (img.width, img.height), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse((px(cx - r), px(cy - r), px(cx + r), px(cy + r)),
                                      fill=color + (alpha,))
        layer = layer.filter(ImageFilter.GaussianBlur(px(44)))
        img.paste(layer, (0, 0), layer)
    return img


def header(img, d, theme_icon=False):
    logo = Image.open(ROOT / "assets/party_quiz_logo_wordmark.png").convert("RGBA")
    h = px(34)
    w = int(logo.width * h / logo.height)
    logo = logo.resize((w, h), Image.LANCZOS)
    img.paste(logo, (px(20), px(30)), logo)

    # connection-dot: 10px, green when the socket is open
    d.ellipse((px(296), px(45), px(306), px(55)), fill=SUCCESS, outline=INK, width=px(1))

    # .pq-icon-button: 44px circle, --pq-soft fill, accent glyph, 4px hard shadow
    bx0, by0 = px(322), px(28)
    rrect(d, (bx0 + px(4), by0 + px(4), bx0 + px(48), by0 + px(48)), 22, fill=INK)
    rrect(d, (bx0, by0, bx0 + px(44), by0 + px(44)), 22, fill=(239, 228, 255), outline=None)
    gear(d, 344, 50, 9, PRIMARY)


def score_strip(d, score, top=60):
    w = 336
    x0 = 195 - w // 2
    panel(d, (px(x0), px(top), px(x0 + w), px(top + 54)), radius=16, shadow=5, border=2.5)
    text(d, (px(195), px(top + 11)), "YOUR SCORE:", 12, MUTED, anchor="ma", tracking=0.2)
    text(d, (px(195), px(top + 27)), str(score), 22, PRIMARY, anchor="ma")


def bottom_bar(d):
    # #button_main: 56px accent circle with the camera glyph
    cx, cy = 42, 806
    d.ellipse((px(cx - 28 + 3), px(cy - 28 + 5), px(cx + 28 + 3), px(cy + 28 + 5)), fill=(29, 18, 53, 40))
    d.ellipse((px(cx - 28), px(cy - 28), px(cx + 28), px(cy + 28)), fill=PRIMARY)
    camera_glyph(d, cx, cy, WHITE)

    # #controls: 52px white emoji FAB
    cx = 348
    d.ellipse((px(cx - 26 + 2), px(cy - 26 + 4), px(cx + 26 + 2), px(cy + 26 + 4)), fill=(29, 18, 53, 40))
    d.ellipse((px(cx - 26), px(cy - 26), px(cx + 26), px(cy + 26)), fill=WHITE)
    smiley(d, cx, cy, 26, INK)


def home_indicator(d):
    rrect(d, (px(145), px(832), px(245), px(837)), 3, fill=(29, 18, 53, 120))


# --- shared game bits --------------------------------------------------------------------

def clip_fill(img, box, radius, fill):
    """Paint a colour inside a rounded rect without spilling over its border."""
    x0, y0, x1, y1 = (px(v) for v in box)
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    layer = Image.new("RGBA", (w, h), fill)
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=px(radius), fill=255)
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    over.paste(layer, (x0, y0), mask)
    img.paste(Image.alpha_composite(img.convert("RGBA"), over).convert("RGB"), (0, 0))


def standings(d, img, rows, top, me_name="You", final=False, width=350):
    """One .pq-standing row: score bar, dense place, avatar, name, score."""
    x0 = 195 - width // 2
    y = top
    step = 60 if not final else 58
    h = 52 if not final else 50
    for place, name, score, av, top_score in rows:
        box = (x0, y, x0 + width, y + h)
        panel(d, (px(box[0]), px(box[1]), px(box[2]), px(box[3])), radius=16, shadow=5, border=2.5)

        frac = max(6, min(100, round(score / top_score * 100))) / 100
        clip_fill(img, (x0, y, x0 + (width - 5) * frac, y + h), 16, (29, 18, 53, 26))
        if name == me_name:
            clip_fill(img, (x0, y, x0 + width, y + h), 16, (123, 63, 228, 40))
        # the 2.5px ink border sits above the fills
        rrect(d, (px(box[0]), px(box[1]), px(box[2]), px(box[3])), 16, outline=INK, width=2.5)

        cy = y + h / 2
        if final and place <= 3:
            emoji(img, {1: "medal-1.png", 2: "medal-2.png", 3: "medal-3.png"}[place],
                  x0 + 22, cy, 20)
        else:
            text(d, (px(x0 + 22), px(cy)), str(place), 14, MUTED, anchor="mm")

        if av:
            avatar(img, av, x0 + 46, cy, 30)
        else:
            dashed_ring(d, x0 + 46, cy, 15)
            text(d, (px(x0 + 46), px(cy)), name[:1].upper(), 11, PRIMARY, anchor="mm")

        text(d, (px(x0 + 68), px(cy)), name, 14.5, PRIMARY if name == me_name else INK,
             anchor="lm")
        text(d, (px(x0 + width - 14), px(cy)), str(score), 17,
             PRIMARY if name == me_name else INK, anchor="rm")
        y += step
    return y


def eyebrow(d, y, label):
    text(d, (px(195), px(y)), label.upper(), 11, MUTED, anchor="ma", tracking=1.1)


# --- screens -----------------------------------------------------------------------------

ROSTER = [
    (1, "Anna", 380, "avatars/Knight_Male.png"),
    (2, "Maks", 300, "avatars/GoldenKnight_Male.png"),
    (3, "Ben", 260, "avatars/Chef_Male.png"),
    (4, "You", 240, "avatars/Casual_Female.png"),
    (5, "Cleo", 180, "avatars/Witch_Female.png"),
    (6, "Dana", 120, "avatars/Viking_Female.png"),
]


def round_result():
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    header(img, d)
    score_strip(d, 240, top=76)
    eyebrow(d, 142, "Round result")
    text(d, (px(195), px(160)), "#4", 58, PRIMARY, anchor="ma")
    text(d, (px(195), px(208)), "+40", 14, SUCCESS_INK, anchor="ma")

    rows = [(i, n, s, a, 380) for i, n, s, a in ROSTER]
    y = standings(d, img, rows, 236)
    text(d, (px(195), px(y + 12)), "The next round is about to begin", 13, MUTED, anchor="ma")
    bottom_bar(d)
    home_indicator(d)
    return img


def final_result():
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    header(img, d)
    score_strip(d, 300, top=76)
    eyebrow(d, 142, "Game result")
    rows = [(1, "Anna", 380, "avatars/Knight_Male.png", 380),
            (2, "You", 300, "avatars/Casual_Female.png", 380),
            (3, "Ben", 260, "avatars/Chef_Male.png", 380),
            (4, "Cleo", 180, "avatars/Witch_Female.png", 380),
            (5, "Dana", 120, "avatars/Viking_Female.png", 380)]
    y = standings(d, img, rows, 162, final=True)
    emoji(img, "clap.png", 195, y + 46, 54)
    button(d, (px(84), px(y + 80), px(306), px(y + 132)), "Clap!", DANGER, size=20, shadow=4)
    bottom_bar(d)
    home_indicator(d)
    return img


def team_lobby():
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    header(img, d)

    text(d, (px(195), px(104)), "Join a team or create your own", 12, MUTED, anchor="ma")
    teams = [
        ("Golden Knights", "avatars/Knight_Male.png", "Members", ["Anna  (captain)", "Ben", "You"], True),
        ("Kitchen Crew", "avatars/Chef_Male.png", "Members", ["Cleo  (captain)", "Dana"], False),
        ("The Coven", "avatars/Witch_Female.png", "Members", ["Liv  (captain)", "Ada", "Max"], False),
    ]
    y = 128
    for name, av, label, members, mine in teams:
        h = 54 + (18 if mine else 0) + 16 * len(members)
        x0 = 20
        panel(d, (px(x0), px(y), px(x0 + 350), px(y + h)), radius=18, shadow=5)
        avatar(img, av, x0 + 26, y + 26, 44)
        text(d, (px(x0 + 56), px(y + 14)), name, 15, INK, anchor="la")
        text(d, (px(x0 + 56), px(y + 33)), label, 11, MUTED, anchor="la")
        if not mine:
            button(d, (px(x0 + 348 - 74), px(y + 14), px(x0 + 348 - 14), px(y + 44)),
                   "Join", PRIMARY, size=13, shadow=0)
        for j, m in enumerate(members):
            text(d, (px(x0 + 56), px(y + (52 if mine else 54) + 16 * j)), m, 12,
                 PRIMARY if m == "You" else INK, anchor="la")
        y += h + 10

    # dashed "create team" button
    rrect(d, (px(20), px(y), px(370), px(y + 52)), 18, fill=SOFT_SOLID, outline=DASHED, width=2)
    text(d, (px(195), px(y + 26)), "Create team", 15, PRIMARY, anchor="mm")
    bottom_bar(d)
    home_indicator(d)
    return img


def settings():
    base = backdrop(390, 844)
    d = ImageDraw.Draw(base, "RGBA")
    header(base, d)
    score_strip(d, 240, top=76)

    # the page behind the sheet
    panel(d, (px(20), px(128), px(370), px(250)), radius=18, shadow=5)
    text(d, (px(195), px(150)), "Which country invented the sandwich?", 15, INK, anchor="ma")
    rrect(d, (px(36), px(176), px(354), px(214)), 14, fill=WHITE, outline=(29, 18, 53, 60), width=2)
    text(d, (px(50), px(187)), "Type your answer", 13, MUTED, anchor="la")

    # overlay + sheet
    veil = Image.new("RGBA", base.size, (5, 2, 16, 128))
    base.paste(veil, (0, 0), veil)
    d = ImageDraw.Draw(base, "RGBA")
    sheet_top = 340
    rrect(d, (px(8), px(sheet_top), px(382), px(844)), 24, fill=PANEL)
    rrect(d, (px(171), px(sheet_top + 10), px(219), px(sheet_top + 15)), 3, fill=(29, 18, 53, 60))

    text(d, (px(26), px(sheet_top + 26)), "PQREVAMPED", 9, PRIMARY, anchor="la", tracking=1.3)
    text(d, (px(26), px(sheet_top + 38)), "Settings", 21, INK, anchor="la")
    rrect(d, (px(328), px(sheet_top + 28), px(368), px(sheet_top + 68)), 12, fill=SOFT_SOLID)
    close_glyph(d, 348, sheet_top + 48, 7, PRIMARY)

    text(d, (px(26), px(sheet_top + 84)), "LANGUAGE", 10, MUTED, anchor="la", tracking=1.2)

    langs = ["English", "Русский", "Українська", "Español", "Español (LatAm)",
             "Deutsch", "Português", "Français", "Polski"]
    col_w = 116
    for i, label in enumerate(langs):
        col, row = i % 3, i // 3
        x0 = 26 + col * (col_w + 5)
        y0 = sheet_top + 100 + row * 46
        active = i == 0
        rrect(d, (px(x0), px(y0), px(x0 + col_w), px(y0 + 40)), 11,
              fill=PRIMARY if active else SOFT_SOLID,
              outline=INK if active else None, width=2)
        text(d, (px(x0 + col_w / 2), px(y0 + 20)), label, 10.5,
             WHITE if active else INK, anchor="mm")

    text(d, (px(26), px(sheet_top + 246)), "APPEARANCE", 10, MUTED, anchor="la", tracking=1.2)
    rrect(d, (px(26), px(sheet_top + 262), px(368), px(sheet_top + 312)), 14, fill=(29, 18, 53, 24))
    for i, label in enumerate(("Auto", "Light", "Dark")):
        x0 = 30 + i * 112
        active = i == 1
        if active:
            rrect(d, (px(x0), px(sheet_top + 266), px(x0 + 108), px(sheet_top + 308)), 10,
                  fill=PANEL)
        text(d, (px(x0 + 54), px(sheet_top + 287)), label, 11,
             INK if active else MUTED, anchor="mm")

    for i, (label, on) in enumerate((("Haptic feedback", True), ("Keep screen awake", True))):
        y0 = sheet_top + 326 + i * 48
        text(d, (px(26), px(y0 + 22)), label, 13, INK, anchor="lm")
        rrect(d, (px(300), px(y0 + 6), px(348), px(y0 + 34)), 14,
              fill=SUCCESS if on else (29, 18, 53, 26))
        knob = 333 if on else 315
        d.ellipse((px(knob), px(y0 + 10), px(knob + 20), px(y0 + 30)), fill=PANEL,
                  outline=INK, width=px(1.6))

    # footer, pinned to the bottom of the sheet
    d.line((px(26), px(844 - 44), px(368), px(844 - 44)), fill=(29, 18, 53, 40), width=px(1))
    text(d, (px(26), px(844 - 32)), "PQRevamped v2.0.0", 10, MUTED, anchor="la")
    text(d, (px(368), px(844 - 32)), "GitHub", 10, PRIMARY, anchor="ra")

    home_indicator(d)
    return base


def resume():
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    header(img, d)
    eyebrow(d, 118, "Resume game")

    panel(d, (px(20), px(148), px(370), px(400)), radius=18, shadow=5)
    text(d, (px(195), px(166)), "Resume game", 20, INK, anchor="ma")
    msg = ["Game found, but the server is not", "responding. Reconnect unavailable."]
    for i, line in enumerate(msg):
        text(d, (px(195), px(200) + i * 20), line, 13, MUTED, anchor="ma", weight=400)
    button(d, (px(40), px(250), px(350), px(300)), "Try again", SUCCESS, size=17)
    text(d, (px(195), px(312)), "The server did not answer. If the game is still running,", 11,
         MUTED, anchor="ma", weight=400)
    text(d, (px(195), px(327)), "try again in a moment.", 11, MUTED, anchor="ma", weight=400)
    button(d, (px(40), px(342), px(350), px(392)), "Leave game", DANGER, size=17)
    button(d, (px(40), px(342), px(350), px(392)), "", DANGER, size=17, shadow=0)
    # re-draw the label above the shadow-less pass
    text(d, (px(195), px(367)), "Leave game", 17, WHITE, anchor="mm")
    bottom_bar(d)
    home_indicator(d)
    return img


def join():
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    header(img, d)

    panel(d, (px(20), px(96), px(370), px(432)), radius=18, shadow=5)
    text(d, (px(40), px(118)), "Game ID", 12, MUTED, anchor="la")
    rrect(d, (px(40), px(136), px(350), px(224)), 16, fill=WHITE, outline=INK, width=3)
    text(d, (px(56), px(168)), "QZ7K", 44, INK, anchor="la", weight=700)
    text(d, (px(40), px(240)), "Game password", 12, MUTED, anchor="la")
    rrect(d, (px(40), px(258), px(350), px(302)), 16, fill=WHITE,
          outline=(29, 18, 53, 90), width=2)
    text(d, (px(56), px(272)), "optional", 15, MUTED, anchor="la", weight=400)

    button(d, (px(40), px(324), px(350), px(378)), "Join", SUCCESS, size=19)
    chevron(d, 320, 351, 12, WHITE)

    d.line((px(40), px(402), px(150), px(402)), fill=(29, 18, 53, 80), width=px(1))
    d.line((px(240), px(402), px(350), px(402)), fill=(29, 18, 53, 80), width=px(1))
    text(d, (px(195), px(402)), "or scan the QR code", 11, MUTED, anchor="mm")
    bottom_bar(d)
    home_indicator(d)
    return img


def answer():
    """The answering screen: topic block, the card, one field, one action."""
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    header(img, d)
    score_strip(d, 240, top=76)

    # .topic-block: the round's theme, on both screens
    text(d, (px(195), px(150)), "Food & Drink", 26, INK, anchor="ma")
    text(d, (px(195), px(182)), "Round 3 · question 2 of 4", 12, MUTED, anchor="ma", weight=400)

    # #question_selected_group
    panel(d, (px(20), px(206), px(370), px(250)), radius=18, shadow=5)
    text(d, (px(132), px(228)), "Sandwiches", 15, INK, anchor="mm")
    text(d, (px(264), px(228)), "200", 17, PRIMARY, anchor="mm")

    # #you_answer_group
    panel(d, (px(20), px(266), px(370), px(430)), radius=18, shadow=5)
    text(d, (px(195), px(296)), "Enter your answer or say it out loud", 13, MUTED, anchor="ma",
         weight=400)
    rrect(d, (px(37), px(318), px(353), px(360)), 14, fill=WHITE, outline=(29, 18, 53, 90), width=2)
    text(d, (px(53), px(339)), "Earl of Sandwich", 17, INK, anchor="lm")
    button(d, (px(37), px(372), px(353), px(418)), "Answer", SUCCESS)

    bottom_bar(d)
    home_indicator(d)
    return img


def landing():
    """index.html — the language hand-off, which is what a visitor sees first."""
    img = backdrop(390, 844)
    d = ImageDraw.Draw(img, "RGBA")
    logo = Image.open(ROOT / "assets/party_quiz_logo_wordmark.png").convert("RGBA")
    h = px(96)
    w = int(logo.width * h / logo.height)
    logo = logo.resize((w, h), Image.LANCZOS)
    img.paste(logo, (px(195) - w // 2, px(70)), logo)

    text(d, (px(195), px(180)), "Choose your language to begin", 16, MUTED, anchor="ma", weight=400)
    text(d, (px(30), px(224)), "LANGUAGE", 11, MUTED, anchor="la", tracking=1.2)
    langs = ["English", "Русский", "Українська", "Español", "Español (LatAm)", "Deutsch",
             "Português", "Français", "Polski"]
    for i, label in enumerate(langs):
        col, row = i % 2, i // 2
        x0 = 26 + col * 172
        y0 = 246 + row * 50
        active = i == 0
        rrect(d, (px(x0), px(y0), px(x0 + 166), px(y0 + 44)), 12,
              fill=PRIMARY if active else SOFT_SOLID)
        if active:
            rrect(d, (px(x0 + 4), px(y0 + 4), px(x0 + 162), px(y0 + 40)), 10,
                  outline=INK, width=2)
            # the "auto" chip detectLang() puts next to the suggested locale
            text(d, (px(x0 + 20), px(y0 + 22)), label, 12, WHITE, anchor="lm")
            rrect(d, (px(x0 + 106), px(y0 + 12), px(x0 + 152), px(y0 + 32)), 10, fill=GOLD)
            text(d, (px(x0 + 129), px(y0 + 22)), "AUTO", 8, "#8a6300", anchor="mm", tracking=0.4)
        else:
            text(d, (px(x0 + 83), px(y0 + 22)), label, 12, INK, anchor="mm")

    button(d, (px(26), px(500), px(364), px(556)), "Start", PRIMARY, size=17)
    chevron(d, 330, 528, 11, WHITE)
    text(d, (px(195), px(600)), "Unofficial companion for Party Quiz", 11, MUTED, anchor="ma",
         weight=400)
    text(d, (px(195), px(618)), "GitHub", 11, PRIMARY, anchor="ma")
    home_indicator(d)
    return img


# --- framing -----------------------------------------------------------------------------

DEVICE = "#0d0a18"


def device_layer(img: Image.Image) -> Image.Image:
    """Put the screen into a phone body on a transparent canvas."""
    pad = 26
    layer = Image.new("RGBA", (img.width + px(pad * 2 + 20), img.height + px(pad * 2 + 20)),
                      (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ox, oy = px(pad + 10), px(pad + 10)
    rrect(d, (ox - px(14), oy - px(14), ox + img.width + px(14), oy + img.height + px(14)), 52,
          fill=DEVICE, outline="#2b2440", width=3)

    # the glass is rounded, so the screen has to be clipped to a matching radius
    screen = img.convert("RGBA")
    mask = Image.new("L", screen.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, screen.width - 1, screen.height - 1),
                                           radius=px(38), fill=255)
    layer.paste(screen, (ox, oy), mask)
    d = ImageDraw.Draw(layer)
    # the OS chrome that lives above the page
    text(d, (ox + px(26), oy + px(12)), "9:41", 11, INK)
    rrect(d, (ox + img.width - px(46), oy + px(15), ox + img.width - px(24), oy + px(25)), 3,
          outline=INK, width=1.2)
    d.rectangle((ox + img.width - px(44), oy + px(17), ox + img.width - px(30), oy + px(23)),
                fill=INK)
    rrect(d, (ox + img.width // 2 - px(60), oy + img.height - px(13),
              ox + img.width // 2 + px(60), oy + img.height - px(8)), 3,
          fill=(29, 18, 53, 110))
    return layer


def save(layer: Image.Image, name: str):
    OUT.mkdir(parents=True, exist_ok=True)
    flat = Image.new("RGB", layer.size, "#efe9f7")
    flat.paste(layer, (0, 0), layer)
    flat = flat.resize((flat.width * SAVE_SCALE // 4, flat.height * SAVE_SCALE // 4),
                       Image.LANCZOS)
    flat.save(OUT / name, optimize=True)
    print("wrote", (OUT / name).relative_to(ROOT), flat.size)
    return flat


def hero(layers):
    gap = px(18)
    w = sum(l.width for l in layers) + gap * (len(layers) - 1)
    h = max(l.height for l in layers)
    canvas = backdrop((w + px(60)) / S, (h + px(60)) / S)
    x = px(30)
    for i, layer in enumerate(layers):
        y = px(30) + (h - layer.height) // 2 + (px(10) if i == 1 else 0)
        canvas.paste(layer, (x, y), layer)
        x += layer.width + gap
    canvas.save(OUT / "00-hero.png", optimize=True)
    print("wrote", (OUT / "00-hero.png").relative_to(ROOT), canvas.size)


if __name__ == "__main__":
    shots = [
        ("01-round-result.png", round_result),
        ("02-final-result.png", final_result),
        ("03-team-lobby.png", team_lobby),
        ("04-settings.png", settings),
        ("05-resume.png", resume),
        ("06-join.png", join),
        ("07-landing.png", landing),
        ("08-answer.png", answer),
    ]
    layers = {}
    for name, fn in shots:
        layers[name] = device_layer(fn())
        save(layers[name], name)
    hero([layers["03-team-lobby.png"], layers["02-final-result.png"], layers["04-settings.png"]])
