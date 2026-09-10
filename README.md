# Zephikyu PNGCalls

Zephikyu PNGCalls is a private OBS browser source for player PNG avatars and webcam tiles. The host dashboard requires an account. Invited players do not need an account.

Each player opens a room link, chooses an idle image and a talking image, and allows microphone access. The browser measures volume locally and sends only a speaking status to the server.

It does not read or record microphone audio. It does not require Discord, a game mod, or a game-specific integration. It can be used alongside R.E.P.O., PEAK, Meccha Chameleon, and other games. Discord account connection remains optional.

## Quick local run with Docker

```bash
docker compose up -d --build
```

Open `http://localhost:4173`, create the host account, and create an overlay. The `data` and `uploads` directories are persistent volumes. Back up both directories together. The SQLite database is stored at `data/zephikyu.db`.

## One-command Proxmox LXC installation

Paste this command into the root shell of your Proxmox VE host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main/proxmox/zephikyu-pngcalls.sh)"
```

Choose **Default setup** for a 1 CPU, 1 GB RAM, 8 GB Debian LXC with DHCP. Choose **Advanced setup** to select the container ID, hostname, CPU, RAM, disk, storage, network bridge, and static or DHCP networking. AMD64 hosts use Debian 13. ARM64 hosts use Debian 12 compatibility mode because ARM Proxmox builds can have trouble starting Debian 13 systemd containers.

The installer asks for an optional public domain. Providing one configures automatic HTTPS through Caddy. HTTPS is required for remote browser camera and microphone permission. The domain must already point to your public IP, and TCP ports 80 and 443 must reach the new LXC.

To update an installed container later, replace `123` with its container ID:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main/proxmox/zephikyu-pngcalls.sh)" -- update 123
```

To change the domain later:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main/proxmox/zephikyu-pngcalls.sh)" -- configure 123
```

The native installation stores application data in `/var/lib/pngcalls`, configuration in `/etc/pngcalls`, and source in `/opt/pngcalls`. Use Proxmox backup jobs to protect the complete LXC.

If container creation completed but Debian 13 could not start because nesting was disabled, resume that container instead of creating a second one:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main/proxmox/zephikyu-pngcalls.sh)" -- resume 115 pngcalls.yarnobachmann.nl
```

The application runs natively as a restricted `pngcalls` service account. SQLite and uploads are kept under `/var/lib/pngcalls`, application configuration is kept under `/etc/pngcalls`, and the Node.js download is checked against the official SHA-256 manifest.

To update an installed container, replace `123` with its container ID:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main/proxmox/zephikyu-pngcalls.sh)" -- update 123
```

The updater stages the new version, performs a health check, and restores the previous version automatically if startup fails.

To change the domain later:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main/proxmox/zephikyu-pngcalls.sh)" -- configure 123
```

Discord credentials are configured from the host Settings page after installation.

The Docker Compose deployment remains available for users who already have a Debian LXC or another Docker host. Its files are `compose.proxmox.yaml`, `.env.proxmox.example`, and `scripts/install-proxmox-lxc.sh`.

## Run with Node

Requires Node.js 22.5 or newer.

```bash
npm install
npm start
```

The supported environment variables are listed in `.env.example`. Set them in your shell, container configuration, or hosting dashboard.

## Stack

This version uses an Express server, Prisma ORM, SQLite, and a browser-native frontend. It is not a T3 application. Prisma handles all live application reads and writes, and the versioned SQL schema is bootstrapped locally before startup.

The previous `data/state.json` file is imported once when the SQLite database is empty. Keep it as a migration backup until you have confirmed the imported rooms.

## How to use Zephikyu PNGCalls

1. Create a room in the dashboard.
2. Send the player join link to everyone who should appear.
3. Each player opens the link, enters a name, chooses PNG images or webcam mode, and allows the requested browser permissions.
4. Players keep that browser tab open while playing. It may be minimized.
5. Copy the separate OBS link from the dashboard.
6. In OBS, add a Browser source, paste the link, and use a 1920 by 1080 canvas or your scene size.

The player link lets people add themselves to the room. The OBS link is read-only. Treat both links as private.

## Internet hosting

Microphone and webcam permission require HTTPS unless the site is running on localhost. For an internet-facing installation, put Zephikyu PNGCalls behind an HTTPS reverse proxy such as Caddy, Traefik, or nginx. Do not expose port 4173 directly without a reverse proxy and firewall rules.

Set `PUBLIC_URL` in `compose.yaml` to the HTTPS address that players and OBS can reach.

## How speaking detection works

The join page uses the browser Web Audio API to calculate microphone loudness on the player's device. It sends a small heartbeat containing only the participant ID and whether that participant is speaking. The overlay receives updates through Server-Sent Events.

Players can optionally animate their avatar or webcam tile while speaking. Available styles are bounce, pulse, shake, and glow. The host can change the animation later from the player editor. Reduced-motion browser and OBS preferences disable these animations automatically.

This approach is game-neutral. It cannot automatically read the roster inside a game because browsers are not allowed to inspect another program. Players instead join through the shared room link, which is the no-mod and no-install option.

## Webcam mode

Webcam mode captures camera frames in the guest browser, compresses them as JPEG, and sends them only to this self-hosted server. The latest frame is streamed over a persistent WebSocket instead of being recorded as a video. Players can choose 30 FPS or 60 FPS at 640 by 360 pixels. The effective frame rate still depends on the selected camera, browser, server, and network connection. If a WebSocket connection cannot be established, PNGCalls uses a lower-rate HTTP fallback so the camera remains visible.

Caddy and Cloudflare Tunnel proxy the WebSocket on the same PNGCalls hostname and port. No additional public port is needed.

### OBS Virtual Camera

1. Build the scene you want to show in OBS.
2. Click **Start Virtual Camera** in OBS.
3. Open the PNGCalls player invite link in Chrome or Edge and choose **Webcam**.
4. Click **Find cameras** and select **OBS Virtual Camera**.
5. Use **Zoom**, **Horizontal position**, and **Vertical position** to crop the full OBS scene down to the face camera.
6. Check the 16:9 output preview and join.

OBS Virtual Camera is exposed to the browser as a normal camera device. No OBS plugin or game mod is required. Camera device names become available only after the browser grants camera permission. The camera picker and crop settings are remembered in that guest's browser.

If the default camera is already being used by another application, PNGCalls still lists the other detected camera sources. Select another source from the list and its preview will open separately.

## Built-in tutorial

On the first visit, Zeph asks whether the user wants a guided tour. The tour highlights the important controls for the current host or player screen. Choosing no, closing the tour, or finishing it keeps Zeph available in the lower-right corner with a help button. Tutorial completion is stored only in that browser.

## Optional Discord connection

Create an application in the Discord Developer Portal and add this redirect URL:

```text
https://your-pngcalls-domain.example/auth/discord/callback
```

Open the host Settings page and copy the displayed redirect URL into the Discord application's OAuth2 Redirects list. Enter the application's client ID and client secret in PNGCalls, save the configuration, and select Connect Discord account. The client secret is encrypted before it is stored in SQLite. Back up the `.credentials-key` file alongside the database because saved secrets cannot be decrypted without it.

Environment variables named `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and `DISCORD_REDIRECT_URI` remain supported as a fallback for existing deployments. A configuration saved in Settings takes priority. The OAuth connection requests only the `identify` scope and stores the Discord user ID and display name. Access and refresh tokens are not stored.

Discord account linking does not automatically read a normal Discord call. Discord desktop RPC requires an approved Discord application and a desktop integration. Invite links and browser microphone detection remain the supported no-install speaking workflow.

## Security scope

The application includes controls selected from current OWASP guidance: scrypt password hashing with a unique salt, generic login failures, rate limits, 12-hour server-side sessions, `HttpOnly`, `SameSite=Strict`, and HTTPS-aware cookies, CSRF tokens on host mutations, authorization checks on protected routes, content security headers, strict request limits, randomized upload names, MIME and file-signature validation, parameterized Prisma queries, and audit events for sensitive actions.

For production operations:

1. Use HTTPS and keep the app behind a maintained reverse proxy and firewall.
2. Restrict filesystem access to the service account. The database, uploaded images, and backups contain user data.
3. Back up `data` and `uploads` together, encrypt backups, test restores, and define retention periods.
4. Patch Node.js, the container base image, and dependencies regularly. Run `npm audit --omit=dev` in CI.
5. Monitor authentication failures, application errors, storage usage, and backup failures.
6. Rotate room links after accidental disclosure by creating a new room and deleting the old one.

These measures support an ISO/IEC 27001 information security program, but software alone is not ISO/IEC 27001 certified. Certification also requires an organization-wide ISMS, risk treatment, policies, evidence, internal review, and an independent audit.
