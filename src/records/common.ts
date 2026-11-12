import { createHash } from 'node:crypto';
import { KnowledgeError } from '../core/errors.js';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
export function requireValue(test: unknown, message: string, code = 'INVALID_ARGUMENT'): asserts test { if (!test) throw new KnowledgeError(code, message, undefined, code === 'INVALID_ARGUMENT' ? 2 : 1); }
export function text(value: unknown, name: string): string { requireValue(typeof value === 'string' && value.trim(), `${name} 必须非空`); return value; }
export function decode(bytes: Buffer): string { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new KnowledgeError('INVALID_ARGUMENT', '正文必须为有效 UTF-8', undefined, 2); } }
export function title(body: string): string { return body.match(/^\uFEFF?\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim() ?? body.split(/\r?\n/).find(line => line.replace(/^\uFEFF/, '').trim())?.replace(/^\uFEFF/, '').trim() ?? ''; }
