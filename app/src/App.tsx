import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type React from 'react'
import { api, useMutation, useQuery, useNetDown, BASE, chatUrl as netChatUrl, exportLink, importOwner, isOwnerChat, idbClear } from './lib/net'
import {
  decrypt, decryptBytes, encrypt, encryptBytes, importChatKey, newChatKey, rid,
} from './lib/crypto'
import { tr } from './lib/i18n'
import type { Dict } from './lib/i18n'
import { getMode, modeIcon, nextMode, notifyBell, notifyIncoming, notifySent, setMode, unlockAudio } from './lib/sound'
import type { NotifyMode } from './lib/sound'
import { Keyboard, KDisplay, backspace, getKb, setKb } from './components/keyboard'
import type { KbLang } from './components/keyboard'
import { enablePush, pushState, currentSub, subKeys, isIOS } from './lib/push'
import type { PushState } from './lib/push'

const TTL = 24 * 3600_000

/** v9: connection to the ntfy server lost → visible warning bar */
function NetBar(p: { t: Dict }) {
  const down = useNetDown()
  return down ? <div className="pa-bar down">{p.t.netDown}</div> : null
}

// ---------- storage ----------
function setV(k: string, v: string) {
  try { localStorage.setItem(k, v) } catch {}
  document.cookie = `${k}=${encodeURIComponent(v)};max-age=31536000;path=/;SameSite=Lax`
}
function getV(k: string): string | null {
  let v: string | null = null
  try { v = localStorage.getItem(k) } catch {}
  if (v) return v
  const m = document.cookie.match('(?:^|; )' + k + '=([^;]*)')
  return m ? decodeURIComponent(m[1]) : null
}
function delV(k: string) {
  try { localStorage.removeItem(k) } catch {}
  document.cookie = `${k}=;max-age=0;path=/`
}
// secrets (chat keys, device token) only in localStorage – never in cookies, which travel to the server
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }
function getDev() {
  let d = lsGet('pn_dev')
  if (!d || !/^[a-z0-9]{16,40}$/.test(d)) { d = rid(24); lsSet('pn_dev', d) }
  return d
}
function wipeLocal() {
  try {
    const ks: string[] = []
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('pn_')) ks.push(k) }
    ks.forEach((k) => localStorage.removeItem(k))
  } catch {}
  document.cookie.split('; ').forEach((c) => { const k = c.split('=')[0]; if (k.startsWith('pn_')) document.cookie = `${k}=;max-age=0;path=/` })
}

// ---------- helpers ----------
type Prefs = { ownerName: string; lang: string; ytApp: boolean; chrome: boolean; ask: boolean; pushNames?: boolean }
type EncMsg = {
  id: string; from: string; iv: string; ct: string; at: number; kind?: string | null
  liked?: boolean; expiresAt?: number | null; blob?: string | null
}
type Acc = { dev?: string; auth?: string }

const p2 = (x: number) => String(x).padStart(2, '0')
const fmtDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }
const fmtTime = (t: number) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }
function fmtListTime(t: number) {
  return fmtDay(t) === fmtDay(Date.now()) ? fmtTime(t) : fmtDay(t).slice(5)
}
function left(lastAt: number, t: Dict) {
  const ms = Math.max(0, lastAt + TTL - Date.now())
  return ms >= 3600_000 ? `${Math.ceil(ms / 3600_000)} ${t.h}` : `${Math.max(1, Math.ceil(ms / 60_000))} ${t.min}`
}
function chatUrl(cid: string, raw: string, srv?: string) {
  return netChatUrl(cid, raw, srv)
}
async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); return true } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = s; document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy'); ta.remove(); return ok
  } catch { return false }
}
function errMsg(e: unknown, t: Dict) {
  const m = e instanceof Error ? e.message : ''
  const k = (m.match(/(BAD_KEY|ENDED|TOO_LONG|NO_NICK|BAD_ID|LOCKED|RATE)/) || [])[1]
  return k === 'RATE' ? t.err + ': ntfy limit' : k === 'ENDED' ? t.ended : k === 'LOCKED' ? t.locked : k === 'TOO_LONG' ? t.imgBig : k ? `${t.err}: ${k}` : t.err
}
const haptic = (ms = 15) => { try { navigator.vibrate?.(ms) } catch {} }

// message payload (inside the encryption): plain text, or \u0001 + JSON for replies / media meta
type Payload = { t: string; r?: { id: string; s: string; f: string }; w?: number; h?: number; d?: number; m?: string }
function encodePayload(p: Payload) {
  return p.r || p.w || p.d || p.m ? '\u0001' + JSON.stringify(p) : p.t
}
function parsePayload(raw: string): Payload {
  if (raw.startsWith('\u0001')) { try { return JSON.parse(raw.slice(1)) as Payload } catch {} }
  return { t: raw }
}
function previewOf(kind: string | null | undefined, raw: string | undefined, t: Dict) {
  if (kind === 'bell') return '🛎️ ' + t.bell
  if (kind === 'ttl' || kind === 'auto') return '⏳'
  if (kind === 'img') return t.photo
  if (kind === 'voice') return t.voice
  if (raw === undefined) return '…'
  return parsePayload(raw).t.replace(/\n/g, ' ')
}

// ---------- environment: in-app browsers, install, curtain ----------
const isInApp = () => typeof navigator !== 'undefined' && /FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|MicroMessenger|Line\/|; wv\)/i.test(navigator.userAgent)
function chromeIntent(pathAndQuery: string) {
  const h = window.location.host
  return `intent://${h}${pathAndQuery}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent('https://' + h + pathAndQuery)};end`
}
function InAppBar(p: { t: Dict; path: string; copy?: string }) {
  if (!isInApp()) return null
  if (isIOS()) return <div className="pa-bar">{p.t.inApp}. {p.t.inAppIos}</div>
  return (
    <div className="pa-inapp">
      <span>{p.t.inApp}</span>
      <button onClick={() => { void (async () => { if (p.copy) await copyText(p.copy); window.location.href = chromeIntent(p.path) })() }}>{p.t.openInChrome}</button>
    </div>
  )
}

type BIP = Event & { prompt: () => Promise<void> }
let bip: BIP | null = null
const bipSubs = new Set<() => void>()
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); bip = e as BIP; bipSubs.forEach((f) => f()) })
  window.addEventListener('appinstalled', () => { bip = null; bipSubs.forEach((f) => f()) })
}
function useInstall() {
  const [, force] = useState(0)
  useEffect(() => { const f = () => force((x) => x + 1); bipSubs.add(f); return () => { bipSubs.delete(f) } }, [])
  return bip ? async () => { const b = bip; bip = null; force((x) => x + 1); await b?.prompt() } : null
}

function useCurtain() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const show = () => setOn(true)
    const hide = () => setOn(false)
    const vis = () => (document.visibilityState === 'hidden' ? show() : hide())
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('blur', show)
    window.addEventListener('focus', hide)
    window.addEventListener('pagehide', show)
    return () => {
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('blur', show)
      window.removeEventListener('focus', hide)
      window.removeEventListener('pagehide', show)
    }
  }, [])
  return on
}

// ---------- links ----------
const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"']+|(?:youtu\.be|youtube\.com|m\.youtube\.com)\/[^\s<>"']+)/gi
function normUrl(u: string) {
  const clean = u.replace(/[),.!?;:]+$/, '')
  return /^https?:\/\//i.test(clean) ? clean : 'https://' + clean
}
function isYT(u: string) {
  try { const h = new URL(u).hostname.replace(/^www\.|^m\./, ''); return h === 'youtube.com' || h === 'youtu.be' || h === 'music.youtube.com' } catch { return false }
}
const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
function linkKind(u: string, prefs: Prefs): 'yt' | 'chrome' | 'web' {
  if (!isAndroid()) return 'web'
  if (isYT(u) && prefs.ytApp) return 'yt'
  if (prefs.chrome) return 'chrome'
  return 'web'
}
function openExternal(u: string, prefs: Prefs) {
  const kind = linkKind(u, prefs)
  if (kind === 'web') { window.open(u, '_blank', 'noopener,noreferrer'); return }
  const x = new URL(u)
  const pkg = kind === 'yt' ? 'com.google.android.youtube' : 'com.android.chrome'
  window.location.href = `intent://${x.host}${x.pathname}${x.search}#Intent;scheme=${x.protocol.replace(':', '')};package=${pkg};S.browser_fallback_url=${encodeURIComponent(u)};end`
}
function Linkified(p: { text: string; prefs: Prefs; onLink: (u: string) => void }) {
  const parts = p.text.split(URL_RE)
  return (
    <>
      {parts.map((seg, i) => {
        if (i % 2 === 0) return seg
        const u = normUrl(seg)
        const kind = linkKind(u, p.prefs)
        const tail = seg.slice(seg.replace(/[),.!?;:]+$/, '').length)
        return (
          <span key={i}>
            <a className="pa-lk" href={u} onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.onLink(u) }} rel="noopener noreferrer">
              {seg.slice(0, seg.length - tail.length)}
              <i>{kind === 'yt' ? '▶ YouTube' : kind === 'chrome' ? '◉ Chrome' : '↗'}</i>
            </a>{tail}
          </span>
        )
      })}
    </>
  )
}

// ---------- media ----------
async function compressImage(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url })
    const steps: [number, number][] = [[1280, 0.72], [1024, 0.6], [800, 0.5]]
    for (const [max, q] of steps) {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * s)
      const h = Math.round(img.naturalHeight * s)
      const cv = document.createElement('canvas')
      cv.width = w; cv.height = h
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h) // re-encoding also strips EXIF / GPS
      const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/jpeg', q))
      if (blob && blob.size < 650_000) return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h }
    }
    throw new Error('TOO_LONG')
  } finally { URL.revokeObjectURL(url) }
}

function useRecorder(onDone: (bytes: Uint8Array, mime: string, secs: number) => void) {
  const [rec, setRec] = useState<number | null>(null)
  const mr = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const cancelled = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cb = useRef(onDone)
  cb.current = onDone
  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? ''
    const r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined)
    chunks.current = []
    cancelled.current = false
    const t0 = Date.now()
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data) }
    r.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop())
      clearTimeout(timer.current)
      setRec(null)
      if (cancelled.current) return
      const b = new Blob(chunks.current, { type: r.mimeType || mime })
      cb.current(new Uint8Array(await b.arrayBuffer()), b.type, Math.max(1, Math.round((Date.now() - t0) / 1000)))
    }
    r.start()
    mr.current = r
    setRec(t0)
    timer.current = setTimeout(() => { if (r.state === 'recording') r.stop() }, 60_000)
  }
  const stop = () => { if (mr.current?.state === 'recording') mr.current.stop() }
  const cancel = () => { cancelled.current = true; stop() }
  return { rec, start, stop, cancel }
}

const blobCache = new Map<string, string>()
function useBlobUrl(cid: string, id: string | null | undefined, ckey: CryptoKey | null, acc: Acc, mime: string) {
  const cached = id ? blobCache.get(id) : undefined
  const data = useQuery(api.paranoia.getBlob, cached || !id ? 'skip' : { cid, id })
  const [url, setUrl] = useState(cached ?? '')
  useEffect(() => {
    if (url || !data || !ckey || !id) return
    let alive = true
    void decryptBytes(ckey, data.iv, data.ct).then((b) => {
      const u = URL.createObjectURL(new Blob([b as unknown as BlobPart], { type: mime }))
      blobCache.set(id, u)
      if (alive) setUrl(u)
    }).catch(() => {})
    return () => { alive = false }
  }, [data, ckey, id])
  return url
}
function ImgMsg(p: { cid: string; id?: string | null; ckey: CryptoKey | null; acc: Acc; meta: Payload; onOpen: (u: string) => void }) {
  const url = useBlobUrl(p.cid, p.id, p.ckey, p.acc, 'image/jpeg')
  const ratio = p.meta.w && p.meta.h ? `${p.meta.w} / ${p.meta.h}` : '4 / 3'
  return url
    ? <img className="pa-img" src={url} alt="" style={{ aspectRatio: ratio }} onClick={(e) => { e.stopPropagation(); p.onOpen(url) }} />
    : <div className="pa-img ph" style={{ aspectRatio: ratio }}>🔒📷</div>
}
function VoiceMsg(p: { cid: string; id?: string | null; ckey: CryptoKey | null; acc: Acc; meta: Payload }) {
  const url = useBlobUrl(p.cid, p.id, p.ckey, p.acc, p.meta.m || 'audio/webm')
  const au = useRef<HTMLAudioElement | null>(null)
  const [play, setPlay] = useState(false)
  const [pos, setPos] = useState(0)
  const dur = p.meta.d || 1
  function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (!url) return
    if (!au.current) {
      const a = new Audio(url)
      a.ontimeupdate = () => setPos(a.currentTime)
      a.onended = () => { setPlay(false); setPos(0) }
      au.current = a
    }
    if (play) { au.current.pause(); setPlay(false) } else { void au.current.play(); setPlay(true) }
  }
  useEffect(() => () => { au.current?.pause() }, [])
  return (
    <div className="pa-voice">
      <button className="pa-vplay" onClick={toggle} disabled={!url}>{!url ? '…' : play ? '⏸' : '▶'}</button>
      <div className="pa-vbar"><div style={{ width: `${Math.min(100, (pos / dur) * 100)}%` }} /></div>
      <span className="pa-vdur">0:{p2(Math.round(play ? pos : dur))}</span>
    </div>
  )
}

// ---------- shared UI ----------
function Header(p: { title: string; sub?: string; back?: () => void; av?: string; right?: ReactNode }) {
  return (
    <header className="pa-h">
      {p.back ? <button className="pa-ib" onClick={p.back}>←</button> : null}
      {p.av ? <div className="pa-av s">{p.av}</div> : !p.back ? <div className="pa-lg">🔒</div> : null}
      <div className="pa-tt"><b>{p.title}</b>{p.sub ? <small>{p.sub}</small> : null}</div>
      {p.right}
    </header>
  )
}
function useToast() {
  const [msg, setMsg] = useState('')
  const tm = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = (m: string) => {
    setMsg(m)
    if (tm.current) clearTimeout(tm.current)
    tm.current = setTimeout(() => setMsg(''), 1800)
  }
  const el = msg ? <div className="pa-toast">{msg}</div> : null
  return [show, el] as const
}
function Center(p: { icon: string; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="pa-center">
      <div className="pa-big">{p.icon}</div>
      <b style={{ fontSize: 19 }}>{p.title}</b>
      {p.text ? <p className="pa-note">{p.text}</p> : null}
      {p.children}
    </div>
  )
}
function useNow(ms = 60_000) {
  const [n, setN] = useState(() => Date.now())
  useEffect(() => { const i = setInterval(() => setN(Date.now()), ms); return () => clearInterval(i) }, [ms])
  return n
}

// ---------- chat view ----------
const EMO_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u
function ChatView(p: {
  cid: string; acc: Acc; msgs: EncMsg[] | undefined; ckey: CryptoKey | null; me: 'o' | 's'; t: Dict; prefs: Prefs
  otherName: string; otherTyping: number; otherRead: number; myRead: number; ttl: number; auto: boolean
}) {
  const autoM = useMutation(api.paranoia.setAutoDelete)
  const send = useMutation(api.paranoia.send)
  const ttlM = useMutation(api.paranoia.setMsgTtl)
  const [ttlOpen, setTtlOpen] = useState(false)
  const [hintOff, setHintOff] = useState(() => lsGet('pn_hint_off') === '1')
  const sendBlob = useMutation(api.paranoia.sendBlob)
  const likeM = useMutation(api.paranoia.toggleLike)
  const destroyM = useMutation(api.paranoia.destroyIn60)
  const typingM = useMutation(api.paranoia.setTyping)
  const readM = useMutation(api.paranoia.markRead)
  const base = { cid: p.cid, ...p.acc }

  const [plain, setPlain] = useState<Record<string, string>>({})
  const cache = useRef<Record<string, string>>({})
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [kbOpen, setKbOpen] = useState(true)
  const [kbLang, setKbLang] = useState<KbLang>(() => getKb())
  const [reply, setReply] = useState<{ id: string; s: string; f: string } | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [swipe, setSwipe] = useState<{ id: string; dx: number } | null>(null)
  const lastBell = useRef(0)
  const lastTyping = useRef(0)
  const taps = useRef<Record<string, number>>({})
  const hold = useRef<{ t?: ReturnType<typeof setTimeout>; x: number; y: number; id: string; replied: boolean }>({ x: 0, y: 0, id: '', replied: false })
  const held = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const fileIn = useRef<HTMLInputElement>(null)

  const recorder = useRecorder((bytes, mime, secs) => { void sendMedia('voice', bytes, { t: '', d: secs, m: mime }) })

  // live clock while something counts down or the other side is typing
  const [now, setNow] = useState(() => Date.now())
  const ticking = !!p.msgs?.some((m) => m.expiresAt) || Date.now() - p.otherTyping < 10000 || recorder.rec !== null
  useEffect(() => {
    if (!ticking) return
    const i = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(i)
  }, [ticking])

  useEffect(() => {
    if (!p.msgs || !p.ckey) return
    let alive = true
    void (async () => {
      let changed = false
      for (const m of p.msgs!) {
        if (m.kind === 'bell' || m.kind === 'ttl' || m.kind === 'auto' || cache.current[m.id] !== undefined) continue
        try { cache.current[m.id] = await decrypt(p.ckey!, m.iv, m.ct) } catch { cache.current[m.id] = '\u0000' }
        changed = true
      }
      if (alive && changed) setPlain({ ...cache.current })
    })()
    return () => { alive = false }
  }, [p.msgs, p.ckey])

  const otherTyping = now - p.otherTyping < 9000
  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight }, [plain, p.msgs?.length, kbOpen, otherTyping, !!reply])

  // read receipts: tell the server what I've seen (only while the page is in front)
  const newestOther = p.msgs?.reduce((mx, m) => (m.from !== p.me && m.at > mx ? m.at : mx), 0) ?? 0
  useEffect(() => {
    const go = () => { if (document.visibilityState === 'visible' && newestOther > p.myRead) void readM({ ...base, at: newestOther }).catch(() => {}) }
    go()
    document.addEventListener('visibilitychange', go)
    return () => document.removeEventListener('visibilitychange', go)
  }, [newestOther, p.myRead])

  function typed() {
    const n = Date.now()
    if (n - lastTyping.current > 7000) { lastTyping.current = n; void typingM(base).catch(() => {}) }
  }
  async function sendText() {
    const text = val.trim()
    if (!text || busy || !p.ckey) return
    setBusy(true); setStatus(p.t.sending)
    try {
      const e = await encrypt(p.ckey, encodePayload({ t: text.slice(0, 4000), ...(reply ? { r: reply } : {}) }))
      await send({ ...base, iv: e.iv, ct: e.ct })
      setVal(''); setReply(null); setStatus(''); notifySent()
    } catch (e) { setStatus('⚠ ' + errMsg(e, p.t)) } finally { setBusy(false) }
  }
  async function sendMedia(kind: 'img' | 'voice', bytes: Uint8Array, meta: Payload) {
    if (!p.ckey) return
    setBusy(true); setStatus(p.t.sending)
    try {
      const b = await encryptBytes(p.ckey, bytes)
      const e = await encrypt(p.ckey, encodePayload({ ...meta, ...(reply ? { r: reply } : {}) }))
      await sendBlob({ ...base, kind, iv: e.iv, ct: e.ct, biv: b.iv, bct: b.ct })
      setReply(null); setStatus(''); notifySent()
    } catch (e) { setStatus('⚠ ' + errMsg(e, p.t)) } finally { setBusy(false) }
  }
  async function pickImage(f: File | undefined) {
    if (!f) return
    try { const r = await compressImage(f); await sendMedia('img', r.bytes, { t: '', w: r.w, h: r.h }) }
    catch (e) { setStatus('⚠ ' + errMsg(e, p.t)) }
  }
  async function startRec() {
    try { haptic(25); await recorder.start() } catch { setStatus('⚠ ' + p.t.micNo) }
  }
  async function bell() {
    if (Date.now() - lastBell.current < 4000) return
    lastBell.current = Date.now()
    notifyBell(undefined, 0.35, false)
    try { await send({ ...base, iv: '', ct: '', bell: true }) } catch (e) { setStatus('⚠ ' + errMsg(e, p.t)) }
  }
  function onLink(u: string) {
    if (p.prefs.ask) setPending(u)
    else openExternal(u, p.prefs)
  }
  function snippet(m: EncMsg) {
    if (m.kind === 'img') return p.t.photo
    if (m.kind === 'voice') return p.t.voice
    if (m.kind === 'bell') return '🛎️'
    return parsePayload(plain[m.id] ?? '').t.slice(0, 80)
  }
  // double-tap the other person's message = Like (toggle)
  function tapMsg(m: EncMsg) {
    if (m.from === p.me || m.kind === 'bell') return
    const n = Date.now()
    if (n - (taps.current[m.id] ?? 0) < 380) {
      taps.current[m.id] = 0
      haptic(18)
      void likeM({ ...base, id: m.id }).catch(() => {})
    } else taps.current[m.id] = n
  }
  // press & hold → "Destroy in 60 s?"; swipe right → reply
  function startHold(m: EncMsg, e: React.PointerEvent) {
    clearTimeout(hold.current.t)
    hold.current = {
      x: e.clientX, y: e.clientY, id: m.id, replied: false,
      t: m.expiresAt ? undefined : setTimeout(() => { held.current = true; haptic(35); setSel(m.id) }, 520),
    }
  }
  function moveHold(m: EncMsg, e: React.PointerEvent) {
    const dx = e.clientX - hold.current.x
    const dy = e.clientY - hold.current.y
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimeout(hold.current.t)
    if (hold.current.id !== m.id || Math.abs(dy) > 30) { if (swipe) setSwipe(null); return }
    if (dx > 8) setSwipe({ id: m.id, dx: Math.min(dx, 80) })
    if (dx > 60 && !hold.current.replied) {
      hold.current.replied = true
      held.current = true
      haptic(20)
      setReply({ id: m.id, s: snippet(m), f: m.from })
      setKbOpen(true)
    }
  }
  function endHold() { clearTimeout(hold.current.t); hold.current.id = ''; setSwipe(null) }
  function jumpTo(id: string) {
    const el = document.getElementById('m-' + id)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 900)
  }

  async function pickTtl(v: number) {
    setTtlOpen(false)
    if (v === p.ttl) return
    haptic(15)
    try { await ttlM({ ...base, ttl: v }) } catch (e) { setStatus('⚠ ' + errMsg(e, p.t)) }
  }
  const ttlOpts: [number, string][] = [[0, p.t.ttlOff], [60_000, p.t.ttl1m], [3_600_000, p.t.ttl1h], [86_400_000, p.t.ttl24h], [-1, p.t.ttlRead]]
  const ttlName = (v: number) => ttlOpts.find((o) => o[0] === v)?.[1] ?? ''

  let day = ''
  const pk = pending ? linkKind(pending, p.prefs) : 'web'
  const recSecs = recorder.rec ? Math.floor((now - recorder.rec) / 1000) : 0
  return (
    <>
      <button className={'pa-ttlbar' + (p.ttl ? ' on' : '') + (ttlOpen ? ' open' : '')} onClick={() => setTtlOpen((o) => !o)}>
        <span>{p.ttl ? p.t.ttlBarOn(ttlName(p.ttl)) : p.t.ttlBarOff}{p.auto ? ' · ⏱ 24 h' : ''}</span><i>{ttlOpen ? '✕' : p.t.ttlChange + ' ▾'}</i>
      </button>
      {ttlOpen ? (
        <div className="pa-ttlpick">
          <div className="pa-seg wide">
            {ttlOpts.map(([v, l]) => <button key={v} className={p.ttl === v ? 'on' : ''} onClick={() => void pickTtl(v)}>{l}</button>)}
          </div>
          <small>{p.t.ttlNew}</small>
          <button className={'pa-chk' + (p.auto ? ' on' : '')} style={{ margin: '8px 0 0' }} aria-pressed={p.auto}
            onClick={() => { haptic(15); void autoM({ ...base, on: !p.auto }).catch((e) => setStatus('⚠ ' + errMsg(e, p.t))) }}>
            <span className="box">{p.auto ? '✓' : ''}</span>
            <span>⏱ {p.t.autoOpt}<small>{p.t.autoIn}</small></span>
          </button>
        </div>
      ) : null}
      <div className="pa-msgs" ref={box} onClick={() => { if (held.current) { held.current = false; return } setKbOpen(false); setSel(null); setTtlOpen(false) }}>
        {!hintOff ? (
          <div className="pa-hint">
            <button onClick={(e) => { e.stopPropagation(); lsSet('pn_hint_off', '1'); setHintOff(true) }} aria-label="close">✕</button>
            <b>{p.t.hintTitle}</b>
            {p.t.hints.map((h) => <div key={h}>{h}</div>)}
          </div>
        ) : null}
        {!p.msgs ? <div className="pa-empty">{p.t.loading}</div>
          : p.msgs.length === 0 ? <div className="pa-empty">{p.t.noMsgs} 🔒</div>
          : p.msgs.filter((m) => !m.expiresAt || m.expiresAt > now).map((m) => {
            const d = fmtDay(m.at)
            const showDay = d !== day
            day = d
            const mine = m.from === p.me
            if (m.kind === 'auto') {
              const who = mine ? p.t.you : p.otherName
              return (
                <div key={m.id} style={{ display: 'contents' }}>
                  {showDay ? <div className="pa-day">{d}</div> : null}
                  <div className="pa-sys">{m.ct === '1' ? p.t.autoOnBy(who) : p.t.autoOffBy(who)} · {fmtTime(m.at)}</div>
                </div>
              )
            }
            if (m.kind === 'ttl') {
              const v = Number(m.ct) || 0
              const who = mine ? p.t.you : p.otherName
              return (
                <div key={m.id} style={{ display: 'contents' }}>
                  {showDay ? <div className="pa-day">{d}</div> : null}
                  <div className="pa-sys">{v ? p.t.ttlSet(who, p.t.ttlWord(v)) : p.t.ttlOffBy(who)} · {fmtTime(m.at)}</div>
                </div>
              )
            }
            const side = mine ? 'pa-me' : 'pa-th'
            const isSel = sel === m.id
            const secs = m.expiresAt ? Math.max(0, Math.ceil((m.expiresAt - now) / 1000)) : 0
            const raw = plain[m.id]
            const pl = raw !== undefined && raw !== '\u0000' ? parsePayload(raw) : null
            const media = m.kind === 'img' || m.kind === 'voice'
            const emo = !!pl && !media && m.kind !== 'bell' && !pl.r && Array.from(pl.t).length <= 12 && EMO_ONLY.test(pl.t)
            const cls = 'pa-m ' + side + (m.liked ? ' liked' : '') + (isSel ? ' sel' : '') + (m.expiresAt ? ' doom' : '')
              + (m.kind === 'bell' ? ' bell' : '') + (media ? ' media' : '') + (emo && !isSel ? ' emo' : '')
            const sw = swipe?.id === m.id ? swipe.dx : 0
            const timeLine = (
              <div className="t">
                {m.expiresAt ? <b className="pa-doomt">💣 {secs} s · </b> : null}
                {fmtTime(m.at)}
                {mine ? <span className={'pa-tick' + (m.at <= p.otherRead ? ' read' : '')}>{m.at <= p.otherRead ? ' ✓✓' : ' ✓'}</span> : null}
              </div>
            )
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay ? <div className="pa-day">{d}</div> : null}
                {isSel ? (
                  <div className={'pa-dq ' + (mine ? 'dq-me' : 'dq-th')} onClick={(e) => e.stopPropagation()}>
                    <span>💣 {p.t.destroyQ}</span>
                    <button onClick={() => { const id = m.id; setSel(null); haptic(30); void destroyM({ ...base, id: id }).catch(() => {}) }}>{p.t.yes}</button>
                    <button onClick={() => setSel(null)}>{p.t.no}</button>
                  </div>
                ) : null}
                <div id={'m-' + m.id} className={cls} style={sw ? { transform: `translateX(${sw}px)` } : undefined}
                  onPointerDown={(e) => startHold(m, e)} onPointerMove={(e) => moveHold(m, e)}
                  onPointerUp={endHold} onPointerLeave={endHold} onPointerCancel={endHold}
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); if (held.current) { held.current = false; return } if (sel) { setSel(null); return } tapMsg(m) }}>
                  {sw > 20 ? <span className="pa-swr">↩</span> : null}
                  {pl?.r ? (
                    <div className="pa-q" onClick={(e) => { e.stopPropagation(); jumpTo(pl.r!.id) }}>
                      <b>{pl.r.f === p.me ? p.t.you : p.otherName}</b>{pl.r.s}
                    </div>
                  ) : null}
                  {m.kind === 'bell' ? <>🛎️ {p.t.bell}</>
                    : raw === undefined ? '…'
                    : raw === '\u0000' ? p.t.cantDecrypt
                    : m.kind === 'img' ? <ImgMsg cid={p.cid} id={m.blob} ckey={p.ckey} acc={p.acc} meta={pl!} onOpen={setViewer} />
                    : m.kind === 'voice' ? <VoiceMsg cid={p.cid} id={m.blob} ckey={p.ckey} acc={p.acc} meta={pl!} />
                    : <Linkified text={pl!.t} prefs={p.prefs} onLink={onLink} />}
                  {timeLine}
                  {m.liked ? <span className="pa-like">Like</span> : null}
                </div>
              </div>
            )
          })}
        {otherTyping ? <div className="pa-typing"><span /><span /><span /> <i>{p.t.typing}</i></div> : null}
      </div>
      {status ? <div className="pa-status">{status}</div> : null}
      <div className="pa-dock">
        {reply ? (
          <div className="pa-reply">
            <div><b>↩ {reply.f === p.me ? p.t.you : p.otherName}</b><span>{reply.s}</span></div>
            <button onClick={() => setReply(null)}>✕</button>
          </div>
        ) : null}
        {recorder.rec !== null ? (
          <div className="pa-cmp rec">
            <span className="pa-recdot" />
            <span className="pa-rectxt">{p.t.rec} 0:{p2(recSecs)}</span>
            <button className="pa-bell" onClick={recorder.cancel}>✕</button>
            <button className="pa-snd" onClick={recorder.stop}>➤</button>
          </div>
        ) : (
          <div className="pa-cmp">
            <button className="pa-att" onClick={() => fileIn.current?.click()} disabled={busy || !p.ckey} aria-label="photo">📎</button>
            <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = '' }} />
            <KDisplay value={val} placeholder={p.t.msgPh} active={kbOpen} onClick={() => setKbOpen(true)} />
            <button className="pa-bell" onClick={() => void bell()} aria-label="Ding dong">🛎️</button>
            {val.trim()
              ? <button className="pa-snd" onClick={() => void sendText()} disabled={busy || !p.ckey}>➤</button>
              : <button className="pa-snd" onClick={() => void startRec()} disabled={busy || !p.ckey} aria-label="voice">🎤</button>}
          </div>
        )}
        {kbOpen && recorder.rec === null ? (
          <Keyboard lang={kbLang} onLang={(l) => { setKb(l); setKbLang(l) }} spaceLabel={p.t.space} value={val} autoCap
            onChar={(c) => { typed(); setVal((v) => (v + c).slice(0, 4000)) }} onBack={() => { typed(); setVal((v) => backspace(v)) }}
            onEnter={() => setVal((v) => (v + '\n').slice(0, 4000))} onHardEnter={() => void sendText()}
            onHide={() => setKbOpen(false)} />
        ) : null}
      </div>
      {viewer ? <div className="pa-viewer" onClick={() => setViewer(null)}><img src={viewer} alt="" /></div> : null}
      {pending ? (
        <div className="pa-sheet" onClick={() => setPending(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <b>{p.t.openOutside}</b>
            <div className="pa-url" style={{ margin: '2px 0 6px' }}>{pending.replace(/^https?:\/\//, '')}</div>
            <button className="pa-btn" onClick={() => { openExternal(pending, p.prefs); setPending(null) }}>
              {pk === 'yt' ? p.t.openYT : pk === 'chrome' ? p.t.openChrome : p.t.openBrowser}
            </button>
            <button className="pa-btn o" onClick={() => setPending(null)}>{p.t.cancel}</button>
          </div>
        </div>
      ) : null}
    </>
  )
}

// ---------- APP ----------
type Mode = null | { kind: 'sender'; cid: string; raw: string; srv?: string } | { kind: 'owner'; open?: string }
  | { kind: 'none'; bad?: boolean } | { kind: 'needkey'; cid: string; srv?: string }
export default function App() {
  const [mode, setAppMode] = useState<Mode>(null)
  const curtain = useCurtain()
  useEffect(() => {
    const f = () => unlockAudio()
    window.addEventListener('pointerdown', f)
    window.addEventListener('keydown', f)
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE }).catch(() => {})
    return () => { window.removeEventListener('pointerdown', f); window.removeEventListener('keydown', f) }
  }, [])
  useEffect(() => {
    // owner moving to another device: #own=<all chats + keys>
    const h = window.location.hash
    if (h.startsWith('#own=')) {
      window.history.replaceState(null, '', BASE)
      const n = importOwner(h.slice(5))
      lsSet('pn_owner', '1')
      if (n >= 0) setTimeout(() => alert(tr(getV('pn_lang') || 'lt').imported(n)), 300)
      setAppMode({ kind: 'owner' })
      return
    }
    const qs = new URLSearchParams(window.location.search)
    const c = qs.get('c')
    const srv = qs.get('s') || undefined
    if (c) {
      if (isOwnerChat(c)) { window.history.replaceState(null, '', BASE); setAppMode({ kind: 'owner', open: c }); return }
      const raw = window.location.hash.slice(1) || lsGet('pn_ck_' + c) || ''
      setAppMode(raw ? { kind: 'sender', cid: c, raw, srv } : { kind: 'needkey', cid: c, srv })
      return
    }
    if (lsGet('pn_owner') === '1') { setAppMode({ kind: 'owner' }); return }
    // installed app opened from the home screen → last chat on this device
    const last = lsGet('pn_last')
    const lastKey = last ? lsGet('pn_ck_' + last) : null
    if (last && lastKey) { setAppMode({ kind: 'sender', cid: last, raw: lastKey }); return }
    lsSet('pn_owner', '1')
    setAppMode({ kind: 'owner' })
  }, [])

  let body: ReactNode
  if (!mode) body = <div className="pa"><Header title="Paranoia" /></div>
  else if (mode.kind === 'sender') body = <Sender cid={mode.cid} raw={mode.raw} srv={mode.srv} />
  else if (mode.kind === 'owner') body = <Owner open={mode.open} />
  else if (mode.kind === 'needkey') body = <NeedKey cid={mode.cid} onKey={(raw) => { window.history.replaceState(null, '', `${BASE}?c=${mode.cid}${mode.srv ? '&s=' + encodeURIComponent(mode.srv) : ''}#${raw}`); setAppMode({ kind: 'sender', cid: mode.cid, raw, srv: mode.srv }) }} />
  else body = <Landing bad={mode.bad} />
  return (
    <>
      {body}
      {curtain ? <div className="pa-curtain"><div className="pa-big">🔒</div></div> : null}
    </>
  )
}

function Landing(p: { bad?: boolean }) {
  const s = useQuery(api.paranoia.publicSettings)
  const t = tr(s?.lang)
  return (
    <div className="pa">
      <Header title="Paranoia" />
      <Center icon="🔒" title="Paranoia" text={p.bad ? t.badLink : t.invite} />
    </div>
  )
}

/** Opened without the #key (e.g. moved from Messenger to Chrome): paste the full link. */
function NeedKey(p: { cid: string; onKey: (raw: string) => void }) {
  const s = useQuery(api.paranoia.publicSettings)
  const t = tr(s?.lang)
  const [err, setErr] = useState('')
  async function paste() {
    try {
      const txt = await navigator.clipboard.readText()
      const m = txt.match(new RegExp('[?&]c=' + p.cid + '#([A-Za-z0-9_-]{40,50})'))
      if (m) p.onKey(m[1]); else setErr(t.pasteFail)
    } catch { setErr(t.pasteFail) }
  }
  return (
    <div className="pa">
      <Header title="Paranoia" />
      <Center icon="🔑" title="Paranoia" text={t.needKey}>
        <button className="pa-btn" onClick={() => void paste()}>{t.paste}</button>
        {err ? <p className="pa-note">⚠ {err}</p> : null}
      </Center>
    </div>
  )
}

// ---------- push + install ----------
function usePushState() {
  const [st, setSt] = useState<PushState | null>(null)
  useEffect(() => { void pushState().then(setSt) }, [])
  return [st, setSt] as const
}
function ToolsBar(p: { t: Dict; save: (k: { endpoint: string; p256dh: string; auth: string }) => Promise<unknown> }) {
  const [st, setSt] = usePushState()
  const install = useInstall()
  useEffect(() => {
    if (st !== 'on') return
    void currentSub().then((sub) => { if (sub) void p.save(subKeys(sub)).catch(() => {}) })
  }, [st])
  if (st === 'ios-install') return <div className="pa-bar">{p.t.iosHint}</div>
  if (st !== 'off' && !install) return null
  return (
    <div className="pa-tools">
      {st === 'off' ? (
        <button onClick={() => void enablePush().then(async (sub) => {
          if (sub) { await p.save(subKeys(sub)); setSt('on') } else setSt(await pushState())
        })}>{p.t.pushAsk}</button>
      ) : null}
      {install ? <button onClick={() => void install()}>{p.t.install}</button> : null}
    </div>
  )
}

// ---------- SENDER ----------
function Sender(p: { cid: string; raw: string; srv?: string }) {
  const dev = useMemo(() => getDev(), [])
  const data = useQuery(api.paranoia.chatMsgs, { cid: p.cid, dev })
  const prefs = useQuery(api.paranoia.publicSettings, { cid: p.cid })
  const open = useMutation(api.paranoia.openChat)
  const setNickM = useMutation(api.paranoia.setNick)
  const savePushM = useMutation(api.paranoia.savePush)
  const guestDel = useMutation(api.paranoia.guestDelete)
  const [ckey, setCkey] = useState<CryptoKey | null>(null)
  const [badKey, setBadKey] = useState(false)
  const [localNick, setLocalNick] = useState(() => getV('pn_nick_' + p.cid) || '')
  const [nickIn, setNickIn] = useState('')
  const [nickErr, setNickErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [gone, setGone] = useState(false)
  const [nmode, setNmode] = useState<NotifyMode>(() => getMode())
  const [toast, toastEl] = useToast()
  const prevLen = useRef<number | null>(null)
  const [kbLang, setKbLang] = useState<KbLang>(() => getKb())
  const [pst, setPst] = usePushState()
  const [askDone, setAskDone] = useState(() => lsGet('pn_pushask_' + p.cid) === '1')
  const [askBusy, setAskBusy] = useState(false)
  useNow()
  const t = tr(prefs?.lang)

  useEffect(() => {
    importChatKey(p.raw).then((k) => { setCkey(k); lsSet('pn_ck_' + p.cid, p.raw); lsSet('pn_last', p.cid) }).catch(() => setBadKey(true))
  }, [p.raw])
  useEffect(() => { void open({ cid: p.cid, dev, raw: p.raw, srv: p.srv }).catch(() => {}) }, [p.cid])
  const live = data && !data.locked ? data : null
  // pop / ding + vibrate when the owner's new message arrives
  useEffect(() => {
    if (!live) return
    const n = live.msgs.length
    if (prevLen.current !== null && n > prevLen.current && live.msgs[n - 1].from === 'o' && live.msgs[n - 1].kind !== 'ttl' && live.msgs[n - 1].kind !== 'auto') {
      if (live.msgs[n - 1].kind === 'bell') notifyBell(); else notifyIncoming()
    }
    prevLen.current = n
  }, [live?.msgs.length])

  if (badKey) return <div className="pa"><Header title="Paranoia" /><Center icon="⚠" title="Paranoia" text={t.badLink} /></div>
  if (data === null || gone) return <div className="pa"><Header title="Paranoia" /><Center icon="⌛" title={t.ended} text={t.endedText} /></div>
  if (data?.locked) return <div className="pa"><Header title="Paranoia" /><Center icon="📱" title="Paranoia" text={t.locked} /></div>
  const pr: Prefs = prefs ?? { ownerName: '', lang: 'lt', ytApp: true, chrome: true, ask: true }
  const nick = live?.senderNick || localNick
  const fullUrl = chatUrl(p.cid, p.raw, p.srv)

  async function saveNick() {
    const n = nickIn.trim()
    if (!n || busy) return
    setBusy(true); setNickErr('')
    try {
      const saved = await setNickM({ cid: p.cid, nick: n, dev })
      setV('pn_nick_' + p.cid, saved); setLocalNick(saved)
    } catch (e) { setNickErr(errMsg(e, t)) } finally { setBusy(false) }
  }
  async function panic() {
    if (!confirm(t.guestPanicQ)) return
    try { await guestDel({ cid: p.cid, dev }) } catch {}
    try { localStorage.removeItem('pn_ck_' + p.cid); localStorage.removeItem('pn_last') } catch {}
    delV('pn_nick_' + p.cid)
    window.history.replaceState(null, '', BASE)
    setGone(true)
  }
  if (live && !nick) {
    return (
      <div className="pa">
        <Header title={pr.ownerName || 'Paranoia'} sub={t.encrypted} />
        <InAppBar t={t} path={`${BASE}?c=${p.cid}`} copy={fullUrl} />
        <div className="pa-center">
          <div className="pa-big">🔒</div>
          <b style={{ fontSize: 19 }}>{t.yourNick}</b>
          <p className="pa-note">{t.yourNickText}</p>
          <KDisplay className="sq" value={nickIn} placeholder={t.yourNick} active />
          <button className="pa-btn" onClick={() => void saveNick()} disabled={busy || !nickIn.trim()}>{t.start}</button>
          {nickErr ? <p className="pa-note">⚠ {nickErr}</p> : null}
        </div>
        <div className="pa-dock">
          <Keyboard lang={kbLang} onLang={(l) => { setKb(l); setKbLang(l) }} spaceLabel={t.space} enterLabel="✓" value={nickIn} autoCap
            onChar={(c) => { if (c !== '\n') setNickIn((v) => (v + c).slice(0, 24)) }} onBack={() => setNickIn((v) => backspace(v))}
            onEnter={() => void saveNick()} />
        </div>
      </div>
    )
  }
  // one big, one-tap ask for notifications right after the nick (browsers require the person's own tap)
  const finishAsk = () => { lsSet('pn_pushask_' + p.cid, '1'); setAskDone(true) }
  if (live && nick && !askDone && !isInApp() && (pst === 'off' || pst === 'ios-install')) {
    async function allow() {
      if (askBusy) return
      setAskBusy(true)
      try {
        const sub = await enablePush()
        if (sub) { await savePushM({ ...subKeys(sub), cid: p.cid, dev }); setPst('on') } else setPst(await pushState())
      } catch {} finally { setAskBusy(false); finishAsk() }
    }
    return (
      <div className="pa">
        <Header title={pr.ownerName || 'Paranoia'} sub={t.encrypted} />
        <Center icon="🔔" title={t.pushPromptTitle} text={pst === 'ios-install' ? t.iosHint : t.pushPromptText}>
          {pst === 'off' ? <button className="pa-btn" onClick={() => void allow()} disabled={askBusy}>{t.pushPromptBtn}</button> : null}
          <div style={{ height: 8 }} />
          <button className="pa-btn o" onClick={finishAsk}>{pst === 'off' ? t.later : 'OK'}</button>
          <p className="pa-note" style={{ marginTop: 10 }}>{t.pushPromptNote}</p>
        </Center>
      </div>
    )
  }
  const cycle = () => { const m = nextMode(nmode); setMode(m); setNmode(m); toast(t.modeName(m)); if (m !== 'off') notifyIncoming(m) }
  return (
    <div className="pa">
      <Header title={pr.ownerName || 'Paranoia'} sub={live ? `${t.you}: ${nick} · ${t.encrypted.replace('🔒 ', '')}${live.msgTtl ? ' · ' + t.ttlTag(live.msgTtl) : ''}` : t.loading}
        right={<>
          <button className="pa-ib" onClick={cycle}>{modeIcon(nmode)}</button>
          <button className="pa-ib" onClick={() => void panic()}>🚨</button>
        </>} />
      {toastEl}
      <NetBar t={t} />
      <InAppBar t={t} path={`${BASE}?c=${p.cid}`} copy={fullUrl} />
      {!isInApp() ? <ToolsBar t={t} save={(k) => savePushM({ ...k, cid: p.cid, dev })} /> : null}
      {live?.autoDelete ? <div className="pa-bar">{t.expiresBar(left(live.lastAt, t))}</div> : null}
      <ChatView cid={p.cid} acc={{ dev }} msgs={live?.msgs} ckey={ckey} me="s" t={t} prefs={pr}
        otherName={pr.ownerName || '…'} otherTyping={live?.typingO ?? 0} otherRead={live?.readO ?? 0} myRead={live?.readS ?? 0}
        ttl={live?.msgTtl ?? 0} auto={live?.autoDelete ?? false} />
    </div>
  )
}

// ---------- OWNER ----------
type OChat = {
  cid: string; raw: string; srv: string; nick: string; senderNick: string | null; wrapped: string; createdAt: number; lastAt: number; opened: boolean; count: number
  autoDelete: boolean; msgTtl: number; oneDevice: boolean; bound: boolean; typingS: number
  last: { from: string; iv: string; ct: string; kind?: string | null } | null
}

function Owner(p: { open?: string }) {
  const auth = 'local'
  const data = useQuery(api.paranoia.ownerData, {}) as { settings: Prefs & { srv: string }; chats: OChat[] } | undefined
  const panicM = useMutation(api.paranoia.panicOwner)

  const [screen, setScreen] = useState<{ s: 'list' } | { s: 'new' } | { s: 'settings' } | { s: 'chat'; cid: string }>(p.open ? { s: 'chat', cid: p.open } : { s: 'list' })
  const [keys, setKeys] = useState<Record<string, { raw: string; key: CryptoKey }>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [toast, toastEl] = useToast()
  const now = useNow(3_000)
  const prevCounts = useRef<Record<string, number> | null>(null)

  // pop / ding + vibrate when any visitor writes
  useEffect(() => {
    if (!data) return
    const cur: Record<string, number> = {}
    let fresh: OChat | null = null
    for (const c of data.chats) {
      cur[c.cid] = c.count
      if (prevCounts.current && c.count > (prevCounts.current[c.cid] ?? 0) && c.last?.from === 's') fresh = c
    }
    if (fresh) { if (fresh.last?.kind === 'bell') notifyBell(); else notifyIncoming() }
    prevCounts.current = cur
  }, [data])

  // import each chat key once
  useEffect(() => {
    if (!data) return
    let alive = true
    void (async () => {
      const add: Record<string, { raw: string; key: CryptoKey }> = {}
      for (const c of data.chats) {
        if (keys[c.cid]) continue
        try { add[c.cid] = { raw: c.raw, key: await importChatKey(c.raw) } } catch {}
      }
      if (alive && Object.keys(add).length) setKeys((k) => ({ ...k, ...add }))
    })()
    return () => { alive = false }
  }, [data])

  // decrypt last-message previews
  useEffect(() => {
    if (!data) return
    let alive = true
    void (async () => {
      const add: Record<string, string> = {}
      for (const c of data.chats) {
        const k = keys[c.cid]
        if (!k || !c.last) continue
        const pk = c.cid + ':' + c.count + ':' + c.last.ct.slice(0, 16)
        if (previews[pk] !== undefined || c.last.kind === 'bell' || c.last.kind === 'ttl' || c.last.kind === 'auto') continue
        try { add[pk] = await decrypt(k.key, c.last.iv, c.last.ct) } catch { add[pk] = '⚠' }
      }
      if (alive && Object.keys(add).length) setPreviews((x) => ({ ...x, ...add }))
    })()
    return () => { alive = false }
  }, [data, keys])

  if (!data) return <div className="pa"><Header title="Paranoia" /><div className="pa-empty">…</div></div>
  const t = tr(data.settings.lang)
  const prefs = data.settings as Prefs

  async function copyLink(c: OChat) {
    const k = keys[c.cid]
    if (!k) return
    if (await copyText(chatUrl(c.cid, k.raw, c.srv))) toast(t.copied)
  }
  async function panic() {
    if (!confirm(t.panicQ)) return
    try { await panicM({ auth }) } catch {}
    wipeLocal()
    await idbClear()
    window.location.replace(BASE)
  }

  if (screen.s === 'new') return <NewChat auth={auth} t={t} back={() => setScreen({ s: 'list' })} />
  if (screen.s === 'settings') {
    return <Settings auth={auth} srv={data.settings.srv} prefs={prefs} t={t}
      back={() => setScreen({ s: 'list' })} onPanic={() => void panic()} />
  }
  if (screen.s === 'chat') {
    const c = data.chats.find((x) => x.cid === screen.cid)
    if (!c) { setTimeout(() => setScreen({ s: 'list' }), 0); return null }
    return <OwnerChat c={c} auth={auth} t={t} prefs={prefs} ckey={keys[c.cid]?.key ?? null}
      back={() => setScreen({ s: 'list' })} copy={() => void copyLink(c)} toastEl={toastEl} toast={toast} />
  }

  const label = (c: OChat) => (c.senderNick ? `${c.nick} (${c.senderNick})` : c.nick)
  const active = data.chats.filter((c) => c.opened || c.count > 0)
  const waiting = data.chats.filter((c) => !c.opened && c.count === 0)
  const item = (c: OChat) => {
    const seen = +(getV('pn_seen_' + c.cid) || 0)
    const unread = Math.max(0, c.count - seen)
    const raw = c.last ? previews[c.cid + ':' + c.count + ':' + c.last.ct.slice(0, 16)] : undefined
    const typing = now - c.typingS < 9000
    const line = typing ? t.typing
      : !c.last ? (c.opened ? t.noMsgs : t.notOpened)
      : (c.last.from === 'o' ? t.you + ': ' : '') + previewOf(c.last.kind, raw, t)
    const key = keys[c.cid]?.raw
    return (
      <div key={c.cid} className={'pa-it' + (unread > 0 ? ' unread' : '')} role="button" tabIndex={0}
        onClick={() => setScreen({ s: 'chat', cid: c.cid })}>
        <div className="pa-av">{c.nick.charAt(0).toUpperCase()}</div>
        <div className="pa-mt">
          <div className="n">
            {unread > 0 ? <span className="gl" data-t={label(c)}>{label(c)}</span> : <span>{label(c)}</span>}
            <small>{fmtListTime(c.lastAt)}</small>
          </div>
          <div className={'l' + (typing ? ' typ' : '')}>{unread > 0 ? <span className="gl" data-t={line.slice(0, 60)}>{line}</span> : line}</div>
          <div className="pa-tags">
            {unread > 0 ? <span className="pa-tag w">{t.newCount(unread)}</span> : null}
            {!c.opened && key ? <span className="pa-tag">🔑 #{key.slice(0, 4).toUpperCase()}</span> : null}
            {c.oneDevice ? <span className="pa-tag">📱{c.bound ? '✓' : ''}</span> : null}
            {c.msgTtl ? <span className="pa-tag">{t.ttlTag(c.msgTtl)}</span> : null}
            {c.autoDelete ? <span className="pa-tag">⏱ {t.expiresIn(left(c.lastAt, t))}</span> : null}
          </div>
        </div>
        <button className="pa-cp" onClick={(e) => { e.stopPropagation(); void copyLink(c) }}>⧉ {t.url}</button>
      </div>
    )
  }
  return (
    <div className="pa">
      <Header title="Paranoia" sub={t.chats(data.chats.length)}
        right={<>
          <button className="pa-ib" onClick={() => void panic()}>🚨</button>
          <button className="pa-ib" onClick={() => setScreen({ s: 'settings' })}>⚙</button>
        </>} />
      <NetBar t={t} />
      <InAppBar t={t} path={BASE} />
      <div className="pa-body">
        {data.chats.length === 0 ? <div className="pa-empty">{t.empty}</div> : null}
        {active.length ? <><div className="pa-sec">{t.active}</div>{active.map(item)}</> : null}
        {waiting.length ? <><div className="pa-sec">{t.waiting}</div>{waiting.map(item)}</> : null}
        <div style={{ height: 120, flex: 'none' }} />
      </div>
      <button className="pa-fab" onClick={() => setScreen({ s: 'new' })}>＋</button>
      {toastEl}
    </div>
  )
}

function NewChat(p: { auth: string; t: Dict; back: () => void }) {
  const create = useMutation(api.paranoia.createChat)
  const [nick, setNick] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<{ nick: string; url: string; auto: boolean } | null>(null)
  const [auto, setAuto] = useState(false)
  const [oneDev, setOneDev] = useState(true)
  const [ttl, setTtl] = useState(0)
  const [kbOpen, setKbOpen] = useState(true)
  const [kbLang, setKbLang] = useState<KbLang>(() => getKb())
  const [err, setErr] = useState('')
  const [toast, toastEl] = useToast()
  const t = p.t
  const od = useQuery(api.paranoia.ownerData, {}) as { settings: { srv: string } } | undefined
  const srvNow = od?.settings.srv

  async function go() {
    const n = nick.trim()
    if (!n || busy) return
    setBusy(true); setErr('')
    try {
      const cid = rid(16)
      const raw = newChatKey()
      await create({ auth: p.auth, cid, nick: n, raw, autoDelete: auto, oneDevice: oneDev, msgTtl: ttl })
      setRes({ nick: n, url: chatUrl(cid, raw, srvNow), auto }); setNick(''); setKbOpen(false)
    } catch (e) { setErr(errMsg(e, t)) } finally { setBusy(false) }
  }
  const chk = (on: boolean, set: (v: boolean) => void, label: string, sub: string) => (
    <button className={'pa-chk' + (on ? ' on' : '')} onClick={() => set(!on)} aria-pressed={on}>
      <span className="box">{on ? '✓' : ''}</span>
      <span>{label}<small>{sub}</small></span>
    </button>
  )
  return (
    <div className="pa">
      <Header title={t.newChat} sub={t.newSub} back={p.back} />
      <div className="pa-body pa-pad">
        <div className="pa-lbl">{t.nickLabel}</div>
        <KDisplay className="sq" value={nick} placeholder={t.nickPh} active={kbOpen} onClick={() => setKbOpen(true)} />
        {chk(auto, setAuto, '⏱ ' + t.autoOpt, t.autoOptSub)}
        {chk(oneDev, setOneDev, '📱 ' + t.oneDev, t.oneDevSub)}
        <div className="pa-lbl" style={{ marginTop: 2 }}>⏳ {t.ttlLabel}</div>
        <div className="pa-seg wide">
          {([[0, t.ttlOff], [60_000, t.ttl1m], [3_600_000, t.ttl1h], [86_400_000, t.ttl24h], [-1, t.ttlRead]] as [number, string][]).map(([v, l]) => (
            <button key={v} className={ttl === v ? 'on' : ''} onClick={() => setTtl(v)}>{l}</button>
          ))}
        </div>
        <div style={{ height: 12 }} />
        <button className="pa-btn" onClick={() => void go()} disabled={busy || !nick.trim()}>{t.create}</button>
        {err ? <p className="pa-note" style={{ marginTop: 8 }}>⚠ {err}</p> : null}
        {res ? (
          <div className="pa-box">
            <div className="pa-lbl" style={{ marginTop: 0 }}>{t.linkFor(res.nick)}</div>
            <div className="pa-url">{res.url}</div>
            <div className="pa-key">{t.keyNote}</div>
            <div className="pa-key">{res.auto ? '⏱ ' + t.autoOpt : t.keep}</div>
            <div style={{ height: 12 }} />
            <button className="pa-btn" onClick={() => void copyText(res.url).then((ok) => ok && toast(t.copied))}>{t.copyUrl}</button>
            {typeof navigator !== 'undefined' && 'share' in navigator ? (
              <>
                <div style={{ height: 8 }} />
                <button className="pa-btn o" onClick={() => void navigator.share({ title: 'Paranoia', url: res.url }).catch(() => {})}>{t.share}</button>
              </>
            ) : null}
          </div>
        ) : null}
        <p className="pa-note" style={{ marginTop: 14 }}>{t.ttlNote}</p>
      </div>
      {kbOpen ? (
        <div className="pa-dock">
          <Keyboard lang={kbLang} onLang={(l) => { setKb(l); setKbLang(l) }} spaceLabel={t.space} enterLabel="✓" value={nick} autoCap
            onChar={(c) => { if (c !== '\n') setNick((v) => (v + c).slice(0, 30)) }} onBack={() => setNick((v) => backspace(v))}
            onEnter={() => void go()} onHide={() => setKbOpen(false)} />
        </div>
      ) : null}
      {toastEl}
    </div>
  )
}

function OwnerChat(p: {
  c: OChat; auth: string; t: Dict; prefs: Prefs; ckey: CryptoKey | null
  back: () => void; copy: () => void; toastEl: ReactNode; toast: (m: string) => void
}) {
  const data = useQuery(api.paranoia.chatMsgs, { cid: p.c.cid, auth: p.auth })
  const del = useMutation(api.paranoia.deleteChat)
  const unbind = useMutation(api.paranoia.unbindDevice)
  const t = p.t
  useNow()
  const live = data && !data.locked ? data : null
  useEffect(() => { if (live) setV('pn_seen_' + p.c.cid, String(live.count)) }, [live?.count])
  useEffect(() => { if (data === null) p.back() }, [data])
  const name = p.c.senderNick ? `${p.c.nick} (${p.c.senderNick})` : p.c.nick
  const subParts = [t.encrypted]
  const curTtl = live?.msgTtl ?? p.c.msgTtl
  if (curTtl) subParts.push(t.ttlTag(curTtl))
  if (live?.autoDelete ?? p.c.autoDelete) subParts.push(t.expiresIn(left(live?.lastAt ?? p.c.lastAt, t)))

  return (
    <div className="pa">
      <Header title={name} back={p.back} av={p.c.nick.charAt(0).toUpperCase()} sub={subParts.join(' · ')}
        right={<>
          {p.c.oneDevice && p.c.bound ? (
            <button className="pa-ib" onClick={() => { if (confirm(t.unbindQ)) void unbind({ auth: p.auth, cid: p.c.cid }).then(() => p.toast(t.unbound)) }}>📱</button>
          ) : null}
          <button className="pa-ib" onClick={p.copy}>⧉</button>
          <button className="pa-ib" onClick={() => { if (confirm(t.delChat(p.c.nick))) void del({ auth: p.auth, cid: p.c.cid }).then(p.back) }}>🗑</button>
        </>} />
      <NetBar t={t} />
      <ChatView cid={p.c.cid} acc={{ auth: p.auth }} msgs={live?.msgs} ckey={p.ckey} me="o" t={t} prefs={p.prefs}
        otherName={p.c.senderNick || p.c.nick} otherTyping={live?.typingS ?? 0} otherRead={live?.readS ?? 0} myRead={live?.readO ?? 0}
        ttl={curTtl} auto={live?.autoDelete ?? p.c.autoDelete} />
      {p.toastEl}
    </div>
  )
}

function Settings(p: {
  auth: string; srv: string; prefs: Prefs; t: Dict; back: () => void; onPanic: () => void
}) {
  const save = useMutation(api.paranoia.saveSettings)
  const changeSrv = useMutation(api.paranoia.changeServer)
  const delAll = useMutation(api.paranoia.deleteAll)
  const savePushM = useMutation(api.paranoia.savePush)
  const [name, setName] = useState(p.prefs.ownerName)
  const [busy, setBusy] = useState(false)
  const [nmode, setNmode] = useState<NotifyMode>(() => getMode())
  const [kbLang, setKbLang] = useState<KbLang>(() => getKb())
  const [nameKb, setNameKb] = useState(false)
  const [pst, setPst] = usePushState()
  const install = useInstall()
  const [toast, toastEl] = useToast()
  const t = p.t
  const pickMode = (m: NotifyMode) => { setMode(m); setNmode(m); if (m !== 'off') notifyIncoming(m) }
  const pickKb = (l: KbLang) => { setKb(l); setKbLang(l) }
  const saveName = () => { setNameKb(false); if (name.trim() && name.trim() !== p.prefs.ownerName) void save({ auth: p.auth, ownerName: name }) }
  async function turnOnPush() {
    const sub = await enablePush()
    if (sub) { await savePushM({ ...subKeys(sub), ownerAuth: p.auth }); setPst('on'); toast(t.pushOn) }
    else { const st = await pushState(); setPst(st); if (st !== 'denied') toast(t.pushFail) }
  }
  const sw = (on: boolean, k: 'ytApp' | 'chrome' | 'ask' | 'pushNames') => (
    <button className={'pa-sw' + (on ? ' on' : '')} aria-pressed={on} onClick={() => void save({ auth: p.auth, [k]: !on })} />
  )
  async function pickServer() {
    const v = window.prompt(t.srvQ, p.srv)
    if (!v || v.trim() === p.srv) return
    setBusy(true)
    try { await changeSrv({ srv: v }); toast('✓') } catch (e) { alert(errMsg(e, t)) } finally { setBusy(false) }
  }

  return (
    <div className="pa">
      <Header title={t.settings} back={p.back} />
      <div className="pa-body">
        <div className="pa-row"><div>{t.myName}<small>{t.myNameSub}</small></div>
          <KDisplay className="sm" value={name} placeholder="…" active={nameKb} onClick={() => setNameKb(true)} /></div>
        <div className="pa-row"><div>{t.language}<small>{t.languageSub}</small></div>
          <div className="pa-seg">
            <button className={p.prefs.lang === 'lt' ? 'on' : ''} onClick={() => void save({ auth: p.auth, lang: 'lt' })}>LT</button>
            <button className={p.prefs.lang === 'en' ? 'on' : ''} onClick={() => void save({ auth: p.auth, lang: 'en' })}>EN</button>
          </div></div>
        <div className="pa-row"><div>{t.kb}<small>{t.kbSub}</small></div>
          <div className="pa-seg">
            <button className={kbLang === 'lt' ? 'on' : ''} onClick={() => pickKb('lt')}>LT</button>
            <button className={kbLang === 'en' ? 'on' : ''} onClick={() => pickKb('en')}>EN</button>
          </div></div>
        <div className="pa-row"><div>{t.notify}<small>{t.notifySub}</small></div>
          <div className="pa-seg">
            <button className={nmode === 'sound' ? 'on' : ''} onClick={() => pickMode('sound')}>{t.mSound}</button>
            <button className={nmode === 'vib' ? 'on' : ''} onClick={() => pickMode('vib')}>{t.mVib}</button>
            <button className={nmode === 'off' ? 'on' : ''} onClick={() => pickMode('off')}>{t.mOff}</button>
          </div></div>
        <div className="pa-row"><div>{t.pushTitle}<small>{pst === 'ios-install' ? t.iosHint : isInApp() ? t.inApp : t.pushSub}</small></div>
          {pst === 'on' ? <span className="pa-val">{t.pushOn}</span>
            : pst === 'off' ? <button className="pa-val" onClick={() => void turnOnPush()}>{t.pushEnable}</button>
            : <span className="pa-val">{pst === 'denied' ? t.pushBlocked : pst === 'ios-install' ? '📲' : t.pushNo}</span>}</div>
        <div className="pa-row"><div>{t.pushNames}<small>{t.pushNamesSub}</small></div>{sw(!!p.prefs.pushNames, 'pushNames')}</div>
        {install ? (
          <div className="pa-row"><div>{t.install}<small>{t.installSub}</small></div>
            <button className="pa-val" onClick={() => void install()}>{t.installBtn}</button></div>
        ) : null}
        <div className="pa-row"><div>{t.autoDel}<small>{t.autoDelSub}</small></div><span className="pa-val">{t.autoDelVal}</span></div>
        <div className="pa-row"><div>{t.ytLinks}<small>{t.ytLinksSub}</small></div>{sw(p.prefs.ytApp, 'ytApp')}</div>
        <div className="pa-row"><div>{t.otherLinks}<small>{t.otherLinksSub}</small></div>{sw(p.prefs.chrome, 'chrome')}</div>
        <div className="pa-row"><div>{t.askOpen}<small>{t.askOpenSub}</small></div>{sw(p.prefs.ask, 'ask')}</div>
        <div className="pa-row"><div>{t.srv}<small>{t.srvSub}</small></div>
          <button className="pa-val" onClick={() => void pickServer()} disabled={busy}>{p.srv.replace(/^https?:\/\//, '')}</button></div>
        <div className="pa-row"><div>{t.myAccess}<small>{t.myAccessSub}</small></div>
          <button className="pa-val" onClick={() => { if (confirm(t.myAccessQ)) void copyText(exportLink()).then((ok) => ok && toast(t.copied)) }}>⧉</button></div>
        <div className="pa-row"><div>{t.delAll}<small>{t.delAllSub}</small></div>
          <button className="pa-val" onClick={() => { if (confirm(t.delAllQ)) void delAll({ auth: p.auth }) }}>{t.delAllBtn}</button></div>
        <div className="pa-row"><div>{t.panic}<small>{t.panicSub}</small></div>
          <button className="pa-val danger" onClick={p.onPanic}>🚨</button></div>
        <p className="pa-note" style={{ padding: 12 }}>{t.footer}</p>
      </div>
      {nameKb ? (
        <div className="pa-dock">
          <Keyboard lang={kbLang} onLang={pickKb} spaceLabel={t.space} enterLabel="✓" value={name} autoCap
            onChar={(c) => { if (c !== '\n') setName((v) => (v + c).slice(0, 24)) }} onBack={() => setName((v) => backspace(v))}
            onEnter={saveName} onHide={saveName} />
        </div>
      ) : null}
      {toastEl}
    </div>
  )
}

