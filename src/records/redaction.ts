export const REDACTION_VERSION = 'credentials-1';
const REPLACEMENT = '[REDACTED_CREDENTIAL]'; // 保留凭证曾出现的事实，移除实际值。
const CREDENTIAL_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
/** 来源原件与指纹保持原样，发送材料和生成正文在边界处脱敏。 */
export function redactCredentials(text: string, knownValues: string[] = []): { text: string; replacements: number } {
  let replacements = 0;
  let value = text;
  for (const secret of knownValues.filter(secret => secret.length >= 8)) {
    value = value.split(secret).map((part, index) => { if (index) replacements++; return part; }).join(REPLACEMENT);
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    value = value.replace(pattern, () => { replacements++; return REPLACEMENT; });
  }
  return { text: value, replacements };
}
