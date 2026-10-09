#!/usr/bin/env python3
"""Check registered list pages in an idle Citadel debug app using shared fixtures."""
import argparse
import json
import math
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from driver import Driver

TOOLS = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--scenario", default="series", help="Registered scenario name (series or authors)")
parser.add_argument("--count", type=int, default=100_000)
parser.add_argument("--output", type=Path)
parser.add_argument("--baseline", action="store_true", help="Capture initial layout without regression assertions")
parser.add_argument("--allow-layout-warnings", action="store_true", help="Record existing sticky-layout failures without failing the run")
args = parser.parse_args()
if not 1 <= args.count <= 100_000:
    parser.error("--count must be between 1 and 100000")
output = args.output or Path(f"/tmp/citadel-list-check/{args.scenario}")
output.mkdir(parents=True, exist_ok=True)
driver = Driver(args.port)
reports, warnings = {}, []
scenario = {}
snapshot_script = (TOOLS / "list-snapshot.js").read_text()
original_url = driver.execute("return location.pathname + location.search")


def expected(index):
    return driver.execute(f"return window.__listCheck.scenario.createItem({index}, false)")


def footer_text(count):
    label = scenario["label"]
    return f"{args.count} {label}" if count == args.count else f"{count} of {args.count} {label}"


def layout_assert(condition, message):
    if not condition and args.allow_layout_warnings:
        if message not in warnings:
            warnings.append(message)
    else:
        assert condition, message


def check(name, count=None, first=None, last=None):
    def settled():
        state = driver.execute(snapshot_script)
        rows = state["rows"]
        if count is not None and len(rows) != count:
            return None
        if first is not None and (not rows or rows[0]["name"] != first["name"]):
            return None
        if last is not None and (not rows or rows[-1]["name"] != last["name"]):
            return None
        if rows and not any(row["bottom"] > state["viewport"]["top"] and row["top"] < state["viewport"]["bottom"] for row in rows):
            return None
        if count is not None:
            expected_footer = None if count == 0 and scenario["emptyResultsHideChrome"] else footer_text(count)
            if state["footer"] != expected_footer:
                return None
        return state

    deadline = time.monotonic() + 15
    state = None
    while state is None and time.monotonic() < deadline:
        state = settled()
        if state is None:
            time.sleep(0.1)
    if state is None:
        reports[name] = driver.execute(snapshot_script)
        raise AssertionError((name, "content did not settle"))
    reports[name] = state
    rows = state["rows"]
    limit = math.ceil(state["viewport"]["height"] / scenario["rowHeight"]) + 2 * scenario["overscan"] + 2
    assert len(rows) <= limit, (name, "unbounded DOM", len(rows), limit)
    for previous, current in zip(rows, rows[1:]):
        assert abs(previous["bottom"] - current["top"]) <= 1, (name, "row gap/overlap")
        assert abs(previous["countRight"] - current["countRight"]) <= 1, (name, "count alignment")
    for row in rows:
        item_id = parse_qs(urlparse(row["href"]).query)[scenario["queryKey"]][0]
        item = expected(int(json.loads(item_id)) - 1)
        assert row["name"] == item["name"] and row["count"] == item["book_count"], (name, "stale name/count/link", row)
    if state["scrollTop"] > 100 and state["header"]:
        layout_assert(abs(state["header"]["top"] - state["viewport"]["top"]) <= 2, f"{name}: header not sticky")
    if state["footerBounds"]:
        layout_assert(abs(state["footerBounds"]["bottom"] - state["viewport"]["bottom"]) <= 2, f"{name}: footer not sticky")
    driver.capture(output / f"{name}.png")
    return state


def search(term):
    driver.execute("""
const input = document.querySelector(window.__listCheck.scenario.search);
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, %s);
input.dispatchEvent(new Event('input', {bubbles:true}));
""" % json.dumps(term))


def scroll(fraction):
    driver.execute(f"window.__listCheck.scroll.scrollTop = window.__listCheck.scroll.scrollHeight * {fraction};")


try:
    driver.execute("window.__listCheckOptions = " + json.dumps({"scenario": args.scenario, "count": args.count}) + ";\n" + (TOOLS / "list-session.js").read_text())
    driver.wait("return window.__listCheck.error || (window.__listCheck.ready && !!document.querySelector(window.__listCheck.scenario.search))")
    error = driver.execute("return window.__listCheck.error")
    assert not error, error
    scenario = driver.execute("return window.__listCheck.description")
    driver.execute("""
let node = document.querySelector(window.__listCheck.scenario.search).parentElement;
while (node && !['auto','scroll'].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
if (!node) throw new Error('No scroll ancestor');
window.__listCheck.scroll = node;
window.__listCheck.style = node.getAttribute('style');
node.scrollTop = 0;
""")
    driver.wait("return document.querySelectorAll(window.__listCheck.scenario.rows).length > 0")
    first, last = expected(0), expected(args.count - 1)
    if args.baseline:
        reports["top"] = driver.execute(snapshot_script)
        driver.capture(output / "top.png")
    else:
        top = check("top", first=first)
        assert top["footer"] == footer_text(args.count)
        assert top["scrollHeight"] >= args.count * scenario["rowHeight"], "List does not reserve its full scroll height"
        scroll(0.5)
        check("middle")
        scroll(1)
        check("end", last=last)
        search(last["name"].upper())
        check("one-match", count=1, first=last)
        search(first["name"][:-1].upper())
        matches = check("ten-matches", count=min(args.count, 10), first=first)
        assert [row["name"] for row in matches["rows"]] == [expected(index)["name"] for index in range(min(args.count, 10))]
        search("absent-list-item")
        check("no-matches", count=0)
        search("")
        check("cleared", first=first)
        driver.execute("window.__listCheck.scroll.style.width = '420px'; window.__listCheck.scroll.style.height = '480px';")
        driver.wait("return window.__listCheck.scroll.getBoundingClientRect().width === 420")
        check("narrow")
        scroll(1)
        check("narrow-end", last=last)
        driver.execute("[...document.querySelectorAll(window.__listCheck.scenario.rows)].at(-1).querySelector(window.__listCheck.scenario.link).click()")
        driver.wait("return JSON.parse(new URLSearchParams(location.search).get(" + json.dumps(scenario["queryKey"]) + ")) === " + json.dumps(last["id"]))
    print(json.dumps({"scenario":args.scenario, "stages":{name:len(state["rows"]) for name,state in reports.items()}, "layoutWarnings":warnings}, indent=2))
finally:
    primary_error = sys.exc_info()[1]
    try:
        driver.execute("""
const fixture = window.__listCheck;
if (fixture?.scroll) {
  if (fixture.style === null) fixture.scroll.removeAttribute('style');
  else fixture.scroll.setAttribute('style', fixture.style);
  fixture.scroll.scrollTop = 0;
}
fixture?.restore?.();
delete window.__listCheck;
delete window.__listCheckOptions;
""")
        driver.execute("history.replaceState(null, '', " + json.dumps(original_url) + "); window.dispatchEvent(new PopStateEvent('popstate'));")
    except Exception as cleanup_error:
        warnings.append(f"Cleanup failed; restart the debug app: {cleanup_error}")
        if primary_error is None:
            raise
        print(warnings[-1], file=sys.stderr)
    finally:
        (output / "results.json").write_text(json.dumps({"scenario":args.scenario,"stages":reports,"layoutWarnings":warnings}, indent=2))
