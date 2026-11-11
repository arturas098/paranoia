// Chat sounds (synthesized with Web Audio, no files) + vibration.
// Mode is per device: 'sound' = pop + vibration, 'vib' = vibration only (silent), 'off' = nothing.
export type NotifyMode = 'sound' | 'vib' | 'off'

let ac: AudioContext | null = null

export function getMode(): NotifyMode {
  try {
    const m = localStorage.getItem('pn_notify')
    if (m === 'sound' || m === 'vib' || m === 'off') return m
  } catch {}
  return 'sound'
}
export function setMode(m: NotifyMode) {
  try { localStorage.setItem('pn_notify', m) } catch {}
}
export function nextMode(m: NotifyMode): NotifyMode {
  return m === 'sound' ? 'vib' : m === 'vib' ? 'off' : 'sound'
}
export const modeIcon = (m: NotifyMode) => (m === 'sound' ? '🔔' : m === 'vib' ? '📳' : '🔕')

// Browsers only allow audio after a user tap: call this from a pointer/key handler.
export function unlockAudio() {
  try {
    if (!ac) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (AC) ac = new AC()
    }
    if (ac && ac.state === 'suspended') void ac.resume()
  } catch {}
}

function pop(at: number, freq: number, dur: number, vol: number) {
  if (!ac) return
  const o = ac.createOscillator()
  const g = ac.createGain()
  o.type = 'sine'
  o.frequency.setValueAtTime(freq * 1.35, at)
  o.frequency.exponentialRampToValueAtTime(freq, at + 0.018)
  o.frequency.exponentialRampToValueAtTime(freq * 0.62, at + dur)
  g.gain.setValueAtTime(0.0001, at)
  g.gain.exponentialRampToValueAtTime(vol, at + 0.006)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  o.connect(g).connect(ac.destination)
  o.start(at)
  o.stop(at + dur + 0.02)
}

function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern) } catch {}
}

/** Incoming message: short clear "pop-pop". */
export function notifyIncoming(mode: NotifyMode = getMode()) {
  if (mode === 'off') return
  if (mode === 'sound') {
    unlockAudio()
    if (ac) {
      const t = ac.currentTime + 0.01
      pop(t, 760, 0.075, 0.5)
      pop(t + 0.115, 1020, 0.085, 0.45)
    }
  }
  vibrate([70, 50, 70])
}

function bellTone(at: number, f: number, dur: number, vol: number) {
  if (!ac) return
  const parts: [number, number][] = [[1, 1], [2, 0.42], [3.01, 0.22], [4.17, 0.1]]
  for (const [m, a] of parts) {
    const o = ac.createOscillator()
    const g = ac.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(f * m, at)
    const d = dur / Math.sqrt(m)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(vol * a, at + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, at + d)
    o.connect(g).connect(ac.destination)
    o.start(at)
    o.stop(at + d + 0.05)
  }
}

/** Doorbell: "ding-dong" (E5 → C5) + long vibration. vol < 1 for the sender's own echo. */
export function notifyBell(mode: NotifyMode = getMode(), vol = 1, vibrateToo = true) {
  if (mode === 'off') return
  if (mode === 'sound') {
    unlockAudio()
    if (ac) {
      const t = ac.currentTime + 0.02
      bellTone(t, 659.25, 1.2, 0.42 * vol)
      bellTone(t + 0.48, 523.25, 1.8, 0.42 * vol)
    }
  }
  if (vibrateToo) vibrate([220, 120, 380])
}

/** Own message sent: one soft pop, no vibration. */
export function notifySent(mode: NotifyMode = getMode()) {
  if (mode !== 'sound') return
  unlockAudio()
  if (ac) pop(ac.currentTime + 0.01, 560, 0.06, 0.22)
}
