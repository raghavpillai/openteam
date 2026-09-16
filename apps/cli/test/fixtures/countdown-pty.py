"""Run the countdown in a real terminal and inject a key or resize mid-countdown."""
import errno, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time

columns, scenario, *command = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, int(columns), 0, 0))
process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave)
before = termios.tcgetattr(slave)
output = b''
sent = False
try:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], .1)
        if ready:
            try: data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not data: break
            output += data
            if b'Starting in 5s' in output and not sent:
                keys = {'escape': b'\x1b', 'enter': b'\r', 'letter': b'x', 'ctrl-c': b'\x03', 'arrow': b'\x1b[A', 'paste': b'multi\nline'}
                if scenario in keys: os.write(master, keys[scenario])
                elif scenario == 'resize':
                    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 24, 0, 0))
                    os.kill(process.pid, signal.SIGWINCH)
                sent = True
        if process.poll() is not None and not ready: break
    else:
        process.kill()
        raise RuntimeError('Countdown did not finish')
    after = termios.tcgetattr(slave)
    sys.stdout.buffer.write(output)
    print(json.dumps({'terminalRestored': before == after}))
finally:
    os.close(master)
    os.close(slave)
    process.wait()
sys.exit(process.returncode)
