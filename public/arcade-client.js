/*
 * Little Joy Arcade — drop-in account + cloud save client.
 *
 * One plain <script> gives any game (Phaser, React or vanilla, browser or
 * Electron) a sign-in panel and cross-device saves. No build step, no
 * framework, no game-code changes:
 *
 *   <script src="./arcade-client.js" data-game-id="jewel-match"></script>
 *
 * The public anon key is injected when this file is copied into a game; it is
 * safe to ship because every table is protected by row level security.
 *
 * How sync works: the client mirrors the game's Web Storage keys (everything
 * except its own `lja:` keys) into one `game_progress` row per player. On a new
 * device the newest cloud snapshot is restored and the page reloads once so the
 * game reads the restored save. Local edits always win until they are pushed;
 * only an untouched device accepts a cloud overwrite. Games with IndexedDB or
 * SQLite saves can opt in with window.LJA_SNAPSHOT (see docs).
 */
(function () {
  'use strict'

  if (window.LittleJoyArcade && window.LittleJoyArcade.__installed) return

  var script = document.currentScript || document.querySelector('script[data-game-id]')
  var GAME_ID = (script && script.dataset.gameId) || window.LJA_GAME_ID || 'unknown'
  var API = (script && script.dataset.supabaseUrl) || window.LJA_SUPABASE_URL || 'https://fqovramltegcfiyebyrt.supabase.co'
  var ANON = (script && script.dataset.anonKey) || window.LJA_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxb3ZyYW1sdGVnY2ZpeWVieXJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1ODk2ODcsImV4cCI6MjEwOTE2NTY4N30.q4sloqvE4VDSF7WCI2P7G5Wj9rxxi3ZkZTU_wX6M7YI'
  var CONFIGURED = ANON.indexOf('__LJA_') !== 0 && ANON.length > 40

  var SESSION_KEY = 'lja:session'
  var META_KEY = 'lja:mirror:' + GAME_ID
  var EXCLUDE = /^(lja:|sb-|supabase\.)/

  // Games hosted on the same origin share one localStorage (every github.io
  // build lives under jd4rider.github.io), so mirroring every key uploads
  // other games' saves and lets one game's sync overwrite another's. Only
  // mirror this game's own keys: declared with data-save-keys / LJA_SAVE_KEYS,
  // or named after the game (`<id>-save...`, dashes optional).
  var SAVE_KEYS = (function () {
    var raw = (script && script.dataset.saveKeys) || window.LJA_SAVE_KEYS || ''
    var list = Array.isArray(raw) ? raw : String(raw).split(',')
    return list
      .map(function (key) {
        return String(key).trim()
      })
      .filter(Boolean)
  })()
  var COMPACT_ID = GAME_ID.replace(/-/g, '')

  function ownKey(key) {
    if (SAVE_KEYS.length) return SAVE_KEYS.indexOf(key) !== -1
    return key.indexOf(GAME_ID + '-') === 0 || key.indexOf(COMPACT_ID + '-') === 0
  }

  var statusText = 'Not signed in'
  var root = null
  var ui = {}
  var busy = false

  // Portal handoff. The catalogue lives on littlejoyarcade.site while every
  // game runs on its own origin, so a signed-in player would otherwise have to
  // sign in again inside each game. Those are the only origins whose
  // `lja:session` messages are trusted; anything else is ignored.
  var PORTAL_ORIGINS = [
    'https://littlejoyarcade.site',
    'https://www.littlejoyarcade.site',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]
  var portalOrigin = null
  var viaPortal = false

  function url(path) {
    return API + path
  }

  function headers(token) {
    var out = { apikey: ANON, 'Content-Type': 'application/json' }
    if (token) out.Authorization = 'Bearer ' + token
    return out
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY)
      return raw ? JSON.parse(raw) : null
    } catch (error) {
      return null
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    } catch (error) {
      /* private mode: the session lives for this page only */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch (error) {
      /* ignore */
    }
  }

  // Tell the portal what this game did, so signing in (or out) here updates the
  // header on littlejoyarcade.site instead of leaving two separate accounts.
  function notifyPortal() {
    if (!portalOrigin) return
    var payload = { type: 'lja:auth', gameId: GAME_ID, session: loadSession() }
    try {
      if (window.parent !== window) window.parent.postMessage(payload, portalOrigin)
    } catch (error) {
      /* ignore */
    }
    // A game opened with "Open in new tab" is not embedded, so the portal is
    // its opener rather than its parent. Keep it in step too.
    try {
      if (window.opener && !window.opener.closed) window.opener.postMessage(payload, portalOrigin)
    } catch (error) {
      /* ignore */
    }
  }

  function adoptSession(session) {
    if (session && session.access_token && session.user) {
      var current = loadSession()
      var same = current && current.access_token === session.access_token
      saveSession(session)
      viaPortal = true
      if (!same) statusText = 'Signed in via Little Joy Arcade'
      render()
      syncNow('portal')
      return
    }
    if (!session && loadSession()) {
      clearSession()
      viaPortal = false
      statusText = 'Signed out'
      render()
    }
  }

  function listenForPortal() {
    window.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'lja:session') return
      if (PORTAL_ORIGINS.indexOf(event.origin) === -1) return
      portalOrigin = event.origin
      adoptSession(event.data.session || null)
    })
    var ready = { type: 'lja:ready', gameId: GAME_ID, configured: CONFIGURED }
    if (window.parent !== window) {
      try {
        window.parent.postMessage(ready, '*')
      } catch (error) {
        /* ignore */
      }
    }
    // Same handshake for a tab the portal opened: the opener answers with the
    // signed-in session, which this origin then keeps in localStorage.
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(ready, '*')
      } catch (error) {
        /* ignore */
      }
    }
  }

  function readMeta() {
    try {
      var raw = localStorage.getItem(META_KEY)
      return raw ? JSON.parse(raw) : null
    } catch (error) {
      return null
    }
  }

  function writeMeta(meta) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta))
    } catch (error) {
      /* ignore */
    }
  }

  function hash(value) {
    var h = 5381
    for (var i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) | 0
    return (h >>> 0).toString(36) + ':' + value.length
  }

  function snapshot() {
    if (typeof window.LJA_SNAPSHOT === 'function') {
      try {
        var custom = window.LJA_SNAPSHOT()
        if (custom && typeof custom === 'object') return custom
      } catch (error) {
        /* fall back to Web Storage */
      }
    }
    var out = {}
    try {
      for (var i = 0; i < localStorage.length; i += 1) {
        var key = localStorage.key(i)
        if (!key || EXCLUDE.test(key) || !ownKey(key)) continue
        out[key] = localStorage.getItem(key)
      }
    } catch (error) {
      return {}
    }
    return out
  }

  function applySnapshot(keys) {
    if (!keys || typeof keys !== 'object') return
    if (typeof window.LJA_APPLY_SNAPSHOT === 'function') {
      try {
        window.LJA_APPLY_SNAPSHOT(keys)
        return
      } catch (error) {
        /* fall through to Web Storage */
      }
    }
    Object.keys(keys).forEach(function (key) {
      try {
        localStorage.setItem(key, String(keys[key]))
      } catch (error) {
        /* quota */
      }
    })
  }

  function signedInUser() {
    var session = loadSession()
    return session && session.user ? session.user : null
  }

  async function accessToken() {
    var session = loadSession()
    if (!session) return null
    if (!session.access_token) return null
    if (!session.expires_at || Date.now() / 1000 < session.expires_at - 90) return session.access_token
    try {
      var res = await fetch(url('/auth/v1/token?grant_type=refresh_token'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      })
      if (!res.ok) {
        clearSession()
        return null
      }
      var data = await res.json()
      saveSession(Object.assign({}, session, data))
      return data.access_token
    } catch (error) {
      return session.access_token
    }
  }

  async function fetchRemote(token) {
    var user = signedInUser()
    if (!user) return null
    var query =
      '/rest/v1/game_progress?select=data,updated_at&game_id=eq.' +
      encodeURIComponent(GAME_ID) +
      '&user_id=eq.' +
      encodeURIComponent(user.id)
    var res = await fetch(url(query), { headers: headers(token) })
    if (!res.ok) throw new Error('cloud read failed (' + res.status + ')')
    var rows = await res.json()
    return rows && rows[0] ? rows[0] : null
  }

  async function pushSnapshot(snapshotValue) {
    var token = await accessToken()
    var user = signedInUser()
    if (!token || !user) return false
    var keys = snapshotValue || snapshot()
    var payload = {
      user_id: user.id,
      game_id: GAME_ID,
      schema_version: 1,
      data: { keys: keys, savedAt: Date.now() },
    }
    var res = await fetch(url('/rest/v1/game_progress?on_conflict=user_id,game_id'), {
      method: 'POST',
      headers: Object.assign(headers(token), {
        Prefer: 'resolution=merge-duplicates,return=representation',
      }),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      statusText = 'Cloud save failed (' + res.status + ')'
      render()
      return false
    }
    var rows = await res.json().catch(function () {
      return []
    })
    var row = rows && rows[0] ? rows[0] : null
    writeMeta({
      userId: user.id,
      hash: hash(JSON.stringify(keys)),
      serverAt: (row && row.updated_at) || new Date().toISOString(),
    })
    return true
  }

  async function syncNow(reason) {
    if (!CONFIGURED || busy || !signedInUser()) {
      render()
      return
    }
    busy = true
    statusText = 'Syncing…'
    render()
    try {
      var token = await accessToken()
      if (!token) {
        statusText = 'Session expired — sign in again'
        render()
        return
      }
      var meta = readMeta()
      var local = snapshot()
      var localHash = hash(JSON.stringify(local))
      var hasLocalKeys = Object.keys(local).length > 0
      // Having local keys is not the same as having new edits. On a first sync
      // (no meta for this device) the cloud copy wins, so a device that had
      // played before signing in can no longer publish its older save over a
      // newer one from another device. Only a device that changed since its
      // last sync is dirty.
      var dirty = meta ? localHash !== meta.hash : false

      if (dirty && hasLocalKeys) {
        // This device has changes: publish them. Never push an empty snapshot,
        // which would replace the cloud copy with nothing.
        var pushed = await pushSnapshot(local)
        statusText = pushed ? 'Saved to the cloud' : 'Could not reach the cloud'
        render()
        return
      }

      var row = await fetchRemote(token)
      if (row && row.data && row.data.keys && (!meta || Date.parse(row.updated_at) > Date.parse(meta.serverAt || 0))) {
        applySnapshot(row.data.keys)
        writeMeta({
          userId: signedInUser().id,
          hash: hash(JSON.stringify(snapshot())),
          serverAt: row.updated_at,
        })
        statusText = 'Restored from the cloud'
        render()
        var guard = 'lja:reloaded:' + GAME_ID
        if (!sessionStorage.getItem(guard)) {
          sessionStorage.setItem(guard, '1')
          setTimeout(function () {
            location.reload()
          }, 400)
          return
        }
      } else if (!row && hasLocalKeys) {
        await pushSnapshot(local)
        statusText = 'Saved to the cloud'
      } else {
        statusText = 'Up to date'
      }
      render()
      // A quiet note for debugging: keeps which pass ran visible in devtools.
      if (reason === 'poll') document.documentElement.dataset.ljaSync = statusText
    } catch (error) {
      statusText = 'Offline — saved locally'
      render()
    } finally {
      busy = false
    }
  }

  async function signIn(email, password) {
    if (!CONFIGURED) return { error: 'Cloud accounts are not configured in this game build.' }
    try {
      var res = await fetch(url('/auth/v1/token?grant_type=password'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: email.trim(), password: password }),
      })
      var data = await res.json().catch(function () {
        return {}
      })
      if (!res.ok) return { error: data.error_description || data.msg || data.error || 'Sign-in failed' }
      saveSession(data)
      viaPortal = false
      statusText = 'Signed in'
      render()
      await syncNow('sign-in')
      notifyPortal()
      return { error: null }
    } catch (error) {
      return { error: 'Could not reach Little Joy Arcade. Check your connection.' }
    }
  }

  async function signUp(email, password) {
    if (!CONFIGURED) return { error: 'Cloud accounts are not configured in this game build.', needsConfirmation: false }
    try {
      var res = await fetch(url('/auth/v1/signup'), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ email: email.trim(), password: password }),
      })
      var data = await res.json().catch(function () {
        return {}
      })
      if (!res.ok && !data.access_token) {
        return { error: data.error_description || data.msg || data.error || 'Could not create the account', needsConfirmation: false }
      }
      if (data.access_token) {
        saveSession(data)
        viaPortal = false
        statusText = 'Account created'
        render()
        await syncNow('sign-up')
        notifyPortal()
        return { error: null, needsConfirmation: false }
      }
      return { error: null, needsConfirmation: true }
    } catch (error) {
      return { error: 'Could not reach Little Joy Arcade. Check your connection.', needsConfirmation: false }
    }
  }

  async function signOut() {
    var session = loadSession()
    clearSession()
    viaPortal = false
    statusText = 'Signed out — progress stays on this device'
    render()
    notifyPortal()
    if (session && session.access_token) {
      fetch(url('/auth/v1/logout'), { method: 'POST', headers: headers(session.access_token) }).catch(function () {})
    }
  }

  function el(tag, props, children) {
    var node = document.createElement(tag)
    Object.keys(props || {}).forEach(function (key) {
      if (key === 'style') node.setAttribute('style', props[key])
      else if (key === 'text') node.textContent = props[key]
      else node.setAttribute(key, props[key])
    })
    ;(children || []).forEach(function (child) {
      if (child) node.appendChild(child)
    })
    return node
  }

  function render() {
    if (!ui.panel) return
    var user = signedInUser()
    ui.signedOut.hidden = !!user
    ui.signedIn.hidden = !user
    ui.who.textContent = user ? user.email || 'Signed in' : ''
    if (user && viaPortal && !/synced|saved to the cloud|up to date|offline|syncing/i.test(statusText)) {
      statusText = 'Signed in via Little Joy Arcade'
    }
    ui.status.textContent = statusText
    ui.toggle.textContent = user ? '✓' : '👤'
    ui.toggle.title = user ? 'Little Joy account — ' + (user.email || 'signed in') : 'Sign in to save across devices'
    ui.status.setAttribute('aria-live', 'polite')
  }

  function buildUi() {
    root = document.createElement('div')
    root.setAttribute('data-lja-client', GAME_ID)
    root.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483000;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif'
    var shadow = root.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent =
      '.btn{pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:999px;cursor:pointer;font:inherit}' +
      '.toggle{width:42px;height:42px;background:#151525;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18);font-size:18px}' +
      '.toggle:focus-visible{outline:2px solid #fbbf24;outline-offset:2px}' +
      '.panel{pointer-events:auto;margin-top:10px;width:286px;box-sizing:border-box;background:#12121f;color:#f4f4f8;border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:14px;box-shadow:0 18px 50px rgba(0,0,0,.45)}' +
      '.panel[hidden]{display:none}' +
      '.panel h2{margin:0 0 2px;font-size:14px;letter-spacing:.2px}' +
      '.sub{margin:0 0 10px;font-size:11px;color:#9ca3b8;line-height:1.5}' +
      'label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8b93a9;margin:8px 0 4px}' +
      'input{width:100%;box-sizing:border-box;background:#0b0b14;color:#f4f4f8;border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:8px 10px;font:inherit;font-size:13px}' +
      'input:focus{outline:none;border-color:#fbbf24}' +
      '.primary{width:100%;margin-top:10px;background:#fbbf24;color:#231a04;padding:9px;font-weight:700;font-size:13px}' +
      '.primary:disabled{opacity:.5;cursor:default}' +
      '.link{width:100%;margin-top:6px;background:transparent;color:#9ca3b8;padding:6px;font-size:11px;text-decoration:underline;pointer-events:auto}' +
      '.row{display:flex;gap:6px;margin-top:8px}' +
      '.row .btn{flex:1;background:#23233a;color:#f4f4f8;padding:7px;font-size:11px}' +
      '.status{margin-top:9px;font-size:11px;color:#9ca3b8;min-height:14px}' +
      '.who{margin:0 0 6px;font-size:12px;font-weight:600;word-break:break-all}' +
      '.close{position:absolute;top:8px;right:10px;background:transparent;color:#8b93a9;font-size:16px;padding:4px}'
    shadow.appendChild(style)

    var toggle = el('button', { class: 'btn toggle', type: 'button', 'aria-label': 'Little Joy account', title: 'Sign in to save across devices' }, [
      document.createTextNode('👤'),
    ])

    var panel = el('div', { class: 'panel', hidden: 'hidden', role: 'dialog', 'aria-label': 'Little Joy account' })
    panel.style.position = 'relative'
    var close = el('button', { class: 'btn close', type: 'button', 'aria-label': 'Close account panel' }, [document.createTextNode('×')])

    var title = el('h2', { text: 'Little Joy account' })
    var sub = el('p', { class: 'sub', text: 'One login for every game. Progress syncs when you are signed in; the game never needs it.' })

    var email = el('input', { id: 'lja-email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com', 'aria-label': 'Email' })
    var password = el('input', { id: 'lja-password', type: 'password', autocomplete: 'current-password', placeholder: '••••••••', 'aria-label': 'Password' })

    var signInBtn = el('button', { class: 'btn primary', id: 'lja-signin', type: 'button', text: 'Sign in' })
    var createBtn = el('button', { class: 'btn link', id: 'lja-signup', type: 'button', text: 'New here? Create an account' })
    var status = el('p', { class: 'status', id: 'lja-status' })

    var signedOut = el('div', {}, [
      el('label', { for: 'lja-email', text: 'Email' }),
      email,
      el('label', { for: 'lja-password', text: 'Password' }),
      password,
      signInBtn,
      createBtn,
      status,
    ])

    var who = el('p', { class: 'who' })
    var signedIn = el('div', { hidden: 'hidden' }, [
      who,
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', type: 'button', text: 'Sync now', onclick: null }),
        el('button', { class: 'btn', type: 'button', text: 'Sign out' }),
      ]),
      status,
    ])
    var rowButtons = signedIn.querySelectorAll('.row .btn')
    rowButtons[0].addEventListener('click', function () {
      syncNow('manual')
    })
    rowButtons[1].addEventListener('click', function () {
      signOut()
    })

    panel.appendChild(close)
    panel.appendChild(title)
    panel.appendChild(sub)
    panel.appendChild(signedOut)
    panel.appendChild(signedIn)

    close.addEventListener('click', function () {
      panel.hidden = true
    })
    toggle.addEventListener('click', function () {
      panel.hidden = !panel.hidden
      if (!panel.hidden) email.focus()
    })

    var pending = false
    signInBtn.addEventListener('click', async function () {
      if (pending) return
      if (!email.value.trim() || !password.value) {
        status.textContent = 'Enter your email and password.'
        return
      }
      pending = true
      signInBtn.disabled = true
      status.textContent = 'Signing in…'
      var result = await signIn(email.value, password.value)
      pending = false
      signInBtn.disabled = false
      if (result.error) status.textContent = result.error
      else {
        password.value = ''
        render()
      }
    })

    createBtn.addEventListener('click', async function () {
      if (pending) return
      if (!email.value.trim() || password.value.length < 6) {
        status.textContent = 'Use an email and a password of at least 6 characters.'
        return
      }
      pending = true
      createBtn.disabled = true
      status.textContent = 'Creating your account…'
      var result = await signUp(email.value, password.value)
      pending = false
      createBtn.disabled = false
      if (result.error) status.textContent = result.error
      else if (result.needsConfirmation) status.textContent = 'Check your email to confirm, then sign in.'
      else {
        password.value = ''
        render()
      }
    })

    password.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') signInBtn.click()
    })

    shadow.appendChild(toggle)
    shadow.appendChild(panel)
    document.body.appendChild(root)

    ui = { toggle: toggle, panel: panel, email: email, password: password, status: status, who: who, signedOut: signedOut, signedIn: signedIn }
    render()
  }

  function install() {
    if (!CONFIGURED) {
      // Never show a button that cannot work.
      return
    }
    listenForPortal()
    buildUi()
    if (new URLSearchParams(location.search).get('lja') === 'login' || location.hash === '#login') {
      ui.panel.hidden = false
    }
    if (signedInUser()) syncNow('start')
    setInterval(function () {
      syncNow('poll')
    }, 12000)
    window.addEventListener('focus', function () {
      syncNow('focus')
    })
    window.addEventListener('online', function () {
      syncNow('online')
    })
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        var meta = readMeta()
        var keys = snapshot()
        if (signedInUser() && meta && hash(JSON.stringify(keys)) !== meta.hash) pushSnapshot(keys).catch(function () {})
      }
    })
  }

  window.LittleJoyArcade = {
    __installed: true,
    gameId: GAME_ID,
    configured: CONFIGURED,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    syncNow: syncNow,
    push: function () {
      return pushSnapshot(snapshot())
    },
    snapshot: snapshot,
    user: signedInUser,
    status: function () {
      return { text: statusText, signedIn: !!signedInUser() }
    },
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install)
  } else {
    install()
  }
})()
