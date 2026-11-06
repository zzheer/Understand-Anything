# understand-anything-viewer

Standalone read-only viewer for [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) knowledge graphs. Opens the full interactive dashboard for a graph that was already generated with `/understand` — no Claude Code, no LLM, no API key. Only Node.js (>= 18) is required.

## Usage

Build the viewer from a checkout of this repository and run it with `node` — nothing is downloaded at run time:

```bash
pnpm install --frozen-lockfile
pnpm --filter understand-anything-viewer build
node understand-anything-plugin/packages/viewer/bin/viewer.mjs /path/to/analyzed/project
```

This is what the `/understand-dashboard` skill does. A prebuilt tarball is also attached to each GitHub release for people who prefer `npx <release-url>`; treat that as executing unreviewed code from the network and verify the asset (e.g. compare its SHA-256 with the one published on the release page) before running it.

The project directory (default: current directory) must contain a data directory — `.ua/` or legacy `.understand-anything/` — with a `knowledge-graph.json`. The terminal prints a tokenized URL (`http://127.0.0.1:<port>/?token=…`) and opens it in your browser.

Options: `--port <n>` (default 5173, auto-increments if taken), `--no-open`.

Everything is served read-only from local disk, bound to `127.0.0.1`, and gated behind a one-time access token — no data leaves your machine.

## Building the tarball (maintainers)

```bash
pnpm --filter understand-anything-viewer pack:release
gh release upload <tag> understand-anything-plugin/packages/viewer/understand-anything-viewer-*.tgz
```

The pack step builds the dashboard and embeds its compiled `dist/` into the package, producing a fully self-contained, zero-dependency tarball.
