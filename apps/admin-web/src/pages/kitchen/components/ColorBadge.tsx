import { colorMeta } from '../colorMeta'

/** 五色色块 + 色名小徽章 */
export default function ColorBadge({ color }: { color: string | undefined }) {
  const meta = colorMeta(color)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          display: 'inline-block',
          width: 14,
          height: 14,
          borderRadius: 4,
          background: meta.hex,
          border: '1px solid rgba(0,0,0,0.15)',
        }}
      />
      <span>{meta.label}</span>
    </span>
  )
}
