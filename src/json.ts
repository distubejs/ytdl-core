import type { Thumbnail } from "./types.ts";

export type Json = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[key];
    }
  }
  return current;
}

/** A finite number, or a numeric string as InnerTube sends sizes and bitrates. */
export function num(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const simple = at(value, "simpleText");
  if (typeof simple === "string") return simple;
  const content = at(value, "content");
  if (typeof content === "string") return content;
  const runs = at(value, "runs");
  if (Array.isArray(runs)) {
    const joined = runs.map((run) => str(at(run, "text")) ?? "").join("");
    return joined || undefined;
  }
  return undefined;
}

export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function ytcfg(page: string): Json {
  const merged: Record<string, unknown> = {};
  for (const [, body] of page.matchAll(/ytcfg\.set\s*\(\s*(\{.+?\})\s*\)\s*;/gsu)) {
    try {
      const parsed: unknown = JSON.parse(body ?? "");
      if (isRecord(parsed)) Object.assign(merged, parsed);
    } catch {}
  }
  return merged;
}

// InnerTube moves renderers between paths on client updates, so parsers look them up by name.
export function collect(value: unknown, key: string, found: Json[] = []): Json[] {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, found);
  } else if (isRecord(value)) {
    for (const [name, child] of Object.entries(value)) {
      if (name === key && isRecord(child)) found.push(child);
      else collect(child, key, found);
    }
  }
  return found;
}

export function thumbnails(value: unknown): Thumbnail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const url = str(at(item, "url"));
    return url
      ? [
          {
            url: url.startsWith("//") ? `https:${url}` : url,
            width: num(at(item, "width")),
            height: num(at(item, "height")),
          },
        ]
      : [];
  });
}

export function parseAbbreviated(input: string | undefined): number | undefined {
  const match = input?.replace(/,/gu, "").match(/([\d.]+)\s*([KMB])?/iu);
  if (!match?.[1]) return undefined;
  const base = Number(match[1]);
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[(match[2] ?? "").toUpperCase() as "K" | "M" | "B"] ?? 1;
  return Number.isFinite(base) ? Math.round(base * scale) : undefined;
}

export function parseClock(input: string | undefined): number | undefined {
  if (!input || !/^\d+(?::\d+){0,2}$/u.test(input.trim())) return undefined;
  return input
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}
