// Bounded streaming parser for OMP `--mode json` stdout (ADAPT-OUT-2-v1).
// Frozen interface: ADAPT-OUT-1 output-adapt.test.mjs, group "module".
//
// Memory is bounded: the parser keeps only the session id, the current final
// candidate (one line, <= maxLineBytes), the advisor pairing state (a digest,
// not the message), counters, and a line buffer of at most maxLineBytes.
// It never keeps the full stream text.
import { createHash } from "node:crypto";
import { MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";

// Same values as index.mjs; do not raise.
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_EVENTS = 50_000;
export const DEFAULT_MAX_FINAL_TEXT_CHARS = 64 * 1024;

const NEWLINE = 0x0a;
const ADVISOR_MESSAGE_KEYS = new Set(["role", "customType", "content", "display", "attribution", "details", "timestamp"]);

function hasOnlyKeys(obj, keys) {
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

// Advisor protocol shape: role "custom", non-empty
// customType, string "<advisory" content, display === true, attribution "agent".
function isAdvisorMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  if (!Object.keys(message).every((k) => ADVISOR_MESSAGE_KEYS.has(k))) return false;
  return (
    message.role === "custom" &&
    typeof message.customType === "string" &&
    message.customType.length > 0 &&
    typeof message.content === "string" &&
    message.content.startsWith("<advisory") &&
    message.display === true &&
    message.attribution === "agent"
  );
}

function advisorDigest(event, type) {
  if (event.type !== type || !hasOnlyKeys(event, ["type", "message"]) || !isAdvisorMessage(event.message)) return null;
  return createHash("sha256").update(JSON.stringify(event.message)).digest("hex");
}

function isAdvisorYielded(event) {
  return event.type === "advisor_yielded" && hasOnlyKeys(event, ["type"]);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * createOmpOutputParser({ maxLineBytes, maxEvents }) -> { feed(chunk), end() }.
 * Only a complete, newline-terminated agent_end without willContinue that is
 * not followed by a substantive event counts as final. After final, only
 * matched advisor message_start/message_end pairs and a payload-free
 * advisor_yielded are exempt; anything else invalidates the final.
 * Damage tokens: malformed_lines, oversized_lines, truncated_tail, event_cap.
 */
export function createOmpOutputParser(limits = {}) {
  const maxLineBytes = limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxEvents = limits.maxEvents ?? DEFAULT_MAX_EVENTS;

  let sessionId = null;
  let final = null;
  let finalsInvalidated = 0;
  let advisorPending = null; // sha256 of the open advisor message_start, only while final is set
  let advisorPairsExempted = 0;
  let advisorYieldedExempted = 0;

  let lines = 0;
  let malformedLines = 0;
  let oversizedLines = 0;
  let events = 0;
  let bytesSeen = 0;
  let eventCapExceeded = false;
  let truncatedTail = false;
  let ended = false;

  let lineParts = [];
  let lineBytes = 0;
  let skippingOversized = false;
  let heldSurrogate = "";

  function invalidateFinal() {
    if (final) {
      final = null;
      finalsInvalidated += 1;
    }
    advisorPending = null;
  }

  function handleEvent(event) {
    events += 1;
    if (final) {
      if (advisorPending === null) {
        const start = advisorDigest(event, "message_start");
        if (start !== null) {
          advisorPending = start;
          return;
        }
        if (isAdvisorYielded(event)) {
          advisorYieldedExempted += 1;
          return;
        }
      } else if (advisorDigest(event, "message_end") === advisorPending) {
        advisorPending = null;
        advisorPairsExempted += 1;
        return;
      }
      invalidateFinal();
    }
    if (event.type === "session") {
      if (typeof event.id === "string" && sessionId === null) sessionId = event.id;
    } else if (event.type === "agent_end") {
      if (
        !Array.isArray(event.messages) ||
        (event.willContinue !== undefined && typeof event.willContinue !== "boolean") ||
        (event.isTerminal !== undefined && typeof event.isTerminal !== "boolean")
      ) {
        malformedLines += 1;
      } else if (event.willContinue !== true && event.isTerminal !== false) {
        final = event;
        advisorPending = null;
      }
    }
  }

  function takeLine() {
    const buf = lineParts.length === 1 ? lineParts[0] : Buffer.concat(lineParts, lineBytes);
    lineParts = [];
    lineBytes = 0;
    return buf;
  }

  function completeLine() {
    if (skippingOversized) {
      skippingOversized = false;
      if (lines >= maxEvents) {
        eventCapExceeded = true;
        return;
      }
      lines += 1;
      oversizedLines += 1;
      return;
    }
    const lineText = takeLine().toString("utf8").trim();
    if (lineText.length === 0) return;
    if (lines >= maxEvents) {
      eventCapExceeded = true;
      return;
    }
    lines += 1;
    let event;
    try {
      event = JSON.parse(lineText);
    } catch {
      malformedLines += 1;
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      malformedLines += 1;
      return;
    }
    handleEvent(event);
  }

  function append(buf, start, stop) {
    if (skippingOversized || stop <= start) return;
    if (lineBytes + (stop - start) > maxLineBytes) {
      lineParts = [];
      lineBytes = 0;
      skippingOversized = true;
      return;
    }
    // Copy: callers may reuse their chunk buffers.
    lineParts.push(Buffer.from(buf.subarray(start, stop)));
    lineBytes += stop - start;
  }

  function feedBytes(buf) {
    bytesSeen += buf.length;
    if (eventCapExceeded) return;
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(NEWLINE, start);
      const stop = nl === -1 ? buf.length : nl;
      append(buf, start, stop);
      if (nl === -1) return;
      completeLine();
      if (eventCapExceeded) return;
      start = nl + 1;
    }
  }

  function toBytes(chunk) {
    if (typeof chunk === "string") {
      // A string chunk may end between the halves of a surrogate pair; hold the
      // high half so the pair is encoded once, as UTF-8, with the next chunk.
      let text = heldSurrogate + chunk;
      heldSurrogate = "";
      if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
        heldSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      return Buffer.from(text, "utf8");
    }
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    throw new TypeError("createOmpOutputParser.feed expects a string, Buffer, or Uint8Array chunk");
  }

  return {
    feed(chunk) {
      if (ended) throw new Error("createOmpOutputParser.feed called after end()");
      feedBytes(toBytes(chunk));
    },
    end() {
      if (!ended) {
        ended = true;
        if (heldSurrogate) {
          const rest = Buffer.from(heldSurrogate, "utf8");
          heldSurrogate = "";
          feedBytes(rest);
        }
        if (!eventCapExceeded) {
          if (skippingOversized || (lineBytes > 0 && takeLine().toString("utf8").trim().length > 0)) truncatedTail = true;
          skippingOversized = false;
          lineParts = [];
          lineBytes = 0;
        }
        // An advisor message_start without its message_end is not the frozen pair.
        if (advisorPending !== null) invalidateFinal();
      }
      const damage = [];
      if (malformedLines > 0) damage.push("malformed_lines");
      if (oversizedLines > 0) damage.push("oversized_lines");
      if (truncatedTail) damage.push("truncated_tail");
      if (eventCapExceeded) damage.push("event_cap");
      return {
        sessionId,
        final,
        finalsInvalidated,
        damage,
        counts: { lines, malformedLines, oversizedLines, events, bytesSeen },
        diagnostics: { maxLineBytes, maxEvents, eventCapExceeded, truncatedTail, advisorPairsExempted, advisorYieldedExempted },
      };
    },
  };
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return typeof message?.content === "string" ? message.content : "";
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Whole-string compatibility wrapper with the index.mjs parseOmpJsonOutput
 * result shape. Adds capture_cap (native capture keeps only the tail) and
 * final_text_cap on top of the streaming damage tokens.
 */
export function parseOmpJsonOutput(stdout, limits = {}) {
  const maxFinalTextChars = limits.maxFinalTextChars ?? DEFAULT_MAX_FINAL_TEXT_CHARS;
  const captureLimitChars = limits.captureLimitChars ?? MAX_CAPTURE_BYTES;
  const redact = typeof limits.redact === "function" ? limits.redact : (s) => s;
  const text = typeof stdout === "string" ? stdout : "";

  const parser = createOmpOutputParser({ maxLineBytes: limits.maxLineBytes, maxEvents: limits.maxEvents });
  parser.feed(text);
  const r = parser.end();

  const out = {
    sessionId: r.sessionId,
    final: r.final,
    finalMessage: null,
    finalText: "",
    finalTextTruncated: false,
    eventCount: r.counts.events,
    eventCapExceeded: r.diagnostics.eventCapExceeded,
    finalsInvalidated: r.finalsInvalidated,
    malformedLines: r.counts.malformedLines,
    oversizedLines: r.counts.oversizedLines,
    truncatedTail: r.diagnostics.truncatedTail,
    captureMayBeTruncated: text.length >= captureLimitChars,
    damage: [],
  };

  if (out.final) {
    const assistants = out.final.messages.filter((m) => m && m.role === "assistant");
    out.finalMessage = assistants.length > 0 ? assistants[assistants.length - 1] : null;
    const full = textOf(out.finalMessage);
    out.finalTextTruncated = full.length > maxFinalTextChars;
    // Redact the whole text before cutting so a secret cannot straddle the cut.
    out.finalText = redact(full).slice(0, maxFinalTextChars);
  }

  if (out.malformedLines > 0) out.damage.push("malformed_lines");
  if (out.oversizedLines > 0) out.damage.push("oversized_lines");
  if (out.truncatedTail) out.damage.push("truncated_tail");
  if (out.captureMayBeTruncated) out.damage.push("capture_cap");
  if (out.eventCapExceeded) out.damage.push("event_cap");
  if (out.finalTextTruncated) out.damage.push("final_text_cap");
  return out;
}
