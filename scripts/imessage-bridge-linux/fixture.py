"""Disposable host bridge and stdio adapter. All RPC data is synthetic."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import threading
from urllib.request import Request, urlopen


class Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        global bridge
        if self.server.server_port == 8787:
            if self.path == '/start' and bridge is None:
                bridge = Server(('::', 8799), Handler)
                threading.Thread(target=bridge.serve_forever, daemon=True).start()
            if self.path == '/stop' and bridge is not None:
                bridge.shutdown()
                bridge.server_close()
                bridge = None
            value = {'running': bridge is not None}
        else:
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            method = request['method']
            if method == 'initialize':
                result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}},
                          'serverInfo': {'name': 'fixture-bridge', 'version': '1'}}
            elif method == 'tools/list':
                result = {'tools': [{'name': 'IMessageStatus', 'inputSchema': {'type': 'object'}}]}
            else:
                result = {'content': [{'type': 'text', 'text': json.dumps({'readable': True})}]}
            value = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'fixture-neighbor')


def rpc(request):
    req = Request(os.environ['FIXTURE_BRIDGE'], data=json.dumps(request).encode(),
                  headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=2) as response:
        return json.load(response)


if sys.argv[1] == 'host':
    bridge = None
    # A neighboring port must keep following the application network policy.
    neighbor = Server(('::', 8798), Handler)
    threading.Thread(target=neighbor.serve_forever, daemon=True).start()
    Server(('::', 8787), Handler).serve_forever()
else:
    # Match the installed adapter's eager access check and per-request failures.
    try:
        rpc({'jsonrpc': '2.0', 'id': 'check', 'method': 'tools/call',
             'params': {'name': 'IMessageStatus', 'arguments': {}}})
    except (OSError, http.client.HTTPException):
        raise SystemExit(1)
    starts = Path('/tmp/bridge-adapter-starts')
    with starts.open('a') as file:
        file.write('started\n')
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request:
            continue
        try:
            response = rpc(request)
        except (OSError, http.client.HTTPException):
            response = {'jsonrpc': '2.0', 'id': request['id'],
                        'error': {'code': -32603, 'message': 'Bridge unavailable'}}
        print(json.dumps(response), flush=True)
