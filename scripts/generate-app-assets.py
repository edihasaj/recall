#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "macos" / "RecallApp" / "Recall" / "Assets.xcassets"
APPICON = ASSETS / "AppIcon.appiconset"
MENUBAR = ASSETS / "MenuBarIcon.imageset"


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def gradient_background(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size))
    px = img.load()
    top = (14, 20, 28)
    bottom = (7, 10, 14)
    for y in range(size):
        t = y / (size - 1)
        row = (lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t), 255)
        for x in range(size):
            px[x, y] = row
    return img


def add_orbs(canvas: Image.Image) -> Image.Image:
    size = canvas.size[0]
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse((size * 0.08, size * 0.06, size * 0.72, size * 0.68), fill=(0, 194, 179, 90))
    draw.ellipse((size * 0.38, size * 0.30, size * 0.95, size * 0.88), fill=(255, 160, 64, 100))
    return Image.alpha_composite(canvas, layer.filter(ImageFilter.GaussianBlur(size * 0.08)))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size, size), radius=radius, fill=255)
    return mask


def make_app_icon(size: int = 1024) -> Image.Image:
    canvas = gradient_background(size)
    canvas = add_orbs(canvas)

    motif = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(motif)

    line = (233, 247, 245, 255)
    accent = (255, 183, 92, 255)
    teal = (86, 222, 205, 255)

    stroke_outer = max(16, size // 42)
    stroke_inner = max(10, size // 62)

    center = size * 0.51
    top = size * 0.22
    bottom = size * 0.80

    draw.arc((size * 0.18, top, size * 0.84, bottom), start=210, end=22, fill=line, width=stroke_outer)
    draw.arc((size * 0.28, size * 0.30, size * 0.74, size * 0.74), start=208, end=18, fill=(230, 244, 242, 220), width=stroke_inner)
    draw.arc((size * 0.37, size * 0.39, size * 0.64, size * 0.64), start=205, end=15, fill=(230, 244, 242, 180), width=max(8, size // 90))

    ribbon = [
        (size * 0.66, size * 0.20),
        (size * 0.78, size * 0.30),
        (size * 0.58, size * 0.46),
        (size * 0.49, size * 0.39),
    ]
    draw.polygon(ribbon, fill=accent)
    draw.ellipse((size * 0.43, size * 0.43, size * 0.58, size * 0.58), fill=teal)
    draw.ellipse((size * 0.47, size * 0.47, size * 0.54, size * 0.54), fill=(251, 252, 250, 255))
    draw.ellipse((size * 0.73, size * 0.24, size * 0.79, size * 0.30), fill=(255, 244, 223, 255))

    motif = motif.filter(ImageFilter.GaussianBlur(size * 0.004))
    composed = Image.alpha_composite(canvas, motif)
    highlight = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hdraw = ImageDraw.Draw(highlight)
    hdraw.rounded_rectangle((size * 0.12, size * 0.10, size * 0.88, size * 0.88), radius=size * 0.23, outline=(255, 255, 255, 34), width=max(4, size // 128))
    composed = Image.alpha_composite(composed, highlight)

    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(composed, (0, 0), rounded_mask(size, int(size * 0.23)))
    return result


def make_menubar_icon(size: int = 22) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    line = (0, 0, 0, 255)
    width = 2
    draw.arc((2, 3, size - 2, size - 3), start=218, end=20, fill=line, width=width)
    draw.arc((5, 6, size - 5, size - 6), start=218, end=18, fill=line, width=width)
    draw.ellipse((size * 0.42, size * 0.42, size * 0.58, size * 0.58), fill=line)
    draw.polygon([(size * 0.70, size * 0.15), (size * 0.88, size * 0.30), (size * 0.64, size * 0.44), (size * 0.56, size * 0.36)], fill=line)
    return img


def save_app_icons() -> None:
    master = make_app_icon()
    for size in (16, 32, 64, 128, 256, 512, 1024):
        master.resize((size, size), Image.Resampling.LANCZOS).save(APPICON / f"icon-{size}.png")


def save_menubar_icon() -> None:
    make_menubar_icon(22).save(MENUBAR / "menubar-icon.png")


def main() -> None:
    APPICON.mkdir(parents=True, exist_ok=True)
    MENUBAR.mkdir(parents=True, exist_ok=True)
    save_app_icons()
    save_menubar_icon()


if __name__ == "__main__":
    main()
