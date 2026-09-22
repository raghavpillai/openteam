#!/usr/bin/env python3
"""Compare unmodified reference/before/after chat captures at a 440-point width.

Requires Pillow. Reference must be an idle (not pressed) send state. Inputs may
have different pixel densities; their original pixels and hashes are preserved.
Rendered RGB samples describe appearances, not a material's underlying alpha.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from statistics import median
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reference', type=Path, required=True)
parser.add_argument('--before', type=Path, required=True)
parser.add_argument('--after', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
out = args.output
out.mkdir(parents=True, exist_ok=True)
paths = {'reference': args.reference, 'before': args.before, 'after': args.after}
images = {key: Image.open(path).convert('RGB') for key, path in paths.items()}
provenance = {}
for key, path in paths.items():
    target = out / (key + path.suffix)
    shutil.copyfile(path, target)
    provenance[key] = {'source': str(path.resolve()), 'file': target.name,
                       'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                       'pixels': images[key].size}

def sample(image, box):
    scale = image.width / 440
    cropped = image.crop(tuple(round(v * scale) for v in box))
    data = cropped.load()
    pixels = [data[x, y] for y in range(cropped.height) for x in range(cropped.width)]
    return [round(median(p[c] for p in pixels), 2) for c in range(3)]

regions = {
    'Dark canvas': (3, 300, 10, 400),
    'Resting composer interior': (220, 558, 310, 575),
    'Header upper interior over content': (180, 72, 300, 76),
    'Header lower interior over content': (180, 100, 300, 106),
}
measurements = []
for label, box in regions.items():
    measurements.append({'region': label, 'boxAt440Points': box,
                         **{key: sample(im, box) for key, im in images.items()}})
fade = []
for y in [90, 95, 100, 105, 110, 115, 120, 125, 130, 140, 155]:
    box = (65, y, 69, y + 1)
    fade.append({'y': y, 'boxAt440Points': box,
                 **{key: sample(im, box)[0] for key, im in images.items()}})

def glyph_bounds(image, box, bright):
    scale = image.width / 440
    cropped = image.crop(tuple(round(v * scale) for v in box))
    w, h = cropped.size
    data = cropped.load()
    pixels = [data[x, y] for y in range(h) for x in range(w)]
    points = {(i % w, i // w) for i, pixel in enumerate(pixels)
              if (min(pixel) > 220 if bright else max(pixel) < 90)}
    components = []
    while points:
        point = points.pop()
        todo, found = [point], [point]
        while todo:
            x, y = todo.pop()
            for neighbor in [(x-1,y), (x+1,y), (x,y-1), (x,y+1)]:
                if neighbor in points:
                    points.remove(neighbor)
                    todo.append(neighbor)
                    found.append(neighbor)
        xs, ys = zip(*found)
        if len(found) > 20 and min(xs) > 0 and min(ys) > 0 and max(xs) < w-1 and max(ys) < h-1:
            components.append(found)
    found = max(components, key=len)
    xs, ys = zip(*found)
    return {'widthPt': round((max(xs)-min(xs)+1)/scale, 2),
            'heightPt': round((max(ys)-min(ys)+1)/scale, 2),
            'inkAreaPt2': round(len(found)/scale**2, 2)}

glyphs = {}
for name, box, bright in [('Send arrow',(383,555,408,580),False),
                           ('Attachment plus',(24,551,55,582),True),
                           ('Back chevron',(28,77,50,104),True)]:
    glyphs[name] = {}
    for key, image in images.items():
        # Native keyboard top is two points lower on this simulator OS. Compare
        # glyph bounds relative to each control, without moving the screenshot.
        offset = 2 if key != 'reference' and name != 'Back chevron' else 0
        b = (box[0],box[1]+offset,box[2],box[3]+offset)
        glyphs[name][key] = glyph_bounds(image, b, bright)
summary = {
    'images': provenance,
    'method': 'Original pixels sampled at scaled coordinates; no color correction, registration or status-bar replacement. Glass-over-text samples are scene observations, not a pixel-parity score.',
    'regions': measurements, 'topFade': fade, 'glyphs': glyphs,
    'meanFadeAbsoluteError': {key: round(sum(abs(r[key]-r['reference']) for r in fade)/len(fade), 2) for key in ['before','after']},
}
(out/'measurements.json').write_text(json.dumps(summary, indent=2)+'\n')
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 18)
small = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
canvas = Image.new('RGB', (880, 998), '#222222')
draw = ImageDraw.Draw(canvas)
for i, (key, label) in enumerate([('reference','GrokBot reference — idle send'), ('after','OpenTeam Swift — updated')]):
    canvas.paste(images[key].resize((440,956)), (i*440,42))
    draw.text((i*440+12,12),label,font=font,fill='white')
canvas.save(out/'side-by-side.png')
canvas = Image.new('RGB', (1320, 410), '#222222')
draw = ImageDraw.Draw(canvas)
for i, (key, label) in enumerate([('reference','GrokBot reference'), ('before','Swift before'), ('after','Swift updated')]):
    image = images[key].resize((1320,2868))
    draw.text((i*440+12,10),label,font=font,fill='white')
    for y, box in [(42,(0,135,1320,480)),(226,(0,1614,1320,1908))]:
        crop=image.crop(box)
        canvas.paste(crop.resize((440,round(crop.height/3))), (i*440,y))
    draw.text((i*440+12,355),'Original crops; displayed at equal scale',font=small,fill='#bbbbbb')
canvas.save(out/'controls-before-after.png')
print(json.dumps({'regions': measurements, 'meanFadeAbsoluteError':summary['meanFadeAbsoluteError'], 'glyphs':glyphs},indent=2))
