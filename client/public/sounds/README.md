# Dropping real sounds in

The game ships with synthesised audio — every cue is built from oscillators and
noise in `client/src/audio.ts`, so there are no asset bytes and no licences to
worry about. That is a placeholder, not a destination.

To replace any cue with a real recording, put the file in this folder and name
it in `index.json`:

```json
{
  "hit": "hit.webm",
  "death": "death.webm"
}
```

Only the cues you list are replaced; everything else keeps its synth recipe, so
you can swap them one at a time. The cue names are the `SoundName` union in
`client/src/audio.ts`: `swing`, `hit`, `jump`, `land`, `death`, `roundStart`,
`roundEnd`, `matchOver`.

Notes:

- Anything the browser can decode works. Prefer `.webm` (Opus) or `.m4a` over
  `.wav` — these are short cues and the file lands on a phone over restaurant
  wifi.
- Keep them SHORT. A hit that rings for half a second turns into mud when four
  people are brawling.
- The manifest is fetched once when audio unlocks. A missing file or a broken
  manifest falls back to the synth rather than failing.
- `index.json` must stay valid JSON even when empty — that is why it ships
  as `{}` rather than being absent, so the fetch never 404s.
