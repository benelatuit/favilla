import fs from 'node:fs'
import postcss from 'postcss'

/** The native frame needs resolved colours before the renderer starts. */
export function themeBars() {
  const dir = new URL('../web/src/themes/', import.meta.url)
  const themes = new Map()
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.css')).sort()) {
    const css = postcss.parse(fs.readFileSync(new URL(file, dir), 'utf8'), { from: file })
    for (const rule of css.nodes) {
      if (rule.type !== 'rule') continue
      for (const selector of rule.selectors) {
        const name = /^:root\[data-theme=['"]([^'"]+)['"]\]$/.exec(selector)?.[1]
        if (!name) continue
        const tokens = themes.get(name) ?? new Map()
        for (const decl of rule.nodes) if (decl.type === 'decl') tokens.set(decl.prop, decl.value)
        themes.set(name, tokens)
      }
    }
  }
  return Object.fromEntries([...themes].map(([name, tokens]) => {
    const bar = { color: tokens.get('--title-bar') ?? tokens.get('--board'), symbolColor: tokens.get('--ink-2'), background: tokens.get('--paper') }
    for (const [key, value] of Object.entries(bar)) {
      if (!/^#[\da-f]{6}$/i.test(value ?? '')) throw new Error(`Missing or invalid ${key} for native theme ${name}`)
    }
    return [name, bar]
  }))
}
