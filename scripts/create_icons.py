from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]


def icon(size: int) -> None:
    image = Image.new("RGB", (size, size), "#176b57")
    draw = ImageDraw.Draw(image)
    margin = int(size * 0.13)
    draw.rounded_rectangle((margin, margin, size - margin, size - margin), radius=int(size * 0.22), fill="#e4f2ec")
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/georgiab.ttf", int(size * 0.47))
    except OSError:
        font = ImageFont.load_default()
    draw.text((size / 2, size / 2), "T", font=font, fill="#113d34", anchor="mm", stroke_width=max(1, size // 180))
    image.save(ROOT / "public" / f"icon-{size}.png", optimize=True)


for dimension in (192, 512):
    icon(dimension)
