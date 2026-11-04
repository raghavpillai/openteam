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
import subprocess
import sys
from urllib.parse import urlsplit

MARK = '0x4f54'
TABLE = '18791'
TUN = 'openteam0'


def run(*args, input=None):
    return subprocess.run(args, input=input, text=True, check=True, capture_output=True).stdout


def management_url(server_url):
    if os.geteuid() != 0:
        raise RuntimeError('Computer networking requires the container supervisor')
    # Refuse to change a host's default namespace when invoked outside Docker.
    if not Path('/.dockerenv').exists():
        raise RuntimeError('Computer networking must run inside its container')
    url = urlsplit(server_url)
    if url.scheme not in ('http', 'https') or not url.hostname:
        raise ValueError('Invalid computer management URL')
    port = url.port or (443 if url.scheme == 'https' else 80)
    return url, port


def update_management(server_url, values):
    url, port = management_url(server_url)
    if not isinstance(values, list) or not values or len(values) > 32:
        raise ValueError('Invalid management addresses')
    addresses = sorted({str(ipaddress.ip_address(value)) for value in values})
    state = Path('/run/openteam-management.json')
    # Kernel state is authoritative, including after an interrupted update.
    # Retrying a failed nft/hosts write must not append duplicate policy rules.
    previous = set()
    for family in ['-4', '-6']:
        for rule in json.loads(run('ip', family, '-j', 'rule', 'show', 'pref', '99')):
            destination = rule.get('dst')
            if destination:
                previous.add(str(ipaddress.ip_interface(destination).ip))
    # Install new source-selection rules before publishing addresses to apps.
    # Never create a window where an old destination falls through to Docker.
    for address in addresses:
        if address not in previous:
            family = '-6' if ':' in address else '-4'
            run('ip', family, 'rule', 'add', 'pref', '99', 'to', address,
                'ipproto', '6', 'dport', str(port), 'lookup', 'main')
    rules = ['flush set inet openteam_network management_v4',
             'flush set inet openteam_network management_v6']
    for suffix, group in [('v4', [a for a in addresses if ':' not in a]),
                          ('v6', [a for a in addresses if ':' in a])]:
        if group:
            rules.append(f'add element inet openteam_network management_{suffix} {{ {", ".join(group)} }}')
    run('nft', '-f', '-', input='\n'.join(rules) + '\n')
    try:
        ipaddress.ip_address(url.hostname)
        hostname = False
    except ValueError:
        hostname = True
    hosts = Path('/etc/hosts')
    text = '\n'.join(line for line in hosts.read_text().splitlines()
                     if not line.endswith('# openteam management')) + '\n'
    if hostname:
        text += ''.join(f'{address}\t{url.hostname}\t# openteam management\n' for address in addresses)
    hosts.write_text(text)
    for address in previous:
        if address not in addresses:
            family = '-6' if ':' in address else '-4'
            while subprocess.run(['ip', family, 'rule', 'del', 'pref', '99', 'to', address,
                                  'ipproto', '6', 'dport', str(port), 'lookup', 'main'],
                                 capture_output=True).returncode == 0:
                pass
    state.write_text(json.dumps(addresses))


def prepare(server_url):
    url, port = management_url(server_url)
    # The server can start only after the computer is healthy. Do not perform
    # hostname resolution here: the marked worker discovers it asynchronously.
    try:
        addresses = [str(ipaddress.ip_address(url.hostname))]
    except ValueError:
        addresses = []
    rules = f'''table inet openteam_network {{
    set management_v4 {{ type ipv4_addr; }}
    set management_v6 {{ type ipv6_addr; }}
    chain transport {{
        type route hook output priority -150; policy accept;
        ct direction reply meta mark set {MARK}
        ip daddr @management_v4 tcp dport {port} meta mark set {MARK}
        ip6 daddr @management_v6 tcp dport {port} meta mark set {MARK}
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
        run('ip', family, 'rule', 'add', 'pref', '100', 'fwmark', MARK + '/0xffff', 'lookup', 'main')
        run('ip', family, 'rule', 'add', 'pref', '101', 'fwmark', MARK + '/0xffff', 'prohibit')
        run('ip', family, 'rule', 'add', 'pref', '110', 'lookup', TABLE)
    # Responses arrive from the virtual interface, rather than the Docker NIC.
    for interface in ['all', TUN]:
        Path(f'/proc/sys/net/ipv4/conf/{interface}/rp_filter').write_text('0')
    Path('/run/openteam-management.json').write_text('[]')
    if addresses:
        update_management(server_url, addresses)
    Path('/run/openteam-network-ready').write_text(json.dumps({'interface': TUN, 'dnsPort': 5353}))


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == '--management':
            update_management(sys.argv[2], json.loads(sys.argv[3]))
        elif len(sys.argv) == 2:
            prepare(sys.argv[1])
        else:
            raise ValueError('Expected computer management URL')
    except Exception as error:
        # Never print the management URL (it may contain authentication data).
        print(f'Cannot enforce computer networking: {type(error).__name__}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr[:2000], file=sys.stderr)
        raise SystemExit(1)
