const SECRET_PATTERN =
  /(PLAUD_API_TOKEN\s*[=:=]\s*)([^\s"',}]+)|(X-Amz-(?:Security-Token|Signature|Credential)=)([^\s&"']+)|(code=)([^\s&"']+)|(NOTION_TOKEN\s*[=:=]\s*)([^\s"',}]+)|((?:OPENAI|ANTHROPIC)_API_KEY\s*[=:=]\s*)([^\s"',}]+)|(Bearer\s+)([A-Za-z0-9._\-+=/]+)|(authorization["']?\s*[:=]\s*["']?)([^"'\s]+)|((?:access_token|refresh_token)\s*[=:]\s*["']?)([^"'\s,}]+)|(sk-[A-Za-z0-9_-]{16,})|(ntn_[A-Za-z0-9]+)|(secret_[A-Za-z0-9]+)/gi;

export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(SECRET_PATTERN, (full, a, _b, c, _d, e, _f, g, _h, i, _j, k, _l, m, _n, o) => {
      if (a) return `${a}[REDACTED]`;
      if (c) return `${c}[REDACTED]`;
      if (e) return `${e}[REDACTED]`;
      if (g) return `${g}[REDACTED]`;
      if (i) return `${i}[REDACTED]`;
      if (k) return `${k}[REDACTED]`;
      if (m) return `${m}[REDACTED]`;
      if (o) return `${o}[REDACTED]`;
      return "[REDACTED]";
    })
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

export function looksLikeSecret(value: string): boolean {
  return /sk-[A-Za-z0-9_-]{16,}|ntn_[A-Za-z0-9]{8,}|secret_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._\-]{20,}|eyJ[A-Za-z0-9_-]{20,}\./.test(
    value
  );
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return redactSecrets(err.message);
  }
  return redactSecrets(String(err));
}
