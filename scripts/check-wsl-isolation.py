"""Real OS boundary probes, without model calls or a LIVE_READY declaration."""
import ctypes
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time

DISTRO = "DreamMaker-Acceptance-20261011"


def linux_probe():
    import resource
    run_id = sys.argv[1]
    if not re.fullmatch(r"[a-z0-9-]{1,100}", run_id):
        raise RuntimeError("INVALID_OWN_PROBE_ID")
    base = Path("/opt/dream-maker-acceptance-20261011") / run_id
    if base.exists():
        raise RuntimeError("OWN_PROBE_PATH_EXISTS")
    if os.getuid() != 0 or "enabled=false" not in Path("/etc/wsl.conf").read_text():
        raise RuntimeError("DEDICATED_DISTRO_CONFIGURATION_UNPROVEN")
    cgroot = Path("/sys/fs/cgroup")
    before = (cgroot / "cgroup.subtree_control").read_text().split()
    # Do not alter controller delegation if another project's group already exists.
    if any(p.is_dir() for p in cgroot.iterdir()):
        raise RuntimeError("CGROUP_ROOT_ALREADY_SHARED_WITH_MANAGED_JOBS")
    required = {"memory", "pids", "cpu"}
    if not required.issubset(set((cgroot / "cgroup.controllers").read_text().split())):
        raise RuntimeError("REQUIRED_KERNEL_CONTROLLERS_UNAVAILABLE")
    report = {"schema": "dream-maker.wsl-isolation-probes.v1", "environment": DISTRO,
              "evidenceClass": "REAL_OS_PROBES_NOT_NATIVE_PROJECT_ACCEPTANCE",
              "modelCalls": 0, "globalHostNetworkChanged": False, "results": [],
              "kernel": os.uname().release, "cgroupDelegationBefore": before,
              "uid": 34271, "limits": {"memoryBytes": 536870912, "pids": 64,
              "cpuMax": "100000 100000", "wallSeconds": 8, "outputFileBytes": 1048576,
              "workspaceBytes": 33554432, "outputBytes": 33554432}}
    base.mkdir(mode=0o700, parents=True)
    os.chmod(base.parent, 0o755)
    os.chmod(base, 0o755)
    source = base / "source"
    source.mkdir()
    (source / "frozen.txt").write_text("frozen-source-canary\n")
    (base / "controller-secret-canary").write_text("SYNTHETIC_NOT_A_PROVIDER_SECRET\n")
    work, output = base / "workspace", base / "output"
    for p in (work, output):
        p.mkdir()
    group = cgroot / ("dream-maker-" + run_id)
    filter_fd = None
    canary = None
    mounted = []
    try:
        added = sorted(required - set(before))
        if added:
            (cgroot / "cgroup.subtree_control").write_text(" ".join("+" + c for c in added))
        group.mkdir()
        for name, value in (("memory.max", "536870912"), ("memory.swap.max", "0"),
                            ("pids.max", "64"), ("cpu.max", "100000 100000"), ("memory.oom.group", "1")):
            (group / name).write_text(value)
        for p in (work, output):
            subprocess.run(["mount", "-t", "tmpfs", "-o", "size=32M,mode=0700,nosuid,nodev", "none", str(p)], check=True)
            mounted.append(p)
            os.chown(p, 34271, 34271)

        class Compare(ctypes.Structure):
            _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                        ("a", ctypes.c_uint64), ("b", ctypes.c_uint64)]
        lib = ctypes.CDLL("libseccomp.so.2")
        lib.seccomp_init.restype = ctypes.c_void_p
        lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
        lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
        lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.seccomp_release.argtypes = [ctypes.c_void_p]
        ctx = lib.seccomp_init(0x7FFF0000)
        try:
            for name in ("mount", "umount2", "setns", "unshare", "ptrace", "process_vm_readv",
                         "process_vm_writev", "bpf", "perf_event_open", "keyctl", "open_by_handle_at"):
                nr = lib.seccomp_syscall_resolve_name(name.encode())
                if nr >= 0 and lib.seccomp_rule_add(ctx, 0x00050001, nr, 0) != 0:
                    raise RuntimeError("SECCOMP_RULE_FAILED")
            socket_nr = lib.seccomp_syscall_resolve_name(b"socket")
            for domain in (40, 16, 17):  # VSOCK, NETLINK and PACKET are not project HTTP.
                if lib.seccomp_rule_add(ctx, 0x00050001, socket_nr, 1, Compare(0, 4, domain, 0)) != 0:
                    raise RuntimeError("SECCOMP_SOCKET_RULE_FAILED")
            filter_fd = os.memfd_create("dream-maker-seccomp", 0)
            if lib.seccomp_export_bpf(ctx, filter_fd) != 0:
                raise RuntimeError("SECCOMP_EXPORT_FAILED")
            os.lseek(filter_fd, 0, os.SEEK_SET)
        finally:
            lib.seccomp_release(ctx)
        canary = subprocess.Popen(["sleep", "120"], env={"PATH": "/usr/bin:/bin"})
        args = ["bwrap", "--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session",
                "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
                "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
                "--tmpfs", "/usr/lib/modules", "--tmpfs", "/lib/modules", "--proc", "/proc",
                "--dev", "/dev", "--size", "33554432", "--tmpfs", "/tmp",
                "--ro-bind", str(source), "/source", "--bind", str(work), "/workspace",
                "--bind", str(output), "/output", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin",
                "--setenv", "HOME", "/tmp", "--chdir", "/workspace", "--seccomp", str(filter_fd)]

        def run(name, code, timeout=8):
            os.lseek(filter_fd, 0, os.SEEK_SET)
            def enter():
                (group / "cgroup.procs").write_text(str(os.getpid()))
                resource.setrlimit(resource.RLIMIT_FSIZE, (1048576, 1048576))
                resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
                resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
                os.setgroups([])
                os.setgid(34271)
                os.setuid(34271)
            with tempfile.TemporaryFile(dir=base) as stdout, tempfile.TemporaryFile(dir=base) as stderr:
                child = subprocess.Popen(args + ["python3", "-c", code], preexec_fn=enter,
                                         env={"PATH": "/usr/bin:/bin", "DM_SECRET_CANARY": "OUTER_ONLY"},
                                         pass_fds=(filter_fd,), stdout=stdout, stderr=stderr)
                timed_out = False
                try:
                    child.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    (group / "cgroup.kill").write_text("1")
                    child.wait(timeout=5)
                # A completed namespace must not leave detached descendants behind.
                (group / "cgroup.kill").write_text("1")
                for _ in range(50):
                    if not (group / "cgroup.procs").read_text().strip():
                        break
                    time.sleep(.02)
                stdout.seek(0)
                stderr.seek(0)
                item = {"name": name, "exitCode": child.returncode, "timedOut": timed_out,
                        "stdout": stdout.read(1048576).decode(errors="replace"),
                        "stderr": stderr.read(1048576).decode(errors="replace"),
                        "remainingOwnedPids": (group / "cgroup.procs").read_text().split(),
                        "unrelatedCanaryAlive": canary.poll() is None}
                report["results"].append(item)
                return item

        boundary = run("filesystem-secrets-management-network", r'''
import os, socket, pathlib, subprocess, json
assert os.getuid() == 34271
assert 'DM_SECRET_CANARY' not in os.environ
for p in ['/mnt/c','/mnt/wsl','/mnt/wslg','/init','/run','/sys','/root','/opt','/var/run/docker.sock']:
    assert not pathlib.Path(p).exists(), p
assert pathlib.Path('/source/frozen.txt').read_text() == 'frozen-source-canary\n'
try:
    pathlib.Path('/source/frozen.txt').write_text('changed')
    raise AssertionError('source was writable')
except OSError: pass
pathlib.Path('/workspace/own.txt').write_text('own workspace')
pathlib.Path('/output/own.txt').write_text('own output')
for family in [socket.AF_VSOCK, socket.AF_NETLINK, socket.AF_PACKET]:
    try:
        socket.socket(family, socket.SOCK_STREAM)
        raise AssertionError('management socket accessible')
    except OSError: pass
s = socket.socket(); s.settimeout(.3)
try:
    s.connect(('1.1.1.1',443))
    raise AssertionError('external network accessible')
except OSError: pass
assert subprocess.run(['unshare','--user','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0
status = pathlib.Path('/proc/self/status').read_text()
assert 'CapEff:\t0000000000000000' in status
assert 'NoNewPrivs:\t1' in status
assert 'Seccomp:\t2' in status
print(json.dumps({'uid':os.getuid(),'status':status,'mounts':pathlib.Path('/proc/mounts').read_text(),'PASS':True}))
''')
        memory = run("memory-limit", "x = bytearray(900 * 1024 * 1024); print('UNEXPECTED_ALLOCATION')")
        memory_events = (group / "memory.events").read_text()
        pids = run("pid-limit", "import subprocess,time\nchildren=[]\ntry:\n for _ in range(80): children.append(subprocess.Popen(['sleep','30']))\nexcept OSError:\n print('PID_LIMIT_ENFORCED',len(children))\nfinally:\n for p in children: p.terminate()\n for p in children: p.wait()")
        timeout = run("timeout-grandchild-cleanup", "import subprocess,time\np=subprocess.Popen(['sh','-c','sleep 60 & wait'])\ntime.sleep(60)", timeout=1)
        source_unchanged = hashlib.sha256((source / "frozen.txt").read_bytes()).hexdigest() == hashlib.sha256(b"frozen-source-canary\n").hexdigest()
        report["memoryEvents"] = memory_events
        report["pidEvents"] = (group / "pids.events").read_text()
        report["sourceUnchanged"] = source_unchanged
        report["allProbesPassed"] = (boundary["exitCode"] == 0 and '"PASS": true' in boundary["stdout"]
            and memory["exitCode"] != 0 and "UNEXPECTED_ALLOCATION" not in memory["stdout"]
            and "PID_LIMIT_ENFORCED" in pids["stdout"] and timeout["timedOut"] and source_unchanged
            and all(not r["remainingOwnedPids"] and r["unrelatedCanaryAlive"] for r in report["results"]))
    finally:
        if filter_fd is not None:
            os.close(filter_fd)
        if canary:
            canary.terminate()
            canary.wait(timeout=5)
        if group.exists():
            (group / "cgroup.kill").write_text("1")
            for _ in range(50):
                try:
                    group.rmdir()
                    break
                except OSError:
                    time.sleep(.02)
        for p in reversed(mounted):
            subprocess.run(["umount", str(p)], check=True)
        current = (cgroot / "cgroup.subtree_control").read_text().split()
        if current != before and not any(p.is_dir() for p in cgroot.iterdir()):
            (cgroot / "cgroup.subtree_control").write_text(" ".join("-" + c for c in current if c not in before))
        report["cgroupDelegationAfter"] = (cgroot / "cgroup.subtree_control").read_text().split()
        report["resourceGroupRemoved"] = not group.exists()
        report["resourceDelegationRestored"] = report["cgroupDelegationAfter"] == before
    print(json.dumps(report))
    return 0 if report.get("allProbesPassed") and report["resourceDelegationRestored"] and report["resourceGroupRemoved"] else 1


if __name__ == "__main__":
    if os.name == "nt":
        if len(sys.argv) != 2:
            raise SystemExit("Explicit evidence output required")
        result = subprocess.run(["wsl.exe", "-d", DISTRO, "--exec", "python3", "-", Path(sys.argv[1]).stem],
                                input=Path(__file__).read_bytes(), capture_output=True, timeout=90)
        output = Path(sys.argv[1])
        with output.open("xb") as f:
            f.write(result.stdout)
        with Path(str(output) + ".stderr").open("xb") as f:
            f.write(result.stderr)
        print(json.dumps({"exitCode": result.returncode, "evidence": str(output.resolve()),
                          "stderrBytes": len(result.stderr), "modelCalls": 0}))
        raise SystemExit(result.returncode)
    raise SystemExit(linux_probe())
