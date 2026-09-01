# ograf-server

Implementation of [EBU OGraf](https://ograf.ebu.io/) server for managing and rendering graphics.

Works well with the [Erenprise](https://erenprise.com/) client which has Ograf and CasparCG support built-in.

Download `ograf-server-v<version>-windows-x64.zip` from [releases](https://github.com/erenprise/ograf-server/releases) or build single **ograf-server.exe** file for easy running on Windows.

Or download source, build and run server directly with **Node.js**.

![Banner](https://i.imgur.com/tjmAZP9.png)

![Demo](https://i.ibb.co/99d6dqR8/o.webp)

## Requirements

- Node.js 26+
- Yarn 4.18+

```sh
npm install -g corepack
corepack enable
```

## Run

```sh
yarn install
yarn dev
```

Open `http://localhost:8080` for the admin UI.

Production:

```sh
yarn build && yarn start
```

Set `PORT` to change the default port (8080).

## Windows standalone executable

Requires Node.js 26+ (an official build from [nodejs.org](https://nodejs.org); shared-library builds such as Homebrew's have single-executable support disabled).

```sh
yarn build:exe
```

Output:

```text
build/ograf-server.exe
```

The executable bundles Node.js, the server, the admin/renderer web assets, and the OGraf API specification. The target Windows machine needs no Node.js installation and no `node_modules/`, `dist/` or `package.json` beside it.

`yarn build` downloads the current official OGraf documentation into the ignored `.cache/ograf/` directory. Vite copies it into `dist/`, and the executable embeds it.

Runtime data is stored beside the executable, not in the working directory:

```text
ograf-server.exe
ograf-server/
├── graphics/
├── uploads/
└── state.json
```

Place the executable in a directory the current user can write to.

Building on macOS/Linux downloads and SHA-256 verifies the matching official Windows x64 Node.js runtime and caches it under `.cache/node/`.

## Checks

```sh
yarn check
```

## Authentication

Auth requires an API-scoped token to enable. Tokens are created in Settings. Renderer tokens are restricted to output page access only.

External clients authenticate with `Authorization: Bearer <token>`. The built-in admin UI signs in once with an API-scoped token via `POST /api/session`, which is exchanged for the HttpOnly session cookie (`ograf_admin_token`, `SameSite=Strict`, path `/api`). That session authenticates same-origin Admin API _and_ OGraf API requests from the admin UI, so renderer controls keep working when authentication is enabled; no bearer token is stored in the browser.

The renderer bootstrap URL `/render/:id?token=...` sets an HttpOnly cookie then 303-redirects to the token-free URL. The query token is a credential only until the redirect consumes it.

## Endpoints

- Admin UI: `/`
- OGraf API: `/api/ograf/v1`
- Admin API: `/api/admin`
- Renderer output: `/render/:rendererId`
- API docs: `/docs/ograf`, `/docs/admin`

## Graphics

Packages use `graphics/<package-id>/` with an `*.ograf.json` manifest. Uploads are streamed (max 200 MiB). Re-uploading a package creates a new revision; existing renderer ESM modules are not invalidated until reload. Soft-deleted graphics are hidden from new loads but remain controllable for 5 minutes until garbage-collected.

## State

Persistent state and upload staging use `ograf-server/` in the working directory, or beside the executable in a standalone build.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
