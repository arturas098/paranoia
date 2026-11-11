// Paranoia v9 service worker: shows local notifications (only "New message") and opens the app on tap.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
// network-only (nothing is cached on the device); present so the app can be installed
self.addEventListener('fetch', () => {})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) { if ('focus' in w) return w.focus() }
    return self.clients.openWindow(url)
  })())
})
