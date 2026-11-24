#!/usr/bin/env python3
"""Dream Maker trusted bridge (Linux side).

Owns the Kimi server process and carries the credential channel on DEDICATED fds, never on the
server's own stdout: the Kimi server prints a banner there, and mixing a length-prefixed frame
stream with human output is how a "token" silently becomes a banner line.

Layout:
    controller --stdin/stdout--> THIS SCRIPT --fd3/fd4--> Kimi server
      * the child writes frames to fd 3
      * the child reads frames from fd 4
    This script is a byte copier. It does not parse, re-encode or log frame content: parsing lives in
    the packaged Node code, so the protocol has exactly one implementation.

Usage:
    bridge.py --home /opt/.../kimi-home -- /path/to/node /path/to/dist/main.mjs web --no-open ...
"""
import argparse
import os
import signal
import subprocess
import sys
import threading

# Deliberately tiny: the Kimi child sees only these. The DM_KIMI_* entries configure the credential
# channel itself (mode, identity, ACK timeout) and carry no secrets.
ALLOWED_ENV = (
    "PATH", "HOME", "KIMI_CODE_HOME", "LANG", "DM_KIMI_BRIDGE",
    "DM_KIMI_CHANNEL", "DM_KIMI_INSTANCE_ID", "DM_KIMI_ACCOUNT_REF", "DM_KIMI_ACK_TIMEOUT_MS",
    "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
    "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
)


def evacuate(number):
    """Free a positional fd, keeping whatever was on it alive."""
    try:
        os.fstat(number)
    except OSError:
        return
    os.dup(number)      # a fresh, higher-numbered handle to the same open file
    os.close(number)


def safe_close(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def main(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--home", required=True)
    # Diagnostics only: capture the child's own output instead of discarding it. Without this a
    # child that dies before printing anything is indistinguishable from a child that never started.
    parser.add_argument("--log-dir", default=None)
    # Socket mode: listen on a unix socket and treat the accepted connection as the controller side.
    # This exists because "Windows spawns wsl.exe and supplies its stdin" proved unreliable here, while
    # "connect to a socket that already exists" does not involve the failing path at all.
    parser.add_argument("--socket", default=None)
    args, rest = parser.parse_known_args(argv)
    if rest and rest[0] == "--":
        rest = rest[1:]
    if not rest:
        print("bridge: missing child command", file=sys.stderr)
        return 2

    # The supervised process must not inherit whatever directory wsl.exe happened to land in: the
    # Kimi server resolves its workspace from cwd and fails far from the real cause if that is wrong.
    try:
        os.chdir(args.home)
    except OSError as message:
        print(f"bridge: cannot enter home {args.home}: {message}", file=sys.stderr)
        return 4

    # A piped parent commonly leaves its own stdio ends sitting exactly on 3 and 4, so free them
    # first — and then move the fresh pipes out of that range too, because os.pipe() hands back the
    # LOWEST free numbers, which would be 3 and 4 again.
    evacuate(3)
    evacuate(4)

    env = {k: os.environ[k] for k in ALLOWED_ENV if k in os.environ}
    env["HOME"] = args.home
    env["KIMI_CODE_HOME"] = args.home
    env["DM_KIMI_BRIDGE"] = "1"
    # DM Local-Only: authentication/inference is explicit; background reporting and update checks
    # are never permission granted by opening this trusted bridge.
    env["KIMI_DISABLE_TELEMETRY"] = "1"
    env["KIMI_CODE_NO_AUTO_UPDATE"] = "1"
    # A bridge that owns the child IS the fd channel: this is a property of the topology, not an
    # operator setting to remember. Without it the patched storage would fall back to the legacy
    # memory + FIFO mode and quietly never acknowledge anything.
    env["DM_KIMI_CHANNEL"] = "fds"
    env.setdefault("DM_KIMI_ACCOUNT_REF", os.environ.get("DM_KIMI_ACCOUNT_REF", ""))

    to_child_r, to_child_w = os.pipe()        # controller -> child (child reads fd 4)
    from_child_r, from_child_w = os.pipe()    # child -> controller (child writes fd 3)

    # Park all four ends above the positional range first: dup2() closes whatever already occupies
    # the target number, and that would silently destroy one of the pipe ends we just created.
    to_child_r = os.dup2(to_child_r, 10)
    to_child_w = os.dup2(to_child_w, 11)
    from_child_r = os.dup2(from_child_r, 12)
    from_child_w = os.dup2(from_child_w, 13)

    # Move the two ends the child needs into the positional numbers, kept across exec by pass_fds.
    os.dup2(to_child_r, 4)
    os.dup2(from_child_w, 3)

    child_stdout = subprocess.DEVNULL
    child_stderr = sys.stderr
    out_file = err_file = None
    if args.log_dir:
        os.makedirs(args.log_dir, exist_ok=True)
        out_file = open(os.path.join(args.log_dir, "child.out"), "ab", buffering=0)
        err_file = open(os.path.join(args.log_dir, "child.err"), "ab", buffering=0)
        child_stdout, child_stderr = out_file, err_file

    child = subprocess.Popen(
        rest,
        env=env,
        # The child gets a pipe we never write to and never close. \`DEVNULL\` looks tidier but hands the
        # server an immediate EOF on stdin, and the Kimi server exits on that — which showed up as a
        # port that was never bound rather than as a spawn error.
        stdin=subprocess.PIPE,
        stdout=child_stdout,
        stderr=child_stderr,    # server logs stay on stderr; frames never travel there
        pass_fds=(3, 4),
    )
    for fd in (3, 4, to_child_r, from_child_w):   # parent-side copies only; 11 and 12 stay open
        safe_close(fd)

    listener = None
    conn = None
    if args.socket:
        import socket as socket_module
        try:
            os.unlink(args.socket)
        except OSError:
            pass
        listener = socket_module.socket(socket_module.AF_UNIX, socket_module.SOCK_STREAM)
        listener.bind(args.socket)
        os.chmod(args.socket, 0o600)
        listener.listen(1)
        print(f"bridge: listening on {args.socket}", file=sys.stderr, flush=True)

    def controller_write(chunk):
        if conn is not None:
            conn.sendall(chunk)
        else:
            os.write(1, chunk)

    def controller_read(size=65536):
        if conn is not None:
            return conn.recv(size)
        return os.read(0, size)

    if listener is not None:
        conn, _ = listener.accept()
        try:
            listener.close()
        except OSError:
            pass

    def pump_child_to_controller():
        try:
            while True:
                chunk = os.read(from_child_r, 65536)
                if not chunk:
                    break
                controller_write(chunk)
        except OSError:
            pass
        finally:
            try:
                child.send_signal(signal.SIGTERM)
            except Exception:
                pass

    threading.Thread(target=pump_child_to_controller, daemon=True).start()

    try:
        while True:
            chunk = controller_read()
            if not chunk:
                break
            os.write(to_child_w, chunk)
    except (OSError, KeyboardInterrupt):
        pass
    finally:
        safe_close(to_child_w)
        if args.log_dir:
            with open(os.path.join(args.log_dir, "child.status"), "w") as status:
                status.write(f"pid={child.pid} poll={child.poll()}\n")
        try:
            code = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
        return code if isinstance(code, int) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
