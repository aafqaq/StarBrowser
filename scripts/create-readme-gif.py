from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOTS = ROOT / "docs" / "screenshots"
OUTPUT = ROOT / "docs" / "starbrowser-demo.gif"
FONT_PATH = Path("C:/Windows/Fonts/msyh.ttc")
SOURCES = [
    (SCREENSHOTS / "01-isolated-sessions.png", "多个会话，各自保留独立登录状态"),
    (SCREENSHOTS / "02-session-switch.png", "一键切换身份，网页与标签随会话切换"),
    (SCREENSHOTS / "03-favorites.png", "收藏夹在所有会话之间共享"),
    (SCREENSHOTS / "04-memo.png", "备注是可以拖动排序的独立标签页"),
    (SCREENSHOTS / "05-session-settings.png", "记录可用时间，并按规则自动回收会话"),
    (SCREENSHOTS / "06-performance.png", "五档性能策略适配不同配置的电脑"),
]


def prepared(path: Path, caption: str, index: int) -> Image.Image:
    image = Image.open(path).convert("RGB")
    width = 960
    height = round(image.height * width / image.width)
    image = image.resize((width, height), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(image, "RGBA")
    font = ImageFont.truetype(str(FONT_PATH), 22) if FONT_PATH.exists() else ImageFont.load_default()
    counter_font = ImageFont.truetype(str(FONT_PATH), 17) if FONT_PATH.exists() else ImageFont.load_default()
    caption_box = draw.textbbox((0, 0), caption, font=font)
    caption_width = caption_box[2] - caption_box[0]
    pill_width = caption_width + 96
    left = (width - pill_width) // 2
    top = height - 65
    draw.rounded_rectangle((left, top, left + pill_width, top + 46), radius=23, fill=(22, 24, 43, 224), outline=(255, 255, 255, 38), width=1)
    draw.text((left + 23, top + 10), f"{index + 1}", font=counter_font, fill=(178, 174, 255, 255))
    draw.text((left + 58, top + 8), caption, font=font, fill=(255, 255, 255, 255))
    return image


images = [prepared(path, caption, index) for index, (path, caption) in enumerate(SOURCES)]
frames: list[Image.Image] = []
durations: list[int] = []

for index, current in enumerate(images):
    following = images[(index + 1) % len(images)]
    frames.append(current)
    durations.append(1550)
    for step in range(1, 6):
        frames.append(Image.blend(current, following, step / 6))
        durations.append(70)

palette_frames = [frame.quantize(colors=192, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG) for frame in frames]
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
