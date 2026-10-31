# Recording trackpad gestures

Trackpad flicks are hard to fake: macOS sends a stream of `wheel` events
whose size and timing (including the momentum after your fingers lift) are
what paging code has to cope with. To tune or check gesture handling, record
real gestures and replay them in a browser test.

## Record

1. Open the app (web or desktop debug build) and get to the screen you're
   testing, e.g. the upload review with a few books.
2. Open the developer console (Safari: Develop → Show JavaScript Console;
   Chrome: ⌥⌘J; desktop debug build: right-click → Inspect Element).
3. Paste this and press Return, then do the gestures within 15 seconds. Do
   one kind per recording (e.g. three hard flicks, a pause between each).

```js
(() => {
	const events = [];
	const start = performance.now();
	const onWheel = (event) =>
		events.push({
			t: Math.round(event.timeStamp - start),
			dx: event.deltaX,
			dy: event.deltaY,
			mode: event.deltaMode,
		});
	addEventListener("wheel", onWheel, { capture: true, passive: true });
	console.log("Recording wheel events for 15 s: swipe now.");
	setTimeout(() => {
		removeEventListener("wheel", onWheel, { capture: true });
		const json = JSON.stringify(events);
		if (typeof copy === "function") copy(json);
		console.log(`Recorded ${events.length} events (copied to the clipboard):`);
		console.log(json);
	}, 15_000);
})();
```

4. When it finishes, the recording is on the clipboard (and printed in the
   console). Save it as a `.json` file or paste it into the issue or chat,
   with a note of what you did and what you expected ("3 hard flicks right,
   should move 3 books").

## Replay

Each entry is `{ t, dx, dy, mode }`: milliseconds since recording started,
the wheel deltas, and the delta mode (0 is pixels). Replay by dispatching a
`WheelEvent` per entry on the element under test at its recorded offset:

```js
const replay = (element, events) =>
	Promise.all(
		events.map(
			({ t, dx, dy, mode }) =>
				new Promise((resolve) =>
					setTimeout(() => {
						element.dispatchEvent(
							new WheelEvent("wheel", {
								deltaX: dx,
								deltaY: dy,
								deltaMode: mode,
								bubbles: true,
								cancelable: true,
							}),
						);
						resolve();
					}, t),
				),
		),
	);
```

In Playwright, run it with `locator.evaluate(replay-as-a-function, events)`
on the carousel track (the parent of the `[data-slide-index]` covers), then
check the review's "n of m".
