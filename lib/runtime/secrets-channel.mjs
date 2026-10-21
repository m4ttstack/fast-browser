export const DEVLOGIN_NAME = /^devlogin:[a-z0-9][a-z0-9._-]*:(email|password)$/;

export const SAVED_LOGIN_TTL_MS = 30_000;
// A total deadline, 250 ms past the client's 1500 ms socket idle timeout,
// which a daemon that drips bytes never trips. The client module imports this
// one, so the value cannot be read from it.
const SAVED_LOGIN_DEADLINE_MS = 1750;
const NONE = Object.freeze({ none: true });

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

function isHttpOrigin(value) {
  return isOrigin(value) && /^https?:/.test(value);
}

function usableAnswer(answer) {
  if (answer?.none === true) return NONE;
  const { email, password } = answer?.fields ?? {};
  if (typeof email === 'string' && typeof password === 'string') return { fields: { email, password } };
  return null;
}

export function createSavedLoginLookup({
  fetchSavedLogin,
  now = Date.now,
  ttlMs = SAVED_LOGIN_TTL_MS,
  deadlineMs = SAVED_LOGIN_DEADLINE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const cache = new Map();
  const inFlight = new Map();

  const start = (origin) => {
    const attempt = new Promise((resolve) => {
      const timer = setTimer(() => resolve(null), deadlineMs);
      timer?.unref?.();
      let fetched;
      try {
        fetched = Promise.resolve(fetchSavedLogin(origin));
      } catch {
        fetched = Promise.resolve(null);
      }
      fetched
        .then(usableAnswer, () => null)
        .then((answer) => {
          clearTimer(timer);
          resolve(answer);
        });
    }).then((answer) => {
      if (inFlight.get(origin) === attempt) inFlight.delete(origin);
      if (answer === null) return NONE;
      cache.set(origin, { answer, expires: now() + ttlMs });
      return answer;
    });
    inFlight.set(origin, attempt);
    return attempt;
  };

  return async (origin) => {
    if (!isHttpOrigin(origin)) return NONE;
    const cached = cache.get(origin);
    if (cached !== undefined && cached.expires > now()) return cached.answer;
    return inFlight.get(origin) ?? start(origin);
  };
}

async function savedLoginReply(id, origin, lookupSavedLogin) {
  let answer;
  try {
    answer = (await lookupSavedLogin?.(origin)) ?? NONE;
  } catch {
    answer = NONE;
  }
  return answer.fields === undefined
    ? { id, type: 'saved-login', origin, none: true }
    : { id, type: 'saved-login', origin, fields: answer.fields };
}

export async function replyTo(request, fetchFill, lookupSavedLogin) {
  const id = request?.id;
  if ((typeof id !== 'string' || id === '') && !Number.isInteger(id)) return null;
  if (request.type === 'saved-login') return savedLoginReply(id, request.origin, lookupSavedLogin);
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

export function attachSecretsChannel({ socket, fetchFill, lookupSavedLogin, log = () => {} }) {
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
    const reply = await replyTo(request, fetchFill, lookupSavedLogin);
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
