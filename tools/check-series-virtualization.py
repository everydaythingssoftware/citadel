#!/usr/bin/env python3
"""Exercise the real Series page through a running debug app's WebDriver plugin."""
import argparse
import base64
import json
import math
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--count", type=int, default=100_000)
parser.add_argument("--output", type=Path, default=Path("/tmp/citadel-series-check"))
parser.add_argument("--baseline", action="store_true", help="Capture top with the old full DOM renderer")
args = parser.parse_args()
if args.count < 1:
    parser.error("--count must be positive; the runner covers zero results through search")
args.output.mkdir(parents=True, exist_ok=True)


def post(endpoint, payload):
    request = urllib.request.Request(
        f"http://127.0.0.1:{args.port}/{endpoint}",
        json.dumps(payload).encode(), {"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def js(script):
    result = post("script/execute", {"script": script})
    if "value" not in result:
        raise RuntimeError(result)
    return result["value"]


def wait_for(script):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        result = js(script)
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError(f"Timed out: {script}")


def capture(name):
    time.sleep(0.25)
    data = post("screenshot", {})["data"]
    (args.output / f"{name}.png").write_bytes(base64.b64decode(data))


SNAPSHOT = """
const rows = [...document.querySelectorAll('.ctd-author-row')];
const rect = window.__seriesStress.scroll.getBoundingClientRect();
return {
  count: rows.length, scrollTop: window.__seriesStress.scroll.scrollTop,
  scrollHeight: window.__seriesStress.scroll.scrollHeight,
  viewport: {width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom},
  rows: rows.map(row => {
    const bounds = row.getBoundingClientRect();
    return {text:row.innerText, href:row.querySelector('a').getAttribute('href'),
      top:bounds.top, bottom:bounds.bottom, height:bounds.height,
      nameRight:row.querySelector('span').getBoundingClientRect().right,
      countRight:row.querySelectorAll('a')[1].getBoundingClientRect().right};
  }),
  footer: document.querySelector('[data-series-footer]')?.innerText ?? '',
  header: document.querySelector('[data-series-header]')?.getBoundingClientRect().toJSON(),
  footerBounds: document.querySelector('[data-series-footer]')?.getBoundingClientRect().toJSON()
};
"""
reports = {}


def check(name, expected_count=None):
    time.sleep(0.25)
    state = js(SNAPSHOT)
    reports[name] = state
    limit = math.ceil(state["viewport"]["height"] / 40) + 22
    assert state["count"] <= limit, (name, "unbounded DOM", state["count"], limit)
    if expected_count is not None:
        assert state["count"] == expected_count, (name, state)
    rows = state["rows"]
    for previous, current in zip(rows, rows[1:]):
        assert abs(previous["bottom"] - current["top"]) <= 1, (name, "row gap/overlap")
        assert abs(previous["countRight"] - current["countRight"]) <= 1, (name, "count alignment")
    for row in rows:
        number = int(row["text"].split("\n")[0].split()[1])
        assert row["text"].split("\n")[-1] == str(number % 7), (name, "wrong count", row)
        assert f"series_id={number + 1}" in row["href"], (name, "wrong link", row)
    if rows:
        visible = [r for r in rows if r["bottom"] > state["viewport"]["top"] and r["top"] < state["viewport"]["bottom"]]
        assert visible, (name, "blank viewport")
    if state["scrollTop"] > 100:
        assert abs(state["header"]["top"] - state["viewport"]["top"]) <= 2, (name, "header not sticky")
    assert abs(state["footerBounds"]["bottom"] - state["viewport"]["bottom"]) <= 2, (name, "footer not sticky")
    capture(name)
    return state


def search(term):
    js("""
const input = document.querySelector('input[aria-label="Search series"]');
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, %s);
input.dispatchEvent(new Event('input', {bubbles:true}));
""" % json.dumps(term))
    time.sleep(0.25)


original_url = js("return location.pathname + location.search")
try:
    js("""
window.__seriesStress = {ready:false};
import('/src/stores/library/store.ts').then(({useLibraryStore}) => {
  const state = useLibraryStore.getState();
  window.__seriesStress.restore = () => useLibraryStore.setState({series:state.series, seriesLoading:state.seriesLoading});
  useLibraryStore.setState({series:Array.from({length:%d}, (_, i) => ({id:i+1, name:`Series ${String(i).padStart(6,'0')}`, book_count:i %% 7})), seriesLoading:false});
  document.querySelector('a[href="/series"]').click();
  window.__seriesStress.ready = true;
}).catch(error => {window.__seriesStress.error = String(error)});
""" % args.count)
    wait_for("return window.__seriesStress.error || (window.__seriesStress.ready && !!document.querySelector('input[aria-label=\"Search series\"]'))")
    assert not js("return window.__seriesStress.error"), js("return window.__seriesStress.error")
    js("""
let node = document.querySelector('input[aria-label="Search series"]').parentElement;
while (node && !['auto','scroll'].includes(getComputedStyle(node).overflowY)) node = node.parentElement;
if (!node) throw new Error('No scroll ancestor');
window.__seriesStress.scroll = node;
window.__seriesStress.style = node.getAttribute('style');
node.scrollTop = 0;
""")
    wait_for("return document.querySelectorAll('.ctd-author-row').length > 0")
    if args.baseline:
        capture("top")
        reports["top"] = js(SNAPSHOT)
    else:
        top = check("top")
        assert top["rows"][0]["text"].startswith("Series 000000\n")
        assert top["footer"] == f"{args.count} series"
        for name, fraction in [("middle", 0.5), ("end", 1)]:
            js(f"window.__seriesStress.scroll.scrollTop = window.__seriesStress.scroll.scrollHeight * {fraction};")
            wait_for("""
const rows = [...document.querySelectorAll('.ctd-author-row')];
const rect = window.__seriesStress.scroll.getBoundingClientRect();
return rows.some(row => {const r = row.getBoundingClientRect(); return r.bottom > rect.top && r.top < rect.bottom});
""")
            state = check(name)
            if name == "end":
                assert state["rows"][-1]["text"].startswith(f"Series {args.count-1:06d}\n"), state
        search(f"Series {args.count-1:06d}")
        match = check("one-match", 1)
        assert match["footer"] == ("1 series" if args.count == 1 else f"1 of {args.count} series")
        assert match["rows"][0]["text"].startswith(f"Series {args.count-1:06d}\n")
        search("SERIES 00000")
        matches = check("ten-matches", min(args.count, 10))
        assert matches["footer"] == (f"{args.count} series" if args.count <= 10 else f"10 of {args.count} series")
        assert [row["text"].split("\n")[0] for row in matches["rows"]] == [f"Series {index:06d}" for index in range(min(args.count, 10))]
        search("absent-series")
        empty = check("no-matches", 0)
        assert empty["footer"] == f"0 of {args.count} series"
        search("")
        cleared = check("cleared")
        assert cleared["rows"][0]["text"].startswith("Series 000000\n")
        js("window.__seriesStress.scroll.style.width = '420px'; window.__seriesStress.scroll.style.height = '480px';")
        wait_for("return window.__seriesStress.scroll.getBoundingClientRect().width === 420")
        check("narrow")
        js("window.__seriesStress.scroll.scrollTop = window.__seriesStress.scroll.scrollHeight;")
        wait_for("""
const row = [...document.querySelectorAll('.ctd-author-row')].at(-1);
return row && row.innerText.startsWith(%s);
""" % json.dumps(f"Series {args.count-1:06d}\n"))
        check("narrow-end")
        js("[...document.querySelectorAll('.ctd-author-row')].at(-1).querySelector('a').click()")
        wait_for("return new URLSearchParams(location.search).get('series_id') === " + json.dumps(str(args.count)))
    print(json.dumps({name: {"mounted": state["count"], "scrollHeight": state["scrollHeight"]} for name, state in reports.items()}, indent=2))
finally:
    (args.output / "results.json").write_text(json.dumps(reports, indent=2))
    js("""
const fixture = window.__seriesStress;
if (fixture?.scroll) {
  if (fixture.style === null) fixture.scroll.removeAttribute('style');
  else fixture.scroll.setAttribute('style', fixture.style);
  fixture.scroll.scrollTop = 0;
}
fixture?.restore?.();
delete window.__seriesStress;
""")
    js("history.replaceState(null, '', " + json.dumps(original_url) + "); window.dispatchEvent(new PopStateEvent('popstate'));")
