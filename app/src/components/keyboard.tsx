// In-app keyboard modelled on Gboard (QWERTY EN / LT + symbols + emoji), with haptic feedback.
// No <input>/<textarea> is ever focused, so the phone's own keyboard (and its tracking) never opens.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type KbLang = 'en' | 'lt'
/** Default is always EN; LT only if the user picked it. */
export function getKb(_def?: string): KbLang {
  try {
    const v = localStorage.getItem('pn_kb')
    if (v === 'en' || v === 'lt') return v
  } catch {}
  return 'en'
}
export function setKb(l: KbLang) {
  try { localStorage.setItem('pn_kb', l) } catch {}
}

type SegCtor = new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> }
/** Remove the last visible character (keeps emoji like 👍🏽 or 🤷‍♂️ whole). */
export function backspace(s: string) {
  try {
    const Seg = (Intl as unknown as { Segmenter?: SegCtor }).Segmenter
    if (Seg) {
      const parts = Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment)
      parts.pop()
      return parts.join('')
    }
  } catch {}
  const a = Array.from(s)
  a.pop()
  return a.join('')
}

/** True on a computer with mouse + physical keyboard (no on-screen keys needed). */
export function useDesktop() {
  const [d, setD] = useState(false)
  useEffect(() => {
    try {
      const mq = window.matchMedia('(hover: hover) and (pointer: fine)')
      const f = () => setD(mq.matches && !(navigator.maxTouchPoints > 0 && /Android|iPhone|iPad/i.test(navigator.userAgent)))
      f()
      mq.addEventListener?.('change', f)
      return () => mq.removeEventListener?.('change', f)
    } catch { return undefined }
  }, [])
  return d
}

function haptic(ms = 12) {
  try { navigator.vibrate?.(ms) } catch {}
}

const EMOJI = ('😀 😂 🤣 😊 😍 😘 😎 🤔 😏 😉 😇 🙂 😢 😭 😡 🤯 😱 🥳 😴 🙄 😬 🤗 🤫 🤐 '
  + '👍 👎 👌 ✌️ 🤞 🙏 👏 💪 🤘 🤝 👋 🫡 🔥 ❤️ 💔 💯 ✨ 🎉 😈 👀 💀 🤷 🤦 🙈 '
  + '🍺 🍻 ☕ 🍕 🍔 🚗 🏠 ⚽ 🎵 💰 💸 🔒 🔑 🛎️ ✅ ❌ ⚠️ ❓ ⏰ 📍 📞 💬').split(' ')
const ROW_LT = 'ą č ę ė į š ų ū ž'.split(' ')
const R1 = 'q w e r t y u i o p'.split(' ')
const R2 = 'a s d f g h j k l'.split(' ')
const R3 = 'z x c v b n m'.split(' ')
// Gboard symbol page
const S1 = '1 2 3 4 5 6 7 8 9 0'.split(' ')
const S2 = '@ # € _ & - + ( ) /'.split(' ')
const S3 = '* " \' : ; ! ?'.split(' ')
// Gboard second symbol page (=\<)
const T1 = '~ ` | • √ π ÷ × ¶ ∆'.split(' ')
const T2 = '£ ¥ $ ¢ ^ ° = { } \\'.split(' ')
const T3 = '% © ® ™ ✓ [ ]'.split(' ')

type Shift = 'off' | 'once' | 'lock'

export function Keyboard(p: {
  lang: KbLang
  onLang: (l: KbLang) => void
  onChar: (c: string) => void
  onBack: () => void
  onEnter: () => void
  onHardEnter?: () => void
  onHide?: () => void
  spaceLabel: string
  enterLabel?: string
  value?: string // for Gboard-style auto capitalisation
  autoCap?: boolean
}) {
  const [layer, setLayer] = useState<'abc' | 'sym' | 'sym2' | 'emo'>('abc')
  const [shift, setShift] = useState<Shift>('off')
  const [preview, setPreview] = useState<{ c: string; x: number; y: number; w: number } | null>(null)
  const lastShift = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const cb = useRef(p)
  cb.current = p
  const rep = useRef<{ t?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setInterval> }>({})

  // auto-capitalise at the start and after . ! ? or a new line (like Gboard)
  useEffect(() => {
    if (!p.autoCap || shift === 'lock') return
    const v = p.value ?? ''
    setShift(v === '' || /[.!?]\s$/.test(v) || v.endsWith('\n') ? 'once' : 'off')
  }, [p.value, p.autoCap])

  const stopRep = () => { clearTimeout(rep.current.t); clearInterval(rep.current.i) }
  const startBack = () => {
    haptic()
    cb.current.onBack()
    stopRep()
    rep.current.t = setTimeout(() => { rep.current.i = setInterval(() => { haptic(6); cb.current.onBack() }, 70) }, 400)
  }
  useEffect(() => stopRep, [])

  // physical keyboard on a computer
  useEffect(() => {
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Backspace') { e.preventDefault(); cb.current.onBack() }
      else if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) cb.current.onChar('\n')
        else (cb.current.onHardEnter ?? cb.current.onEnter)()
      } else if (Array.from(e.key).length === 1) { e.preventDefault(); cb.current.onChar(e.key) }
    }
    // Ctrl+V on a computer
    const paste = (e: ClipboardEvent) => {
      const s = e.clipboardData?.getData('text') ?? ''
      if (!s) return
      e.preventDefault()
      cb.current.onChar(s.replace(/\r\n?/g, '\n'))
    }
    window.addEventListener('keydown', h)
    window.addEventListener('paste', paste)
    return () => { window.removeEventListener('keydown', h); window.removeEventListener('paste', paste) }
  }, [])
  const desk = useDesktop()

  const showPreview = (el: HTMLElement, c: string) => {
    const k = el.getBoundingClientRect()
    const b = box.current?.getBoundingClientRect()
    if (!b) return
    setPreview({ c, x: k.left - b.left, y: k.top - b.top, w: k.width })
  }
  const hidePreview = () => setPreview(null)

  const key = (label: ReactNode, act: () => void, cls = '', id?: string) => (
    <button key={id ?? String(label)} type="button" className={'pa-k ' + cls}
      onPointerDown={(e) => { e.preventDefault(); haptic(); act() }}>{label}</button>
  )
  const ch = (c: string) => {
    const out = shift !== 'off' ? c.toUpperCase() : c
    return (
      <button key={'c' + c} type="button" className="pa-k"
        onPointerDown={(e) => {
          e.preventDefault(); haptic(); showPreview(e.currentTarget, out)
          cb.current.onChar(out)
          if (shift === 'once') setShift('off')
        }}
        onPointerUp={hidePreview} onPointerLeave={hidePreview} onPointerCancel={hidePreview}>{out}</button>
    )
  }
  const tapShift = () => {
    const now = Date.now()
    if (shift === 'lock') setShift('off')
    else if (now - lastShift.current < 350) setShift('lock')
    else setShift(shift === 'off' ? 'once' : 'off')
    lastShift.current = now
  }
  const back = (
    <button key="bk" type="button" className="pa-k f w15"
      onPointerDown={(e) => { e.preventDefault(); startBack() }}
      onPointerUp={stopRep} onPointerLeave={stopRep} onPointerCancel={stopRep}>⌫</button>
  )
  const space = key(cb.current.spaceLabel, () => cb.current.onChar(' '), 'sp', 'space')
  const enter = key(p.enterLabel ?? '⏎', () => cb.current.onEnter(), 'ent w15', 'enter')
  const comma = key(',', () => cb.current.onChar(','), 'f', 'comma')
  const period = key('.', () => cb.current.onChar('.'), 'f', 'period')
  const emoBtn = key('☺', () => setLayer('emo'), 'f', 'emo')
  const hide = p.onHide ? key('⌄', () => cb.current.onHide?.(), 'f', 'hide') : null

  let body: ReactNode
  if (layer === 'emo') {
    body = (
      <>
        <div className="pa-emo">{EMOJI.map((e) => key(e, () => cb.current.onChar(e), 'em', 'e' + e))}</div>
        <div className="pa-kr">{key('ABC', () => setLayer('abc'), 'f w15', 'abc')}{space}{back}{hide}</div>
      </>
    )
  } else if (layer === 'sym' || layer === 'sym2') {
    const two = layer === 'sym2'
    body = (
      <>
        <div className="pa-kr">{(two ? T1 : S1).map(ch)}</div>
        <div className="pa-kr">{(two ? T2 : S2).map(ch)}</div>
        <div className="pa-kr">
          {key(two ? '?123' : '=\\<', () => setLayer(two ? 'sym' : 'sym2'), 'f w15', 'page')}
          {(two ? T3 : S3).map(ch)}
          {back}
        </div>
        <div className="pa-kr">{key('ABC', () => setLayer('abc'), 'f w15', 'abc')}{comma}{emoBtn}{space}{period}{enter}{hide}</div>
      </>
    )
  } else {
    body = (
      <>
        {p.lang === 'lt' ? <div className="pa-kr">{ROW_LT.map(ch)}</div> : null}
        <div className="pa-kr">{R1.map(ch)}</div>
        <div className="pa-kr half">{R2.map(ch)}</div>
        <div className="pa-kr">
          {key(shift === 'lock' ? '⇪' : '⇧', tapShift, 'f w15' + (shift !== 'off' ? ' on' : ''), 'shift')}
          {R3.map(ch)}
          {back}
        </div>
        <div className="pa-kr">
          {key('?123', () => setLayer('sym'), 'f w15', 'sym')}
          {comma}
          {emoBtn}
          {key(p.lang === 'lt' ? 'LT' : 'EN', () => cb.current.onLang(p.lang === 'lt' ? 'en' : 'lt'), 'f', 'lang')}
          {space}
          {period}
          {enter}
          {hide}
        </div>
      </>
    )
  }
  if (desk) return null // computer: physical keyboard only (handlers above stay active)
  return (
    <div className="pa-kb" ref={box}>
      {body}
      {preview ? (
        <div className="pa-kprev" style={{ left: preview.x - preview.w * 0.15, top: preview.y - 6, width: preview.w * 1.3 }}>{preview.c}</div>
      ) : null}
    </div>
  )
}

/** Text "field" that never opens the phone keyboard. */
export function KDisplay(p: { value: string; placeholder: string; active: boolean; onClick?: () => void; className?: string }) {
  return (
    <div className={'pa-kin' + (p.active ? ' on' : '') + (p.className ? ' ' + p.className : '')} role="textbox" onClick={p.onClick}>
      {p.value}
      {p.active ? <span className="caret" /> : null}
      {p.value ? null : <span className="ph">{p.placeholder}</span>}
    </div>
  )
}
