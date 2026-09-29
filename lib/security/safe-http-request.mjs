import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const MAX_URL_LENGTH = 2_048;
const MAX_REQUEST_BYTES = 256 * 1_024;
const MAX_RESPONSE_BYTES = 1_024 * 1_024;
const REQUEST_TIMEOUT_MS = 10_000;

function ipv4ToNumber(address) {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function isPublicIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return false;

  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];

  return !blocked.some(([network, prefix]) => {
    const base = ipv4ToNumber(network);
    const shift = BigInt(32 - prefix);
    return (value >> shift) === (base >> shift);
  });
}

function ipv6ToBigInt(address) {
  let value = address.toLowerCase();

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = ipv4ToNumber(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }

  const [leftText, rightText = ""] = value.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (missing === 0 && !value.includes("::"))) return null;

  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) {
    return null;
  }

  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function hasIpv6Prefix(value, prefix, prefixBits) {
  return value >> BigInt(128 - prefixBits) === prefix;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6 || address.includes("%")) return false;

  const value = ipv6ToBigInt(address);
  if (value === null) return false;

  // IPv4-mapped IPv6 addresses inherit the policy of their embedded IPv4.
  if ((value >> 32n) === 0xffffn) {
    const embedded = value & 0xffffffffn;
    const ipv4 = [24n, 16n, 8n, 0n]
      .map((shift) => Number((embedded >> shift) & 0xffn))
      .join(".");
    return isPublicIpv4(ipv4);
  }

  // Only global unicast space is accepted. Reject protocol and documentation ranges.
  if (!hasIpv6Prefix(value, 1n, 3)) return false;
  if (hasIpv6Prefix(value, 0x64ff9b000000000000000000n, 96)) return false;
  if (hasIpv6Prefix(value, 0x64ff9b000001n, 48)) return false;
  if (hasIpv6Prefix(value, 0x100000000000000n, 64)) return false;
  if ((value >> 96n) === 0x20010db8n) {
    return false;
  }
  if (hasIpv6Prefix(value, 0x3fff0n, 20)) return false;
  if ((value >> 105n) === 0x100080n) {
    return false;
  }
  if (hasIpv6Prefix(value, 0x2002n, 16)) return false;
  if ((value >> 112n) === 0x5f00n) return false;

  return true;
}

export function parseSafeHttpUrl(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) {
    throw new Error("Invalid URL");
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) {
    throw new Error("Only standard HTTP and HTTPS ports are allowed");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local destinations are not allowed");
  }

  const family = isIP(hostname);
  if (family && !isPublicAddress(hostname)) {
    throw new Error("Non-public IP destinations are not allowed");
  }

  return url;
}

async function resolvePublicAddress(hostname, timeoutMs) {
  const family = isIP(hostname);
  if (family) return { address: hostname, family };

  let timer;
  let records;
  try {
    records = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS resolution timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (records.length === 0 || records.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Destination does not resolve exclusively to public IP addresses");
  }

  return records[0];
}

function requestOnce(url, address, { method, headers, body, timeoutMs, maxResponseBytes }) {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const family = address.family;
  const pinnedLookup = (_hostname, options, callback) => {
    if (options && typeof options === "object" && options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, family);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(result);
    };

    const request = transport(
      url,
      {
        method,
        headers,
        lookup: pinnedLookup,
        agent: false,
        maxHeaderSize: 16 * 1_024,
      },
      (response) => {
        const chunks = [];
        let size = 0;

        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            response.destroy(new Error("HTTP response exceeded the allowed size"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => finish(error));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finish(new Error("HTTP redirects are not allowed"));
            return;
          }
          finish(null, {
            status,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    deadline = setTimeout(() => request.destroy(new Error("HTTP request timed out")), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", (error) => finish(error));
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

export async function executeSafeHttpRequest({
  url: inputUrl,
  method = "GET",
  headers = {},
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
  const url = parseSafeHttpUrl(inputUrl);
  const totalTimeout = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(timeoutMs, 1), 30_000)
    : REQUEST_TIMEOUT_MS;
  const startedAt = Date.now();
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const address = await resolvePublicAddress(hostname, totalTimeout);
  const normalizedMethod = String(method).toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    throw new Error("HTTP method is not allowed");
  }

  const requestBody = body === undefined || body === null ? undefined : Buffer.from(String(body));
  if (requestBody && requestBody.byteLength > MAX_REQUEST_BYTES) {
    throw new Error("HTTP request body exceeded the allowed size");
  }

  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("HTTP headers must be an object");
  }
  const headerEntries = Object.entries(headers);
  if (headerEntries.length > 50) throw new Error("Too many HTTP headers");
  const safeHeaders = Object.create(null);
  for (const [name, value] of headerEntries) {
    const normalizedName = name.toLowerCase();
    if (["host", "content-length", "transfer-encoding", "connection", "proxy-authorization"].includes(normalizedName)) {
      continue;
    }
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (String(value).length > 8_192) throw new Error("HTTP header value is too large");
    safeHeaders[name] = String(value);
  }

  const remainingTimeout = Math.max(1, totalTimeout - (Date.now() - startedAt));
  return requestOnce(url, address, {
    method: normalizedMethod,
    headers: safeHeaders,
    body: requestBody,
    timeoutMs: remainingTimeout,
    maxResponseBytes: Number.isFinite(maxResponseBytes)
      ? Math.min(Math.max(maxResponseBytes, 1), MAX_RESPONSE_BYTES)
      : MAX_RESPONSE_BYTES,
  });
}
