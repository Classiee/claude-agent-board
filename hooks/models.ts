// Reading a model id for display. Nothing here assumes a particular setup:
// ids and aliases of the families this knows are shown as "<family> <version>",
// and anything else (a custom model, a gateway's id) is shown exactly as given.

export type ParsedModel = {
  /** sonnet, opus, haiku or fable; undefined for any other model. */
  family?: string
  /** What to show: "sonnet 4.5", "opus", or the raw id for an unknown model. */
  label: string
}

// No model id is anywhere near this long. A longer one is shown as given, cut, and not parsed.
const MAX_ID = 200

const FAMILIES = 'sonnet|opus|haiku|fable'
// What may follow a model name: the end of the id, a Vertex @date or a Bedrock :version,
// or a dash and a date, a v<n> or latest. Anything else means the id is not read whole.
const END = '(?=$|[@:]|-(?:\\d{8}|v\\d|latest)(?![A-Za-z0-9]))'
// claude-sonnet-4-5, claude-opus-4-1-20250805, us.anthropic.claude-sonnet-4-5-v1:0,
// claude-sonnet-4@20250514, claude-sonnet-4.5. A version is one or two digits: a longer
// digit run is a date, and an id with a version this cannot read whole is shown raw.
const NEW_STYLE = new RegExp(`claude-(${FAMILIES})-(\\d{1,2})(?:[-.](\\d{1,2}))?${END}`)
// claude-3-5-sonnet-20241022, claude-3-opus-20240229
const OLD_STYLE = new RegExp(`claude-(\\d{1,2})(?:[-.](\\d{1,2}))?-(${FAMILIES})${END}`)
const ALIAS = new RegExp(`^(${FAMILIES})$`)

function named(family: string, major: string | undefined, minor: string | undefined): ParsedModel {
  return { family, label: `${family} ${major ?? ''}${minor ? '.' + minor : ''}`.trim() }
}

export function parseModel(id: string | undefined | null): ParsedModel {
  const raw = (id ?? '').trim()
  if (!raw) return { label: 'unknown' }
  if (raw.length > MAX_ID) return { label: raw.slice(0, MAX_ID) }
  const s = raw.toLowerCase().replace(/\[[^[\]]*\]$/, '') // "opus[1m]" -> "opus"
  const a = NEW_STYLE.exec(s)
  if (a?.[1]) return named(a[1], a[2], a[3])
  const o = OLD_STYLE.exec(s)
  if (o?.[3]) return named(o[3], o[1], o[2])
  const alias = ALIAS.exec(s)
  if (alias?.[1]) return { family: alias[1], label: alias[1] }
  return { label: raw }
}

export function modelLabel(id: string | undefined | null): string {
  return parseModel(id).label
}

export function modelFamily(id: string | undefined | null): string | undefined {
  return parseModel(id).family
}
