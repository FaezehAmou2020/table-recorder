/**
 * Table Recorder — backend (Google Apps Script)
 *
 * Receives audio chunks from the recording page (index.html), stores them in
 * your Google Drive and, when a session ends, merges them into a single audio
 * file.
 *
 * Drive layout:
 *   <root folder>/table-07/table-07_2026-10-05_14-03_ab12.webm   (final recording)
 *   <root folder>/table-07/_parts_<session>/                      (temporary, trashed after merge)
 *
 * Setup: see README.md.
 */

const CONFIG = {
  // ID of the Drive folder that will hold the recordings
  // (the last part of the folder URL: https://drive.google.com/drive/folders/<ID>).
  ROOT_FOLDER_ID: 'PASTE_YOUR_DRIVE_FOLDER_ID_HERE',
  // Shared secret between the page and this script. Use the SAME value in index.html.
  TOKEN: 'PASTE_A_RANDOM_TOKEN_HERE',
  // Sessions with no new chunks for this long are finalized automatically.
  STALE_MINUTES: 30,
  // Time zone used in the final file names.
  TIMEZONE: 'Europe/Amsterdam',
};

const TABLE_PREFIX = 'table-';
const PARTS_PREFIX = '_parts_';
const PART_NAME_RE = /^part_\d+$/;
const LOCK_TIMEOUT_MS = 25000;
const FINALIZE_RETRY_MS = 10 * 60000; // a stuck merge may be retried after 10 minutes
const CACHE_TTL_SECONDS = 21600;      // 6 hours (CacheService maximum)
const TRIGGER_EVERY_MINUTES = 15;

/* ---------------- Web app endpoints ---------------- */

/** Health check: opening the /exec URL in a browser should return {"ok":true,...}. */
function doGet() {
  return json_({ ok: true, service: 'table-recorder' });
}

/**
 * Single POST endpoint. Body (JSON sent as text/plain):
 *   { token, table, session, action: 'chunk', seq, mime, data(base64) }
 *   { token, table, session, action: 'finish' }
 */
function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.token !== CONFIG.TOKEN) return json_({ ok: false, error: 'token' });

    const tableId = sanitize_(req.table);
    const session = sanitize_(req.session);
    if (!tableId || !session) return json_({ ok: false, error: 'params' });

    if (req.action === 'chunk') return json_(saveChunk_(tableId, session, req));
    if (req.action === 'finish') return json_(finishSession_(tableId, session));
    return json_({ ok: false, error: 'action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err) });
  }
}

/* ---------------- Chunks ---------------- */

function saveChunk_(tableId, session, req) {
  const seq = parseInt(req.seq, 10);
  if (!(seq >= 0) || !req.data) return { ok: false, error: 'chunk' };

  const partsFolder = getPartsFolder_(tableId, session, req.mime);
  const name = 'part_' + String(seq).padStart(6, '0');

  // A re-sent chunk (e.g. the response was lost on the way back) is not duplicated.
  if (partsFolder.getFilesByName(name).hasNext()) return { ok: true, dup: true };

  const bytes = Utilities.base64Decode(req.data);
  partsFolder.createFile(Utilities.newBlob(bytes, 'application/octet-stream', name));
  return { ok: true };
}

/** Returns (creating if needed) the temporary folder that holds a session's chunks. */
function getPartsFolder_(tableId, session, mime) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'pf_' + session;
  const cachedId = cache.get(cacheKey);
  if (cachedId) {
    try {
      const folder = DriveApp.getFolderById(cachedId);
      if (!folder.isTrashed()) return folder;
    } catch (e) { /* folder is gone: recreate it below */ }
  }

  return withLock_(function () {
    const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
    const tableFolder = getOrCreateFolder_(root, TABLE_PREFIX + tableId);
    const partsName = PARTS_PREFIX + session;
    let folder = findFolder_(tableFolder, partsName);
    if (!folder) {
      folder = tableFolder.createFolder(partsName);
      writeMeta_(folder, {
        table: tableId,
        session: session,
        mime: String(mime || ''),
        created: new Date().toISOString(),
      });
    }
    cache.put(cacheKey, folder.getId(), CACHE_TTL_SECONDS);
    return folder;
  });
}

/* ---------------- Finalizing a session ---------------- */

function finishSession_(tableId, session) {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const tableFolder = findFolder_(root, TABLE_PREFIX + tableId);
  if (!tableFolder) return { ok: true, empty: true };
  const partsFolder = findFolder_(tableFolder, PARTS_PREFIX + session);
  if (!partsFolder) return { ok: true, already: true };
  return finalize_(tableFolder, partsFolder);
}

function finalize_(tableFolder, partsFolder) {
  // Prevents the page's "finish" request and the scheduled cleanup from merging
  // the same session at the same time.
  const meta = withLock_(function () {
    if (partsFolder.isTrashed()) return null;
    const m = readMeta_(partsFolder);
    if (m.finalizing && Date.now() - m.finalizing < FINALIZE_RETRY_MS) return { inProgress: true };
    m.finalizing = Date.now();
    writeMeta_(partsFolder, m);
    return m;
  });

  if (!meta) return { ok: true, already: true };
  if (meta.inProgress) return { ok: true, inProgress: true };
  return mergeParts_(partsFolder, tableFolder, meta);
}

/**
 * Merges the chunks into one file with a Drive API "resumable" upload,
 * sending blocks of ~8 MB so Apps Script does not run out of memory.
 */
function mergeParts_(partsFolder, tableFolder, meta) {
  const parts = listParts_(partsFolder);
  if (!parts.length) {
    partsFolder.setTrashed(true);
    return { ok: true, empty: true };
  }

  const format = audioFormat_(meta.mime);
  const started = meta.created ? new Date(meta.created) : new Date();
  const stamp = Utilities.formatDate(started, CONFIG.TIMEZONE, 'yyyy-MM-dd_HH-mm');
  const name = TABLE_PREFIX + meta.table + '_' + stamp + '_' + String(meta.session).slice(-4) + '.' + format.ext;
  const total = parts.reduce(function (sum, f) { return sum + f.getSize(); }, 0);

  const uploadUrl = startResumableUpload_(name, tableFolder.getId(), format.mime, total);

  const UNIT = 256 * 1024;     // every non-final block must be a multiple of 256 KB
  const FLUSH_AT = 32 * UNIT;  // send roughly every 8 MB
  let buffer = [];
  let offset = 0;

  function sendBlock(bytes, isLast) {
    const end = offset + bytes.length - 1;
    const resp = UrlFetchApp.fetch(uploadUrl, {
      method: 'put',
      contentType: format.mime,
      payload: bytes,
      headers: { 'Content-Range': 'bytes ' + offset + '-' + end + '/' + total },
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    const expected = isLast ? (code === 200 || code === 201) : code === 308;
    if (!expected) throw new Error('Upload failed (' + code + '): ' + resp.getContentText());
    offset += bytes.length;
  }

  parts.forEach(function (file) {
    buffer = buffer.concat(file.getBlob().getBytes());
    if (buffer.length >= FLUSH_AT) {
      // Always keep at least 1 byte back for the final request.
      const n = Math.floor((buffer.length - 1) / UNIT) * UNIT;
      if (n > 0) {
        sendBlock(buffer.slice(0, n), false);
        buffer = buffer.slice(n);
      }
    }
  });
  sendBlock(buffer, true);

  partsFolder.setTrashed(true);
  return { ok: true, file: name };
}

function listParts_(partsFolder) {
  const parts = [];
  const it = partsFolder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (PART_NAME_RE.test(f.getName()) && !f.isTrashed()) parts.push(f);
  }
  // Names are zero-padded, so alphabetical order == recording order.
  parts.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });
  return parts;
}

/** Maps the browser's MediaRecorder MIME type to a file extension and MIME type. */
function audioFormat_(mime) {
  const raw = String(mime || '').split(';')[0] || 'audio/webm';
  if (raw.indexOf('mp4') >= 0) return { ext: 'm4a', mime: 'audio/mp4' }; // iPhone / Safari
  if (raw.indexOf('ogg') >= 0) return { ext: 'ogg', mime: raw };
  return { ext: 'webm', mime: raw };                                      // Android / Chrome
}

function startResumableUpload_(name, parentId, mime, totalBytes) {
  const resp = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(totalBytes),
      },
      payload: JSON.stringify({ name: name, parents: [parentId], mimeType: mime }),
      muteHttpExceptions: true,
    }
  );
  if (resp.getResponseCode() !== 200) {
    throw new Error('Could not start upload: ' + resp.getResponseCode() + ' ' + resp.getContentText());
  }
  const headers = resp.getHeaders();
  return headers.Location || headers.location;
}

/* ---------------- Scheduled cleanup ---------------- */

/**
 * Finalizes sessions where the phone died or the page was closed without
 * tapping "End session". Runs on a time-driven trigger (see installTrigger).
 */
function finalizeStaleSessions() {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const cutoff = Date.now() - CONFIG.STALE_MINUTES * 60000;
  const tables = root.getFolders();
  while (tables.hasNext()) {
    const tableFolder = tables.next();
    if (tableFolder.isTrashed()) continue;
    const subfolders = tableFolder.getFolders();
    while (subfolders.hasNext()) {
      const partsFolder = subfolders.next();
      if (partsFolder.isTrashed() || partsFolder.getName().indexOf(PARTS_PREFIX) !== 0) continue;
      if (lastActivity_(partsFolder) < cutoff) {
        try { finalize_(tableFolder, partsFolder); } catch (e) { console.error(partsFolder.getName(), e); }
      }
    }
  }
}

function lastActivity_(partsFolder) {
  let last = partsFolder.getDateCreated().getTime();
  const files = partsFolder.getFiles();
  while (files.hasNext()) last = Math.max(last, files.next().getDateCreated().getTime());
  return last;
}

/**
 * Run ONCE from the editor: authorizes the script and schedules the cleanup
 * every 15 minutes. Safe to run again (it replaces the existing trigger).
 */
function installTrigger() {
  if (CONFIG.ROOT_FOLDER_ID.indexOf('PASTE_') === 0 || CONFIG.TOKEN.indexOf('PASTE_') === 0) {
    throw new Error('Fill in CONFIG.ROOT_FOLDER_ID and CONFIG.TOKEN at the top of Code.gs first.');
  }
  DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID).getName();  // checks access to the folder
  UrlFetchApp.getRequest('https://www.googleapis.com/');     // requests the network permission
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'finalizeStaleSessions'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('finalizeStaleSessions').timeBased().everyMinutes(TRIGGER_EVERY_MINUTES).create();
  console.log('All set: folder is accessible and automatic cleanup is scheduled.');
}

/** Optional: run after the event to stop the scheduled cleanup. */
function removeTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'finalizeStaleSessions'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  console.log('Scheduled cleanup removed.');
}

/* ---------------- Utilities ---------------- */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Session metadata is stored as JSON in the parts folder's description. */
function readMeta_(folder) {
  return JSON.parse(folder.getDescription() || '{}');
}

function writeMeta_(folder, meta) {
  folder.setDescription(JSON.stringify(meta));
}

function findFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    const folder = it.next();
    if (!folder.isTrashed()) return folder;
  }
  return null;
}

function getOrCreateFolder_(parent, name) {
  return findFolder_(parent, name) || parent.createFolder(name);
}

function sanitize_(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
