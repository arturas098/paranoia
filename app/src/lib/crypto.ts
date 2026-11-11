// End-to-end encryption helpers (Web Crypto). Keys never leave the browser.
const enc = new TextEncoder()
const dec = new TextDecoder()
const bs = (u: Uint8Array) => u as unknown as BufferSource

export function b64u(b: Uint8Array) {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function ub64u(s: string) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}
export function rand(n: number) {
  const u = new Uint8Array(n)
  crypto.getRandomValues(u)
  return u
}
export function rid(n = 12) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from(rand(n), (x) => a[x % 36]).join('')
}
export function newChatKey() {
  return b64u(rand(32))
}
export function newAccessKey() {
  return b64u(rand(18))
}

export async function authHash(access: string) {
  const h = await crypto.subtle.digest('SHA-256', bs(enc.encode('paranoia-auth:' + access)))
  return Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join('')
}

export async function wrapKeyFrom(access: string) {
  const base = await crypto.subtle.importKey('raw', bs(enc.encode(access)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bs(enc.encode('paranoia-wrap-v2')), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

export async function importChatKey(raw: string) {
  const b = ub64u(raw)
  if (b.length !== 32) throw new Error('BAD_KEY')
  return crypto.subtle.importKey('raw', bs(b), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(key: CryptoKey, text: string) {
  const iv = rand(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(enc.encode(text)))
  return { iv: b64u(iv), ct: b64u(new Uint8Array(ct)) }
}
export async function decrypt(key: CryptoKey, iv: string, ct: string) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(ub64u(iv)) }, key, bs(ub64u(ct)))
  return dec.decode(pt)
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array) {
  const iv = rand(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(data))
  return { iv: b64u(iv), ct: b64u(new Uint8Array(ct)) }
}
export async function decryptBytes(key: CryptoKey, iv: string, ct: string) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(ub64u(iv)) }, key, bs(ub64u(ct))))
}

export async function wrap(wk: CryptoKey, raw: string) {
  const r = await encrypt(wk, raw)
  return r.iv + '.' + r.ct
}
export async function unwrap(wk: CryptoKey, wrapped: string) {
  const [iv, ct] = wrapped.split('.')
  return decrypt(wk, iv, ct)
}

