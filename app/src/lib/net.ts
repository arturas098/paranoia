// Paranoia v9 transport: replaces the v7 Convex backend with ntfy.
// Every action is an encrypted event (AES-256-GCM, chat key) published to the chat's ntfy topic.
// Each device rebuilds the chat state from the event stream and keeps it in localStorage / IndexedDB.
import { useMemo, useSyncExternalStore } from 'react'
import { b64u, ub64u, rid, importChatKey, encrypt, decrypt } from './crypto'
import { tr } from './i18n'

export const DEF_SRV = 'https://ntfy.sh'
export const BASE = (() => { try { return window.location.pathname.replace(/[^/]*$/, '') || '/' } catch { return '/' } })()
const DAY = 24 * 3600_000

export type Prefs = { ownerName: string; lang: string; ytApp: boolean; chrome: boolean; ask: boolean; pushNames?: boolean }
type Settings = Prefs & { srv: string }
type Role = 'o' | 's'
export type Msg = {
  id: string; from: Role; iv: string; ct: string; at: number; kind?: string | null
  liked?: boolean; ttl?: number; expiresAt?: number | null; blob?: string | null
}
type Chat = {
  cid: string; raw: string; role: Role; srv: string
  nick: string; senderNick: string | null; createdAt: number; lastAt: number; opened: boolean; count: number
  autoDelete: boolean; msgTtl: number; oneDevice: boolean; bound: string
  typingO: number; typingS: number; readO: number; readS: number
  msgs: Msg[]; seen: string[]; bl: Record<string, { u: string; iv: string }>
  cfg?: Prefs; locked?: boolean; myDev?: string
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = { e: string; eid: string; ts: number; from: Role; _u?: string; [k: string]: any }

// ---------- storage ----------
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }
const lsDel = (k: string) => { try { localStorage.removeItem(k) } catch {} }
function jget<T>(k: string, d: T): T { try { const v = lsGet(k); return v ? (JSON.parse(v) as T) : d } catch { return d } }
const jset = (k: string, v: unknown) => lsSet(k, JSON.stringify(v))

let dbp: Promise<IDBDatabase> | null = null
function db() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('pn9', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('b')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))
}
async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  try {
    const d = await db()
    return await new Promise((res) => {
      const q = f(d.transaction('b', mode).objectStore('b'))
      q.onsuccess = () => res(q.result as T)
      q.onerror = () => res(undefined)
    })
  } catch { return undefined }
}
type B = { iv: string; ct: string }
const idbGet = (k: string) => idb<B>('readonly', (s) => s.get(k))
const idbSet = (k: string, v: B) => idb('readwrite', (s) => s.put(v, k))
const idbDel = (k: string) => idb('readwrite', (s) => s.delete(k))
export const idbClear = () => idb('readwrite', (s) => s.clear())

// ---------- reactive store ----------
let ver = 0
const subs = new Set<() => void>()
let emitT: ReturnType<typeof setTimeout> | null = null
function emit() {
  if (emitT) return
  emitT = setTimeout(() => { emitT = null; ver++; subs.forEach((f) => f()) }, 16)
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }
const getVer = () => ver

export const settings: Settings = { ownerName: '', lang: 'lt', ytApp: true, chrome: true, ask: true, pushNames: false, srv: DEF_SRV, ...jget<Partial<Settings>>('pn_settings', {}) }
const saveSettings = () => jset('pn_settings', settings)
const prefsOf = (): Prefs => ({ ownerName: settings.ownerName, lang: settings.lang, ytApp: settings.ytApp, chrome: settings.chrome, ask: settings.ask, pushNames: settings.pushNames })

const chats = new Map<string, Chat>()
const ids = (r: Role) => jget<string[]>(r === 'o' ? 'pn_ochats' : 'pn_schats', [])
function setIds(r: Role, a: string[]) { jset(r === 'o' ? 'pn_ochats' : 'pn_schats', Array.from(new Set(a))) }
function mk(p: Partial<Chat> & { cid: string; raw: string; role: Role }): Chat {
  const now = Date.now()
  return {
    srv: DEF_SRV, nick: '', senderNick: null, createdAt: now, lastAt: now, opened: false, count: 0,
    autoDelete: false, msgTtl: 0, oneDevice: false, bound: '', typingO: 0, typingS: 0, readO: 0, readS: 0,
    msgs: [], seen: [], bl: {}, ...p,
  }
}
function loadAll() {
  for (const r of ['o', 's'] as Role[]) {
    for (const id of ids(r)) {
      const c = jget<Chat | null>('pn_chat_' + id, null)
      if (c && c.raw) chats.set(id, mk(c))
    }
  }
}
const dirty = new Set<Chat>()
let saveT: ReturnType<typeof setTimeout> | null = null
function touch(c: Chat) {
  dirty.add(c)
  if (!saveT) saveT = setTimeout(() => { saveT = null; dirty.forEach((x) => { if (chats.get(x.cid) === x) jset('pn_chat_' + x.cid, x) }); dirty.clear() }, 150)
  emit()
}
function addChat(c: Chat) {
  chats.set(c.cid, c)
  setIds(c.role, [...ids(c.role), c.cid])
  jset('pn_chat_' + c.cid, c)
  resync()
  emit()
}

// ---------- crypto envelope ----------
const keyP = new Map<string, Promise<CryptoKey>>()
function key(c: Chat) {
  let p = keyP.get(c.cid)
  if (!p) { p = importChatKey(c.raw); keyP.set(c.cid, p) }
  return p
}
async function seal(c: Chat, ev: Ev) {
  const r = await encrypt(await key(c), JSON.stringify(ev))
  return 'p7.' + r.iv + '.' + r.ct
}
async function unseal(c: Chat, s: string): Promise<Ev> {
  const [p, iv, ct] = s.split('.')
  if (p !== 'p7') throw new Error('fmt')
  return JSON.parse(await decrypt(await key(c), iv, ct)) as Ev
}
const topic = (cid: string) => 'pn9' + cid
const srvOf = (c: Chat) => (c.srv || DEF_SRV).replace(/\/+$/, '')

async function publish(c: Chat, ev: { e: string; [k: string]: unknown }, opt: { cache?: boolean; bytes?: Uint8Array } = {}) {
  const full = { eid: rid(14), ts: Date.now(), from: c.role, ...ev } as Ev
  const body = await seal(c, full)
  const url = srvOf(c) + '/' + topic(c.cid)
  const r = opt.bytes
    ? await fetch(url + '?filename=p.bin&message=' + encodeURIComponent(body), { method: 'PUT', body: opt.bytes as unknown as BodyInit })
    : await fetch(url + (opt.cache === false ? '?cache=no' : ''), { method: 'POST', body })
  if (!r.ok) throw new Error(r.status === 429 ? 'RATE' : r.status === 413 ? 'TOO_LONG' : 'NET ' + r.status)
  if (chats.get(c.cid) === c) apply(c, full, true)
  return full
}

// ---------- applying events ----------
function sys(c: Chat, ev: Ev, kind: string, ct: string) {
  if (c.msgs.some((m) => m.id === ev.eid)) return
  insert(c, { id: ev.eid, from: ev.from, iv: '', ct, at: ev.ts, kind })
}
function insert(c: Chat, m: Msg) {
  c.msgs.push(m)
  if (c.msgs.length > 1 && c.msgs[c.msgs.length - 2].at > m.at) c.msgs.sort((a, b) => a.at - b.at)
}
const cfgTimes = new Map<string, number>()
function sendCfg(c: Chat, force = false) {
  const last = cfgTimes.get(c.cid) ?? 0
  if (!force && Date.now() - last < 20_000) return
  cfgTimes.set(c.cid, Date.now())
  void publish(c, { e: 'cfg', cfg: prefsOf(), ttl: c.msgTtl, auto: c.autoDelete, one: c.oneDevice }).catch(() => {})
}

function apply(c: Chat, ev: Ev, local: boolean) {
  if (c.seen.includes(ev.eid)) return
  if (ev.e !== 'typing') {
    c.seen.push(ev.eid)
    if (c.seen.length > 3000) c.seen.splice(0, c.seen.length - 3000)
  }
  const fromO = ev.from === 'o'
  const find = (id: unknown) => c.msgs.find((m) => m.id === id)
  switch (ev.e) {
    case 'msg': {
      if (typeof ev.id !== 'string' || find(ev.id)) break
      const ttl = Number(ev.ttl) || 0
      const m: Msg = {
        id: ev.id, from: ev.from, iv: String(ev.iv ?? ''), ct: String(ev.ct ?? ''), at: ev.ts,
        kind: ev.kind === 'bell' || ev.kind === 'img' || ev.kind === 'voice' ? ev.kind : null,
        ttl, expiresAt: ttl > 0 ? ev.ts + ttl : null, blob: typeof ev.blob === 'string' ? ev.blob : null,
      }
      if (m.blob && ev._u) c.bl[m.blob] = { u: ev._u, iv: String(ev.biv ?? '') }
      c.lastAt = Math.max(c.lastAt, ev.ts)
      if (m.expiresAt && m.expiresAt < Date.now()) break
      insert(c, m)
      c.count++
      if (ev.from !== c.role && !local) incoming(c, m)
      break
    }
    case 'like': { const m = find(ev.id); if (m) m.liked = !!ev.v; break }
    case 'destroy': { const m = find(ev.id); if (m && !m.expiresAt) m.expiresAt = ev.ts + 60_000; break }
    case 'typing': if (fromO) c.typingO = Math.max(c.typingO, ev.ts); else c.typingS = Math.max(c.typingS, ev.ts); break
    case 'read': {
      const at = Number(ev.at) || 0
      if (fromO) c.readO = Math.max(c.readO, at); else c.readS = Math.max(c.readS, at)
      for (const m of c.msgs) if (m.from !== ev.from && m.ttl === -1 && !m.expiresAt && m.at <= at) m.expiresAt = ev.ts + 30_000
      break
    }
    case 'ttl': { const v = Number(ev.v) || 0; c.msgTtl = [0, -1, 60_000, 3_600_000, 86_400_000].includes(v) ? v : 0; sys(c, ev, 'ttl', String(c.msgTtl)); break }
    case 'auto': c.autoDelete = !!ev.on; c.lastAt = Math.max(c.lastAt, ev.ts); sys(c, ev, 'auto', ev.on ? '1' : '0'); break
    case 'nick': if (!fromO) c.senderNick = String(ev.nick ?? '').slice(0, 24) || c.senderNick; break
    case 'open': {
      if (fromO) break
      const dev = String(ev.dev ?? '')
      c.opened = true
      if (!c.bound) c.bound = dev
      if (c.role === 's' && c.oneDevice && c.bound && c.myDev && c.bound !== c.myDev) c.locked = true
      if (c.role === 'o' && !local) {
        sendCfg(c)
        if (c.oneDevice && c.bound && dev && dev !== c.bound) void publish(c, { e: 'lock', dev }).catch(() => {})
      }
      break
    }
    case 'lock': if (fromO && c.role === 's' && ev.dev === c.myDev) c.locked = true; break
    case 'unbind':
      if (!fromO) break
      c.bound = ''
      if (c.role === 's' && c.locked) { c.locked = false; if (!local && c.myDev) void publish(c, { e: 'open', dev: c.myDev }).catch(() => {}) }
      break
    case 'cfg':
      if (!fromO || c.role !== 's') break
      if (ev.cfg && typeof ev.cfg === 'object') c.cfg = ev.cfg as Prefs
      if (typeof ev.ttl === 'number') c.msgTtl = ev.ttl
      if (typeof ev.auto === 'boolean') c.autoDelete = ev.auto
      c.oneDevice = !!ev.one
      if (c.oneDevice && c.bound && c.myDev && c.bound !== c.myDev) c.locked = true
      break
    case 'move':
      if (fromO && typeof ev.srv === 'string' && /^https?:\/\//.test(ev.srv)) { c.srv = ev.srv; setTimeout(() => resync(), 50) }
      break
    case 'del':
      localDel(c)
      return
    default: break
  }
  touch(c)
}

function localDel(c: Chat) {
  chats.delete(c.cid)
  dirty.delete(c)
  lsDel('pn_chat_' + c.cid)
  setIds(c.role, ids(c.role).filter((x) => x !== c.cid))
  if (c.role === 's') {
    lsSet('pn_gone_' + c.cid, '1')
    lsDel('pn_ck_' + c.cid); lsDel('pn_nick_' + c.cid); lsDel('pn_pushask_' + c.cid)
    if (lsGet('pn_last') === c.cid) lsDel('pn_last')
  }
  for (const m of c.msgs) if (m.blob) void idbDel(m.blob)
  keyP.delete(c.cid)
  resync()
  emit()
}

async function incoming(c: Chat, m: Msg) {
  try {
    if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return
    const s = c.role === 's' ? c.cfg : prefsOf()
    const t = tr(s?.lang)
    const name = c.role === 'o' ? (c.senderNick || c.nick) : (c.cfg?.ownerName || '')
    const title = settings.pushNames && name ? name : 'Paranoia'
    const body = m.kind === 'bell' ? '🛎️ ' + t.bell : t.newMsg
    const o = { body, tag: 'pn-' + c.cid, renotify: true, icon: BASE + 'pn-icon-192.png', badge: BASE + 'pn-badge-96.png', data: { url: BASE } } as NotificationOptions
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration(BASE) : undefined
    if (reg) await reg.showNotification(title, o)
    else new Notification(title, o)
  } catch {}
}

// ---------- ntfy streams ----------
const streams = new Map<string, EventSource>()
let sig = ''
let down = false
let reT: ReturnType<typeof setTimeout> | undefined
function setDown(v: boolean) { if (down !== v) { down = v; emit() } }
function resync(force = false) {
  if (typeof EventSource === 'undefined') return
  const groups: Record<string, string[]> = {}
  for (const c of chats.values()) (groups[srvOf(c)] ||= []).push(topic(c.cid))
  const s = JSON.stringify(groups)
  if (!force && s === sig) return
  sig = s
  streams.forEach((es) => es.close())
  streams.clear()
  for (const [srv, tps] of Object.entries(groups)) openStream(srv, tps)
  if (!Object.keys(groups).length) setDown(false)
}
function openStream(srv: string, tps: string[]) {
  let es: EventSource
  try { es = new EventSource(`${srv}/${tps.join(',')}/sse?since=all`) } catch { setDown(true); return }
  streams.set(srv, es)
  es.onopen = () => setDown(false)
  es.onmessage = (e) => { let j; try { j = JSON.parse(e.data) } catch { return } enqueue(j) }
  es.onerror = () => {
    if (streams.get(srv) !== es) return
    es.close(); streams.delete(srv); setDown(true)
    clearTimeout(reT); reT = setTimeout(() => resync(true), 4000)
  }
}
let chain: Promise<void> = Promise.resolve()
const seenN = new Set<string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function enqueue(j: any) { chain = chain.then(() => handle(j)).catch(() => {}) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handle(j: any) {
  if (!j || j.event !== 'message' || typeof j.topic !== 'string' || seenN.has(j.id)) return
  seenN.add(j.id)
  const c = chats.get(String(j.topic).slice(3))
  if (!c) return
  let s: string = typeof j.message === 'string' ? j.message : ''
  let att: string | undefined = j.attachment?.url
  if (!s.startsWith('p7.')) {
    if (!att) return
    try { s = await (await fetch(att)).text() } catch { return }
    att = undefined
    if (!s.startsWith('p7.')) return
  }
  let ev: Ev
  try { ev = await unseal(c, s) } catch { return }
  if (!ev || typeof ev.e !== 'string' || typeof ev.eid !== 'string' || typeof ev.ts !== 'number' || (ev.from !== 'o' && ev.from !== 's')) return
  ev._u = att
  if (chats.get(c.cid) !== c) return
  apply(c, ev, false)
}

// housekeeping: disappearing messages + 24 h chat deletion
if (typeof window !== 'undefined') {
  loadAll()
  setTimeout(() => resync(), 0)
  window.addEventListener('online', () => resync(true))
  setInterval(() => {
    const now = Date.now()
    for (const c of Array.from(chats.values())) {
      if (c.autoDelete && now - c.lastAt > DAY) { localDel(c); continue }
      const n = c.msgs.length
      const gone = c.msgs.filter((m) => m.expiresAt && m.expiresAt <= now)
      if (gone.length) {
        c.msgs = c.msgs.filter((m) => !m.expiresAt || m.expiresAt > now)
        for (const m of gone) if (m.blob) void idbDel(m.blob)
      }
      if (c.msgs.length !== n) touch(c)
    }
  }, 3000)
}

// ---------- blobs (photos, voice) ----------
const blobMem = new Map<string, B>()
const blobBusy = new Set<string>()
async function loadBlob(cid: string, id: string) {
  let b = await idbGet(id)
  if (!b) {
    const meta = chats.get(cid)?.bl[id]
    if (!meta) { blobBusy.delete(id); return }
    try {
      const r = await fetch(meta.u)
      if (!r.ok) return
      b = { iv: meta.iv, ct: b64u(new Uint8Array(await r.arrayBuffer())) }
      void idbSet(id, b)
    } catch { return }
  }
  blobMem.set(id, b)
  emit()
}

// ---------- public helpers ----------
export function chatUrl(cid: string, raw: string, srv?: string) {
  const s = srv && srv.replace(/\/+$/, '') !== DEF_SRV ? '&s=' + encodeURIComponent(srv) : ''
  return `${window.location.origin}${BASE}?c=${cid}${s}#${raw}`
}
export function isOwnerChat(cid: string) { return chats.get(cid)?.role === 'o' }
export function exportLink() {
  const c = ids('o').map((id) => chats.get(id)).filter((x): x is Chat => !!x).map((x) => ({
    cid: x.cid, raw: x.raw, nick: x.nick, srv: x.srv, a: x.autoDelete, t: x.msgTtl, o: x.oneDevice, at: x.createdAt, sn: x.senderNick,
  }))
  const data = JSON.stringify({ s: settings, c })
  return `${window.location.origin}${BASE}#own=${b64u(new TextEncoder().encode(data))}`
}
export function importOwner(h: string) {
  try {
    const d = JSON.parse(new TextDecoder().decode(ub64u(h))) as { s?: Partial<Settings>; c?: { cid: string; raw: string; nick: string; srv: string; a: boolean; t: number; o: boolean; at: number; sn: string | null }[] }
    if (d.s) { Object.assign(settings, d.s); saveSettings() }
    let n = 0
    for (const x of d.c ?? []) {
      if (!/^[a-z0-9]{8,40}$/.test(x.cid) || chats.has(x.cid)) continue
      addChat(mk({ cid: x.cid, raw: x.raw, role: 'o', nick: x.nick, srv: x.srv || DEF_SRV, autoDelete: !!x.a, msgTtl: x.t || 0, oneDevice: !!x.o, createdAt: x.at || Date.now(), senderNick: x.sn ?? null }))
      n++
    }
    emit()
    return n
  } catch { return -1 }
}
export function useNetDown() {
  useSyncExternalStore(subscribe, getVer, getVer)
  return down
}

// ---------- Convex-compatible API used by the v7 UI ----------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any
const need = (cid: string) => { const c = chats.get(cid); if (!c) throw new Error('ENDED'); return c }
function view(c: Chat) {
  return {
    msgs: c.msgs.map((m) => ({ ...m })), locked: !!c.locked, senderNick: c.senderNick, msgTtl: c.msgTtl, autoDelete: c.autoDelete,
    lastAt: c.lastAt, typingO: c.typingO, typingS: c.typingS, readO: c.readO, readS: c.readS, count: c.count,
  }
}
function oChat(c: Chat) {
  const l = c.msgs[c.msgs.length - 1]
  return {
    cid: c.cid, raw: c.raw, srv: c.srv, nick: c.nick, senderNick: c.senderNick, wrapped: '', createdAt: c.createdAt, lastAt: c.lastAt,
    opened: c.opened, count: c.count, autoDelete: c.autoDelete, msgTtl: c.msgTtl, oneDevice: c.oneDevice, bound: !!c.bound, typingS: c.typingS,
    last: l ? { from: l.from, iv: l.iv, ct: l.ct, kind: l.kind } : null,
  }
}
const ownerChats = () => ids('o').map((id) => chats.get(id)).filter((c): c is Chat => !!c && c.role === 'o')

export const api = {
  paranoia: {
    publicSettings: { q: (a: A) => { const c = a?.cid ? chats.get(a.cid) : undefined; return c && c.role === 's' ? (c.cfg ?? { ownerName: '', lang: 'lt', ytApp: true, chrome: true, ask: true }) : prefsOf() } },
    chatMsgs: { q: (a: A) => { const c = chats.get(a.cid); if (!c) return lsGet('pn_gone_' + a.cid) ? null : undefined; return view(c) } },
    ownerData: { q: () => ({ settings: { ...prefsOf(), srv: settings.srv }, chats: ownerChats().sort((x, y) => y.lastAt - x.lastAt).map(oChat) }) },
    getBlob: {
      q: (a: A) => {
        const b = blobMem.get(a.id)
        if (b) return b
        if (!blobBusy.has(a.id)) { blobBusy.add(a.id); void loadBlob(a.cid, a.id) }
        return undefined
      },
    },
    openChat: {
      m: async (a: A) => {
        if (lsGet('pn_gone_' + a.cid) || !a.raw) return
        let c = chats.get(a.cid)
        if (c?.role === 'o') return
        if (!c) { c = mk({ cid: a.cid, raw: a.raw, role: 's', srv: a.srv || DEF_SRV }); addChat(c) }
        c.myDev = a.dev
        touch(c)
        await publish(c, { e: 'open', dev: a.dev })
      },
    },
    setNick: { m: async (a: A) => { const c = need(a.cid); const n = String(a.nick).trim().slice(0, 24); if (!n) throw new Error('NO_NICK'); await publish(c, { e: 'nick', nick: n }); c.senderNick = n; touch(c); return n } },
    send: { m: async (a: A) => { const c = need(a.cid); await publish(c, { e: 'msg', id: rid(12), iv: a.iv, ct: a.ct, kind: a.bell ? 'bell' : null, ttl: c.msgTtl }) } },
    sendBlob: {
      m: async (a: A) => {
        const c = need(a.cid)
        const id = rid(12)
        const b = { iv: a.biv, ct: a.bct }
        blobMem.set(id, b); void idbSet(id, b)
        await publish(c, { e: 'msg', id, iv: a.iv, ct: a.ct, kind: a.kind, ttl: c.msgTtl, blob: id, biv: a.biv }, { bytes: ub64u(a.bct) })
      },
    },
    toggleLike: { m: async (a: A) => { const c = need(a.cid); const m = c.msgs.find((x) => x.id === a.id); if (m) await publish(c, { e: 'like', id: a.id, v: !m.liked }) } },
    destroyIn60: { m: async (a: A) => { const c = need(a.cid); await publish(c, { e: 'destroy', id: a.id }) } },
    setTyping: { m: async (a: A) => { const c = chats.get(a.cid); if (c) await publish(c, { e: 'typing' }, { cache: false }) } },
    markRead: { m: async (a: A) => { const c = chats.get(a.cid); if (c && a.at > (c.role === 'o' ? c.readO : c.readS)) await publish(c, { e: 'read', at: a.at }) } },
    setMsgTtl: { m: async (a: A) => { const c = need(a.cid); await publish(c, { e: 'ttl', v: a.ttl }) } },
    setAutoDelete: { m: async (a: A) => { const c = need(a.cid); await publish(c, { e: 'auto', on: !!a.on }) } },
    guestDelete: { m: async (a: A) => { const c = chats.get(a.cid); if (!c) return; try { await publish(c, { e: 'del' }) } catch { localDel(c) } if (chats.has(a.cid)) localDel(c) } },
    deleteChat: { m: async (a: A) => { const c = chats.get(a.cid); if (!c) return; try { await publish(c, { e: 'del' }) } catch {} if (chats.has(a.cid)) localDel(c) } },
    unbindDevice: { m: async (a: A) => { const c = need(a.cid); await publish(c, { e: 'unbind' }) } },
    createChat: {
      m: async (a: A) => {
        const c = mk({ cid: a.cid, raw: a.raw, role: 'o', srv: settings.srv, nick: String(a.nick).slice(0, 30), autoDelete: !!a.autoDelete, oneDevice: !!a.oneDevice, msgTtl: a.msgTtl || 0 })
        addChat(c)
        sendCfg(c, true)
      },
    },
    saveSettings: {
      m: async (a: A) => {
        const { auth: _x, ...rest } = a ?? {}
        Object.assign(settings, rest)
        saveSettings(); emit()
        if (['ownerName', 'lang', 'ytApp', 'chrome', 'ask'].some((k) => k in rest)) for (const c of ownerChats()) sendCfg(c, true)
      },
    },
    changeServer: {
      m: async (a: A) => {
        let s = String(a.srv || '').trim().replace(/\/+$/, '')
        if (!s) return
        if (!/^https?:\/\//.test(s)) s = 'https://' + s
        for (const c of ownerChats()) { try { await publish(c, { e: 'move', srv: s }) } catch {} c.srv = s; touch(c) }
        settings.srv = s; saveSettings(); resync(); emit()
      },
    },
    deleteAll: { m: async () => { for (const c of ownerChats()) { try { await publish(c, { e: 'del' }) } catch {} if (chats.has(c.cid)) localDel(c) } } },
    panicOwner: {
      m: async () => {
        for (const c of Array.from(chats.values())) { try { await publish(c, { e: 'del' }) } catch {} if (chats.has(c.cid)) localDel(c) }
        await idbClear()
      },
    },
    savePush: { m: async () => {} },
  },
}

export function useQuery(f: A, args?: A): A {
  const v = useSyncExternalStore(subscribe, getVer, getVer)
  const k = args === 'skip' ? 'skip' : JSON.stringify(args ?? {})
  return useMemo(() => (k === 'skip' ? undefined : f.q(args ?? {})), [v, k])
}
export function useMutation(f: A): (a?: A) => Promise<A> {
  return f.m
}
