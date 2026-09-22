# ograf-server

[EBU OGraf](https://ograf.ebu.io/) server for managing and rendering broadcast graphics. Works with the [Erenprise](https://erenprise.com/) client, which has OGraf and CasparCG support built in.

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

Set the port with `--port <n>` or `PORT` (default 8080). Standalone binaries accept the same argument:

```sh
yarn start --port 9000
```

## Standalone binaries

Download the Windows or macOS zip from [releases](https://github.com/erenprise/ograf-server/releases), or build for the current platform with `yarn build:binary`:

| Platform    | Output                   |
| ----------- | ------------------------ |
| Windows x64 | `build/ograf-server.exe` |
| macOS ARM64 | `build/ografServer`      |

The binary embeds Node.js, the web assets, and the OGraf API specification, so the target machine needs no Node.js or `node_modules/`. Build with an official Node build from [nodejs.org](https://nodejs.org); Homebrew and distro builds disable single-executable support. Cross-building is not supported.

Runtime data (graphics, uploads, state) lives in `ograf-server/` beside the executable, so place the binary in a writable directory:

```text
ograf-server.exe        # or ografServer
ograf-server/
├── graphics/
├── uploads/
└── state.json
```

The macOS binary is ad-hoc signed, which Apple Silicon requires, but not notarized. If Gatekeeper blocks the first launch, allow it via **Right-click → Open** or `xattr -d com.apple.quarantine ografServer`.

## Checks

```sh
yarn check
```

## Authentication

Off by default; enable it in Settings. Tokens are API-scoped or renderer-scoped (output page only). External clients send `Authorization: Bearer <token>`. The admin UI exchanges an API token for an HttpOnly session cookie, so no token is stored in the browser. `/render/:id?token=...` sets an HttpOnly cookie and 303-redirects to the token-free URL.

## Endpoints

- Admin UI: `/`
- OGraf API: `/api/ograf/v1`
- Admin API: `/api/admin`
- Renderer output: `/render/:rendererId`
- API docs: `/docs/ograf`, `/docs/admin`

## Graphics

Packages live in `ograf-server/graphics/<package-id>/` with an `*.ograf.json` manifest. Uploads stream up to 200 MiB; re-uploading creates a revision. Soft-deleted graphics stay controllable for 5 minutes before garbage collection.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
