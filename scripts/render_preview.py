#!/usr/bin/env python3
"""Render the README preview images.

These are renderings, not terminal screenshots: the sidebar is a fixed
character grid, so drawing the same cells with the same colours produces a
stable asset without opening a TUI. Keep the constants below in sync with
tui.tsx (BADGE_BG / BADGE_INK, FILL_SATURATION / TEXT_SATURATION, the quota and
pace thresholds, and the row geometry).

Usage:
    python3 scripts/render_preview.py
"""

from __future__ import annotations

import colorsys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --- geometry (logical pixels; the image is supersampled before saving) -----
WIDTH, HEIGHT = 586, 182
SCALE = 3
LEFT = 30
BADGE_TOP = 26
BADGE_HEIGHT = 32
BAR_X = 70
BAR_WIDTH = 278
BAR_HEIGHT = 14
CELLS = 20
PCT_X = 360
RESET_RIGHT = 556
ROW_Y = (90, 112, 134)

# --- colours shared with tui.tsx -------------------------------------------
BADGE_BG = "#4678ac"
BADGE_INK = "#ffffff"
FILL_SATURATION = 0.4
TEXT_SATURATION = 0.7

THEMES = {
    "dark": {
        "bg": "#0a0a0a",
        "muted": "#808080",
        "strong": "#eeeeee",
        "success": "#7fd88f",
        "warning": "#f5a742",
        "error": "#e06c75",
    },
    "light": {
        "bg": "#ffffff",
        "muted": "#8a8a8a",
        "strong": "#1a1a1a",
        "success": "#3d9a57",
        "warning": "#d68c27",
        "error": "#d1383d",
    },
}

# Illustrative values chosen to show every channel at once:
#   5h green text / red bar, wk yellow text / yellow bar, mo red text / green bar.
ROWS = (
    {"label": "5h", "pct": 54, "theory": 32, "reset": "1h 12m"},
    {"label": "wk", "pct": 76, "theory": 77, "reset": "4d 12h"},
    {"label": "mo", "pct": 91, "theory": 94, "reset": "22d 13h"},
)
MONTH_TOTAL = "$54.60/$60"

FONT_REGULAR = "/System/Library/Fonts/Menlo.ttc"
FONT_BOLD = "/System/Library/Fonts/Menlo.ttc"
FONT_FALLBACKS = (
    "/System/Library/Fonts/SFNSMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
)


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#%02x%02x%02x" % tuple(round(max(0, min(255, c))) for c in rgb)


def desaturate(value: str, keep: float) -> str:
    """Scale HSL saturation, preserving hue and lightness (mirrors tui.tsx)."""
    r, g, b = (c / 255 for c in hex_to_rgb(value))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r, g, b = colorsys.hls_to_rgb(h, l, max(0.0, min(1.0, s * keep)))
    return rgb_to_hex((r * 255, g * 255, b * 255))


def blend(a: str, b: str, ratio: float) -> str:
    """Mix two hex colours; ratio is the share of ``a``."""
    ac, bc = hex_to_rgb(a), hex_to_rgb(b)
    return rgb_to_hex(tuple(ac[i] * ratio + bc[i] * (1 - ratio) for i in range(3)))


def quota_level(pct: float) -> int:
    return 2 if pct >= 90 else 1 if pct >= 75 else 0


def pace_level(pct: float, theory: float) -> int:
    if theory < 5 and pct < 10:
        return 0
    if pct > theory:
        return 2
    return 1 if theory - pct <= 2 else 0


def tone(theme: dict[str, str], level: int) -> str:
    return theme[("success", "warning", "error")[level]]


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_BOLD if bold else FONT_REGULAR
    try:
        return ImageFont.truetype(path, size, index=1 if bold else 0)
    except OSError:
        for fallback in FONT_FALLBACKS:
            try:
                return ImageFont.truetype(fallback, size)
            except OSError:
                continue
    raise OSError("no monospace font found")


def render(mode: str, out: Path) -> None:
    theme = THEMES[mode]
    s = SCALE
    image = Image.new("RGB", (WIDTH * s, HEIGHT * s), theme["bg"])
    draw = ImageDraw.Draw(image)
    font = load_font(18 * s)
    font_bold = load_font(18 * s, bold=True)

    def xy(x: float, y: float) -> tuple[float, float]:
        return x * s, y * s

    # Header badge.
    badge_w = draw.textlength("Go Usage", font=font_bold) / s + 20
    draw.rectangle(
        [*xy(LEFT, BADGE_TOP), *xy(LEFT + badge_w, BADGE_TOP + BADGE_HEIGHT)],
        fill=BADGE_BG,
    )
    draw.text(
        xy(LEFT + 10, BADGE_TOP + BADGE_HEIGHT / 2),
        "Go Usage",
        font=font_bold,
        fill=BADGE_INK,
        anchor="lm",
    )
    draw.text(
        xy(RESET_RIGHT, BADGE_TOP + BADGE_HEIGHT / 2),
        MONTH_TOTAL,
        font=font,
        fill=theme["muted"],
        anchor="rm",
    )

    # Meter rows.
    track = blend(theme["muted"], theme["bg"], 0.55)
    cell_w = BAR_WIDTH / CELLS
    for row, y in zip(ROWS, ROW_Y):
        draw.text(xy(LEFT, y), row["label"], font=font, fill=theme["muted"], anchor="lm")

        fill_cells = max(0, min(CELLS, round(row["pct"] / 100 * CELLS)))
        marker = max(0, min(CELLS - 1, round(row["theory"] / 100 * (CELLS - 1))))
        bar_top = y - BAR_HEIGHT / 2
        fill_tone = desaturate(tone(theme, pace_level(row["pct"], row["theory"])), FILL_SATURATION)
        text_tone = desaturate(tone(theme, quota_level(row["pct"])), TEXT_SATURATION)

        for i in range(CELLS):
            x0 = BAR_X + i * cell_w
            if i == marker:
                cx = x0 + cell_w / 2
                draw.rectangle(
                    [*xy(cx - 1, bar_top + 1), *xy(cx + 1, bar_top + BAR_HEIGHT - 1)],
                    fill=theme["strong"],
                )
            elif i < fill_cells:
                draw.rectangle(
                    [*xy(x0 + 0.5, bar_top + 1.5), *xy(x0 + cell_w - 0.5, bar_top + BAR_HEIGHT - 1.5)],
                    fill=fill_tone,
                )
            else:
                for dx in (2, 6, 10):
                    for dy in (2, 6, 10):
                        draw.rectangle(
                            [*xy(x0 + dx, bar_top + dy), *xy(x0 + dx + 1.8, bar_top + dy + 1.8)],
                            fill=track,
                        )

        draw.text(
            xy(PCT_X, y),
            f"{row['pct']:.0f}%",
            font=font_bold if quota_level(row["pct"]) > 0 else font,
            fill=text_tone,
            anchor="lm",
        )
        draw.text(xy(RESET_RIGHT, y), row["reset"], font=font, fill=theme["muted"], anchor="rm")

    image.resize((WIDTH, HEIGHT), Image.LANCZOS).save(out, optimize=True)
    print(f"wrote {out}")


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    assets = root / "assets"
    assets.mkdir(exist_ok=True)
    for mode in ("dark", "light"):
        render(mode, assets / f"preview-{mode}.png")


if __name__ == "__main__":
    main()
