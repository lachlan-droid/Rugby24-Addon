# Private Rugby24 Nuvio add-on

This is a small Node 20 server that exposes Rugby24's dated replay archive using the Stremio/Nuvio add-on protocol.

It provides:

- latest and competition catalogs sorted newest publication date first;
- Nuvio metadata pages with poster, date, duration when available, and a source-page link;
- an external-page stream by default, which opens the authorized source page and its embedded player;
- optional direct HLS output when an explicit signed HLS URL is present in the source page.

The static deployment also publishes a metadata-only companion add-on for the separate Sports Replay stream add-on. It keeps the `sports-replay:` IDs unchanged, so Nuvio can use the reliable Sports Replay streams while displaying cleaned rugby titles, competition tags, dates, descriptions, and matched Rugby24 artwork.

The server does not download, store, proxy, or re-host video, and it does not automate any human-verification gate. Use it only where you have the rights and permission to access the source and its embedded providers.

## Free GitHub Pages mode

This repository also includes a static mode for free hosting. GitHub Actions rebuilds the catalog every six hours and GitHub Pages serves the generated manifest, catalog, metadata, and original-page stream files. The static mode does not need Node or Docker to stay running.

1. Create a public GitHub repository and upload the contents of this folder, including `.github/workflows/publish-rugby24-addon.yml`.
2. In the repository, open **Settings → Secrets and variables → Actions**.
3. Add a repository secret named `ADDON_TOKEN` containing a long random value. Do not commit the token.
4. Open **Settings → Pages**, set the source to **GitHub Actions**, and save.
5. Open the **Actions** tab, choose **Refresh Rugby24 static Nuvio add-on**, and click **Run workflow**.
6. After it completes, install this URL in Nuvio:

```text
https://YOUR-GITHUB-USER.github.io/YOUR-REPOSITORY/YOUR_ADDON_TOKEN/manifest.json
```

The workflow refreshes the Rugby24 home and league pages every six hours and publishes the newest 100 replay entries. GitHub Pages is public-by-URL, so the token is only a private-by-obscurity path; do not put sensitive data in the repository.

For the Sports Replay stream add-on, install the companion metadata manifest as a second add-on:

```text
https://YOUR-GITHUB-USER.github.io/YOUR-REPOSITORY/YOUR_ADDON_TOKEN/sports-metadata/manifest.json
```

Place the metadata companion above the original Sports Replay add-on in Nuvio's add-on order so its metadata takes priority.

## Run locally

```sh
cd rugby24-nuvio-addon
cp .env.example .env
# Edit .env and set ADDON_TOKEN to a long random value.
export $(grep -v '^#' .env | xargs)
npm test
npm start
```

Docker is also supported:

```sh
docker build -t private-rugby24-nuvio-addon .
docker run --rm -p 7000:7000 --env-file .env private-rugby24-nuvio-addon
```

For automatic restarts, use Docker Compose:

```sh
docker compose up -d --build
```

The included `docker-compose.yml` uses `restart: unless-stopped`, so the add-on starts again when Docker Desktop restarts or the Mac reboots. Stop it with `docker compose down`.

The local manifest URL will be:

```text
http://127.0.0.1:7000/<ADDON_TOKEN>/manifest.json
```

## First-page local trial

GitHub's hosted runner may receive a 403 from Rugby24 even when the site works in your normal Mac browser. This project includes a small local trial that fetches only the first Rugby24 page from your Mac connection, builds the static files, and serves them to Nuvio. Firecrawl is disabled and the trial refuses to use the old GitHub Pages catalogue as a fallback, so a failed live fetch is obvious.

```sh
cd rugby24-nuvio-addon
cp .env.example .env
# Edit .env and set ADDON_TOKEN to the same private token used for your add-on.
npm run trial
```

The command prints a local manifest URL like:

```text
http://127.0.0.1:7100/<ADDON_TOKEN>/manifest.json
```

On another device on the same Wi-Fi, replace `127.0.0.1` with your Mac's LAN IP, for example `http://192.168.1.20:7100/<ADDON_TOKEN>/manifest.json`. Leave the terminal running while testing. The trial only covers the first source page and up to 20 replay entries; it does not crawl 180 pages or discover torrents.

If the trial reports HTTP 403 or says no live entries were available, Rugby24 is blocking command-line access from that Mac path too. In that case, stop there and we can add an authorized browser/session or re-enable Firecrawl later; Nuvio will not show a real incoming stream until the source page and its authorized player links can be fetched.

Nuvio must be able to reach the URL. A phone or TV usually cannot reach `localhost` on your Mac; for local testing use your Mac's LAN IP, for example `http://192.168.1.20:7000/<ADDON_TOKEN>/manifest.json`, with the device on the same network. For a persistent private add-on, deploy this folder to a small HTTPS Node host and keep `ADDON_TOKEN` secret.

## Install in Nuvio

1. Start the server.
2. Copy the manifest URL from the server log.
3. In Nuvio, open the add-on manager and paste the manifest URL.
4. Open `Private Rugby24 Archive` and check `Latest rugby replays`.

## Playback mode

`STREAM_MODE=external` is the recommended default because the source page controls its own embed and signed URLs. `STREAM_MODE=direct` adds a direct HLS candidate when one is explicitly present in the fetched page; signed upstream URLs can expire or be tied to the fetching IP, so this mode is not guaranteed to work in every Nuvio client.
