#!/usr/bin/python3
"""Process lifecycle fixture, NOT an isolation oracle.

Copy into a private directory, chmod 0755, write scenario.txt alongside it.
State/log files live in that directory. No Docker daemon is contacted.
"""
import json
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parent
scenario = (root / "scenario.txt").read_text().strip()
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
state = root / "container.json"
container_id = "c" * 64


def hang():
    child = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(60)"])
    (root / "child.pid").write_text(str(child.pid))
    print("ready", flush=True)
    time.sleep(60)


if args[:2] == ["image", "inspect"]:
    if scenario == "image-hang":
        hang()
    if scenario == "image-fail":
        sys.exit(1)
    print("sha256:" + "a" * 64)
elif args[0] == "create":
    name = args[args.index("--name") + 1]
    state.write_text(json.dumps({"name": name, "id": container_id}))
    if scenario == "create-hang":
        hang()
    print(container_id)
elif args[0] == "start":
    if scenario == "orphan-pipes":
        child = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(60)"])
        (root / "child.pid").write_text(str(child.pid))
        print("supervisor-exited", flush=True)
        sys.exit(0)
    if scenario in ("hang", "cancel", "cleanup-fail"):
        hang()
    elif scenario == "flood":
        sys.stdout.buffer.write(b"x" * 40000)
        sys.stdout.flush()
        time.sleep(60)
    elif scenario == "raw":
        sys.stdout.buffer.write(b"\xff\xf0\x9f")
        sys.stdout.flush()
        time.sleep(0.01)
        sys.stdout.buffer.write(b"\x98\x80")
    else:
        sys.stdout.buffer.write(sys.stdin.buffer.read())
        sys.stderr.write("fixture diagnostic\n")
        sys.exit(7 if scenario == "nonzero" else 0)
elif args[0] == "rm":
    if scenario == "cleanup-fail":
        sys.exit(1)
    if state.exists():
        state.unlink()
        print(args[-1])
    else:
        sys.exit(1)
elif args[:2] == ["container", "ls"]:
    if state.exists():
        print(container_id)
else:
    sys.stderr.write("unrecognized fake Docker invocation\n")
    sys.exit(2)
