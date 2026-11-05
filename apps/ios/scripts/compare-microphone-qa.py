#!/usr/bin/env python3
"""Make an annotated side-by-side MP4 from record-microphone-qa.py runs.

The device recordings stay unmodified. Captions and touch markers come from
the actual input log; no UI states are synthesized or replaced.
Requires FFmpeg and Pillow. The crop is for a 402 × 874-point iPhone simulator.
"""
import argparse
import json
import subprocess
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--after', default='after-compact', help='After-capture directory inside directory')
parser.add_argument('--name', default='microphone-before-after-compact.mp4')
args = parser.parse_args()
root = args.directory.resolve()
font = '/System/Library/Fonts/Supplemental/Arial.ttf'
filters = []

stages = [(0, 9, 'Tap 13pt left of center'), (9, 17, 'Tap 13pt right of center'),
    (17, 25, 'Tap 23pt toward the upper-left corner'), (25, 37, 'Tap hands-free, then stop and review'),
    (37, 43, 'Hold with 12pt drift, then release'), (43, 55, 'Slide up to lock; lift and keep recording')]
for index, side in enumerate(['before', args.after]):
    data = json.loads((root / side / 'results.json').read_text())
    chain = ['setpts=PTS-STARTPTS', 'fps=30', 'scale=402:874']
    # Mark actual commanded coordinates in device points, before cropping.
    for event in data['events']:
        begin = event['time'] + data['videoTimelineOffset']
        end = max(begin + 0.65, event['returned'] + data['videoTimelineOffset'])
        chain.append(f"drawbox=x={event['x']-7}:y={event['y']-7}:w=14:h=14:color=0x007aff@0.8:t=fill:enable='between(t,{begin:.3f},{end:.3f})'")
    # Keep enough vertical room to show the keyboard opened by a missed press.
    chain += ['crop=402:454:0:420', 'scale=536:606', 'pad=536:740:0:80:color=#111827']
    filters.append(f'[{index}:v]' + ','.join(chain) + f'[v{index}]')
filters.append('[v0][v1]hstack=inputs=2[panels]')
images = []
for stage, (start, end, label) in enumerate(stages):
    image = Image.new('RGBA', (1072, 740))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1072, 79), fill='#111827')
    draw.rectangle((0, 686, 1072, 740), fill='#111827')
    for index, side in enumerate(['before', args.after]):
        x = index * 536 + 20
        draw.text((x, 12), 'BEFORE' if index == 0 else 'AFTER', font=ImageFont.truetype(font, 25), fill='white')
        draw.text((x, 45), 'main 6a2eb397' if index == 0 else 'Same small mic; invisible 52pt target',
            font=ImageFont.truetype(font, 17), fill='#cbd5e1')
        draw.text((x, 694), label, font=ImageFont.truetype(font, 17), fill='#e2e8f0')
        status = 'Blue square = touch start; offsets from each button center'
        color = '#cbd5e1'
        if stage < 3:
            data = json.loads((root / side / 'results.json').read_text())
            passed = data['results'][stage]['recordingStarted']
            status = 'Result: recording started' if passed else 'Result: missed; keyboard opened'
            color = '#86efac' if passed else '#fca5a5'
        draw.text((x, 716), status, font=ImageFont.truetype(font, 14), fill=color)
    path = root / f'caption-{stage}.png'
    image.save(path)
    images += ['-loop', '1', '-i', str(path)]
    source = 'panels' if stage == 0 else f'label{stage-1}'
    filters.append(f"[{source}][{stage+2}:v]overlay=0:0:enable='between(t,{start},{end})'[label{stage}]")
filters.append('[label5]format=yuv420p[out]')
graph = root / 'comparison-filter.txt'
graph.write_text(';\n'.join(filters))
subprocess.run(['ffmpeg', '-y', '-v', 'warning', '-i', str(root / 'before/raw.mp4'),
    '-i', str(root / args.after / 'raw.mp4'), *images, '-/filter_complex', str(graph), '-map', '[out]',
    '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-movflags', '+faststart',
    '-t', '54.5', str(root / args.name)], check=True)
print(root / args.name)
