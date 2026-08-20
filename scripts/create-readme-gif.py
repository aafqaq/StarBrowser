from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / "docs" / "screenshots"
OUTPUT = ROOT / "docs" / "starbrowser-demo.gif"
SOURCES = [SCREENSHOTS / "01-main.png", SCREENSHOTS / "02-settings.png", SCREENSHOTS / "03-update.png"]


def prepared(path: Path) -> Image.Image:
    image = Image.open(path).convert("RGB")
    width = 960
    height = round(image.height * width / image.width)
    return image.resize((width, height), Image.Resampling.LANCZOS)


images = [prepared(path) for path in SOURCES]
frames: list[Image.Image] = []
durations: list[int] = []

for index, current in enumerate(images):
    following = images[(index + 1) % len(images)]
    frames.append(current)
    durations.append(1700)
    for step in range(1, 7):
        frames.append(Image.blend(current, following, step / 7))
        durations.append(75)

palette_frames = [frame.quantize(colors=160, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG) for frame in frames]
palette_frames[0].save(
    OUTPUT,
    save_all=True,
    append_images=palette_frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)
print(f"README 动图已生成：{OUTPUT} ({OUTPUT.stat().st_size} bytes)")
