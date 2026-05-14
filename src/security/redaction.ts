const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization\s*:\s*Bearer\s+)[^\s"'\\]+/gi, "$1[REDACTED]"],
  [/\b(api-key\s*:\s*)[^\s"'\\]+/gi, "$1[REDACTED]"],
  [/\b((?:OPENAI|ANTHROPIC|AZURE|RECALL|AWS|GITHUB|GH|NPM|PYPI|SLACK|STRIPE|DATABASE)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"'\\]+)/gi, "$1[REDACTED]"],
  [/\b(--(?:api-?key|token|secret|password)\s+)(?:"[^"]*"|'[^']*'|[^\s"'\\]+)/gi, "$1[REDACTED]"],
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]"],
];

export function redactSensitiveText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

export function redactSensitiveValue<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map(redactSensitiveValue) as T;
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactSensitiveValue(entry);
  }
  return out as T;
}
