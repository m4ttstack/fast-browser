export const DEVLOGIN_NAME = /^devlogin:[a-z0-9][a-z0-9._-]*:(email|password)$/;

const ELEMENT_KINDS = new Set(['password', 'text']);
const DAEMON_REFUSALS = new Set(['unknown', 'mismatch', 'limited']);
// A request line is a few hundred bytes; anything this long without a
// newline is not a request and must not grow the buffer without bound.
const MAX_PENDING_BYTES = 16 * 1024;

function refusal(id, name, refused, until) {
  const reply = { id, name, refused };
  if (Number.isFinite(until)) reply.until = until;
  return reply;
}

function isOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

export async function replyTo(request, fetchFill) {
  const id = request?.id;
  if ((typeof id !== 'string' || id === '') && !Number.isInteger(id)) return null;
  const { name, frameOrigin, elementKind } = request;
  if (typeof name !== 'string' || !DEVLOGIN_NAME.test(name)) return refusal(id, name, 'unknown');
  if (!ELEMENT_KINDS.has(elementKind) || !isOrigin(frameOrigin)) return refusal(id, name, 'unavailable');

  let answer;
  try {
    answer = await fetchFill({ name, frameOrigin, elementKind });
  } catch {
    return refusal(id, name, 'unavailable');
  }
  if (typeof answer?.refused === 'string') {
    return DAEMON_REFUSALS.has(answer.refused)
      ? refusal(id, name, answer.refused, answer.until)
      : refusal(id, name, 'unavailable');
  }
  const expectedKind = DEVLOGIN_NAME.exec(name)[1];
  if (typeof answer?.value !== 'string') return refusal(id, name, 'unavailable');
  if (
    answer.origin !== frameOrigin
    || answer.kind !== expectedKind
    || (answer.kind === 'password' && elementKind !== 'password')
  ) {
    return refusal(id, name, 'mismatch');
  }
  return { id, name, origin: answer.origin, kind: answer.kind, value: answer.value };
}

export function attachSecretsChannel({ socket, fetchFill, log = () => {} }) {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});

  const handleLine = async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      log('fast-browser-mcp: secrets channel ignored an unparseable frame');
      return;
    }
    const reply = await replyTo(request, fetchFill);
    if (reply === null) {
      log('fast-browser-mcp: secrets channel ignored a frame with no id');
      return;
    }
    if (socket.destroyed || !socket.writable) return;
    socket.write(`${JSON.stringify(reply)}\n`);
  };

  socket.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim() !== '') void handleLine(line);
    }
    if (pending.length > MAX_PENDING_BYTES) {
      pending = '';
      log('fast-browser-mcp: secrets channel dropped an oversized frame');
    }
  });
}
