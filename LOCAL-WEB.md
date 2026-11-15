# Local Web service

This local setup runs the built Web UI and Node.js server without Electron.
It keeps its data in `~/.openmausbot` and its process record and log in the
separate directory `~/.openmausbot-service/`. On the first management command,
an existing `~/.openmausbot/service/` is moved there with its log and record.

```sh
./manage.py start
./manage.py status
./manage.py pair
./manage.py restart
./manage.py stop
```

Open `http://127.0.0.1:8799/` on this computer, or use its LAN address from
another device. The server uses port 8799 and its webhook receiver uses 8800.
The browser requires pairing. Use `./manage.py pair` for a single-use sign-in
link. LAN connections use plain HTTP; the webhook receiver stays on loopback.
To listen only on this computer, start or restart with `OPENMAUSBOT_LAN=0`.
This override applies to that launch; subsequent launches use the default
unless the variable is set.

`OPENMAUSBOT_PORT` changes the server port; the webhook port is the next number.
`OPENMAUSBOT_DATA_DIR` selects an independent data directory; its service
directory is a sibling with `-service` appended to the data directory name.
Set the same data directory for every management command. `OPENMAUSBOT_NODE` selects a Node 24+
executable. `start` chooses an installed Node 24+ when it is not set. The
process record preserves the chosen ports and executable for status and stop.

Legacy OpenMausBot memory is off on this checkout. The server reads
`OMB_LEGACY_MEMORY` at startup. To opt in for a launch, run
`OMB_LEGACY_MEMORY=1 ./manage.py restart`. Leave it unset or set it to `0`
to keep legacy memory off. `GET /api/config` reports the effective value in
`features.legacyMemory`. See [the memory guide](docs/memory.md#legacy-memory-switch).

Run the service-manager regression checks with
`python3 -m unittest discover -s tests -p test_manage.py`.

To rebuild from the checkout, install dependencies with the project's pinned
pnpm 10.33.0 and Node 24+, then run:

```sh
corepack pnpm build
corepack pnpm build:server
./manage.py restart
```

On a Web-only install, `ELECTRON_SKIP_BINARY_DOWNLOAD=1` can be set during
`pnpm install`; the Electron application then requires its runtime to be
downloaded separately before it can run. Browser automation for bots uses a
separate browser engine; see `docs/browser-packaging.md`.
