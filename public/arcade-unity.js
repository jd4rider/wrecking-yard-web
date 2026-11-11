/*
 * Little Joy Arcade — Unity save bridge.
 *
 * Unity WebGL keeps everything a game persists in its own filesystem:
 * PlayerPrefs and any file written under Application.persistentDataPath. That
 * filesystem is backed by the `/idbfs` IndexedDB database, which the page can
 * read and write even though these exports ship no compiled save hook.
 *
 * The arcade client calls two globals:
 *
 *   LJA_SNAPSHOT()        -> the player's save files, as base64
 *   LJA_APPLY_SNAPSHOT()  <- a snapshot restored from another device
 *
 * A restore is handed back through localStorage as well, because the client
 * reloads the page right after applying one; the write to IndexedDB can lose
 * that race, so the next boot finishes the job and reloads once more.
 *
 *   <script src="./arcade-unity.js" data-game-id="..."></script>
 *
 * It must come before the Unity template script, so it can keep the instance
 * and read the live filesystem once the engine boots.
 */
(function () {
  'use strict'

  var tag = document.currentScript
  var GAME = (tag && tag.dataset && tag.dataset.gameId) || window.LJA_GAME_ID || 'unknown'
  var DB_NAME = '/idbfs'
  var STORE = 'FILE_DATA'
  var SNAPSHOT_KEY = 'unity-fs'
  var PENDING_KEY = 'lja:unity-restore:' + GAME
  var RESTORE_GUARD = 'lja:unity-restored:' + GAME
  // A save is not a media library; cap it rather than pushing a huge row.
  var MAX_BYTES = 2 * 1024 * 1024

  var files = {}
  var fs = null

  function encode(bytes) {
    var out = ''
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(out)
  }

  function decode(text) {
    var raw = atob(text)
    var bytes = new Uint8Array(raw.length)
    for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
    return bytes
  }

  function readPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY)
      if (!raw) return null
      var parsed = JSON.parse(raw)
      return parsed && parsed.files ? parsed : null
    } catch (error) {
      return null
    }
  }

  function clearPending() {
    try {
      localStorage.removeItem(PENDING_KEY)
    } catch (error) {
      /* ignore */
    }
  }

  // The Unity template keeps its instance in a local variable; wrap the loader
  // factory so this file holds a reference. With it we get Emscripten's FS and
  // read the game's live files rather than waiting for a flush to IndexedDB.
  var factory = window.createUnityInstance
  if (typeof factory === 'function') {
    window.createUnityInstance = function () {
      return factory.apply(null, arguments).then(function (created) {
        fs = created && created.Module ? created.Module.FS : null
        return created
      })
    }
  }

  function readTree(FS) {
    var out = {}
    var total = 0
    var walk = function (dir, depth) {
      if (depth > 4 || total > MAX_BYTES) return
      var entries
      try {
        entries = FS.readdir(dir)
      } catch (error) {
        return
      }
      for (var i = 0; i < entries.length; i += 1) {
        var name = entries[i]
        if (name === '.' || name === '..') continue
        var path = dir + '/' + name
        var stat
        try {
          stat = FS.stat(path)
        } catch (error) {
          continue
        }
        if (FS.isDir(stat.mode)) {
          out[path] = { m: stat.mode, t: stat.mtime ? new Date(stat.mtime).toISOString() : null, dir: true }
          walk(path, depth + 1)
          continue
        }
        if (total > MAX_BYTES) return
        var bytes
        try {
          bytes = FS.readFile(path)
        } catch (error) {
          continue
        }
        total += bytes.length
        out[path] = { m: stat.mode, t: stat.mtime ? new Date(stat.mtime).toISOString() : null, d: encode(bytes) }
      }
    }
    walk('/idbfs', 0)
    return out
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME)
      request.onupgradeneeded = function () {
        var db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      }
      request.onsuccess = function () {
        resolve(request.result)
      }
      request.onerror = function () {
        reject(request.error)
      }
    })
  }

  function readIdb() {
    return openDb().then(function (db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.close()
        return {}
      }
      return new Promise(function (resolve, reject) {
        var out = {}
        var tx = db.transaction(STORE, 'readonly')
        var request = tx.objectStore(STORE).openCursor()
        request.onsuccess = function () {
          var cursor = request.result
          if (!cursor) return
          var value = cursor.value || {}
          if (value.contents && value.contents.length) {
            out[cursor.key] = {
              m: value.mode,
              t: value.timestamp ? new Date(value.timestamp).toISOString() : null,
              d: encode(value.contents),
            }
          } else {
            out[cursor.key] = { m: value.mode, t: value.timestamp ? new Date(value.timestamp).toISOString() : null, dir: true }
          }
          cursor.continue()
        }
        tx.oncomplete = function () {
          db.close()
          resolve(out)
        }
        tx.onerror = function () {
          db.close()
          reject(tx.error)
        }
      })
    })
  }

  function writeIdb(incoming) {
    return openDb().then(function (db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite')
        var store = tx.objectStore(STORE)
        Object.keys(incoming).forEach(function (path) {
          var record = incoming[path]
          if (!record) return
          var value = {
            timestamp: record.t ? new Date(record.t) : new Date(),
            mode: record.m || (record.dir ? 16877 : 33188),
            contents: record.dir ? undefined : decode(record.d || ''),
          }
          // IndexedDB rejects `undefined` fields differently across engines, so
          // build the record explicitly.
          if (record.dir) store.put({ timestamp: value.timestamp, mode: value.mode }, path)
          else store.put(value, path)
        })
        tx.oncomplete = function () {
          db.close()
          resolve(true)
        }
        tx.onerror = function () {
          db.close()
          reject(tx.error)
        }
      })
    })
  }

  function makeDirs(FS, path) {
    var parts = path.split('/')
    parts.pop()
    var current = ''
    for (var i = 0; i < parts.length; i += 1) {
      current += (i === 0 ? '' : '/') + parts[i]
      if (!current) continue
      try {
        FS.mkdir(current)
      } catch (error) {
        /* already there */
      }
    }
  }

  function writeFs(incoming) {
    Object.keys(incoming).forEach(function (path) {
      var record = incoming[path]
      if (!record) return
      try {
        if (record.dir) {
          FS.mkdir(path)
          return
        }
        makeDirs(fs, path)
        fs.writeFile(path, decode(record.d || ''))
      } catch (error) {
        /* skip a path the game no longer allows */
      }
    })
    if (typeof fs.syncfs === 'function') {
      try {
        fs.syncfs(false, function () {
          clearPending()
        })
      } catch (error) {
        /* the pending copy still lands on the next boot */
      }
    }
  }

  window.LJA_SNAPSHOT = function () {
    if (fs) files = readTree(fs)
    var paths = Object.keys(files)
    if (paths.length === 0) return {}
    var payload = {}
    for (var i = 0; i < paths.length; i += 1) payload[paths[i]] = files[paths[i]]
    return { 'unity-fs': JSON.stringify({ files: payload }) }
  }

  window.LJA_APPLY_SNAPSHOT = function (keys) {
    var raw = keys && keys[SNAPSHOT_KEY]
    if (typeof raw !== 'string') return
    var parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return
    }
    if (!parsed || !parsed.files) return
    try {
      localStorage.setItem(PENDING_KEY, raw)
    } catch (error) {
      /* still try the direct write */
    }
    if (fs) writeFs(parsed.files)
    else writeIdb(parsed.files).catch(function () {})
  }

  function refresh() {
    if (fs) {
      files = readTree(fs)
      return
    }
    readIdb()
      .then(function (read) {
        files = read
      })
      .catch(function () {})
  }

  function boot() {
    // A restore handed over by the previous page may not have reached IndexedDB
    // before the reload. Finish it, then reload once so Unity boots on it.
    var pending = readPending()
    if (pending) {
      var done = fs ? Promise.resolve(writeFs(pending.files)) : writeIdb(pending.files)
      done
        .then(function () {
          clearPending()
          var guard = RESTORE_GUARD + ':' + Object.keys(pending.files).length
          try {
            if (sessionStorage.getItem(guard)) return
            sessionStorage.setItem(guard, '1')
          } catch (error) {
            /* reload anyway; pending is gone so this cannot loop */
          }
          location.reload()
        })
        .catch(function () {})
    }
    refresh()
    setInterval(refresh, 2000)
    window.addEventListener('pagehide', refresh)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') refresh()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
