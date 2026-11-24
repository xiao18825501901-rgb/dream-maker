"""Passive, bounded projection of the DM-owned Codex environment. Never authenticates.

Production has no path arguments, network clients, subprocesses or file writes. Tests may
import the two pure projection functions; raw account and log data never leave this process.
"""
import datetime
import hashlib
import json
import os
import re
import signal
import stat
import sys
import time

HOME = "/opt/dream-maker-controller/codex-home-p2"
BINARY = "/opt/dream-maker-controller/codex-0.162.0/launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
PROXY_NAMES = {b"HTTP_PROXY", b"HTTPS_PROXY", b"ALL_PROXY", b"http_proxy", b"https_proxy", b"all_proxy"}


def account_summary(value):
    result = {"mode": "UNKNOWN", "fingerprint": None}
    if not isinstance(value, dict) or value.get("auth_mode") != "chatgpt":
        return result
    result["mode"] = "CHATGPT"
    tokens = value.get("tokens")
    identifier = tokens.get("account_id") if isinstance(tokens, dict) else None
    if isinstance(identifier, str) and 0 < len(identifier) <= 256:
        result["fingerprint"] = hashlib.sha256(("dm-network-account-v1\0" + identifier).encode()).hexdigest()[:16]
    return result


def classify_login_log(text):
    result = []
    for line in text.splitlines():
        if len(line) > 8192 or not re.search(r"token[ _-]exchange", line, re.I):
            continue
        timestamp = re.search(r"20\d\d-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)", line)
        if not timestamp:
            continue
        try:
            datetime.datetime.fromisoformat(timestamp[0].replace("Z", "+00:00"))
        except ValueError:
            continue
        forbidden = bool(re.search(r"\b403\b", line))
        region = forbidden and bool(re.search(r"country,\s*region,?\s*or territory not supported|unsupported_country_region_territory", line, re.I))
        transport = bool(re.search(r"timed?\s*out|timeout|TLS|DNS|connection (?:refused|reset)|error sending request", line, re.I))
        if not forbidden and not transport:
            continue
        identifier = re.search(r"request id:\s*([a-f0-9]{12,64})(-[A-Z]{3})?\)", line, re.I)
        masked = identifier[1][:6].lower() + "…" + (identifier[2].upper() if identifier[2] else "") if identifier else None
        result.append({"at": timestamp[0], "httpStatus": 403 if forbidden else 0,
                       "reason": "REGION_UNSUPPORTED" if region else "FORBIDDEN_UNKNOWN" if forbidden else "TRANSPORT_ERROR",
                       "requestId": masked})
    return result[-4:]


def read_private(relative, limit):
    """Anchor every component by a no-follow descriptor; refuse links and oversized files."""
    descriptors = []
    try:
        directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(directory)
        for part in HOME.strip("/").split("/") + relative.split("/")[:-1]:
            directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            descriptors.append(directory)
        fd = os.open(relative.split("/")[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        descriptors.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError("PRIVATE_METADATA_DENIED")
        data = os.read(fd, limit + 1)
        if len(data) > limit:
            raise ValueError("PRIVATE_METADATA_DENIED")
        return data
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def observe():
    login = server = proxy = False
    deadline = time.monotonic() + 3
    for index, name in enumerate(os.listdir("/proc")):
        if index >= 8192 or time.monotonic() > deadline:
            raise ValueError("PROCESS_METADATA_LIMIT")
        if not name.isdigit():
            continue
        try:
            prefix = "/proc/" + name
            if os.readlink(prefix + "/exe") != BINARY:
                continue
            with open(prefix + "/cmdline", "rb") as stream:
                args = stream.read(8193).split(b"\0")
            with open(prefix + "/environ", "rb") as stream:
                environment = stream.read(65537)
            if len(environment) > 65536 or sum(map(len, args)) > 8192:
                continue
            fields = environment.split(b"\0")
            if (b"CODEX_HOME=" + HOME.encode()) not in fields:
                continue
            login |= b"login" in args
            server |= b"app-server" in args
            proxy |= any(field.partition(b"=")[0] in PROXY_NAMES and bool(field.partition(b"=")[2]) for field in fields)
        except OSError:
            continue
    account = {"mode": "UNKNOWN", "fingerprint": None}
    account_read = "UNAVAILABLE"
    try:
        account = account_summary(json.loads(read_private("auth.json", 131072)))
        account_read = "OBSERVED"
    except (OSError, ValueError, UnicodeError):
        pass
    rejections = []
    log_read = "UNAVAILABLE"
    for path in ["log/codex-login.log", "codex-login.log"]:
        try:
            rejections = classify_login_log(read_private(path, 262144).decode("utf-8", "replace"))
            log_read = "OBSERVED"
            break
        except (OSError, ValueError):
            continue
    return {"schema": "dream-maker.network-local-observer.v1", "available": True,
            "codexLoginRunning": login, "codexServerRunning": server, "proxyPresent": proxy,
            "proxyScope": "OBSERVED_DEDICATED_PROCESSES_ONLY", "account": account,
            "accountRead": account_read, "logRead": log_read, "rejections": rejections,
            "networkRequests": 0, "loginAttempts": 0, "filesWritten": 0}


def main():
    if sys.platform != "linux" or len(sys.argv) != 1:
        raise SystemExit(2)
    signal.alarm(5)
    try:
        value = observe()
    except (OSError, ValueError):
        value = {"schema": "dream-maker.network-local-observer.v1", "available": False}
    print(json.dumps(value, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
