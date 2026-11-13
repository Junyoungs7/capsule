// Drive the release app's webviews over CDP (no app code involved).
// Start Hera with:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'
// CLI:  node .omc/verify/cdp.mjs <surface> "<js expression>"   (prints the JSON result)
export const PORT = 9333

export async function page(surface) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const t = list.find((x) => x.type === 'page' && x.url.includes(`surface=${surface}`))
  if (!t) throw new Error(`no page for ${surface}: ${list.map((x) => x.url).join(', ')}`)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((ok, err) => ((ws.onopen = ok), (ws.onerror = err)))
  let n = 0
  const wait = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (wait.has(d.id)) wait.get(d.id)(d), wait.delete(d.id)
  }
  const send = (method, params = {}) => new Promise((ok) => (wait.set(++n, ok), ws.send(JSON.stringify({ id: n, method, params }))))
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
  return { send, evaluate, close: () => ws.close() }
}

// store write through the plugin commands (same path as the app's JS)
export const storeSet = (key, value) => `(async () => {
  const I = window.__TAURI_INTERNALS__
  const rid = await I.invoke('plugin:store|get_store', { path: 'hera.json' })
  return I.invoke('plugin:store|set', { rid, key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })
})()`

if (process.argv[1]?.endsWith('cdp.mjs') && process.argv[2]) {
  const p = await page(process.argv[2])
  console.log(JSON.stringify(await p.evaluate(process.argv[3])))
  p.close()
}
