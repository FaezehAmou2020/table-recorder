# Table Recorder

A small, free tool for recording group discussions at several tables at the same time (e.g. workshop break-out sessions). Each table gets a QR code. Participants scan it with a phone, tap **Start recording**, leave the phone on the table, and the audio is uploaded to **your Google Drive** every 30 seconds. When the session ends, the chunks are merged into a single audio file per table.

- **Frontend:** two static HTML pages hosted for free on **GitHub Pages**.
- **Backend:** one **Google Apps Script** web app that writes to your Google Drive.
- No server, no database, no app install, no cost.

```
 Phone (index.html?table=07)                Google Apps Script (Code.gs)             Google Drive
 ───────────────────────────                ────────────────────────────             ────────────
 records audio  ── every 30 s: chunk ──▶    doPost(action=chunk)        ──▶   table-07/_parts_<session>/part_000001
 "End session"  ── finish ─────────────▶    doPost(action=finish)       ──▶   table-07/table-07_2026-10-05_14-03_ab12.webm
                                            every 15 min: finalizeStaleSessions()  (merges sessions that were never ended)
```

## Contents

| File | Where it goes | What it does |
|---|---|---|
| `index.html` | GitHub Pages | Recording page opened from the QR code (`index.html?table=07`). |
| `qr.html` | GitHub Pages | Generates printable QR-code cards, one per table. |
| `apps-script/Code.gs` | Google Apps Script | Receives chunks, stores them in Drive, merges them into one file. |
| `README.md` | — | This guide. |

---

## What you need

- A Google account (with enough free Drive space: about **22 MB per table per hour** of recording).
- A GitHub account (free).
- About 20–30 minutes.

You will create **two values** during setup and paste them into the code:

| Value | Example | Used in |
|---|---|---|
| Drive folder ID | `1WEl16Mn2d352irPURBZGFi_IXzSvwc0h` | `Code.gs` |
| Shared token (any random string) | `rec-7Hq2mX9pLw4sT` | `Code.gs` **and** `index.html` (must match) |

And one value that Google gives you:

| Value | Example | Used in |
|---|---|---|
| Web app URL | `https://script.google.com/macros/s/AKfy…/exec` | `index.html` |

---

## Step-by-step setup

### Step 1 — Create the Google Drive folder

1. Open [Google Drive](https://drive.google.com) and create a new folder, e.g. `Table Recordings`.
2. Open the folder. The address bar looks like this:
   `https://drive.google.com/drive/folders/1WEl16Mn2d352irPURBZGFi_IXzSvwc0h`
3. Copy the part after `/folders/` — that is your **folder ID**. Keep it somewhere handy.

> The folder can stay private. The script runs as you, so participants never need access to your Drive.

### Step 2 — Choose a shared token

Pick a random string of letters and numbers (no spaces), e.g. `rec-7Hq2mX9pLw4sT`. It stops random people who find your script URL from uploading to your Drive. You will paste it in **two** places.

### Step 3 — Create the Google Apps Script project

1. Go to [script.google.com](https://script.google.com) and click **New project**.
2. Click the title **Untitled project** at the top and rename it, e.g. `Table Recorder`.
3. In the editor, a file named `Code.gs` is already open. **Delete everything** in it.
4. Open `apps-script/Code.gs` from this repository, copy its full content and paste it into the editor.
5. At the top of the file, fill in the `CONFIG` block:

   ```js
   const CONFIG = {
     ROOT_FOLDER_ID: '1WEl16Mn2d352irPURBZGFi_IXzSvwc0h', // from Step 1
     TOKEN: 'rec-7Hq2mX9pLw4sT',                          // from Step 2
     STALE_MINUTES: 30,
     TIMEZONE: 'Europe/Amsterdam',                         // your event's time zone
   };
   ```

   `TIMEZONE` only affects the date/time in file names. Use a [tz database name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) such as `Europe/Berlin`, `America/Sao_Paulo` or `America/New_York`.
6. Press **Ctrl + S** (or **⌘ + S**) to save.

### Step 4 — Authorize the script and schedule the cleanup

1. In the toolbar, open the function drop-down (next to **Debug**) and select **`installTrigger`**.
2. Click **Run**.
3. A dialog **"Authorization required"** appears → click **Review permissions** → choose your Google account.
4. Google shows **"Google hasn't verified this app"**. This is normal for your own scripts:
   click **Advanced** → **Go to Table Recorder (unsafe)** → **Allow**.
   The script asks for access to Google Drive (to save the recordings) and to connect to external services (to call the Drive upload API).
5. The **Execution log** at the bottom should end with:
   `All set: folder is accessible and automatic cleanup is scheduled.`

If you get an error instead, see [Troubleshooting](#troubleshooting).

> This step creates a trigger that runs `finalizeStaleSessions` every 15 minutes. It merges any session whose phone stopped sending audio for 30 minutes (battery died, page closed, etc.), so no recording is left as loose chunks. You can check it under the **⏰ Triggers** icon in the left sidebar.

### Step 5 — Deploy the script as a web app

1. Click **Deploy** (top right) → **New deployment**.
2. Click the gear icon ⚙ next to **Select type** → choose **Web app**.
3. Fill in:
   - **Description:** `v1`
   - **Execute as:** **Me** (your email)
   - **Who has access:** **Anyone**
4. Click **Deploy** (authorize again if asked).
5. Copy the **Web app URL**. It ends with **`/exec`**.
6. **Test it:** paste the URL into a new browser tab. You should see:
   ```json
   {"ok":true,"service":"table-recorder"}
   ```

> "Anyone" is required because participants' phones are not signed in to your account. Only requests carrying your token are accepted.

### Step 6 — Configure the recording page

Open `index.html` in a text editor (or directly on GitHub later — see Step 7) and fill in the `CONFIG` block near the top of the `<script>`:

```js
const CONFIG = {
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfy…/exec', // from Step 5
  TOKEN: 'rec-7Hq2mX9pLw4sT',                                    // same as in Code.gs
  CHUNK_SECONDS: 30,
  BITRATE: 48000,
};
```

`CHUNK_SECONDS` and `BITRATE` can stay as they are. 48 kbps is good quality for speech (~22 MB per hour).

### Step 7 — Publish the pages on GitHub Pages

**7a. Create the repository**

1. Sign in to [github.com](https://github.com) and click **+** (top right) → **New repository**.
2. **Repository name:** e.g. `table-recorder` (this becomes part of the URL).
3. Set it to **Public** (GitHub Pages is free for public repositories; private repositories need a paid plan).
4. Click **Create repository**.

**7b. Upload the files**

1. On the new repository page, click **uploading an existing file** (or **Add file → Upload files**).
2. Drag in **`index.html`**, **`qr.html`** and **`README.md`**. You can also drag in the **`apps-script`** folder to keep a copy of the backend code.
3. Click **Commit changes**.

> `index.html` and `qr.html` must be at the **top level** of the repository, not inside a folder.
>
> Note that the token in `index.html` will be public. That's unavoidable (the phones need it) and fine: it only lets someone upload audio to your folder, never read it. See [Security notes](#security-notes).

**7c. Turn on GitHub Pages**

1. In the repository, go to **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment → Source**, select **Deploy from a branch**.
3. Under **Branch**, select **`main`** and **`/ (root)`** → **Save**.
4. Wait 1–2 minutes and refresh the page. A banner shows your site address:
   `https://<your-username>.github.io/table-recorder/`

**Editing later:** open a file on GitHub, click the pencil icon ✏️, edit, then **Commit changes**. The site updates within a minute or two.

### Step 8 — Test end to end (do this before the event!)

1. On your phone, open
   `https://<your-username>.github.io/table-recorder/?table=test`
2. You should see **Table: test** and no red warning.
3. Tap **Start recording**, allow the microphone, talk for about **1–2 minutes** (the level bar should move).
4. Tap **End session** → confirm. Wait for **Saved ✓**.
5. In Google Drive, open your folder → `table-test`. You should find a file like
   `table-test_2026-10-05_14-03_ab12.webm` (Android) or `.m4a` (iPhone). Play it.
6. Test with **both an Android and an iPhone** if you can.

Delete the `table-test` folder afterwards.

### Step 9 — Print the QR codes

1. Open `https://<your-username>.github.io/table-recorder/qr.html` on a computer.
2. **Recording page address** is filled in automatically. If not, enter `https://<your-username>.github.io/table-recorder/`.
3. Set **First table** and **Last table** (e.g. 1 to 8).
4. Optional: tick **Generate a 2nd QR code ("b")** for long tables that need two phones (they're saved as separate recordings, e.g. `table-03` and `table-03b`).
5. Click **Generate**, then **Print** (two cards per A4 page). Cut along the dashed lines and put one card on each table.

---

## On the day

- Ask people at each table to **charge their phone** and to use **Chrome (Android)** or **Safari (iPhone)**.
- The phone must stay **unlocked with the page open**. The page asks the browser to keep the screen on; if a browser doesn't support that, the page shows a hint to set auto-lock to "Never".
- If the recording is interrupted (call, screen locked, another app took the microphone), what was recorded is already saved. The page shows **Resume recording**, which starts a new file for the same table.
- Upload problems (weak Wi-Fi) are handled automatically: chunks wait in a queue and are retried. Ask people **not to close the page** until it shows **Saved ✓**.
- Starting a recording means everyone at the table has agreed to be recorded (the page says so). Make sure you have consent as your ethics/GDPR process requires.

## After the event

- Final recordings are in `<your folder>/table-XX/`. One file per session, named `table-XX_<date>_<time>_<id>.webm|m4a`.
- Temporary `_parts_…` folders are moved to the Drive **trash** once merged. If one is still there an hour after the event, the session didn't finalize. See [Troubleshooting](#troubleshooting).
- To stop the scheduled cleanup, open the Apps Script project, select **`removeTrigger`** and click **Run**.
- `.webm` files play in Chrome, Firefox and VLC. To convert to MP3:
  `ffmpeg -i input.webm -b:a 64k output.mp3`

---

## Updating the backend code

If you change `Code.gs` **after** deploying, saving is not enough. You must publish a new version **under the same URL**:

1. **Deploy** → **Manage deployments**.
2. Select your deployment → click the pencil ✏️ **Edit**.
3. **Version:** choose **New version** → **Deploy**.

The `/exec` URL stays the same, so `index.html` doesn't need to change.
(Using **New deployment** instead would create a *different* URL.)

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Page says **"This link has no table number"** | The URL is missing `?table=XX`. Use the QR code or add it by hand. |
| Page says **"Setup incomplete: SCRIPT_URL / TOKEN is not configured"** | Fill in `CONFIG` in `index.html` (Step 6) and commit on GitHub. |
| Page says **"TOKEN does not match the server"** | The `TOKEN` in `index.html` and `Code.gs` differ. Fix one of them. If you changed `Code.gs`, publish a **new version** (see *Updating the backend code*). |
| Page keeps saying **"connection problem, retrying…"** | Check the phone's internet connection. Open the `/exec` URL in a browser: it must show `{"ok":true,...}`. If it asks you to sign in, the deployment's **Who has access** is not **Anyone**. Redeploy. |
| **"Microphone access was blocked"** | Allow the microphone for the site in the browser settings. On iPhone: *Settings → Safari → Microphone*. |
| **"This browser cannot record audio"** | Open the link in Chrome (Android) or Safari (iPhone), not inside an in-app browser (e.g. a messaging app). |
| `installTrigger` error **"Fill in CONFIG…"** | You haven't replaced the `PASTE_…` placeholders in `Code.gs`. |
| `installTrigger` error **"No item with the given ID could be found"** / access denied | Wrong `ROOT_FOLDER_ID`, or the folder belongs to another account. Copy the ID again (Step 1). |
| Chunks arrive but **no final file** appears | Wait up to 45 minutes. The scheduled cleanup merges abandoned sessions. Check **Executions** (left sidebar in Apps Script) for errors. You can also run `finalizeStaleSessions` manually. |
| Final `.m4a` from iPhone does not play everywhere | Try VLC, or convert with `ffmpeg -i in.m4a out.mp3`. |

To see server-side errors: in the Apps Script editor, open **Executions** (☰ list icon in the left sidebar).

---

## Security notes

- The **token** is visible in the public `index.html`. It only allows *uploading* audio to your folder. Nobody can read, list or delete your files through this script. Use a fresh token per event and change it afterwards if you like.
- The **folder ID** in `Code.gs` is not a secret by itself (the folder stays private), but if you prefer, don't upload `apps-script/Code.gs` to the public repository, or replace the values with placeholders before uploading.
- The script runs with **your** Google permissions. Only deploy code you've read.
- Apps Script has daily usage [quotas](https://developers.google.com/apps-script/guides/services/quotas) (executions, URL fetches, trigger runtime). They are comfortably enough for a typical workshop with a handful of tables for a few hours. For very large events, test with the real number of phones first.

## Configuration reference

**`Code.gs`**

| Setting | Default | Meaning |
|---|---|---|
| `ROOT_FOLDER_ID` | — | Drive folder that receives the recordings. |
| `TOKEN` | — | Shared secret. Must equal `TOKEN` in `index.html`. |
| `STALE_MINUTES` | `30` | A session with no new chunks for this long is finalized by the scheduled cleanup. |
| `TIMEZONE` | `Europe/Amsterdam` | Time zone used in file names. |

**`index.html`**

| Setting | Default | Meaning |
|---|---|---|
| `SCRIPT_URL` | — | The web app URL ending in `/exec`. |
| `TOKEN` | — | Shared secret. Must equal `TOKEN` in `Code.gs`. |
| `CHUNK_SECONDS` | `30` | How often a chunk is uploaded. At most this much audio is at risk if a phone dies. |
| `BITRATE` | `48000` | Audio bitrate in bits/s (~22 MB/hour at 48 kbps). |

**URL parameter:** `index.html?table=<id>` where `<id>` is letters, digits, `-` or `_` (max 20 chars). The older `?mesa=<id>` is still accepted, so previously printed QR codes keep working.
