# Run Apex Velo Lab on your own computer

Apex is a local app for experimenting with cycling workouts and analytics. You do not need an account, a hosted service, an AI key or a trainer to explore it.

## Start

Download the repository ZIP and extract it, or clone the repository. On Windows, double-click `Launch-Apex-Velo.bat`. The launcher uses a compatible Node 24+ runtime if installed; otherwise it downloads a portable Node runtime from nodejs.org, verifies its SHA-256 checksum and keeps it under `%LOCALAPPDATA%\ApexVeloLab\runtime`. This first download needs internet; later launches work offline. No administrator rights, npm install or database configuration are needed. PowerShell launches the shared server and opens the app at `http://localhost:8080`. Keep the terminal open while using the app. The launcher creates `.env` only when it does not exist; it never replaces your settings. A failed setup can be retried by launching again.

On macOS, Linux or Windows with Node.js 24 or later, run `node server.js --open` from the extracted folder. No `npm install` is needed to run the app. If the browser does not open, visit `http://localhost:8080` yourself.

Use desktop Chrome or Edge for Web Bluetooth. Browser/platform support varies; the simulator and file imports work without Bluetooth. Phone Safari can display the remote view; it does not pair trainers itself. Launching a browser does not guarantee Bluetooth permission: pairing still requires a browser prompt.

## First ride or experiment

1. Select **Set up my rider**. Replace the placeholder FTP, weight and maximum heart rate. Optional threshold HR and crank length can be left blank.
2. Choose a workout. Without connected hardware it uses the simulator; no real measurements are implied.
3. For real riding, open **Devices**, pair supported sensors and an FTMS trainer. Trainer control stays in ERG.
4. Import FIT, TCX, CSV or an Apex backup in **History**. A synthetic TCX is available at `data/sample_sweetspot_ride.tcx`; importing it is optional.

**Explore a demo** opens `?apexDemo=1`, with clearly synthetic rides. It uses in-memory settings and a separate `ApexVeloDB_demo` database. Reloading resets demo settings. Demo server requests and Bluetooth pairing are blocked. **Return to my app** returns to your real storage.

## Optional connections

**AI:** edit your own `.env`, add an Anthropic, OpenAI or Gemini key and restart the server. Keys stay server-side. Without a key, the local workout and plan engines remain available. Leaving weekly hours blank specifically delegates hours to AI and needs a successful AI response; enter hours to generate a local plan. AI requests send the selected training and recovery context to the chosen provider; Ask also sends your question and conversation context. Provider usage may incur charges.

**Strava:** a Strava subscription is required to create your own personal API application under the [current developer requirements](https://developers.strava.com/docs/getting-started/). Set `localhost` as its callback domain. Put your client ID and secret in `.env`, restart, and use **Connect Strava**. Everyone uses their own application and tokens; no maintainer credentials are supplied. Public integrations have different approval requirements; this repo does not operate one.

**Strava without API sync:** free accounts can [request a bulk account export](https://support.strava.com/en-us/articles/15401919-how-do-i-export-my-strava-data). On Strava's website, open **Settings > My Account > Download your account > Get Started > Request download**. Any account language works: `activities.csv` is read by column position, and English and German activity types and dates are understood. Drop the emailed ZIP as it is (no need to extract it) on **History > Import**, or pick it with **Choose files**. The app reads the ZIP in the browser; nothing is uploaded anywhere.

- Every activity in `activities.csv` is included. Rides use their activity file (`.fit`, `.gpx` or `.tcx`, also `.gz`): with a power meter, NP and TSS come from the measured power; without one, TSS is estimated from heart rate (Strava's estimated watts are not used). Other sports (strength, runs, walks) use the CSV summary, the same as **Sync from Strava**.
- Before reading, choose how far back second-by-second data is kept: the last year, 2 years (default), 5 years, everything or nothing. Older rides keep their exact NP and TSS but no power curve. A whole history can be large: about 1,900 activities with 885 power rides came to roughly 100 MB with 2 years of second-by-second data, and about 400 MB with all of it.
- You see the same preview as **Sync from Strava** before anything is saved. Activities already imported with the same Strava id are refreshed, never copied twice. Strava copies of rides you recorded in the app are linked to those rides, and unclear matches wait for your decision. An archive import never removes anything.
- A restore point is saved first, and **Undo last sync** puts everything back.
- Importing the same archive again changes nothing. A later **Sync from Strava** recognises the imported activities by their id.

You can also drop single `.fit.gz`, `.tcx.gz`, `.gpx` or `.gpx.gz` files. This is a manual import, not ongoing sync. A current Chrome or Edge is needed to unpack the ZIP.

**Apple Health:** optional **Health Auto Export** on the iPhone uploads Heart Rate, Resting Heart Rate, Heart Rate Variability and Sleep Analysis. Follow **Settings > Apple Health** for the URL, bearer token and JSON setup. Automated exports require that third-party app's supported automation tier. The phone must reach the running computer on the same trusted network. Background delivery depends on iOS and the exporter; it is not a guaranteed hourly feed. Use **Manual export**, then **Check now**, to diagnose a missing day. Readiness needs an HRV baseline; absent data is not a sign of good recovery. Google Fit and Android Health Connect are not built-in connections.

**Phone remote:** on Windows, run `Enable-Phone-View.bat` once if needed, then restart the launcher. Open the address in **Settings > Phone view** on the same trusted Wi-Fi. Other devices on that LAN can access the remote and allowed controls. Keep the PC app on `localhost`; private health/archive management is available only there. Do not port-forward this local server or expose it through a public tunnel.

## Data, backups and updates

Rides and their full samples, rider profiles, preferences, health days, plans and Strava restore points live in a local SQLite database. On Windows this is `%LOCALAPPDATA%\ApexVeloLab\apex.sqlite`; on macOS/Linux it is `$XDG_DATA_HOME/ApexVeloLab` or `~/.local/share/ApexVeloLab`. The app folder can be updated or replaced without deleting this database. A different browser loads the same saved data from the PC. Keep using localhost for private database access and Web Bluetooth. The phone remains a remote, not a second database editor.

The first launch copies existing browser rides, IndexedDB-only samples, preferences and restore points into SQLite. It verifies a migration backup before committing and never deletes the original browser records or old backup files. Each browser also retains a downloadable copy of its earlier data before loading the PC database. If reading, verification or saving fails, migration stops and the app shows the problem. An existing SQLite database wins over another browser's old cache; it is never silently replaced or merged with stale data.

**Settings > Backups** shows whether writes are saved, pending or need attention. Verified compressed snapshots are stored alongside the database in `backups/`: the newest 14 plus up to 30 daily, 12 weekly and 12 monthly representatives. The initial migration snapshot and the latest five before-restore copies are also retained. Backups run after changes and daily while the server is running, even if the browser is closed. Select **Restore a backup**, preview its contents, then confirm; a safety backup is required before replacement. Old `data/backups` files are listed read-only and remain importable from History.

Interrupted rides are checkpointed in this browser approximately every five seconds. On returning, **Recover ride** restores the recorded portion paused; reconnect devices before resuming. Unsaved database operations are retained in an IndexedDB outbox and retried after connection failures. A conflicting tab must be reloaded; its pending recovery operation is retained rather than applied over newer data. Do not clear browser data while a save is pending. The app reports success only after SQLite confirms the save.

For protection against disk failure, optionally set `APEX_BACKUP_MIRROR_DIR` in `.env` to another drive or an existing synced folder. Verified snapshots are copied there; failures are displayed in Backups. Mirror copies are not automatically pruned. Do not sync the live SQLite file. `APEX_DATA_DIR` can select another private data folder, including isolated test/experimental installs; leave it blank for ordinary use. The data is private local storage, not encrypted by Apex.

An update keeps existing rider profiles, rides, health data and device settings. The legacy private archive is still recognised. Optional `data/local-history.json` is loaded only by the PC app; **Merge local archive** adds missing rides without replacing current records. No archive is supplied to new users. The older private archive filenames remain supported without rewriting those files.

For a Git checkout, run `git pull` from the folder, then restart the server and refresh the browser. When updating a ZIP install, copy new app files over the existing folder while retaining your `.env`, token files and `data` directory for optional services and legacy archives. SQLite and its new backups stay in the separate user data folder. Export a backup before changing computers.

## Troubleshooting

- **Port in use:** close the older Apex terminal first. Check which app owns port 8080 before using another port. SQLite persists across ports; browser recovery copies still belong to their original address.
- **Empty history after an update:** check the storage status in Settings and the data folder. Restart the updated launcher, then restore a verified backup if needed. Do not clear browser storage during migration or a pending save.
- **Another tab changed the data:** keep the newer tab and reload the older tab. Its conflicting operations are retained separately and offered as a download; the reloaded tab can save again. They are not blindly retried over newer data.
- **Health storage full:** server exports remain queued. Export a backup, free browser capacity and retry. Do not delete browser data without a verified backup.
- **Health inbox full:** collect existing exports on the PC, then resend. The server rejects additional exports instead of silently deleting unread ones.
- **Bluetooth unavailable:** use desktop Chrome/Edge at localhost, enable OS Bluetooth, wake sensors and disconnect competing apps. Hardware/firmware support still needs checking on your equipment.
- **No AI response:** verify your own key, provider/model access and network. Local riding is still available.

## Development checks

`npm test` runs the Node checks. Browser checks need the optional development dependency: `npm install`, then `npx playwright install chromium` where required. Windows uses installed Edge by default; set `APEX_BROWSER_CHANNEL` to choose another installed channel. Run `npm run test:browser` for new/existing installations and demo isolation, and `npm run test:suite` for the broader browser suite. Both use temporary or isolated storage and synthetic fixtures. `npm run check:share` checks the tracked working-tree contents for common private files and credential patterns; it does not certify Git history.

`node tests/sqlite-browser.cjs` verifies the actual SQLite server with a real browser, including migration, new-browser access, restore UI, failed saves and interrupted rides. All database and launcher API tests use temporary folders, never the rider's real SQLite database or backups.
