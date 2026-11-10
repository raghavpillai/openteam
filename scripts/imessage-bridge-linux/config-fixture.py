"""Synthetic authenticated RPC listeners for the persisted-endpoint matrix."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import threading


class Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6 if os.environ.get('FIXTURE_IPV6') == '1' else socket.AF_INET

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        data = b'fixture-neighbor'
        self.send_response(200)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer fixture-token':
            self.send_error(401)
            return
        length = int(self.headers.get('Content-Length', '0'))
        if self.path != '/mcp' or not 0 < length <= 4096:
            self.send_error(400)
            return
        request = json.loads(self.rfile.read(length))
        if request.get('method') != 'tools/call' or request.get('params', {}).get('name') != 'IMessageStatus':
            self.send_error(400)
            return
        data = json.dumps({
            'jsonrpc': '2.0', 'id': request['id'],
            'result': {'content': [{'type': 'text', 'text': json.dumps({'readable': True})}]},
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


ports = [int(port) for port in os.environ['FIXTURE_PORTS'].split(',')]
address = '::' if Server.address_family == socket.AF_INET6 else '0.0.0.0'
servers = [Server((address, port), Handler) for port in ports]
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
Path('/tmp/bridge-config-ready').touch()
threading.Event().wait()
