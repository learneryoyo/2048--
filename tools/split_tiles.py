# -*- coding: utf-8 -*-
"""
从 奶龙数字.png 切出 11 个数字方块 -> assets/tiles/tile-{value}.png

处理流程：
1. 按白色网格线切出 12 个单元格
2. 自动识别并剔除底部的 "2^n" 标签
3. 从四边泛洪抠掉奶油色背景 -> 透明
4. 边缘羽化，消除奶油色残边（halo）
5. 面积归一化后居中放到 512x512 透明画布上（底部对齐）
"""
import os
from collections import deque
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "奶龙数字.png")
OUT = os.path.join(HERE, "..", "assets", "tiles")

COLS = [(0, 310), (314, 625), (629, 940), (944, 1254)]
ROWS = [(0, 416), (420, 832), (836, 1254)]
VALUES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]

CANVAS = 512          # 输出画布边长
TARGET_GM = 322       # 目标 sqrt(w*h)，用于面积归一化
MAX_DIM = 470         # 最大边
BASELINE = 500        # 角色底部对齐线


def color_dist(a, b):
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))


def bg_mask(px, w, h, tol=14, guard=45):
    mask = bytearray(w * h)
    dq = deque()
    seed_c = px[2, 2]
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if not mask[i]:
                mask[i] = 1
                dq.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if not mask[i]:
                mask[i] = 1
                dq.append((x, y))
    while dq:
        x, y = dq.popleft()
        c = px[x, y]
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if mask[i]:
                    continue
                nc = px[nx, ny]
                if color_dist(nc, c) <= tol and color_dist(nc, seed_c) <= guard:
                    mask[i] = 1
                    dq.append((nx, ny))
    return mask


def build_cell(cell):
    w, h = cell.size
    px = cell.load()
    mask = bg_mask(px, w, h)

    rowcnt = [sum(1 for x in range(w) if not mask[y * w + x]) for y in range(h)]

    y = h - 1
    while y >= 0 and rowcnt[y] < 2:
        y -= 1
    while y >= 0 and rowcnt[y] >= 2:
        y -= 1
    while y >= 0 and rowcnt[y] < 2:
        y -= 1
    keep_h = y + 1

    fg = Image.new("RGBA", (w, keep_h), (0, 0, 0, 0))
    fgp = fg.load()
    for yy in range(keep_h):
        base = yy * w
        for xx in range(w):
            if not mask[base + xx]:
                fgp[xx, yy] = px[xx, yy] + (255,)
    return fg.crop(fg.getbbox())


def feather(im):
    """按「离背景奶油色有多远」给边缘像素定 alpha，消掉奶油色描边。"""
    w, h = im.size
    px = im.load()
    # 收集背景参考色：所有完全透明像素的平均色
    sr = sg = sb = n = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                sr += r; sg += g; sb += b; n += 1
    if n:
        bg = (sr / n, sg / n, sb / n)
    else:
        bg = (246.0, 232.0, 214.0)

    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            edge = False
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                    edge = True
                    break
            if not edge:
                op[x, y] = (r, g, b, 255)
                continue
            d = color_dist((r, g, b), bg)
            alpha = int(min(255, max(0, (d - 6) * 255 / 46)))
            op[x, y] = (r, g, b, alpha)
    return out


def normalize(im):
    w, h = im.size
    k = TARGET_GM / ((w * h) ** 0.5)
    k = min(k, MAX_DIM / max(w, h))
    nw, nh = max(1, int(round(w * k))), max(1, int(round(h * k)))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.paste(im, ((CANVAS - nw) // 2, BASELINE - nh), im)
    return canvas


def main():
    os.makedirs(OUT, exist_ok=True)
    im = Image.open(SRC).convert("RGB")
    idx = 0
    for r0, r1 in ROWS:
        for c0, c1 in COLS:
            if idx >= len(VALUES):
                break
            cell = im.crop((c0, r0, c1, r1))
            char = build_cell(cell)
            char = feather(char)
            tile = normalize(char)
            path = os.path.join(OUT, f"tile-{VALUES[idx]}.png")
            tile.save(path, optimize=True)
            print(f"{VALUES[idx]:>5}  raw={char.size}  -> 512x512  {os.path.getsize(path)//1024}KB")
            idx += 1
    print("done:", idx)


if __name__ == "__main__":
    main()
