// v9: no push server – notifications are shown locally by the service worker while Paranoia is open or in the background.
import { BASE } from './net'

export type PushState = 'unsupported' | 'ios-install' | 'denied' | 'off' | 'on'

export function isIOS() {
  return typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)
}
function standalone() {
  return typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true)
}
export function pushSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export async function pushState(): Promise<PushState> {
  if (isIOS() && !standalone()) return 'ios-install'
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return Notification.permission === 'granted' ? 'on' : 'off'
}

export async function currentSub(): Promise<null> {
  return null
}

/** Ask permission (must be called from a tap). */
export async function enablePush() {
  if (!pushSupported()) return null
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return null
  try { if ('serviceWorker' in navigator) await navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE }) } catch {}
  return {} as PushSubscription
}

export function subKeys(_sub: unknown) {
  return { endpoint: '', p256dh: '', auth: '' }
}
