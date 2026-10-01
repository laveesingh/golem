"""Owned PTY proof of the actual Golem -> Herdr agent terminal attachment.
No prompt/approval keys are sent. Disconnect only the newly-created client group.
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

screen = bytearray()
exited = False
status = None
try:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 140, 0, 0))
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            screen.extend(data)
            if b'gpt-6.1-sol' in screen and b'\x1b[' in screen:
                break
        found, status = os.waitpid(pid, os.WNOHANG)
        if found:
            exited = True
            break
    rendered = b'\x1b[' in screen
    target_screen = b'gpt-6.1-sol' in screen
finally:
    # pty.fork creates a new client session/group; never signal the app's group.
    if not exited:
        assert os.getpgid(pid) == pid
        os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            found, status = os.waitpid(pid, os.WNOHANG)
            if found:
                exited = True
                break
            time.sleep(0.05)
        if not exited:
            os.killpg(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
            exited = True
    os.close(master)
print(json.dumps({'rendered': rendered, 'actual_pi_screen': target_screen,
                  'client_exited': exited, 'screen_bytes': len(screen)}))
if not rendered or not target_screen:
    sys.exit(1)
