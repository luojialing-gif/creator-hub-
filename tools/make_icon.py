#!/usr/bin/env python3
"""生成 CreatorHub 应用图标：1024×1024 PNG → .iconset → .icns"""
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build')
S = 1024

# ---------- 1. 背景：圆角方形 + 竖向渐变 ----------
CORNER_BOX = (100, 100, 924, 924)          # macOS Big Sur 图标的常规留白
RADIUS = 186

grad = Image.new('RGB', (S, S))
gd = ImageDraw.Draw(grad)
TOP = (86, 58, 240)      # #563AF0
BOT = (139, 92, 246)     # #8B5CF6
for y in range(S):
    t = y / (S - 1)
    gd.line(
        [(0, y), (S, y)],
        fill=tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)),
    )

mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(CORNER_BOX, radius=RADIUS, fill=255)

icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)

# 顶部一层柔和高光，让平面渐变有点体积感
gloss = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(gloss).ellipse((60, -420, 964, 560), fill=(255, 255, 255, 46))
gloss = gloss.filter(ImageFilter.GaussianBlur(60))
icon = Image.alpha_composite(icon, Image.composite(gloss, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))

# ---------- 2. 四个平台的色块（2×2 网格） ----------
draw = ImageDraw.Draw(icon)
TILE = 240
GAP = 44
left = (S - (TILE * 2 + GAP)) // 2          # 250
top = left
PLATFORMS = [
    ((37, 244, 238), '抖音'),                # 青
    ((255, 36, 66), '小红书'),               # 红
    ((255, 176, 32), '视频号'),              # 橙黄
    ((255, 255, 255), '快手'),               # 白
]

for idx, (color, _name) in enumerate(PLATFORMS):
    col = idx % 2
    row = idx // 2
    x = left + col * (TILE + GAP)
    y = top + row * (TILE + GAP)
    # 投影
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (x + 6, y + 12, x + TILE + 6, y + TILE + 12), radius=60, fill=(20, 10, 60, 90)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    icon = Image.alpha_composite(icon, shadow)
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle((x, y, x + TILE, y + TILE), radius=58, fill=color + (255,))

# ---------- 3. 导出 icns ----------
os.makedirs(OUT_DIR, exist_ok=True)
png_path = os.path.join(OUT_DIR, 'icon-1024.png')
icon.save(png_path)

iconset = os.path.join(OUT_DIR, 'CreatorHub.iconset')
shutil.rmtree(iconset, ignore_errors=True)
os.makedirs(iconset)

SIZES = [16, 32, 64, 128, 256, 512, 1024]
for size in SIZES:
    resized = icon.resize((size, size), Image.LANCZOS)
    if size <= 512:
        resized.save(os.path.join(iconset, 'icon_%dx%d.png' % (size, size)))
    if size >= 32:
        resized.save(os.path.join(iconset, 'icon_%dx%d@2x.png' % (size // 2, size // 2)))

icns_path = os.path.join(OUT_DIR, 'icon.icns')
subprocess.run(['/usr/bin/iconutil', '-c', 'icns', iconset, '-o', icns_path], check=True)
print('图标已生成：' + icns_path)
