export class LifecycleError extends Error {
  constructor(message, {
    stage = null,
    partialState = null,
    exitCode = 1,
    code = null,
  } = {}) {
    super(message.replaceAll('\n', ' '));
    this.name = 'LifecycleError';
    this.stage = stage;
    this.partialState = partialState;
    this.exitCode = exitCode;
    if (code) this.code = code;
  }
}

export const HOST_ORDER = Object.freeze(['claude', 'codex']);

export function orderedHosts(hosts = []) {
  const selected = new Set(hosts);
  return HOST_ORDER.filter((host) => selected.has(host));
}

export function hostFlags(hosts) {
  const selected = new Set(hosts);
  return {
    claude: selected.has('claude'),
    codex: selected.has('codex'),
  };
}

export function selectedConfigHosts(config) {
  return HOST_ORDER.filter((host) => config.hosts[host]);
}

export function routingState(config) {
  return {
    profile: config.profile,
    files: structuredClone(config.managed.files),
    blocks: structuredClone(config.managed.blocks),
  };
}

export function managedConfig(state) {
  return {
    files: structuredClone(state?.files ?? []),
    blocks: structuredClone(state?.blocks ?? []),
  };
}

export function profileDefaults(profile) {
  if (profile !== 'safe' && profile !== 'full') {
    throw new LifecycleError('Profile must be `safe` or `full`.', {
      stage: 'validate',
      exitCode: 2,
    });
  }
  return {
    enabled: profile === 'full',
    retentionDays: 30,
  };
}

export function retentionDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new LifecycleError('Session retention must be an integer from 1 to 365.', {
      stage: 'validate',
      exitCode: 2,
    });
  }
  return value;
}

export function safeError(message, options) {
  return new LifecycleError(message, options);
}

// Strips C0 control characters (0x00-0x08, 0x0b-0x1f -- which already
// includes ESC, 0x1b) and DEL (0x7f), plus a handful of Unicode characters
// with the same "can misdirect a terminal/reader rather than just look
// odd" property (fix round 2, item 4; widened again by the MAT-138 debt
// sweep, item 2):
//   - U+0085 NEL, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR --
//     line-breaking characters outside the ASCII CR/LF a reader expects,
//     which can split rendered text across lines a caller never asked for.
//   - U+200B ZERO WIDTH SPACE, U+FEFF ZERO WIDTH NO-BREAK SPACE (the BOM
//     character used mid-string) -- both invisible, both usable to break up
//     a string a human is visually scanning without leaving a visible
//     trace.
//   - U+00AD SOFT HYPHEN -- invisible unless a line break happens to land
//     on it, and even then renders a hyphen the source string never
//     contained; the same "reads as something it isn't" property as the
//     bidi controls below, just via line-wrapping instead of reordering.
//   - U+200E LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK -- narrower
//     bidi directionality marks than the embedding/override controls
//     already stripped, but still capable of nudging how adjacent text
//     renders. Deliberately NOT widened to the full U+200B-U+200F block:
//     U+200C ZWNJ and U+200D ZWJ are left untouched because ZWJ is load-
//     bearing for legitimate multi-codepoint emoji sequences (e.g. family
//     emoji), and this function's own contract is to preserve emoji intact.
//   - U+202A-U+202E (LRE/RLE/PDF/LRO/RLO) and U+2066-U+2069 (LRI/RLI/FSI/
//     PDI) -- bidi embedding/override/isolate controls; RLO in particular
//     can visually REVERSE following text, which is exactly the kind of
//     terminal-display spoof this function exists to prevent.
// From text that traces back to page-derived or otherwise
// schema-unvalidated content (a flow's `description`, a flow arg's own key
// name -- artifact.mjs's `parseArgs` accepts any string key) before it is
// ever written to a terminal. Tab (0x09) and newline (0x0a) are left
// alone, as is every other Unicode character -- emoji, CJK, NBSP (U+00A0),
// and ordinary accented/diacritic text all pass through untouched; this is
// a narrow denylist of known-hostile display characters, not a
// printable-ASCII allowlist. Display sanitization only -- never used on
// data that is compared, hashed, or persisted.
//
// Written entirely with `\uXXXX` escapes, deliberately, rather than the
// literal characters: several of these ARE the exact invisible/reordering
// bytes this function strips, so writing them literally into this source
// file would make the pattern itself unreviewable in a diff (and at the
// mercy of any editor/tool that "helpfully" normalizes them away).
const CONTROL_CHAR_PATTERN = new RegExp(
  '[\\x00-\\x08\\x0b-\\x1f\\x7f\\u0085\\u00ad\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'g',
);

export function stripControlChars(value) {
  return typeof value === 'string' ? value.replace(CONTROL_CHAR_PATTERN, '') : value;
}

// Thrown-error names whose `message` we may quote back to the user. Every
// message these types carry is assembled from our own literals: a fixed
// sentence, a subcommand name we chose, a process exit code, or a Node error
// code such as ENOENT. None of them interpolates a path, a token, or any
// other user-supplied value, which is what makes them printable at all.
//
// ConfigError and PathConfinementError are deliberately absent: both wrap a
// resolved path ("unable to read config: <fs error>", "unable to resolve
// confinement root <target>"), as does every bare fs error. Quoting those
// would leak exactly what confinedName in annotate.mjs and the duplicate
// positional fix in parse-args.mjs go out of their way to withhold.
const REPORTABLE_ERROR_NAMES = new Set([
  'CodexBrowserDriverSmokeError',
  'HostInstallError',
  'LifecycleError',
  'PairingError',
  'RoutingTransactionError',
]);

// Returns the thrown error's own message when it is one of ours, and null
// otherwise. Null means "withheld", never "there was no error": callers must
// still report the failure, just without a cause.
export function reportableCause(error) {
  if (!REPORTABLE_ERROR_NAMES.has(error?.name)) return null;
  const message = typeof error.message === 'string'
    ? error.message.replaceAll('\n', ' ').trim()
    : '';
  return message === '' ? null : message;
}
