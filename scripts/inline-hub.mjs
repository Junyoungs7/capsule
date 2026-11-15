// 허브 시안 한 파일 빌드: vite build → JS/CSS 를 HTML 하나에 인라인 (아티팩트용). 사용: node scripts/inline-hub.mjs <out.html>
import { build } from 'vite'
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const out = resolve(process.argv[2] ?? 'hub.html')
const dir = join(tmpdir(), 'hera-hub-build-' + process.pid)
await build({ base: './', logLevel: 'warn', build: { outDir: dir, emptyOutDir: true, assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false } })
const assets = join(dir, 'assets')
const files = readdirSync(assets)
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8'))
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8'))
if (js.length !== 1) throw new Error('JS 청크가 1개가 아님: ' + js.length)
const html = `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=1440"><title>Hera Island 허브</title><style>${css.join('\n')}</style><script>window.__HERA_SURFACE='hub'</script></head><body><div id="root"></div><script type="module">${js[0].replace(/<\/script/gi, '<\/script')}</script></body></html>`
writeFileSync(out, html)
rmSync(dir, { recursive: true, force: true })
console.log(out, (html.length / 1024).toFixed(0) + 'KB')
