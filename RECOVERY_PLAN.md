# ShiftClock Recovery Plan

This repository currently contains only production build artifacts:

- `index.html`
- `assets/index-*.js`
- `assets/index-*.css`

Because the React/TypeScript source files are missing, safe feature work should continue from the original source project (the `shiftclock` folder referenced in the pasted conversation) rather than editing bundled/minified files.

## What appears complete (from your pasted handoff)

- UTC radial clock with 13 agent layers
- Overtime and "up for grabs" visual states
- Profiles page with editable agents
- Clock/Timeline view toggle
- Online-now strip, weekend empty state, and improved button labels
- Hover tooltip work was in progress/fixed around SVG hit-path behavior

## Known blocker recovered from the interrupted handoff

A real bug was identified but not finalized:

- Overnight shifts (e.g. start `22:00`, end `06:00`) can display negative durations such as `-16.0h`.
- This happens when duration is computed as `endUtc - startUtc` instead of wrapping across midnight.

## Drop-in duration rule to apply in source code

Use a helper like:

```ts
const hoursBetweenUtc = (startUtc: number, endUtc: number) => {
  const s = ((startUtc % 24) + 24) % 24;
  const e = ((endUtc % 24) + 24) % 24;
  return e >= s ? e - s : 24 - s + e;
};
```

Then replace all direct duration math (`end - start`) with this helper for:

- Base shift duration labels
- KPI overtime/free calculations
- Coverage report totals
- Timeline row labels

## Safe next step

1. Import/extract the original project source (the folder that contains `client/src` and `server/`).
2. Apply the overnight duration helper everywhere duration is derived.
3. Re-run app QA in both Clock and Timeline modes for agents with overnight shifts.
4. Rebuild and redeploy.
