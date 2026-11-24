#!/usr/bin/env python3
"""Windows<->distro connector: copies stdio to a unix socket and back, byte for byte.

It deliberately does NOT start anything. Failures are reported with a fixed code on stderr so the
controller never has to parse a Python traceback to learn "the bridge is not there".
"""
import os, select, socket, sys, time

if len(sys.argv) < 2:
    print("CONNECTOR_USAGE_MISSING_SOCKET", file=sys.stderr)
    sys.exit(2)

path = sys.argv[1]
# The bridge may still be starting when the controller connects, so give it a bounded window instead
# of failing on the first attempt. The wait is explicit and finite: no silent infinite retry.
wait_seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
deadline = time.monotonic() + max(0.0, wait_seconds)
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
last_errno = None
while True:
    try:
        sock.connect(path)
        break
    except FileNotFoundError as error:
        last_errno = "MISSING"
    except ConnectionRefusedError as error:
        last_errno = "REFUSED"
    except OSError as error:
        last_errno = str(error.errno)
    if time.monotonic() >= deadline:
        if last_errno == "MISSING":
            print(f"CONNECTOR_SOCKET_MISSING {path}", file=sys.stderr, flush=True)
            sys.exit(3)
        if last_errno == "REFUSED":
            print(f"CONNECTOR_SOCKET_REFUSED {path}", file=sys.stderr, flush=True)
            sys.exit(4)
        print(f"CONNECTOR_CONNECT_FAILED {last_errno}", file=sys.stderr, flush=True)
        sys.exit(5)
    sock.close()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    time.sleep(0.2)

print("CONNECTOR_CONNECTED", file=sys.stderr, flush=True)
stdin_open = True
while True:
    watch = [sock] + ([0] if stdin_open else [])
    readable, _, _ = select.select(watch, [], [], 30)
    if not readable:
        continue
    if sock in readable:
        chunk = sock.recv(65536)
        if not chunk:
            print("CONNECTOR_BRIDGE_CLOSED", file=sys.stderr, flush=True)
            break
        os.write(1, chunk)
    if stdin_open and 0 in readable:
        chunk = os.read(0, 65536)
        if not chunk:
            stdin_open = False
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass
        else:
            sock.sendall(chunk)
sock.close()