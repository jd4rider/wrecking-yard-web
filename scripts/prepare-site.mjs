#!/usr/bin/env node
/*
 * Turn the Unity export into a static site GitHub Pages can actually serve.
 *
 * Unity's default WebGL export Brotli-compresses the payload and expects the web
 * server to send `Content-Encoding: br` for those files. GitHub Pages does not
 * let you set response headers, so a compressed export arrives as raw Brotli
 * bytes and the loader dies before the first frame. This script copies the
 * export into `site/`, writes the payload out uncompressed, points index.html at
 * those files, and scales the fixed 900 x 1600 play area to the window.
 *
 *   node scripts/prepare-site.mjs
 *
 * `build/` is the untouched Unity export (12 MB). `site/` is generated and not
 * committed; CI rebuilds it on every push.
 */
import { brotliDecompressSync } from 'node:zlib'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'build/WebGL')
const site = join(root, 'site')
const play = join(site, 'play')
const publicDir = join(root, 'public')

/** Must match the public.games row and the manifest. */
const GAME_ID = 'wrecking-yard'

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** The 9:16 canvas is scaled to fit the window instead of overflowing it. */
const FIT_MARKER = 'fitToWindow'
const FIT_SCRIPT = `        // The play area is a fixed 9:16 window in the Unity template; scale it to
        // whatever screen it is opened on so the whole board stays visible.
        // Injected by scripts/prepare-site.mjs.
        var fitToWindow = function () {
          var aspect = 900 / 1600;
          var width = Math.min(window.innerWidth, window.innerHeight * aspect);
          var height = width / aspect;
          fullscreenContainer.style.width = Math.floor(width) + "px";
          fullscreenContainer.style.height = Math.floor(height) + "px";
        };
        fitToWindow();
        window.addEventListener("resize", fitToWindow);`

const LANDING = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Wrecking Yard</title>
    <meta http-equiv="refresh" content="0;url=./play/">
    <style>
      html, body { margin: 0; height: 100%; }
      body {
        display: grid; place-items: center; background: #17120f; color: #f4e6d4;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { text-align: center; padding: 24px; }
      a { color: #ffc45c; }
    </style>
  </head>
  <body>
    <main>
      <h1>Wrecking Yard</h1>
      <p><a href="./play/">Play</a></p>
    </main>
  </body>
</html>
`

async function main() {
  const buildInfo = await stat(source).catch(() => null)
  if (!buildInfo?.isDirectory()) throw new Error(`missing Unity export at ${source}`)

  await rm(site, { recursive: true, force: true })
  await mkdir(site, { recursive: true })
  await cp(source, play, { recursive: true })

  // 1. Brotli payload -> plain files the browser can read without a header.
  //    An export that already ships uncompressed files is left alone.
  const buildDir = join(play, 'Build')
  const entries = await readdir(buildDir)
  const packedFiles = entries.filter((entry) => entry.endsWith('.br'))
  let compressed = 0
  let expanded = 0
  for (const entry of packedFiles) {
    const packed = join(buildDir, entry)
    const bytes = await readFile(packed)
    const plain = brotliDecompressSync(bytes)
    compressed += bytes.byteLength
    expanded += plain.byteLength
    await writeFile(plainPath(packed), plain)
    await rm(packed)
  }
  if (packedFiles.length === 0) {
    console.log('payload is already uncompressed: nothing to expand')
  } else {
    console.log(`decompressed ${packedFiles.length} files, ${mb(compressed)} -> ${mb(expanded)}`)
  }

  // 2. Point the loader at the uncompressed names.
  const indexPath = join(play, 'index.html')
  let html = await readFile(indexPath, 'utf8')
  const before = (html.match(/\.br"/g) ?? []).length
  if (before !== packedFiles.length) {
    throw new Error(`index.html references ${before} .br files but the build has ${packedFiles.length}`)
  }
  html = html.replaceAll('.br"', '"')

  // 3. Fit the canvas to the window.
  const fixed = `        fullscreenContainer.style.width = "900px";\n        fullscreenContainer.style.height = "1600px";`
  if (!html.includes(fixed)) throw new Error('Unity template changed: could not find the fixed canvas size')
  html = html.replace(fixed, FIT_SCRIPT)
  if (!html.includes(FIT_MARKER)) throw new Error('canvas fit patch did not apply')
  // 4b. The arcade account layer. The drop-in client is copied next to the build and
  //     its tag injected, so the game shares the signed-in session of the portal it is
  //     embedded in. A Unity re-export replaces index.html, so this is also the step
  //     that has to fail loudly if the tag goes missing.
  const clientFrom = join(publicDir, 'arcade-client.js')
  const clientInfo = await stat(clientFrom).catch(() => null)
  if (!clientInfo?.isFile()) throw new Error('missing public/arcade-client.js')
  await cp(clientFrom, join(play, 'arcade-client.js'))

  const accountTag = `<script src="./arcade-client.js" data-game-id="${GAME_ID}"></script>`
  if (!html.includes(accountTag)) {
    if (!html.includes('</body>')) throw new Error('index.html has no </body> to inject the account tag before')
    html = html.replace('</body>', `  ${accountTag}\n  </body>`)
    // The client pins its account pill to the bottom-left, exactly where the Unity
    // footer's logo sits; lift it clear of the footer.
    if (!html.includes('[data-lja-client]')) {
      html = html.replace(
        '</head>',
        `  <style>
      [data-lja-client] { bottom: 46px !important; }
    </style>
  </head>`,
      )
    }
  }
  if (!html.includes(accountTag)) throw new Error('site/play/index.html is missing the account tag')

  await writeFile(indexPath, html)

  await writeFile(join(site, 'index.html'), LANDING)

  // 4. Fail loudly here rather than in a player's console.
  const required = ['Build/WebGL.loader.js', 'Build/WebGL.data', 'Build/WebGL.wasm', 'Build/WebGL.framework.js', 'TemplateData/style.css']
  for (const file of required) {
    const info = await stat(join(play, file)).catch(() => null)
    if (!info?.isFile()) throw new Error(`site/play/${file} is missing from the build`)
  }
  const loader = await readFile(join(play, 'index.html'), 'utf8')
  if (loader.includes('.br"')) throw new Error('index.html still references compressed payload')
  console.log('site/ is ready: site/play/ serves the Unity build')
}

/** `WebGL.data.br` -> `WebGL.data` (path only, the extension comes off). */
function plainPath(path) {
  return path.slice(0, -'.br'.length)
}

main().catch((error) => {
  console.error(`prepare-site failed: ${error.message}`)
  process.exit(1)
})

export { plainPath }
