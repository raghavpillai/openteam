"""Render the fresh-install suite's real terminal recordings as MP4 and GIF.

Requires Python pillow/pyte and ffmpeg. Run test:install:fresh first.
No terminal output is synthesized; the recordings are replayed through pyte.
"""
import argparse
import json
import math
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont
import pyte

parser = argparse.ArgumentParser()
parser.add_argument('--font', default='/System/Library/Fonts/Menlo.ttc')
parser.add_argument('--recordings', type=Path, default=Path(__file__).resolve().parents[3] / 'output/fresh-install/recordings')
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[3] / 'output/installer-demo')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype(args.font, 20)
small = ImageFont.truetype(args.font, 15)
cell = math.ceil(font.getlength('M'))
line = 28
fps = 15
palette = {
    'default': '#e6e8ed', 'black': '#17191e', 'red': '#ff7b86', 'green': '#88dba7',
    'brown': '#eac787', 'yellow': '#eac787', 'blue': '#73adff', 'magenta': '#bc9afa',
    'cyan': '#6cbbff', 'white': '#e6e8ed', 'brightblack': '#959ca8',
}

def color(value, fallback):
    if value == 'default': return fallback
    if value in palette: return palette[value]
    if len(value) == 6: return '#' + value
    return fallback

def load(name, title):
    rows = [json.loads(line) for line in (args.recordings / name).read_text().splitlines()]
    return rows[0], rows[1:], title

clips = [load('installer-continue.cast', 'Automatic setup'), load('installer-cancel.cast', 'Press any key to cancel')]
columns = max(clip[0]['width'] for clip in clips)
rows = max(clip[0]['height'] for clip in clips)
width = math.ceil((columns * cell + 96) / 2) * 2
height = math.ceil((rows * line + 148) / 2) * 2
video = args.output / 'installer-demo.mp4'
encoder = subprocess.Popen([
    'ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
    '-video_size', f'{width}x{height}', '-framerate', str(fps), '-i', '-',
    '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', str(video),
], stdin=subprocess.PIPE)
saved = set()
try:
    for clip_index, (header, events, title) in enumerate(clips):
        screen = pyte.Screen(header['width'], header['height'])
        stream = pyte.Stream(screen)
        # Keep the complete countdown; end the auto-start clip just after the
        # handoff so the recording stays focused on the installer interaction.
        handoff = next((event[0] for event in events if event[1] == 'o' and 'Starting setup…' in event[2]), None)
        end = min(events[-1][0] + 1.8, handoff + 1.5) if handoff is not None else events[-1][0] + 2.5
        start = next((event[0] for event in events if event[1] == 'o'), 0)
        index = 0
        key_at = None
        for frame in range(math.ceil((end - start) * fps)):
            now = start + frame / fps
            while index < len(events) and events[index][0] <= now:
                event = events[index]
                if event[1] == 'o': stream.feed(event[2])
                elif event[1] == 'i': key_at = now
                index += 1
            canvas = Image.new('RGB', (width, height), '#101216')
            draw = ImageDraw.Draw(canvas)
            draw.rounded_rectangle((20, 20, width - 20, height - 56), radius=17, fill='#191b20', outline='#353941', width=1)
            draw.line((21, 70, width - 21, 70), fill='#353941')
            for x, dot in [(42, '#f27d78'), (63, '#e6bd60'), (84, '#73c992')]:
                draw.ellipse((x, 42, x + 10, 52), fill=dot)
            draw.text((116, 35), 'OpenTeam / install', font=small, fill='#d6dae3')
            draw.text((width - 42, 35), title, font=small, fill='#939dac', anchor='ra')
            for y in range(header['height']):
                for x in range(header['width']):
                    char = screen.buffer[y][x]
                    if not char.data: continue
                    foreground = color(char.fg, '#e6e8ed')
                    background = color(char.bg, '#191b20')
                    if char.reverse: foreground, background = background, foreground
                    left, top = 46 + x * cell, 88 + y * line
                    if background != '#191b20': draw.rectangle((left, top, left + cell, top + line), fill=background)
                    if char.data != ' ': draw.text((left, top), char.data, font=font, fill=foreground, stroke_width=0)
            draw.text((30, height - 36), 'Recorded terminal · isolated test installation', font=small, fill='#838e9f')
            if key_at is not None and now - key_at < 2.5:
                draw.text((width - 30, height - 36), 'Esc pressed', font=small, fill='#88dba7', anchor='ra')
            encoder.stdin.write(canvas.tobytes())
            if clip_index == 1 and any('Starting in 3s' in row for row in screen.display) and 'countdown' not in saved:
                canvas.save(args.output / 'countdown.png')
                saved.add('countdown')
            if clip_index == 1 and any('Setup cancelled' in row for row in screen.display) and 'cancelled' not in saved:
                canvas.save(args.output / 'cancelled.png')
                saved.add('cancelled')
finally:
    encoder.stdin.close()
    if encoder.wait(): raise RuntimeError('Video encoding failed')
subprocess.run([
    'ffmpeg', '-y', '-loglevel', 'error', '-i', str(video), '-filter_complex',
    '[0:v]fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    '-loop', '0', str(args.output / 'installer-demo.gif'),
], check=True)
print(video)
print(args.output / 'installer-demo.gif')
