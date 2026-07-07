---
name: verify
description: Build, launch, and drive the VdV scheduling app to verify frontend/backend changes at the real surface.
---

# Verify the VdV scheduling platform

## Launch

```bash
npm run dev:server &   # Fastify on :3000, falls back to PGlite (no Postgres needed), auto-seeds users
npm run dev:web &      # Vite dev server, picks a free port (check its stdout, often 5173–5175), proxies /api → :3000
```

Health check (no curl in this env — use node):

```bash
node -e "fetch('http://localhost:3000/api/users').then(r=>r.json()).then(console.log)"
```

Seeded users: Bram, Anna, Tomas. The web app stores the picked user in
localStorage (`vdv-user-id`) and sends it as the `x-user-id` header.

## Drive (GUI)

Playwright browsers are cached at `/root/.cache/ms-playwright` but the npm
package is not installed in the workspace. Install it in the scratchpad dir:

```bash
cd <scratchpad> && npm init -y && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright node script.mjs
```

Flows worth driving:
- User gate → tap a user button → agenda grid renders.
- Agenda is responsive: 1 day column ≤640px, 3 ≤1000px, 7 on desktop.
- Work-window drag uses pointer events. To simulate touch, use CDP
  `Input.dispatchTouchEvent` via `ctx.newCDPSession(page)` — Playwright's
  `page.touchscreen` only taps. **Scroll the handle into the viewport first**
  (`scrollIntoViewIfNeeded`); touches dispatched at off-screen coordinates
  are silently dropped and the drag never engages.
- "+ New item" modal (bottom sheet on mobile), Save disabled without title.
- Tap a block → `.block-detail` panel.

## Gotchas

- Brand fonts/logo load from vandervolpi.com and fail with CORS errors in the
  console — pre-existing, ignore.
- Work-window edits persist via `PUT /api/work-windows`; restore the seeded
  default afterwards (09:00–17:30 = `{startMinutes:540, endMinutes:1050}`).
