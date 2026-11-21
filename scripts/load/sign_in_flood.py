#!/usr/bin/env python3
"""Floods a citadel-server with wrong sign-ins and checks it stays usable.

Run with the standard library only, isolated:

    python3 -I scripts/load/sign_in_flood.py --server target/release/citadel-server

Each scenario starts the server with a scratch state directory, creates an
administrator with `users add --admin --password-stdin`, and attacks it from
127.0.0.1 while a legitimate administrator signs in from other loopback
addresses (Linux routes all of 127.0.0.0/8 to the loopback interface):

  burst      64 wrong sign-ins for the administrator at once, from one address
  sustained  30 s of wrong sign-ins cycling usernames, from one address
  spoofed    30 s of wrong sign-ins cycling usernames, each with a made-up
             X-Forwarded-For, sent directly (the peer isn't a trusted proxy)
  botnet     30 s of wrong sign-ins for the administrator from 1,000
             addresses named by X-Forwarded-For through a trusted proxy on
             this machine

Every 100 ms it samples the server's CPU (/proc/<pid>/stat) and memory
(/proc/<pid>/status VmRSS and VmHWM) and polls /api/health. Every 2 s it signs
in correctly from a second client twice: as a known device (with the cookie
an earlier sign-in set) and as a new device.

Pass: RSS stays under 150 MB, health answers 200 every time, the known device
always gets in, the new device is always answered (in, or told to retry
within 30 s), and the server averages at most 2 cores over the attack. The
password-checking threads' own share is reported beside it. Exits 1 on any
miss.
"""

import argparse
import http.client
import json
import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time

ADMIN = "admin"
PASSWORD = "the administrator's password"
ATTACKER = "127.0.0.1"
KNOWN_DEVICE = "127.0.0.2"
NEW_DEVICE = "127.0.0.3"
ATTACK_SECONDS = 30
BURST_WATCH_SECONDS = 12
SAMPLE_INTERVAL = 0.1
LEGITIMATE_INTERVAL = 2.0
ATTACK_CONNECTIONS = 64
BOTNET_SIZE = 1000

RSS_LIMIT_MB = 150
CPU_LIMIT_CORES = 2.0
RETRY_LIMIT_SECONDS = 30

SCENARIOS = {
    # name: (description, trusted proxies or None for the default)
    "burst": ("64 concurrent wrong sign-ins, one address", None),
    "sustained": ("30 s flood cycling usernames, one address", None),
    "spoofed": (
        "30 s flood cycling usernames with spoofed X-Forwarded-For, sent directly",
        "192.0.2.1/32",
    ),
    "botnet": (
        "30 s flood on the administrator from 1,000 X-Forwarded-For addresses via a trusted proxy",
        "127.0.0.1/32",
    ),
}


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Server:
    def __init__(self, binary, trusted_proxies):
        self.directory = tempfile.mkdtemp(prefix="citadel-flood-")
        self.port = free_port()
        self.origin = f"http://127.0.0.1:{self.port}"
        self.environment = {
            key: value for key, value in os.environ.items() if not key.startswith("CITADEL_")
        }
        self.environment.update(
            {
                "CITADEL_LISTEN": f"127.0.0.1:{self.port}",
                "CITADEL_OPDS_PORT": str(free_port()),
                "CITADEL_STATE_DIRECTORY": os.path.join(self.directory, "state"),
                "CITADEL_UPDATE_CHECK": "false",
            }
        )
        if trusted_proxies:
            self.environment["CITADEL_TRUSTED_PROXIES"] = trusted_proxies
        added = subprocess.run(
            [binary, "users", "add", ADMIN, "--admin", "--password-stdin"],
            input=PASSWORD + "\n",
            env=self.environment,
            capture_output=True,
            text=True,
        )
        if added.returncode != 0:
            raise SystemExit(f"could not add the administrator: {added.stderr}")
        self.process = subprocess.Popen(
            [binary],
            env=self.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                status, _, _ = request(ATTACKER, self.port, "GET", "/api/health", timeout=1)
                if status == 200:
                    return
            except OSError:
                pass
            time.sleep(0.1)
        self.stop()
        raise SystemExit("the server did not start")

    def stop(self):
        self.process.terminate()
        try:
            self.process.wait(10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        subprocess.run(["rm", "-rf", self.directory], check=False)


def request(source, port, method, path, body=None, headers=None, timeout=35, connection=None):
    """One HTTP request from `source`; returns (status, headers, body)."""
    own = connection is None
    if own:
        connection = http.client.HTTPConnection(
            "127.0.0.1", port, timeout=timeout, source_address=(source, 0)
        )
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        return response.status, response.msg, data
    finally:
        if own:
            connection.close()


def sign_in_request(server, username, password, extra=None):
    headers = {
        "Content-Type": "application/json",
        "Origin": server.origin,
    }
    headers.update(extra or {})
    body = json.dumps({"username": username, "password": password})
    return body, headers


def device_cookie(response_headers):
    for value in response_headers.get_all("Set-Cookie") or []:
        pair = value.split(";", 1)[0]
        if pair.startswith("citadel_device="):
            return pair
    return None


class Monitor:
    """Samples CPU, memory and health, and makes the legitimate sign-ins."""

    def __init__(self, server, cookie):
        self.server = server
        self.cookie = cookie
        self.stop = threading.Event()
        self.cpu = []  # (seconds since start, cores)
        self.verifier_cpu = []  # the same, for the password-checking threads
        self.rss = []
        self.hwm = 0
        self.health = []
        self.known = []
        self.new = []
        self.ticks = os.sysconf("SC_CLK_TCK")
        self.threads = [
            threading.Thread(target=self.sample, daemon=True),
            threading.Thread(target=self.poll_health, daemon=True),
            threading.Thread(target=self.sign_in, daemon=True),
        ]

    def start(self):
        self.started = time.monotonic()
        for thread in self.threads:
            thread.start()

    def finish(self):
        self.stop.set()
        for thread in self.threads:
            thread.join(40)

    def proc(self):
        pid = self.server.process.pid
        with open(f"/proc/{pid}/stat") as stat:
            fields = stat.read().rsplit(")", 1)[1].split()
        cpu = (int(fields[11]) + int(fields[12])) / self.ticks
        verifier = 0.0
        for task in os.listdir(f"/proc/{pid}/task"):
            try:
                with open(f"/proc/{pid}/task/{task}/comm") as comm:
                    if not comm.read().startswith("citadel-verify"):
                        continue
                with open(f"/proc/{pid}/task/{task}/stat") as stat:
                    thread = stat.read().rsplit(")", 1)[1].split()
                verifier += (int(thread[11]) + int(thread[12])) / self.ticks
            except OSError:
                continue
        memory = {"verifier": verifier}
        with open(f"/proc/{pid}/status") as status:
            for line in status:
                key, _, value = line.partition(":")
                if key in ("VmRSS", "VmHWM"):
                    memory[key] = int(value.split()[0]) / 1024
        return cpu, memory

    def sample(self):
        last_cpu, last_memory = self.proc()
        last_verifier = last_memory["verifier"]
        last = time.monotonic()
        while not self.stop.wait(SAMPLE_INTERVAL):
            try:
                cpu, memory = self.proc()
            except OSError:
                return
            now = time.monotonic()
            self.cpu.append((now - self.started, (cpu - last_cpu) / (now - last)))
            self.verifier_cpu.append(
                (now - self.started, (memory["verifier"] - last_verifier) / (now - last))
            )
            last_cpu, last, last_verifier = cpu, now, memory["verifier"]
            self.rss.append(memory["VmRSS"])
            self.hwm = max(self.hwm, memory["VmHWM"])

    def poll_health(self):
        while not self.stop.is_set():
            started = time.monotonic()
            try:
                status, _, _ = request(
                    KNOWN_DEVICE, self.server.port, "GET", "/api/health", timeout=5
                )
            except OSError as error:
                status = f"error: {error.__class__.__name__}"
            self.health.append(status)
            self.stop.wait(max(0, SAMPLE_INTERVAL - (time.monotonic() - started)))

    def attempt(self, source, extra):
        body, headers = sign_in_request(self.server, ADMIN, PASSWORD, extra)
        started = time.monotonic()
        try:
            status, response_headers, _ = request(
                source, self.server.port, "POST", "/api/session", body, headers
            )
            retry = response_headers.get("Retry-After")
            return status, retry, time.monotonic() - started
        except OSError as error:
            return f"error: {error.__class__.__name__}", None, time.monotonic() - started

    def sign_in(self):
        while not self.stop.wait(LEGITIMATE_INTERVAL):
            extra = {"Cookie": self.cookie} if self.cookie else {}
            self.known.append(self.attempt(KNOWN_DEVICE, extra))
            self.new.append(self.attempt(NEW_DEVICE, {}))


def attack_worker(server, stop, statuses, next_guess, scenario):
    connection = None
    while not stop.is_set():
        guess = next_guess()
        extra = {}
        if scenario == "botnet":
            username = ADMIN
            index = guess % BOTNET_SIZE
            # Spread over many /24s, as a botnet's addresses are.
            extra["X-Forwarded-For"] = f"{11 + index % 200}.{index // 200}.{guess % 7}.{index % 250 + 1}"
        elif scenario == "spoofed":
            username = f"user{guess}"
            extra["X-Forwarded-For"] = ".".join(str(random.randint(1, 254)) for _ in range(4))
        else:
            username = f"user{guess}"
        body, headers = sign_in_request(server, username, f"wrong {guess}", extra)
        try:
            if connection is None:
                connection = http.client.HTTPConnection(
                    "127.0.0.1", server.port, timeout=35, source_address=(ATTACKER, 0)
                )
            status, response_headers, _ = request(
                ATTACKER, server.port, "POST", "/api/session", body, headers,
                connection=connection,
            )
            if response_headers.get("Connection", "").lower() == "close":
                connection.close()
                connection = None
        except (OSError, http.client.HTTPException) as error:
            status = f"error: {error.__class__.__name__}"
            if connection is not None:
                connection.close()
            connection = None
        statuses.append(status)


def burst(server, statuses):
    barrier = threading.Barrier(64)

    def one(guess):
        body, headers = sign_in_request(server, ADMIN, f"wrong {guess}")
        barrier.wait()
        try:
            status, _, _ = request(ATTACKER, server.port, "POST", "/api/session", body, headers)
        except OSError as error:
            status = f"error: {error.__class__.__name__}"
        statuses.append(status)

    threads = [threading.Thread(target=one, args=(guess,)) for guess in range(64)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


def run(binary, name):
    description, proxies = SCENARIOS[name]
    server = Server(binary, proxies)
    try:
        # The known device signed in before the attack began.
        body, headers = sign_in_request(server, ADMIN, PASSWORD)
        status, response_headers, _ = request(
            KNOWN_DEVICE, server.port, "POST", "/api/session", body, headers
        )
        if status != 200:
            raise SystemExit(f"{name}: the administrator could not sign in first ({status})")
        cookie = device_cookie(response_headers)
        monitor = Monitor(server, cookie)
        monitor.start()
        statuses = []
        started = time.monotonic()
        if name == "burst":
            burst(server, statuses)
            time.sleep(max(0, BURST_WATCH_SECONDS - (time.monotonic() - started)))
        else:
            stop = threading.Event()
            counter = iter(range(10**9))
            lock = threading.Lock()

            def next_guess():
                with lock:
                    return next(counter)

            workers = [
                threading.Thread(
                    target=attack_worker,
                    args=(server, stop, statuses, next_guess, name),
                    daemon=True,
                )
                for _ in range(ATTACK_CONNECTIONS)
            ]
            for worker in workers:
                worker.start()
            time.sleep(ATTACK_SECONDS)
            stop.set()
            for worker in workers:
                worker.join(40)
        attack_seconds = time.monotonic() - started
        monitor.finish()
    finally:
        server.stop()
    return summarise(name, description, cookie is not None, statuses, attack_seconds, monitor)


def summarise(name, description, has_cookie, statuses, seconds, monitor):
    def share(results, good):
        return sum(1 for result in results if good(result)) / max(1, len(results))

    def answered(result):
        status, retry, _ = result
        if status == 200:
            return True
        if status in (429, 503) and retry is not None:
            try:
                return int(retry) <= RETRY_LIMIT_SECONDS
            except ValueError:
                return False
        return False

    attack_window = [cores for at, cores in monitor.cpu if at <= seconds]
    mean_cpu = sum(attack_window) / max(1, len(attack_window))
    verifier_window = [cores for at, cores in monitor.verifier_cpu if at <= seconds]
    verifier_cpu = sum(verifier_window) / max(1, len(verifier_window))
    # The busiest second.
    peak_cpu = max(
        (
            sum(attack_window[index : index + 10]) / len(attack_window[index : index + 10])
            for index in range(max(1, len(attack_window) - 9))
        ),
        default=0.0,
    )
    counts = {}
    for status in statuses:
        counts[status] = counts.get(status, 0) + 1
    result = {
        "scenario": name,
        "description": description,
        "attempts": len(statuses),
        "attempt_statuses": counts,
        "rate_per_second": len(statuses) / seconds,
        "peak_rss_mb": max(monitor.rss, default=0),
        "vm_hwm_mb": monitor.hwm,
        "mean_cpu_cores": mean_cpu,
        "peak_cpu_cores_1s": peak_cpu,
        "verifier_cpu_cores": verifier_cpu,
        "health_ok": share(monitor.health, lambda status: status == 200),
        "health_polls": len(monitor.health),
        "known_device_ok": share(monitor.known, lambda result: result[0] == 200),
        "known_device_attempts": len(monitor.known),
        "known_device_had_cookie": has_cookie,
        "new_device_answered": share(monitor.new, answered),
        "new_device_in": share(monitor.new, lambda result: result[0] == 200),
        "new_device_attempts": len(monitor.new),
        "slowest_legitimate_seconds": max(
            (result[2] for result in monitor.known + monitor.new), default=0
        ),
        "new_device_statuses": [result[0] for result in monitor.new],
    }
    result["misses"] = [
        miss
        for miss, failed in [
            (f"RSS {result['peak_rss_mb']:.0f} MB", result["peak_rss_mb"] >= RSS_LIMIT_MB),
            (f"health {result['health_ok']:.1%}", result["health_ok"] < 1),
            (f"known device {result['known_device_ok']:.1%}", result["known_device_ok"] < 1),
            (
                f"new device answered {result['new_device_answered']:.1%}",
                result["new_device_answered"] < 1,
            ),
            (f"CPU {mean_cpu:.2f} cores", mean_cpu > CPU_LIMIT_CORES),
        ]
        if failed
    ]
    return result


def table(results, label):
    lines = [
        f"| {label} | attempts (rate) | peak RSS / VmHWM | CPU mean / busiest 1 s (verifier threads) | health 200 | known device in | new device answered (in) | slowest legit | result |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for result in results:
        lines.append(
            "| {scenario} | {attempts} ({rate:.0f}/s) | {rss:.0f} / {hwm:.0f} MB | {cpu:.2f} / {peak:.2f} ({verifier}) | {health:.1%} | {known:.1%} | {new:.1%} ({new_in:.0%}) | {slowest:.1f} s | {verdict} |".format(
                scenario=result["scenario"],
                attempts=result["attempts"],
                rate=result["rate_per_second"],
                rss=result["peak_rss_mb"],
                hwm=result["vm_hwm_mb"],
                cpu=result["mean_cpu_cores"],
                peak=result["peak_cpu_cores_1s"],
                verifier=(
                    f"{result['verifier_cpu_cores']:.2f}"
                    if result["verifier_cpu_cores"] > 0
                    else "—"
                ),
                health=result["health_ok"],
                known=result["known_device_ok"],
                new=result["new_device_answered"],
                new_in=result["new_device_in"],
                slowest=result["slowest_legitimate_seconds"],
                verdict="pass" if not result["misses"] else "MISS: " + ", ".join(result["misses"]),
            )
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--server", required=True, help="the citadel-server binary")
    parser.add_argument(
        "--scenario", action="append", choices=sorted(SCENARIOS), help="default: all"
    )
    parser.add_argument("--label", default="scenario", help="the table's first heading")
    parser.add_argument("--json", help="also write every result here")
    arguments = parser.parse_args()
    if not sys.platform.startswith("linux"):
        raise SystemExit("needs Linux: /proc and the whole of 127.0.0.0/8 on loopback")
    names = arguments.scenario or list(SCENARIOS)
    results = []
    for name in names:
        print(f"running {name}: {SCENARIOS[name][0]}", file=sys.stderr, flush=True)
        results.append(run(os.path.abspath(arguments.server), name))
    print(table(results, arguments.label))
    if arguments.json:
        with open(arguments.json, "w") as output:
            json.dump(results, output, indent=2, default=str)
    if any(result["misses"] for result in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
