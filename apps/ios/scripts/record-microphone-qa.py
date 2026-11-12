#!/usr/bin/env python3
"""Record real simulator HID input and save timings/results for MP4 annotation.

Use a loopback parity fixture and launch the app with --qa-synthetic-voice first.
No audio or messages leave the local QA fixture. Run against the same simulator
and fixture scene before and after a change. Touch markers are added in post.
"""
import argparse
import json
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--udid', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--server', default='http://127.0.0.1:20137')
args = parser.parse_args()
assert args.server.startswith('http://127.0.0.1:'), 'Only a local QA fixture is allowed'
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
events = []

def run(*command):
    return subprocess.check_output(command, text=True, stderr=subprocess.DEVNULL, timeout=30)

def tree():
    return json.loads(run('idb', 'ui', 'describe-all', '--udid', args.udid, '--json'))

def find(label):
    return next((e for e in tree() if e.get('AXLabel') == label), None)

def center(element):
    f = element['frame']
    return f['x'] + f['width'] / 2, f['y'] + f['height'] / 2

def state():
    with urllib.request.urlopen(args.server + '/__qa/state') as response:
        return json.load(response)

def tap(x, y, name, duration=0.1, end=None):
    event = {'name': name, 'time': time.monotonic() - start, 'x': round(x), 'y': round(y), 'duration': duration}
    if end:
        event['end'] = [round(end[0]), round(end[1])]
        run('idb', 'ui', 'swipe', str(round(x)), str(round(y)),
            str(round(end[0])), str(round(end[1])), '--duration', str(duration), '--delta', '1', '--udid', args.udid)
    else:
        run('idb', 'ui', 'tap', str(round(x)), str(round(y)), '--duration', str(duration), '--udid', args.udid)
    event['returned'] = time.monotonic() - start
    events.append(event)
    print(json.dumps(event), flush=True)

def at(seconds):
    time.sleep(max(0, seconds - (time.monotonic() - start)))

def screenshot(name):
    run('xcrun', 'simctl', 'io', args.udid, 'screenshot', str(out / (name + '.png')))

def cleanup():
    discard = find('Discard recording')
    if discard:
        tap(*center(discard), 'Discard')
        time.sleep(1.4)
    tap(200, 350, 'Dismiss keyboard')
    time.sleep(0.6)

run('xcrun', 'simctl', 'status_bar', args.udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100')
for _ in range(40):
    mic = find('Record voice note')
    if mic and mic.get('enabled'):
        break
    time.sleep(0.5)
else:
    raise RuntimeError('Open an empty, loaded QA conversation first')
time.sleep(1)
initial = state()
initial_requests = len([r for r in initial['requests'] if r['path'] == '/api/v0/transcriptions'])
screenshot('idle')
video_log = (out / 'recording.log').open('w')
video = subprocess.Popen(['xcrun', 'simctl', 'io', args.udid, 'recordVideo', '--codec=h264', '--force', str(out / 'raw.mp4')],
    stdout=video_log, stderr=video_log)
time.sleep(1)
start = time.monotonic()
results = []
try:
    for scheduled, name, dx, dy in [(2, 'Left of center -13pt', -13, 0),
        (10, 'Right of center +13pt', 13, 0), (18, 'Outer corner -23pt', -23, -23)]:
        at(scheduled)
        mic = find('Record voice note')
        x, y = center(mic)
        tap(x + dx, y + dy, name)
        at(scheduled + 2)
        recording = find('Discard recording') is not None
        results.append({'name': name, 'micFrame': mic['frame'], 'offset': [dx, dy], 'recordingStarted': recording})
        screenshot('tap-' + str(scheduled))
        at(scheduled + 4)
        cleanup()
    at(26)
    tap(*center(find('Record voice note')), 'Tap for hands-free')
    at(28)
    screenshot('hands-free')
    stop = find('Stop recording')
    at(30)
    if stop:
        tap(*center(stop), 'Stop and review')
    at(31.5)
    results.append({'name': 'Hands-free stop', 'stopAvailable': stop is not None,
        'readyForReview': find('Voice note ready') is not None})
    screenshot('review')
    at(33)
    cleanup()
    at(38)
    x, y = center(find('Record voice note'))
    tap(x, y, 'Hold with 12pt drift', 1.6, (x - 12, y))
    at(41)
    screenshot('hold-released')
    at(44)
    results.append({'name': 'Hold and release', 'composerReturned': find('Record voice note') is not None})
    x, y = center(find('Record voice note'))
    tap(x, y, 'Slide up to lock', 1.6, (x, y - 100))
    at(48)
    screenshot('locked')
    results.append({'name': 'Slide up to lock', 'recordingContinues': find('Discard recording') is not None})
    at(50)
    cleanup()
    at(54)
finally:
    video.send_signal(signal.SIGINT)
    video.wait(timeout=20)
    video_log.close()
    final = state()
    payload = {'udid': args.udid, 'videoTimelineOffset': 1, 'results': results, 'events': events,
        'transcriptionRequests': len([r for r in final['requests'] if r['path'] == '/api/v0/transcriptions']) - initial_requests,
        'haptics': json.load(urllib.request.urlopen(args.server + '/__qa/haptics'))}
    (out / 'results.json').write_text(json.dumps(payload, indent=2))
    print(json.dumps(results, indent=2), flush=True)
