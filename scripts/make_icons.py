"""Generate favicon-32.png and apple-touch-icon.png that match favicon.svg.

Same ascending-bars design rendered directly via Pillow so we don't need a
separate SVG→PNG pipeline. Run when the icon design changes:

    python scripts/make_icons.py
"""
from PIL import Image, ImageDraw

BG = (10, 13, 12, 255)          # #0a0d0c
ACCENT_HI = (31, 227, 168)      # #1fe3a8
ACCENT_LO = (0, 200, 150)       # #00c896


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_icon(size: int) -> Image.Image:
    s = size / 32.0  # scale factor — design is defined in 32px units
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square background
    radius = int(6 * s)
    d.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=radius, fill=BG)

    # Four ascending bars. (x, y, w, h) in 32-unit space.
    bars = [
        (5, 22, 4, 5),
        (11, 17, 4, 10),
        (17, 11, 4, 16),
        (23, 5, 4, 22),
    ]
    bar_radius = max(1, int(1.2 * s))
    for x, y, w, h in bars:
        x0 = int(x * s)
        y0 = int(y * s)
        x1 = int((x + w) * s) - 1
        y1 = int((y + h) * s) - 1
        # Vertical gradient: lighter at top, deeper at bottom. Approximate by
        # stacking horizontal slices since Pillow has no native gradient fill.
        for ry in range(y0, y1 + 1):
            t = (ry - y0) / max(1, (y1 - y0))
            # t=0 top → ACCENT_HI; t=1 bottom → ACCENT_LO
            color = lerp(ACCENT_HI, ACCENT_LO, t) + (255,)
            # Draw a 1-px row, clipped to bar radius via a mask pass below.
            d.line([(x0, ry), (x1, ry)], fill=color)
        # Re-apply rounded corners on top of the gradient by drawing a mask.
        mask = Image.new("L", (x1 - x0 + 1, y1 - y0 + 1), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [(0, 0), (x1 - x0, y1 - y0)], radius=bar_radius, fill=255
        )
        # Composite the bar region back into the image with the rounded mask.
        bar_crop = img.crop((x0, y0, x1 + 1, y1 + 1))
        bar_crop.putalpha(mask)
        # Clear and paste so the corners outside the mask become transparent
        # over the dark background (revealing the BG layer).
        d.rectangle([(x0, y0), (x1, y1)], fill=BG)
        img.paste(bar_crop, (x0, y0), bar_crop)
    return img


if __name__ == "__main__":
    import pathlib
    root = pathlib.Path(__file__).resolve().parent.parent
    draw_icon(32).save(root / "favicon-32.png")
    draw_icon(180).save(root / "apple-touch-icon.png")
    print("wrote favicon-32.png, apple-touch-icon.png")
