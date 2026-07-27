#!/usr/bin/env python3
"""Console tester for the arriero API-proxy preemption / context-switch.

Fires a request to model A, then after a short delay a request to model B, both
concurrently, against the manager proxy. Renders a live in-terminal timeline
(elapsed clock + per-request bars + event log), then prints both answers with
their timings and a verdict on whether B preempted A.

Usage:
    python3 scripts/proxy-swap-demo.py
    python3 scripts/proxy-swap-demo.py --api http://127.0.0.1:8787 --delay 2 \
        --model-a big-slow --model-b fast-chat --max-a 400 --max-b 40
"""

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request

DEFAULT_API = "http://127.0.0.1:8787"
BAR_WIDTH = 44
EVENT_LINES = 7


class Req:
    def __init__(self, key, model, prompt, max_tokens, color):
        self.key = key
        self.model = model
        self.prompt = prompt
        self.max_tokens = max_tokens
        self.color = color
        self.sent_at = None
        self.done_at = None
        self.status = None
        self.content = ""
        self.usage = {}
        self.timings = {}
        self.error = None
        self.body = None


def fire(req, api, t0, on_event, lock):
    with lock:
        req.sent_at = time.monotonic() - t0
    on_event(f"{req.key} → request sent (model {req.model})")
    body = {
        "model": req.model,
        "messages": [{"role": "user", "content": req.prompt}],
        "max_tokens": req.max_tokens,
        "stream": False,
    }
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        api.rstrip("/") + "/v1/chat/completions",
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as resp:
            raw = resp.read()
            status = resp.status
        parsed = json.loads(raw)
        with lock:
            req.status = status
            req.body = parsed
            choice = (parsed.get("choices") or [{}])[0]
            req.content = (choice.get("message") or {}).get("content", "") or ""
            req.finish = choice.get("finish_reason")
            req.usage = parsed.get("usage") or {}
            req.timings = parsed.get("timings") or {}
    except urllib.error.HTTPError as exc:
        with lock:
            req.status = exc.code
            try:
                req.body = json.loads(exc.read())
            except Exception:  # noqa: BLE001
                req.body = None
            req.error = f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        with lock:
            req.status = 0
            req.error = str(exc)
    with lock:
        req.done_at = time.monotonic() - t0
    mark = "✓" if (req.status and 200 <= req.status < 300) else "✗"
    dur = req.done_at - req.sent_at
    on_event(f"{req.key} {mark} done in {dur:.2f}s (status {req.status})")


class Ansi:
    def __init__(self, enabled):
        self.on = enabled

    def c(self, code, text):
        return f"\033[{code}m{text}\033[0m" if self.on else text


def make_bar(req, scale, now, ansi):
    if req.sent_at is None:
        return " " * BAR_WIDTH
    end = req.done_at if req.done_at is not None else now
    left = int(BAR_WIDTH * req.sent_at / scale)
    fill = max(1, int(BAR_WIDTH * (end - req.sent_at) / scale))
    left = min(left, BAR_WIDTH)
    fill = min(fill, BAR_WIDTH - left)
    rest = BAR_WIDTH - left - fill
    bar = (" " * left) + ansi.c(req.color, "█" * fill) + ("░" * rest)
    return bar


def render(reqs, events, t0, ansi, done):
    now = time.monotonic() - t0
    scale = max(now, 0.5)
    lines = []
    lines.append(
        "  API-proxy swap test · elapsed "
        + ansi.c("1", f"{now:6.2f}s")
    )
    lines.append("")
    for req in reqs:
        if req.done_at is not None:
            dur = req.done_at - req.sent_at
            state = ansi.c("90", f"done {dur:6.2f}s")
            extra = ""
            if req.error:
                extra = ansi.c("31", "  " + req.error)
            else:
                tok = req.usage.get("completion_tokens")
                tps = req.timings.get("predicted_per_second")
                bits = [f"{req.status}"]
                if tok is not None:
                    bits.append(f"{tok} tok")
                if tps is not None:
                    bits.append(f"{tps:.0f} tok/s")
                bits.append(f"{len(req.content)} ch")
                extra = ansi.c("90", "  " + " · ".join(bits))
        elif req.sent_at is not None:
            state = ansi.c("93" if req.key == "A" else "94", f"live {now - req.sent_at:6.2f}s")
            extra = ""
        else:
            state = ansi.c("90", "waiting      ")
            extra = ""
        label = ansi.c(req.color, f"{req.key} {req.model}")
        lines.append(f"  {label:<28} [{state}] {make_bar(req, scale, now, ansi)}{extra}")
    lines.append("")
    lines.append(ansi.c("90", "  events"))
    shown = events[-EVENT_LINES:]
    for ev in shown:
        lines.append("    " + ev)
    for _ in range(EVENT_LINES - len(shown)):
        lines.append("")
    return lines


def run(args):
    ansi = Ansi(sys.stdout.isatty() and not args.no_color)
    reqs = [
        Req("A", args.model_a, args.prompt_a, args.max_a, "33"),
        Req("B", args.model_b, args.prompt_b, args.max_b, "34"),
    ]
    by_key = {r.key: r for r in reqs}
    events = []
    lock = threading.Lock()
    t0 = time.monotonic()

    def on_event(msg):
        with lock:
            events.append(f"+{time.monotonic() - t0:5.2f}s  {msg}")

    on_event("test started")
    threads = []
    ta = threading.Thread(target=fire, args=(by_key["A"], args.api, t0, on_event, lock))
    ta.start()
    threads.append(ta)

    def fire_b():
        tb = threading.Thread(target=fire, args=(by_key["B"], args.api, t0, on_event, lock))
        tb.start()
        threads.append(tb)

    timer = threading.Timer(args.delay, fire_b)
    timer.start()

    live = sys.stdout.isatty()
    printed = 0
    if live:
        sys.stdout.write("\033[?25l")

    def all_done():
        return all(r.done_at is not None for r in reqs) and len(threads) == 2

    last_event_count = 0
    try:
        while True:
            if live:
                lines = render(reqs, events, t0, ansi, all_done())
                if printed:
                    sys.stdout.write(f"\033[{printed}A")
                for ln in lines:
                    sys.stdout.write("\033[2K" + ln + "\n")
                printed = len(lines)
                sys.stdout.flush()
            else:
                with lock:
                    while last_event_count < len(events):
                        print(events[last_event_count])
                        last_event_count += 1
            if all_done():
                break
            time.sleep(0.05)
    finally:
        if live:
            sys.stdout.write("\033[?25h")
            sys.stdout.flush()

    timer.cancel()
    for t in threads:
        t.join()

    # final answers
    print()
    for req in reqs:
        head = ansi.c(req.color, f"── {req.key} · {req.model} ")
        print(head + ansi.c("90", "─" * max(0, 40 - len(req.model))))
        if req.error and not req.body:
            print(ansi.c("31", f"  error: {req.error}"))
        else:
            dur = (req.done_at - req.sent_at) if req.sent_at is not None else 0
            meta = [f"status {req.status}", f"total {dur:.2f}s"]
            if getattr(req, "finish", None):
                meta.append(f"finish {req.finish}")
            if req.usage.get("completion_tokens") is not None:
                meta.append(f"{req.usage['completion_tokens']} out tok")
            if req.timings.get("predicted_per_second") is not None:
                meta.append(f"{req.timings['predicted_per_second']:.0f} tok/s")
            print(ansi.c("90", "  " + " · ".join(meta)))
            text = req.content if req.content else (json.dumps(req.body) if req.body else "(empty)")
            for line in text.splitlines() or [""]:
                print("  " + line)
        print()

    a, b = by_key["A"], by_key["B"]
    if (
        a.done_at is not None and b.done_at is not None
        and b.sent_at is not None and a.sent_at is not None
        and b.done_at < a.done_at and b.sent_at > a.sent_at
    ):
        msg = (
            f"✅ B finished in {b.done_at - b.sent_at:.2f}s, before A "
            f"({a.done_at - a.sent_at:.2f}s), though it started "
            f"{b.sent_at - a.sent_at:.2f}s later — B preempted A; "
            f"A hung through the swap and resumed."
        )
        print(ansi.c("32", msg))
    else:
        print(ansi.c("33", "No clear preemption — check both targets share a "
                           "resource group and A is preemptible/enabled."))


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--model-a", default="big-slow")
    parser.add_argument("--model-b", default="fast-chat")
    parser.add_argument("--prompt-a", default="Write a long detailed numbered list of 40 facts about the ocean, one per line.")
    parser.add_argument("--prompt-b", default="Reply with exactly: PONG")
    parser.add_argument("--max-a", type=int, default=400)
    parser.add_argument("--max-b", type=int, default=40)
    parser.add_argument("--delay", type=float, default=2.0, help="seconds before firing B")
    parser.add_argument("--no-color", action="store_true")
    run(parser.parse_args())


if __name__ == "__main__":
    main()
