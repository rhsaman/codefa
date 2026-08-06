/** Full-screen region-selection overlay for screenshot capture.
 *
 * Loaded into a transparent, frameless BrowserWindow sized to the display.
 * Shows the captured screen image full-bleed; the user drags a rectangle and
 * the chosen rect (in window DIP coordinates) is sent back to the main process
 * for cropping. Escape or right-click cancels.
 */

export function buildOverlayHtml(width: number, height: number, imageDataUrl: string): string {
  const script = `
    const W = window.innerWidth
    const H = window.innerHeight
    const canvas = document.getElementById('c')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    const img = document.getElementById('shot')
    let start = null
    let cur = null
    let dragging = false

    function draw() {
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, W, H)
      if (cur) {
        const r = normRect(start, cur)
        ctx.clearRect(r.x, r.y, r.width, r.height)
        ctx.strokeStyle = '#4f8cff'
        ctx.lineWidth = 2
        ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2)
        ctx.fillStyle = '#fff'
        ctx.font = '12px system-ui, sans-serif'
        ctx.fillText(Math.round(r.width) + ' x ' + Math.round(r.height), r.x + 6, r.y + 16)
      }
    }

    function normRect(a, b) {
      return {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y)
      }
    }

    canvas.addEventListener('mousedown', (e) => {
      start = { x: e.clientX, y: e.clientY }
      cur = start
      dragging = true
      draw()
    })
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return
      cur = { x: e.clientX, y: e.clientY }
      draw()
    })
    window.addEventListener('mouseup', (e) => {
      if (!dragging) return
      dragging = false
      const r = normRect(start, { x: e.clientX, y: e.clientY })
      if (r.width > 2 && r.height > 2) {
        window.coder.selectRegion({ x: r.x, y: r.y, width: r.width, height: r.height })
      } else {
        window.coder.cancelRegion()
      }
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.coder.cancelRegion()
    })
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      window.coder.cancelRegion()
    })
    img.addEventListener('load', draw)
  `

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; width: ${width}px; height: ${height}px; }
  body { cursor: crosshair; user-select: none; -webkit-user-select: none; }
  #shot { position: fixed; left: 0; top: 0; width: 100%; height: 100%; }
  #c { position: fixed; left: 0; top: 0; z-index: 2; }
</style>
</head>
<body>
  <img id="shot" src="${imageDataUrl}" />
  <canvas id="c"></canvas>
  <script>${script}</script>
</body>
</html>`
}
