export function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  digits = digits.replace(/^0+/, '')
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`
  if (digits.startsWith('55') && digits.length === 12 && /^[6-9]/.test(digits.slice(4))) {
    digits = `${digits.slice(0, 4)}9${digits.slice(4)}`
  }
  if (digits.length < 12 || digits.length > 15) return null
  return digits
}

export function formatPhone(digits) {
  if (!digits) return ''
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4)
    const local = digits.slice(4)
    if (local.length === 9) return `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`
    return `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`
  }
  return `+${digits}`
}
