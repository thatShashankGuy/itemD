import { isIP } from "node:net";

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateIp(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(normalized);

  if (version === 4) {
    return isPrivateIpv4(normalized);
  }

  if (version !== 6) {
    return false;
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:172.")
  );
}

export function validateWebFetchUrl(
  value: string,
): { ok: true } | { ok: false; message: string } {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "web_fetch.url must be a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: "web_fetch.url must use http or https",
    };
  }

  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    isPrivateIp(url.hostname)
  ) {
    return {
      ok: false,
      message: "web_fetch.url must target a public URL without credentials",
    };
  }

  return { ok: true };
}
