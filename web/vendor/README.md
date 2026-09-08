# Vendored assets

These files are committed on purpose. Serving them from the app itself means:

- the Content-Security-Policy can forbid every external origin,
- the interface works with no internet connection,
- no third party learns when the app is opened,
- and a rebuild months from now produces the same image, instead of failing
  because a CDN has moved on to a newer release.

Every file is hashed in [`../../scripts/vendor-lock.json`](../../scripts/vendor-lock.json).
The Docker build runs `node scripts/fetch-assets.mjs --verify`, which fails if
any byte differs.

## Refreshing

```bash
node scripts/fetch-assets.mjs --update
```

This re-downloads everything and rewrites the lock file. Review the resulting
diff before committing it — that diff is the only place a change to these
files can enter the app.

## Contents and licences

| Directory | Source | Licence |
|---|---|---|
| `fonts/files/exo-2-*`, `orbitron-*`, `audiowide-*`, `rajdhani-*`, `inter-*`, `share-tech-mono-*`, `jetbrains-mono-*`, `press-start-2p-*`, `vt323-*` | Google Fonts | SIL Open Font License 1.1 |
| `fonts/files/material-symbols-outlined-*` | Google Fonts | Apache License 2.0 |
| `fonts/files/nasalization-*` | Typodermic Fonts, via cdnfonts.com | Typodermic free-font licence |
| `confetti/confetti.browser.min.js` | [canvas-confetti](https://github.com/catdad/canvas-confetti) 1.9.2 | ISC |

Only the `latin` and `latin-ext` subsets are included; the rest is what would
otherwise make this directory large.

If you would rather not redistribute Nasalization, delete
`fonts/files/nasalization-400.woff` together with its `@font-face` block in
`fonts/fonts.css` and its entry in the lock file. That font is one of ten
choices in the settings and the interface falls back to a system sans-serif
without it.
