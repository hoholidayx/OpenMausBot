#!/usr/bin/env python3
"""Manage the locally built OpenMausBot web server."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parent
ENTRY = ROOT / "dist-server" / "index.js"
CLI = ROOT / "dist-server" / "openmausbot.js"
STATIC = ROOT / "dist"
DATA = Path(os.environ.get("OPENMAUSBOT_DATA_DIR", str(Path.home() / ".openmausbot"))).expanduser().resolve()
LEGACY_RUN = DATA / "service"
RUN = DATA.with_name(DATA.name + "-service") if DATA.name else DATA
STATE = RUN / "process.json"
LOG = RUN / "web.log"
HTTP = build_opener(ProxyHandler({}))
# Node installs its own SIGHUP disposition at startup, including after nohup.
IGNORE_HANGUP = "data:text/javascript,process.on(%27SIGHUP%27,()%3D%3E%7B%7D)"


def node_binary():
    configured = os.environ.get("OPENMAUSBOT_NODE")
    nvm = Path.home() / ".nvm" / "versions" / "node"
    candidates = [configured] if configured else [shutil.which("node"), *(str(p) for p in nvm.glob("v*/bin/node"))]
    valid = []
    for candidate in filter(None, candidates):
        try:
            path = str(Path(candidate).resolve(strict=True))
            version = subprocess.check_output([path, "--version"], text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
            match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
            if match and int(match[1]) >= 24:
                valid.append((tuple(map(int, match.groups())), path))
        except (OSError, subprocess.SubprocessError):
            continue
    if not valid:
        raise RuntimeError("Node.js 24+ is required; set OPENMAUSBOT_NODE to its executable")
    return max(valid)[1]


def identity(pid):
    result = subprocess.run(
        ["ps", "-ww", "-p", str(pid), "-o", "lstart=", "-o", "state=", "-o", "command="],
        env={**os.environ, "LC_ALL": "C"}, capture_output=True, text=True, check=False,
    ).stdout.split(maxsplit=6)
    if len(result) != 7 or result[5].startswith("Z"):
        return None
    return {"started": " ".join(result[:5]), "command": result[6].strip()}


def load_record(path=STATE):
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    argv = record.get("argv")
    if (type(record.get("pid")) is not int or record["pid"] <= 1 or
        not isinstance(argv, list) or len(argv) != 4 or not isinstance(argv[0], str) or
        argv[1:] != ["--import", IGNORE_HANGUP, str(ENTRY)] or
        type(record.get("port")) is not int or not 1 <= record["port"] < 65535 or
        record.get("webhook_port") != record["port"] + 1 or not isinstance(record.get("identity"), dict)):
        raise RuntimeError(f"Invalid process record: {path}")
    return record


def owned(record):
    if record is None:
        return False
    current = identity(record["pid"])
    if current is None:
        return False
    if current != record["identity"] or current["command"] != " ".join(record["argv"]):
        raise RuntimeError(f"PID {record['pid']} does not belong to this OpenMausBot instance")
    return True


def prepare_runtime():
    if DATA == DATA.parent:
        raise RuntimeError("The data directory cannot be a filesystem root")
    if RUN.is_symlink():
        raise RuntimeError(f"Service directory must not be a symbolic link: {RUN}")
    if not RUN.exists() and LEGACY_RUN.exists():
        if LEGACY_RUN.is_symlink() or not LEGACY_RUN.is_dir():
            if RUN.exists():
                return prepare_runtime()
            raise RuntimeError(f"Invalid legacy service directory: {LEGACY_RUN}")
        legacy_lock = LEGACY_RUN / "process.lock"
        if legacy_lock.is_symlink() or not legacy_lock.is_file():
            if RUN.exists():
                return prepare_runtime()
            raise RuntimeError(f"Cannot verify legacy service directory: {LEGACY_RUN}")
        try:
            with legacy_lock.open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if not RUN.exists() and LEGACY_RUN.exists():
                    names = {path.name for path in LEGACY_RUN.iterdir()}
                    if names - {"process.json", "process.lock", "web.log"}:
                        raise RuntimeError(f"Unexpected files in legacy service directory: {LEGACY_RUN}")
                    if any(path.is_symlink() for path in LEGACY_RUN.iterdir()):
                        raise RuntimeError(f"Unexpected symbolic link in legacy service directory: {LEGACY_RUN}")
                    owned(load_record(LEGACY_RUN / "process.json"))
                    os.rename(LEGACY_RUN, RUN)
        except FileNotFoundError:
            if not RUN.exists():
                raise
    if RUN.is_symlink():
        raise RuntimeError(f"Service directory must not be a symbolic link: {RUN}")
    RUN.mkdir(mode=0o700, parents=True, exist_ok=True)


def write_record(record):
    pending = STATE.with_suffix(".new")
    pending.write_text(json.dumps(record, indent=2) + "\n")
    pending.replace(STATE)


def available(port):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("0.0.0.0", port))
            probe.listen(1)
            return True
        except OSError:
            return False


def listening(pid, port):
    result = subprocess.run(
        ["lsof", "-a", "-p", str(pid), f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True, check=False,
    )
    return str(pid) in result.stdout.split()


def healthy(record):
    pid, port = record["pid"], record["port"]
    if not all(listening(pid, p) for p in (port, record["webhook_port"])):
        return False
    try:
        with HTTP.open(f"http://127.0.0.1:{port}/api/health", timeout=2) as response:
            health = json.load(response)
            if response.status != 200 or health.get("app") != "openmausbot" or health.get("pid") != pid or not health.get("static"):
                return False
        with HTTP.open(f"http://127.0.0.1:{port}/", timeout=2) as response:
            if response.status != 200 or response.headers.get_content_type() != "text/html":
                return False
        with HTTP.open(f"http://127.0.0.1:{record['webhook_port']}/health", timeout=2) as response:
            return response.status == 200 and json.load(response) == {"app": "openmausbot-webhooks", "ready": True}
    except (OSError, ValueError, TypeError):
        return False


def status(record):
    if not owned(record):
        port = record["port"] if record else int(os.environ.get("OPENMAUSBOT_PORT", "8799"))
        if not 1 <= port < 65535:
            raise ValueError("OPENMAUSBOT_PORT must be between 1 and 65534")
        for p in (port, port + 1):
            if not available(p):
                raise RuntimeError(f"Port {p} is occupied by an unmanaged process")
        print("OpenMausBot Web is stopped")
        return 1
    ready = healthy(record)
    print(f"OpenMausBot Web {'healthy' if ready else 'running but unhealthy'}: http://127.0.0.1:{record['port']} (PID {record['pid']})")
    if record.get("lan"):
        print("LAN access enabled")
    print("Browser pairing required")
    print(f"Data: {DATA}\nLog: {LOG}")
    return 0 if ready else 1


def stop(record):
    if owned(record):
        pid = record["pid"]
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 30
        while owned(record):
            if time.monotonic() >= deadline:
                raise RuntimeError(f"PID {pid} did not stop; process record retained")
            time.sleep(0.2)
    STATE.unlink(missing_ok=True)
    port = record["port"] if record else int(os.environ.get("OPENMAUSBOT_PORT", "8799"))
    if not 1 <= port < 65535:
        raise ValueError("OPENMAUSBOT_PORT must be between 1 and 65534")
    for p in (port, port + 1):
        if not available(p):
            raise RuntimeError(f"Port {p} is occupied by an unmanaged process")
    print("OpenMausBot Web is stopped")
    return 0


def start(record):
    if owned(record):
        return status(record)
    port = int(os.environ.get("OPENMAUSBOT_PORT", "8799"))
    if not 1 <= port < 65535:
        raise ValueError("OPENMAUSBOT_PORT must be between 1 and 65534")
    lan = os.environ.get("OPENMAUSBOT_LAN", "1")
    if lan not in ("0", "1"):
        raise ValueError("OPENMAUSBOT_LAN must be 0 or 1")
    for p in (port, port + 1):
        if not available(p):
            raise RuntimeError(f"Port {p} is occupied; refusing to start")
    if not ENTRY.is_file() or not CLI.is_file() or not (STATIC / "index.html").is_file():
        raise RuntimeError("Build the Web UI and server first: pnpm build && pnpm build:server")
    argv = [node_binary(), "--import", IGNORE_HANGUP, str(ENTRY)]
    env = {**os.environ, "OMB_DATA_DIR": str(DATA), "OMB_PORT": str(port), "OMB_WEBHOOK_PORT": str(port + 1),
           "OMB_STATIC_DIR": str(STATIC), "OMB_SKILLS_DIR": str(ROOT / "skills"), "OMB_LAN": lan}
    env.pop("OMB_WEBHOOK_SOCKET", None)
    codex_path = Path("/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path")
    if codex_path.is_dir() and not shutil.which("codex", path=env.get("PATH")):
        env["PATH"] = f"{env.get('PATH', '')}{os.pathsep}{codex_path}"
    with LOG.open("ab") as output:
        child = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    record = None
    try:
        current = identity(child.pid)
        if current is None or current["command"] != " ".join(argv):
            raise RuntimeError("Could not verify the launched server's identity")
        record = {"pid": child.pid, "identity": current, "argv": argv, "port": port,
                  "webhook_port": port + 1, "lan": lan == "1", "log": str(LOG)}
        write_record(record)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline and child.poll() is None:
            if healthy(record):
                return status(record)
            time.sleep(0.25)
        raise RuntimeError(f"Server did not become healthy; see {LOG}")
    except BaseException:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                raise RuntimeError(f"Server PID {child.pid} did not stop; process record retained")
        if record is not None:
            STATE.unlink(missing_ok=True)
        raise


def pair(record):
    if not owned(record) or not healthy(record):
        raise RuntimeError("Start the healthy server before creating a browser sign-in link")
    return subprocess.run([record["argv"][0], str(CLI), "pair", "--port", str(record["port"]),
                           "--data-dir", str(DATA)], cwd=ROOT, check=False).returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "stop", "restart", "status", "pair"))
    action = parser.parse_args().action
    os.umask(0o077)
    prepare_runtime()
    with (RUN / "process.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = load_record()
        if record is not None and record.get("log") == str(LEGACY_RUN / "web.log"):
            record["log"] = str(LOG)
            write_record(record)
        if action == "restart":
            stop(record)
            return start(None)
        return {"start": start, "stop": stop, "status": status, "pair": pair}[action](record)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(f"OpenMausBot Web: {error}")
