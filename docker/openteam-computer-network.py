#!/usr/bin/python3
"""Install the computer's routing policy before starting any application.

Only this container's network namespace is changed. Rules deliberately survive
relay/TUN failure; the unreachable route prevents lookup falling through to the
Docker gateway. Root applications receive exactly the same policy as other apps.
"""
import ipaddress
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from urllib.parse import urlsplit

MARK = '0x4f54'
TABLE = '18791'
TUN = 'openteam0'
HOST_BRIDGE_CONFIG = Path('/home/box/.config/openteam/imessage-bridge.json')


def run(*args, input=None):
    return subprocess.run(args, input=input, text=True, check=True, capture_output=True).stdout


def network_families():
    ipv6 = Path('/proc/sys/net/ipv6/conf')
    enabled = all((ipv6 / name / 'disable_ipv6').is_file() and
                  (ipv6 / name / 'disable_ipv6').read_text().strip() == '0'
                  for name in ['all', 'default'])
    return ['-4', '-6'] if enabled else ['-4']


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


def host_bridge_endpoint():
    """Only a private, explicitly provisioned endpoint reserves an underlay route."""
    try:
        descriptor = os.open(HOST_BRIDGE_CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor) as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                return None
            raw = file.read(16385)
        if len(raw) > 16384:
            return None
        config = json.loads(raw)
        if not isinstance(config, dict) or not isinstance(config.get('endpoint'), str):
            return None
        if not isinstance(config.get('token'), str) or not config['token'].strip():
            return None
        url = urlsplit(config['endpoint'])
        if (url.scheme not in ('http', 'https') or not url.hostname or '%' in url.hostname or
                url.username is not None or url.password is not None or url.query or url.fragment):
            return None
        address = ipaddress.ip_address(url.hostname)
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        port = url.port if url.port is not None else (443 if url.scheme == 'https' else 80)
        if address.is_unspecified or address.is_multicast or not 1 <= port <= 65535:
            return None
        return ('-6' if address.version == 6 else '-4', str(address), str(port))
    except (OSError, ValueError, TypeError, RecursionError):
        return None


def update_host_bridge(server_url):
    management_url(server_url)
    families = network_families()
    # A watcher retry or an administrator's refresh can overlap. Read kernel
    # state under the same lock so interrupted updates never duplicate rules.
    descriptor = os.open('/run/openteam-host-bridge.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        endpoint = host_bridge_endpoint()
        desired = {endpoint} if endpoint and endpoint[0] in families else set()
        previous = set()
        for family in families:
            for rule in json.loads(run('ip', family, '-j', 'rule', 'show', 'pref', '98')):
                if rule.get('dst') and rule.get('dport') is not None:
                    previous.add((family, str(ipaddress.ip_interface(rule['dst']).ip), str(rule['dport'])))
        for family, address, port in desired - previous:
            run('ip', family, 'rule', 'add', 'pref', '98', 'to', address,
                'ipproto', '6', 'dport', port, 'lookup', 'main')
        rules = ['flush set inet openteam_network host_bridge_v4',
                 'flush set inet openteam_network host_bridge_v6']
        for family, address, port in desired:
            suffix = 'v6' if family == '-6' else 'v4'
            rules.append(f'add element inet openteam_network host_bridge_{suffix} {{ {address} . {port} }}')
        # Replace address and port together. Revoked endpoints stop being marked
        # before their old source-selection rules are removed.
        run('nft', '-f', '-', input='\n'.join(rules) + '\n')
        for family, address, port in previous - desired:
            while subprocess.run(['ip', family, 'rule', 'del', 'pref', '98', 'to', address,
                                  'ipproto', '6', 'dport', port, 'lookup', 'main'],
                                 capture_output=True).returncode == 0:
                pass


def update_management(server_url, values):
    url, port = management_url(server_url)
    families = network_families()
    if not isinstance(values, list) or not values or len(values) > 32:
        raise ValueError('Invalid management addresses')
    addresses = sorted({str(ipaddress.ip_address(value)) for value in values})
    addresses = [address for address in addresses if '-6' in families or ':' not in address]
    if not addresses:
        raise ValueError('No management addresses use an enabled address family')
    state = Path('/run/openteam-management.json')
    # Kernel state is authoritative, including after an interrupted update.
    # Retrying a failed nft/hosts write must not append duplicate policy rules.
    previous = set()
    for family in families:
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


def update_families(value):
    if (not isinstance(value, dict) or set(value) != {'ipv4', 'ipv6'} or
            any(type(v) is not bool for v in value.values())):
        raise ValueError('Invalid address families')
    families = network_families()
    for family, enabled in [('-4', value['ipv4']), ('-6', value['ipv6'])]:
        if family not in families:
            continue
        # The unreachable route must remain: deleting it would fall through to
        # the host underlay. Reject before tun2socks can acknowledge a SYN.
        run('ip', family, 'route', 'replace', 'unreachable', 'default', 'metric', '42760', 'table', TABLE)
        if enabled:
            run('ip', family, 'route', 'replace', 'default', 'dev', TUN, 'metric', '10', 'table', TABLE)
        else:
            result = subprocess.run(['ip', family, 'route', 'del', 'default', 'dev', TUN,
                                     'metric', '10', 'table', TABLE], capture_output=True)
            if result.returncode and b'No such process' not in result.stderr:
                raise subprocess.CalledProcessError(result.returncode, result.args, stderr=result.stderr)


def prepare(server_url):
    url, port = management_url(server_url)
    families = network_families()
    # The server can start only after the computer is healthy. Do not perform
    # hostname resolution here: the marked worker discovers it asynchronously.
    try:
        addresses = [str(ipaddress.ip_address(url.hostname))]
    except ValueError:
        addresses = []
    rules = f'''table inet openteam_network {{
    set management_v4 {{ type ipv4_addr; }}
    set management_v6 {{ type ipv6_addr; }}
    set host_bridge_v4 {{ type ipv4_addr . inet_service; }}
    set host_bridge_v6 {{ type ipv6_addr . inet_service; }}
    chain transport {{
        type route hook output priority -150; policy accept;
        ct direction reply meta mark set {MARK}
        ip daddr @management_v4 tcp dport {port} meta mark set {MARK}
        ip6 daddr @management_v6 tcp dport {port} meta mark set {MARK}
        ip daddr . tcp dport @host_bridge_v4 meta mark set {MARK}
        ip6 daddr . tcp dport @host_bridge_v6 meta mark set {MARK}
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
    if '-6' in families:
        run('ip', '-6', 'addr', 'replace', 'fdfe:6f70:656e::1/128', 'dev', TUN)
    run('ip', 'link', 'set', 'dev', TUN, 'mtu', '1500', 'up')
    for family in families:
        run('ip', family, 'route', 'replace', 'unreachable', 'default', 'metric', '42760', 'table', TABLE)
        # Families are enabled only after the selected exit has been tested.
        subprocess.run(['ip', family, 'route', 'del', 'default', 'dev', TUN,
                        'metric', '10', 'table', TABLE], capture_output=True)
        # Dedicated priorities are owned by this container's network service.
        for priority in ['98', '99', '100', '101', '110']:
            while subprocess.run(['ip', family, 'rule', 'del', 'pref', priority], capture_output=True).returncode == 0:
                pass
        run('ip', family, 'rule', 'add', 'pref', '100', 'fwmark', MARK + '/0xffff', 'lookup', 'main')
        run('ip', family, 'rule', 'add', 'pref', '101', 'fwmark', MARK + '/0xffff', 'prohibit')
        run('ip', family, 'rule', 'add', 'pref', '110', 'lookup', TABLE)
    # The maximum of all/interface rp_filter applies. Even loose filtering on
    # eth0 drops marked relay/probe replies when ordinary routes are unreachable
    # during bootstrap. Disable it throughout this namespace, including the
    # default for future interfaces; nftables still enforces every output path.
    for interface in Path('/proc/sys/net/ipv4/conf').iterdir():
        (interface / 'rp_filter').write_text('0')
    Path('/run/openteam-management.json').write_text('[]')
    if addresses:
        update_management(server_url, addresses)
    # Existing private bridge configuration is ready before applications start.
    # The worker watches later provisioning and endpoint changes independently.
    update_host_bridge(server_url)
    Path('/run/openteam-network-ready').write_text(json.dumps({'interface': TUN, 'dnsPort': 5353}))


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--families':
            update_families(json.loads(sys.argv[2]))
        elif len(sys.argv) == 4 and sys.argv[1] == '--management':
            update_management(sys.argv[2], json.loads(sys.argv[3]))
        elif len(sys.argv) == 3 and sys.argv[1] == '--host-bridge':
            update_host_bridge(sys.argv[2])
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
