"""Bounded checks from the dedicated WSL NAT namespace.

Mode v1 reads one integer port and performs one TCP connect().
Mode v2 additionally sends one fixed-target proxy CONNECT, validates TLS, holds
the tunnel briefly for CFW correlation, then closes it. It never sends an origin
HTTP request, invokes a model, reads credentials or writes a file.
"""

import errno
import ipaddress
import json
import signal
import socket
import ssl
import sys
import time

MAX_INPUT = 4096
CONNECT_TIMEOUT_SECONDS = 1.0
TLS_TIMEOUT_SECONDS = 5.0
TLS_READY_HOLD_SECONDS = 2.0
MAX_CONNECT_RESPONSE_BYTES = 16384
TLS_TARGETS = frozenset(("api.openai.com", "chatgpt.com"))


def default_gateway(path="/proc/net/route"):
    with open(path, "r", encoding="ascii") as stream:
        header = stream.readline(4096)
        if not header or not header.startswith("Iface\tDestination\tGateway"):
            raise ValueError("ROUTE_HEADER_INVALID")
        for line in stream:
            fields = line.rstrip("\n").split("\t")
            if len(fields) < 8:
                continue
            destination, gateway, flags = fields[1], fields[2], fields[3]
            if destination != "00000000":
                continue
            try:
                flag_bits = int(flags, 16)
                raw = bytes.fromhex(gateway)
            except ValueError:
                continue
            if not flag_bits & 0x2 or len(raw) != 4 or gateway == "00000000":
                continue
            address = ipaddress.IPv4Address(socket.inet_ntoa(raw[::-1]))
            if not address.is_private or address.is_loopback or address.is_unspecified:
                continue
            return str(address)
    raise ValueError("DEFAULT_ROUTE_UNAVAILABLE")


def classify_connect_error(code):
    if code == errno.ECONNREFUSED:
        return "CONNECTION_REFUSED"
    if code in (errno.ETIMEDOUT, errno.EHOSTUNREACH, errno.ENETUNREACH):
        return "TIMEOUT" if code == errno.ETIMEDOUT else "UNREACHABLE"
    return "UNREACHABLE"


def validate_port(port):
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("PORT_INVALID")
    return port


def validate_gateway(gateway):
    address = ipaddress.IPv4Address(gateway)
    if not address.is_private or address.is_loopback or address.is_unspecified:
        raise ValueError("GATEWAY_DENIED")
    return address


def validate_target(target_host):
    if target_host not in TLS_TARGETS:
        raise ValueError("TARGET_DENIED")
    return target_host


def tls_result(state, target_host, gateway=None, proxy_port=None, elapsed_ms=None,
               protocol=None, alpn=None, authorized=False, error_class=None,
               proxy_connect_requests=1, proxy_control_bytes=0):
    return {
        "schema": "dream-maker.wsl-proxy-tls-helper-observation.v1",
        "state": state,
        "targetHost": target_host,
        "targetPort": 443,
        "gateway": gateway,
        "proxyPort": proxy_port,
        "protocol": protocol,
        "alpn": alpn,
        "authorized": authorized,
        "elapsedMs": elapsed_ms,
        "errorClass": error_class,
        "proxyConnectRequests": proxy_connect_requests,
        "proxyControlBytes": proxy_control_bytes,
        "originHttpRequests": 0,
        "modelCalls": 0,
        "filesWritten": 0,
    }


def read_connect_status(client):
    response = b""
    while b"\r\n\r\n" not in response:
        chunk = client.recv(4096)
        if not chunk:
            raise ValueError("PROXY_CONNECT_EOF")
        response += chunk
        if len(response) > MAX_CONNECT_RESPONSE_BYTES:
            raise ValueError("PROXY_CONNECT_RESPONSE_TOO_LARGE")
    status_line = response.split(b"\r\n", 1)[0]
    try:
        text = status_line.decode("latin1")
        parts = text.split(" ", 2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/"):
            raise ValueError
        status = int(parts[1])
    except (UnicodeDecodeError, ValueError):
        raise ValueError("PROXY_CONNECT_RESPONSE_INVALID")
    if status < 100 or status > 599:
        raise ValueError("PROXY_CONNECT_RESPONSE_INVALID")
    return status


def probe_tls(port, target_host, gateway=None, connector=socket.create_connection,
              context_factory=ssl.create_default_context,
              hold_seconds=TLS_READY_HOLD_SECONDS, on_ready=None):
    validate_port(port)
    validate_target(target_host)
    gateway = gateway or default_gateway()
    address = validate_gateway(gateway)
    started = time.monotonic()
    client = None
    secure = None
    authority = f"{target_host}:443"
    connect_request = (
        f"CONNECT {authority} HTTP/1.1\r\n"
        f"Host: {authority}\r\n"
        "Proxy-Connection: Keep-Alive\r\n"
        "\r\n"
    ).encode("ascii")
    try:
        client = connector((str(address), port), timeout=CONNECT_TIMEOUT_SECONDS)
        client.settimeout(TLS_TIMEOUT_SECONDS)
        local = client.getsockname()
        client.sendall(connect_request)
        status = read_connect_status(client)
        if status != 200:
            return tls_result(
                "PROXY_CONNECT_REJECTED", target_host, str(address), port,
                min(30000, max(0, int((time.monotonic() - started) * 1000))),
                error_class="PROXY_AUTH_REQUIRED" if status == 407 else "PROXY_CONNECT_REJECTED",
                proxy_control_bytes=len(connect_request),
            )
        context = context_factory()
        context.set_alpn_protocols(["http/1.1"])
        secure = context.wrap_socket(client, server_hostname=target_host)
        elapsed = min(30000, max(0, int((time.monotonic() - started) * 1000)))
        readiness = {
            "schema": "dream-maker.wsl-proxy-tls-readiness.v1",
            "stage": "READY",
            "targetHost": target_host,
            "targetPort": 443,
            "gateway": str(address),
            "proxyPort": port,
            "sourceAddress": str(local[0]),
            "sourcePort": int(local[1]),
        }
        if on_ready is not None:
            on_ready(readiness)
        if hold_seconds > 0:
            time.sleep(min(3.0, hold_seconds))
        cipher = secure.cipher()
        return tls_result(
            "CONNECT_AND_TLS_COMPLETED", target_host, str(address), port, elapsed,
            protocol=secure.version(),
            alpn=secure.selected_alpn_protocol(),
            authorized=True,
            proxy_control_bytes=len(connect_request),
        ) | {"cipher": cipher[0] if isinstance(cipher, tuple) and cipher else None}
    except TimeoutError:
        return tls_result(
            "TIMEOUT", target_host, str(address), port,
            min(30000, max(0, int((time.monotonic() - started) * 1000))),
            error_class="TIMEOUT", proxy_control_bytes=len(connect_request),
        )
    except ssl.SSLCertVerificationError:
        return tls_result(
            "TLS_HANDSHAKE_FAILED", target_host, str(address), port,
            min(30000, max(0, int((time.monotonic() - started) * 1000))),
            error_class="TLS_CERTIFICATE_VERIFICATION_FAILED",
            proxy_control_bytes=len(connect_request),
        )
    except ssl.SSLError:
        return tls_result(
            "TLS_HANDSHAKE_FAILED", target_host, str(address), port,
            min(30000, max(0, int((time.monotonic() - started) * 1000))),
            error_class="TLS_HANDSHAKE_FAILED",
            proxy_control_bytes=len(connect_request),
        )
    except (OSError, ValueError):
        return tls_result(
            "UNREACHABLE", target_host, str(address), port,
            min(30000, max(0, int((time.monotonic() - started) * 1000))),
            error_class="PROXY_OR_TLS_TRANSPORT_FAILED",
            proxy_control_bytes=len(connect_request),
        )
    finally:
        if secure is not None:
            try:
                secure.close()
            except OSError:
                pass
        if client is not None and client is not secure:
            try:
                client.close()
            except OSError:
                pass


def probe(port, gateway=None, connector=socket.socket.connect_ex):
    validate_port(port)
    gateway = gateway or default_gateway()
    address = validate_gateway(gateway)
    started = time.monotonic()
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        client.settimeout(CONNECT_TIMEOUT_SECONDS)
        code = connector(client, (str(address), port))
    except TimeoutError:
        code = errno.ETIMEDOUT
    except OSError as error:
        code = error.errno if error.errno is not None else errno.EIO
    finally:
        client.close()
    elapsed = min(5000, max(0, int((time.monotonic() - started) * 1000)))
    return {
        "schema": "dream-maker.wsl-proxy-reachability.v1",
        "state": "TCP_REACHABLE_ONLY" if code == 0 else classify_connect_error(code),
        "gateway": str(address),
        "port": port,
        "elapsedMs": elapsed,
        "routeSource": "WSL_DEFAULT_ROUTE",
        "networkPayloadBytes": 0,
        "httpRequests": 0,
        "tlsHandshakes": 0,
        "modelCalls": 0,
        "filesWritten": 0,
    }


def main():
    if sys.platform != "linux" or len(sys.argv) != 1:
        raise SystemExit(2)
    signal.alarm(10)
    try:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("INPUT_TOO_LARGE")
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) not in ({"port"}, {"port", "targetHost"}):
            raise ValueError("INPUT_INVALID")
        if set(value) == {"port"}:
            result = probe(value["port"])
        else:
            def ready(item):
                print(json.dumps(item, separators=(",", ":")), flush=True)
            result = probe_tls(value["port"], value["targetHost"], on_ready=ready)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        result = {
            "schema": "dream-maker.wsl-proxy-reachability.v1",
            "state": "UNREACHABLE",
            "gateway": None,
            "port": None,
            "elapsedMs": None,
            "routeSource": "WSL_DEFAULT_ROUTE",
            "networkPayloadBytes": 0,
            "httpRequests": 0,
            "tlsHandshakes": 0,
            "modelCalls": 0,
            "filesWritten": 0,
        }
    print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
