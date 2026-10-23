#!/usr/bin/env python3
"""Validate and repair DSH session logs against the v4 loader state machine.

The spine plugin once published context events outside an open step (or with
their origin's stale turn/step), which the persistence worker accepted at
write time but the loader rejects at read time:

    stored log is corrupt: SessionFormatError: developer/message does not
    match an open turn and step

This tool mirrors the loader rules (dsh-session-format-v3-to-v4
``restoreReleasedV4Artifact``: coordinate admission, turn/step sequencing,
tool-call pairing, surface replacement ranges), deletes exactly the illegal
plugin-derived events (``source.kind: spine-context`` carriers/copies and
coordinate-carrying copies that do not match the open step), renumbers the
remaining events and every seq reference (seq, surfaceOp start/endSeq,
sourceEventSeqs, data.headerSeq, data.messageSeqs), and iterates to a
fixpoint that validates. Originals are backed up; the new log is written
atomically after zstd compression.

Usage:
    python3 scripts/dsh-v4-session-doctor.py --check  [roots...]   # report only
    python3 scripts/dsh-v4-session-doctor.py --repair <file.zst>... # repair in place
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

SPINE_SOURCE_KIND = "spine-context"
COORD_TYPES = {
    "system/message",
    "developer/message",
    "assistant/message",
    "tool/result",
    "tool/call",
    "assistant/attempt",
}
SURFACE_TYPES = {
    "system/message",
    "user/message",
    "developer/message",
    "assistant/message",
    "tool/result",
}
STEP_EVENT_TYPES = {"system/message", "developer/message", "assistant/attempt"}


class Violation(Exception):
    pass


def flat_seqs(value):
    out = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, list):
            out.extend(range(item[0], item[-1] + 1))
        else:
            out.append(item)
    return out


def is_spine_context(event):
    data = event.get("data") or {}
    message = data.get("message") or {}
    source = message.get("source") or data.get("source") or {}
    return source.get("kind") == SPINE_SOURCE_KIND


class Machine:
    """One pass of the loader's rules, collecting every violation."""

    def __init__(self, events):
        self.events = events
        self.violations = []  # (seq, kind, message)
        self.run()

    def run(self):
        turn = None
        step = None
        next_turn = 1
        next_step = 1
        tools = {}
        surface = []
        protected_head = None

        def note(seq, kind, message):
            self.violations.append((seq, kind, message))

        def coord_ok(data):
            return (
                turn is not None
                and step is not None
                and data.get("turn") == turn
                and data.get("step") == step
            )

        for event in self.events:
            if event.get("type") == "session":
                continue
            seq = event.get("seq")
            etype = event.get("type")
            data = event.get("data") or {}
            sop = event.get("surfaceOp")

            if etype in SURFACE_TYPES:
                if etype == "system/message" and surface and protected_head is None:
                    note(seq, "surface", "system/message requires a protected first surface head")
                if sop == "append":
                    if etype == "system/message" and not surface:
                        protected_head = seq
                    surface.append(seq)
                elif isinstance(sop, dict) and sop.get("op") == "replace":
                    try:
                        first = surface.index(sop["startSeq"])
                        last = surface.index(sop["endSeq"])
                    except (ValueError, KeyError):
                        note(seq, "surface", f"replacement range {sop} not on current surface")
                        first = last = -1
                    if first >= 0 and last >= first:
                        removed = surface[first : last + 1]
                        sources = flat_seqs(event.get("sourceEventSeqs", []))
                        if any(node not in sources for node in removed):
                            note(seq, "surface", "replacement sourceEventSeqs omit a shadowed node")
                        surface[first : last + 1] = [seq]

            if etype in STEP_EVENT_TYPES and not coord_ok(data):
                note(seq, "coord", f"{etype} does not match open turn/step")

            if etype == "turn/start":
                if turn is not None or data.get("turn") != next_turn:
                    note(seq, "marker", "turn/start does not open the expected turn")
                turn = data.get("turn", next_turn)
                next_step = 1
                tools.clear()
            elif etype == "turn/end":
                if turn is None or data.get("turn") != turn or step is not None:
                    note(seq, "marker", "turn/end does not match the open turn")
                if tools:
                    note(seq, "tools", f"turn/end leaves unresolved tool call {next(iter(tools))}")
                turn = None
                next_turn += 1
            elif etype == "step/start":
                if (
                    turn is None
                    or data.get("turn") != turn
                    or step is not None
                    or data.get("step") != next_step
                ):
                    note(seq, "marker", "step/start does not match the open turn and next step")
                step = data.get("step", next_step)
            elif etype == "step/end":
                if not coord_ok(data):
                    note(seq, "coord", "step/end does not match open turn/step")
                if tools:
                    note(seq, "tools", f"step/end leaves unresolved tool call {next(iter(tools))}")
                step = None
                next_step += 1
            elif etype == "assistant/message":
                if not coord_ok(data):
                    note(seq, "coord", "assistant/message does not match open turn/step")
                for block in (data.get("message") or {}).get("content") or []:
                    if block.get("type") != "tool-call":
                        continue
                    call_id = block.get("id")
                    if call_id in tools:
                        note(seq, "tools", f"assistant/message repeats tool call {call_id}")
                    tools[call_id] = False
            elif etype == "tool/call":
                if not coord_ok(data):
                    note(seq, "coord", "tool/call does not match open turn/step")
                pending = tools.get(data.get("callId"))
                if pending is None or pending is True:
                    note(seq, "tools", "tool/call does not match one advertised tool call")
                elif pending is False:
                    tools[data["callId"]] = True
            elif etype == "tool/result":
                if sop != "append":
                    if turn is None:
                        note(seq, "coord", "tool/result replacement outside an open turn")
                    continue
                if not coord_ok(data):
                    note(seq, "coord", "tool/result does not match open turn/step")
                call_id = (data.get("message") or {}).get("toolCallId")
                if call_id not in tools:
                    note(seq, "tools", f"tool/result {call_id} has no advertised tool call")
                else:
                    tools.pop(call_id)
            elif etype == "request/header":
                if turn is None:
                    note(seq, "coord", "request/header outside an open turn")


def load_lines(path: Path):
    raw = subprocess.run(["zstd", "-dc", str(path)], capture_output=True, check=True).stdout
    events = []
    dropped = 0
    for line in raw.decode(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            dropped += 1
    return events, dropped


def validate(events) -> None:
    machine = Machine(events)
    if machine.violations:
        head = "; ".join(f"seq {seq}: {message}" for seq, _kind, message in machine.violations[:3])
        raise Violation(head)


def renumber(events):
    mapping = {}
    new = 0
    for event in events:
        old = event.get("seq")
        if old is None:
            continue  # the session header line carries no seq
        mapping[old] = new
        event["seq"] = new
        new += 1

    def mapseq(value):
        return mapping.get(value, value)

    for event in events:
        sop = event.get("surfaceOp")
        if isinstance(sop, dict):
            for key in ("startSeq", "endSeq"):
                if key in sop:
                    sop[key] = mapseq(sop[key])
        if "sourceEventSeqs" in event:
            event["sourceEventSeqs"] = [
                [mapseq(item[0]), mapseq(item[-1])] if isinstance(item, list) else mapseq(item)
                for item in event["sourceEventSeqs"]
            ]
        data = event.get("data") or {}
        if "headerSeq" in data:
            data["headerSeq"] = mapseq(data["headerSeq"])
        if isinstance(data.get("messageSeqs"), list):
            data["messageSeqs"] = [mapseq(s) for s in data["messageSeqs"]]


def repair(events):
    """Iteratively delete illegal plugin-derived events until the log validates."""
    for _ in range(40):
        machine = Machine(events)
        if not machine.violations:
            return events
        by_seq = {event.get("seq"): event for event in events}
        to_delete = set()
        for seq, kind, _msg in machine.violations:
            event = by_seq.get(seq)
            if event is None:
                continue
            if kind == "coord" and event.get("type") in COORD_TYPES:
                if is_spine_context(event) or event.get("type") in (
                    "assistant/message",
                    "tool/result",
                    "tool/call",
                ):
                    # Plugin replay copies carry foreign coordinates; host
                    # events never do. Delete plugin-shaped offenders only.
                    to_delete.add(seq)
            elif kind == "surface" and is_spine_context(event):
                to_delete.add(seq)
        if not to_delete:
            # Marker/tool violations we cannot attribute to the plugin: try
            # deleting the spine-context events involved, else give up.
            for seq, kind, _msg in machine.violations:
                event = by_seq.get(seq)
                if event is not None and (is_spine_context(event) or kind == "tools"):
                    to_delete.add(seq)
        if not to_delete:
            raise Violation(f"unrepairable: {machine.violations[0][2]}")
        events = [event for event in events if event.get("seq") not in to_delete]
        renumber(events)
    raise Violation("repair did not converge")


def write_repaired(target: Path, events, stamp: str) -> Path:
    backup = target.with_name(target.name + f".bak-{stamp}")
    shutil.copy2(target, backup)
    tmp = target.with_name(target.name + f".tmp-{stamp}")
    payload = "".join(
        json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n" for event in events
    )
    tmp.write_text(payload, encoding="utf-8")
    subprocess.run(["zstd", "-q", "-f", "-o", str(target), str(tmp)], check=True)
    tmp.unlink()
    return backup


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="report only")
    mode.add_argument("--repair", action="store_true", help="repair given session.v4.jsonl.zstd files")
    parser.add_argument("paths", nargs="+", help="session dirs (check) or .zst files (repair)")
    args = parser.parse_args()

    stamp = time.strftime("%Y%m%d-%H%M%S")
    failures = 0
    if args.check:
        targets = []
        for raw in args.paths:
            root = Path(raw)
            targets.extend(sorted(root.glob("*/*/session.v4.jsonl.zstd")))
            targets.extend(sorted(root.glob("*/session.v4.jsonl.zstd")))
        for target in targets:
            try:
                events, _dropped = load_lines(target)
                validate(events)
                print(f"ok       {target.parent.parent.name}/{target.parent.name}")
            except (Violation, subprocess.CalledProcessError, json.JSONDecodeError) as err:
                print(f"CORRUPT  {target.parent.parent.name}/{target.parent.name}: {err}")
                failures += 1
        return 1 if failures else 0

    for raw in args.paths:
        target = Path(raw)
        try:
            events, dropped = load_lines(target)
        except (subprocess.CalledProcessError, json.JSONDecodeError) as err:
            print(f"SKIP  {target.parent.name}: unreadable ({err})")
            failures += 1
            continue
        before = len(events)
        try:
            repaired = repair(events)
            validate(repaired)
        except Violation as err:
            print(f"SKIP  {target.parent.name}: {err}")
            failures += 1
            continue
        backup = write_repaired(target, repaired, stamp)
        print(
            f"FIXED {target.parent.name}: {before} -> {len(repaired)} events "
            f"(dropped {dropped} garbage lines, backup: {backup.name})"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
