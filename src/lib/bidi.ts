export function fixMixedText(text: string): string {
  return text.replace(
    /([A-Za-z0-9]+(?:[\s\-][A-Za-z0-9]+)+|[A-Za-z0-9@._:/-]+)/g,
    (m) => "\u2068" + m + "\u2069",
  )
}

export function prepareContent(text: string, dir: 'rtl' | 'ltr'): string {
  if (dir !== 'rtl' || !text) return text
  const parts = text.split(/```/g)
  const fixed = parts.map((p, i) => {
    if (i % 2 === 1) return p // inside code block, don't modify
    // Split by lines, skip table rows (lines starting with | or matching table separator pattern)
    return p
      .split('\n')
      .map((line) => {
        const trimmed = line.trim()
        // Skip markdown table rows: header, separator, or data rows
        if (
          trimmed.startsWith('|') ||
          /^\|?\s*[-:|]+\s*\|/.test(trimmed) // table separator like |---|---| or ---|---
        ) {
          return line
        }
        return fixMixedText(line)
      })
      .join('\n')
  })
  return fixed.join('```')
}
