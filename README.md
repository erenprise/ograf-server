# ograf-server

[EBU OGraf](https://ograf.ebu.io/) server for managing and rendering broadcast graphics.

Works with the [Erenprise](https://erenprise.com/) client, which has OGraf and CasparCG support built in.

![Banner](https://i.imgur.com/tjmAZP9.png)

![Demo](https://i.ibb.co/99d6dqR8/o.webp)

## Requirements

- Node.js 26+ (official build from [nodejs.org](https://nodejs.org))
- Yarn 4.18+

```sh
npm install -g corepack
corepack enable
```

## Run

```sh
yarn install
yarn dev                    # development on http://localhost:8080
yarn build && yarn start    # production
```

Set the port with `--port <n>` or `PORT` (default 8080), e.g. `yarn start --port 9000`.

## Standalone binaries

Download the Windows or macOS zip from [releases](https://github.com/erenprise/ograf-server/releases), or build one with `yarn build:binary`. The binary embeds Node.js and all assets, and writes its runtime data to `ograf-server/` beside the executable, so run it from a writable directory.

| Platform    | Output                   |
| ----------- | ------------------------ |
| Windows x64 | `build/ograf-server.exe` |
| macOS ARM64 | `build/ografServer`      |

Runtime data (graphics, uploads, state) lives in `ograf-server/` beside the executable, like so:

```text
ograf-server.exe        # or ografServer
ograf-server/
├── graphics/
├── uploads/
└── state.json
```

The macOS binary is ad-hoc signed. If Gatekeeper blocks the first launch, allow it via **Right-click → Open** or `xattr -d com.apple.quarantine ografServer`.

## Checks

```sh
yarn check
```

## Authentication

Off by default; enable it in Settings. Tokens are API-scoped or renderer-scoped (output page only). External clients send `Authorization: Bearer <token>`. The admin UI exchanges an API token for an HttpOnly session cookie.

## Endpoints

- Admin UI: `/`
- OGraf API: `/api/ograf/v1`
- Admin API: `/api/admin`
- Renderer output: `/render/:rendererId`
- API docs: `/docs/ograf`, `/docs/admin`

## Live transport

OGraf state GET endpoints also stream Server-Sent Events when requested with `Accept: text/event-stream`, and high-frequency `updateAction` calls can use a WebSocket upgrade on the same path. Both are optional extensions; normal HTTP follows the OGraf specification.

Multiple output pages can use the same renderer simultaneously. Commands are mirrored to outputs that share the GraphicInstance. A reloaded or newly opened output is sent the currently loaded graphics again with their original load data; runtime changes made after load are not replayed.

## Graphics

Packages live in `ograf-server/graphics/<package-id>/` with an `*.ograf.json` manifest. The folder is watched, so packages added, edited, or removed on disk are picked up and reloaded automatically. Uploads stream up to 200 MiB; re-uploading creates a revision. Soft-deleted graphics stay controllable for 5 minutes before garbage collection.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
