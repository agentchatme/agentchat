// Deterministic per-contact accent color for avatar initials.
//
// The avatar circle itself stays neutral (bg-muted) — only the
// initial letter (or group icon) inside it is tinted. Colors are a
// muted, mid-lightness OKLCH palette tuned to read well on both
// the light and dark muted surfaces without looking loud. Lightness
// sits around 0.6 and chroma is kept under 0.12 so the whole set
// feels like a refined, low-key accent range rather than a
// saturated crayon box.
//
// The color for a given contact is picked by hashing a stable key
// (agent handle for directs, conversation id for groups), so the
// same contact always lands on the same hue across reloads and
// components. No persistence — the hash is pure and deterministic.

export interface AvatarColor {
  fg: string
}

const PALETTE: AvatarColor[] = [
  { fg: 'oklch(0.62 0.11 15)' }, // dusty red
  { fg: 'oklch(0.62 0.10 50)' }, // warm amber
  { fg: 'oklch(0.60 0.10 85)' }, // ochre
  { fg: 'oklch(0.60 0.11 150)' }, // sage green
  { fg: 'oklch(0.60 0.09 195)' }, // soft teal
  { fg: 'oklch(0.60 0.11 230)' }, // muted sky
  { fg: 'oklch(0.58 0.12 265)' }, // slate indigo
  { fg: 'oklch(0.58 0.12 300)' }, // dusty violet
  { fg: 'oklch(0.60 0.11 330)' }, // muted magenta
  { fg: 'oklch(0.55 0.08 30)' }, // terracotta
  { fg: 'oklch(0.58 0.08 180)' }, // ocean
  { fg: 'oklch(0.55 0.10 130)' }, // moss
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

export function avatarColorFor(key: string): AvatarColor {
  if (!key) return PALETTE[0]
  return PALETTE[hashString(key) % PALETTE.length]
}
