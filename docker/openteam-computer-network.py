#!/usr/bin/python3
"""Install the computer's routing policy before starting any application.

Only this container's network namespace is changed. Rules deliberately survive
relay/TUN failure; the unreachable route prevents lookup falling through to the
Docker gateway. Root applications receive exactly the same policy as other apps.
"""
import ipaddress
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from urllib.parse import urlsplit

MARK = '0x4f54'
TABLE = '18791'
TUN = 'openteam0'


def run(*args, input=None):
    return subprocess.run(args, input=input, text=True, check=True, capture_output=True).stdout


def prepare(server_url):
    if os.geteuid() != 0:
        raise RuntimeError('Computer networking requires the container supervisor')
    # Refuse to change a host's default namespace when invoked outside Docker.
    if not Path('/.dockerenv').exists():
        raise RuntimeError('Computer networking must run inside its container')
    url = urlsplit(server_url)
    if url.scheme not in ('http', 'https') or not url.hostname:
        raise ValueError('Invalid computer management URL')
    port = url.port or (443 if url.scheme == 'https' else 80)
    addresses = sorted({str(ipaddress.ip_address(item[4][0])) for item in
                        socket.getaddrinfo(url.hostname, port, type=socket.SOCK_STREAM)})
    if not addresses:
        raise RuntimeError('Cannot resolve computer management server')
    # Preserve service discovery for the management URL after application DNS is
    # redirected. Other names (including public names) always use the chosen exit.
    try:
        ipaddress.ip_address(url.hostname)
        hostname = False
    except ValueError:
        hostname = True
    if hostname:
        with Path('/etc/hosts').open('a') as hosts:
            for address in addresses:
                hosts.write(f'\n{address}\t{url.hostname}\t# openteam management\n')
    v4 = [a for a in addresses if ':' not in a]
    v6 = [a for a in addresses if ':' in a]
    management = '\n'.join(
        f'        {family} daddr {{ {", ".join(values)} }} tcp dport {port} meta mark set {MARK}'
        for family, values in [('ip', v4), ('ip6', v6)] if values
    )
    rules = f'''table inet openteam_network {{
    chain transport {{
        type route hook output priority -150; policy accept;
        ct direction reply meta mark set {MARK}
{management}
    }}
    chain dns {{
        type nat hook output priority -110; policy accept;
        meta mark & 0xffff != {MARK} udp dport 53 counter redirect to :5353
        meta mark & 0xffff != {MARK} tcp dport 53 counter redirect to :5353
    }}
    chain enforce {{
        type filter hook output priority 0; policy drop;
        oifname "lo" accept
        # OUTPUT DNAT reroutes after this hook. A hardcoded resolver can still
        # carry its original TUN oif here, although its destination is loopback.
        ip daddr 127.0.0.1 udp dport 5353 accept
        ip6 daddr ::1 udp dport 5353 accept
        meta mark & 0xffff == {MARK} accept
        oifname "{TUN}" meta l4proto tcp accept
        meta l4proto 58 icmpv6 type {{ nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert }} accept
        counter reject with icmpx type admin-prohibited
    }}
    chain forwarding {{
        type filter hook forward priority 0; policy drop;
    }}
}}
'''
    # One atomic transaction; do not flush Docker's tables or unrelated rules.
    exists = subprocess.run(['nft', 'list', 'table', 'inet', 'openteam_network'], capture_output=True).returncode == 0
    run('nft', '-f', '-', input=('delete table inet openteam_network\n' if exists else '') + rules)
    if subprocess.run(['ip', 'link', 'show', TUN], capture_output=True).returncode:
        run('ip', 'tuntap', 'add', 'dev', TUN, 'mode', 'tun')
    run('ip', 'addr', 'replace', '198.18.0.1/32', 'dev', TUN)
    run('ip', '-6', 'addr', 'replace', 'fdfe:6f70:656e::1/128', 'dev', TUN)
    run('ip', 'link', 'set', 'dev', TUN, 'mtu', '1500', 'up')
    for family in ['-4', '-6']:
        run('ip', family, 'route', 'replace', 'unreachable', 'default', 'metric', '42760', 'table', TABLE)
        run('ip', family, 'route', 'replace', 'default', 'dev', TUN, 'metric', '10', 'table', TABLE)
        # Dedicated priorities are owned by this container's network service.
        for priority in ['99', '100', '101', '110']:
            while subprocess.run(['ip', family, 'rule', 'del', 'pref', priority], capture_output=True).returncode == 0:
                pass
        for address in (v4 if family == '-4' else v6):
            # Select the original source address before OUTPUT rerouting; this
            # also works for a management server on the Docker bridge itself.
            run('ip', family, 'rule', 'add', 'pref', '99', 'to', address,
                'ipproto', '6', 'dport', str(port), 'lookup', 'main')
        run('ip', family, 'rule', 'add', 'pref', '100', 'fwmark', MARK + '/0xffff', 'lookup', 'main')
        run('ip', family, 'rule', 'add', 'pref', '101', 'fwmark', MARK + '/0xffff', 'prohibit')
        run('ip', family, 'rule', 'add', 'pref', '110', 'lookup', TABLE)
    # Responses arrive from the virtual interface, rather than the Docker NIC.
    for interface in ['all', TUN]:
        Path(f'/proc/sys/net/ipv4/conf/{interface}/rp_filter').write_text('0')
    Path('/run/openteam-network-ready').write_text(json.dumps({'interface': TUN, 'dnsPort': 5353}))


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Expected computer management URL')
        prepare(sys.argv[1])
    except Exception as error:
        # Never print the management URL (it may contain authentication data).
        print(f'Cannot enforce computer networking: {type(error).__name__}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr[:2000], file=sys.stderr)
        raise SystemExit(1)
