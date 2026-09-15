"""Drive keypresses in a sized terminal and assert terminal attributes are restored."""
import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
spec = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", spec.get("rows", 24), spec["columns"], 0, 0))
before = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
output, pending = bytearray(), bytearray()
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
def read_until(marker):
    deadline = time.monotonic() + 8
    while marker not in ansi.sub("", pending.decode("utf-8", "replace")).replace("\r", ""):
        if time.monotonic() > deadline:
            raise RuntimeError("Timed out waiting for " + repr(marker))
        if select.select([master], [], [], 0.1)[0]:
            data = os.read(master, 65536)
            if not data: raise RuntimeError("Terminal closed before " + repr(marker))
            output.extend(data); pending.extend(data)
        elif child.poll() is not None: raise RuntimeError("Process exited before " + repr(marker))
    pending.clear()
try:
    for step in spec["steps"]:
        if "resize" in step:
            rows, columns = step["resize"]
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
            child.send_signal(signal.SIGWINCH)
        if "send" in step: os.write(master, step["send"].encode())
        if "expect" in step: read_until(step["expect"])
    deadline = time.monotonic() + 8
    while child.poll() is None or select.select([master], [], [], 0)[0]:
        if time.monotonic() > deadline: raise RuntimeError("CLI failed to exit")
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
                if not data: break
                output.extend(data)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
    if termios.tcgetattr(slave) != before: raise RuntimeError("CLI did not restore terminal attributes")
    sys.stdout.buffer.write(output)
    sys.exit(child.wait())
except Exception:
    sys.stdout.buffer.write(output)
    raise
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
