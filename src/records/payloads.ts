import type { Message } from './source.js';

const MIN_ENCODED_RUN = 512; // 避开错误码、哈希和短业务常量。
const MAX_DEPTH = 12; // 有界展开嵌套JSON工具结果。
const ASSET_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|dds|ktx2?|pvr|astc|tga|tiff?|hdr|exr|ico|wav|mp3|ogg|flac|aac|m4a|aiff?|pcm|mp4|webm|mov|avi|mpeg|mkv|zip|gz|7z|tar|bz2|bin|dat|exe|dll|pdf|glb|gltf|fbx|blend|wasm|woff2?|ttf|otf|sqlite|db)$/iu;
const PATH_KEYS = new Set(['path', 'file', 'filePath', 'file_path', 'filename', 'originalPath', 'original_path']);
const PAYLOAD_KEYS = /^(?:base64|b64|hex|hexDump|hex_dump|bytes|blob|binary|file_data|image_data|audio_data|video_data)$/iu;
const MEDIA_TYPES = /^(?:input_)?(?:image|audio|video|file)$/u;

/** 路径只取来源明文，保留其原始相对或绝对形式。 */
export function sourcePaths(value: string, depth = 0): string[] {
  if (depth > 4) return [];
  const paths = new Set<string>();
  const add = (candidate: string) => {
    if (!candidate.startsWith('data:') && !/[\r\n]/u.test(candidate) && ASSET_EXTENSION.test(candidate)) paths.add(candidate);
  };
  for (const match of value.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/gu)) {
    let literal = match[1] ?? match[2];
    if (match[1] !== undefined) { try { literal = JSON.parse(match[0]); } catch { continue; } }
    else literal = literal.replace(/\\'/gu, "'").replace(/\\\\/gu, '\\');
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/u.test(literal) || /^[^\s:;{}()]+[\\/][^\s]+$/u.test(literal)) add(literal);
  }
  for (const match of value.matchAll(/(?:[A-Za-z]:[\\/]|\/(?:tmp|home|Users|var)\/)[^\s"'<>|;,)}\]]+/gu)) add(match[0]);
  const body = /^[\[{]/u.test(value.trim()) ? value : value.slice(value.indexOf('\n') + 1);
  try {
    const object = JSON.parse(body);
    if (object && typeof object === 'object' && !Array.isArray(object)) {
      for (const key of ['code', 'cmd', 'arguments', 'input']) if (typeof object[key] === 'string') for (const path of sourcePaths(object[key], depth + 1)) add(path);
      for (const key of PATH_KEYS) if (typeof object[key] === 'string') add(object[key]);
    }
  } catch { /* 字面工具脚本已由上述路径提取覆盖。 */ }
  return [...paths];
}

function encodedRun(value: string): boolean {
  if (value.length < MIN_ENCODED_RUN) return false;
  if (/^(?:0x)?[a-f\d]+$/iu.test(value)) return true;
  return /^[A-Za-z\d+/_=-]+$/u.test(value) && /[A-Z]/u.test(value) && /[a-z]/u.test(value) && /[\d+/=_-]/u.test(value);
}

/** 所有模式的基础清理，编码载荷统一落到明确路径或路径缺失标记。 */
export function stripPayloads(value: string, associatedPaths: string[] = []): string {
  const fallback = associatedPaths.length === 1 ? `[文件路径 ${associatedPaths[0]}]` : '[文件路径未知]';
  function plain(text: string, marker: string): string {
    return text
      .replace(/^[ \t]*[\[{].*$/gmu, line => {
        try {
          const parsed = JSON.parse(line), cleaned = visit(parsed, 1, marker);
          return JSON.stringify(parsed) === JSON.stringify(cleaned) ? line : JSON.stringify(cleaned);
        } catch { return line; }
      })
      .replace(/\[图片原件引用[^\]\r\n]*\]/gu, marker)
      .replace(/data:[\w.+-]+\/[\w.+-]+(?:;[\w=.+-]+)*,[A-Za-z\d+/_=%.-]+/gu, marker)
      .replace(new RegExp(`[A-Za-z\\d+/_=-]{${MIN_ENCODED_RUN},}`, 'gu'), token => encodedRun(token) ? marker : token)
      .replace(/^(?:[A-Za-z\d+/]{64,}={0,2}[ \t]*\r?\n){7,}[A-Za-z\d+/]{16,}={0,2}$/gmu, block => encodedRun(block.replace(/\s/gu, '')) ? marker : block)
      .replace(/(?:\\x[a-f\d]{2}){32,}/giu, marker)
      .replace(/(?:\b[01]{8}[ ,\t]+){32,}[01]{8}\b/gu, marker)
      .replace(/(?:\b(?:0x)?[a-f\d]{2}[ ,\t]+){32,}(?:0x)?[a-f\d]{2}\b/giu, marker)
      .replace(/^[ \t]*(?:[a-f\d]{8,16}:?[ \t]+)(?:[a-f\d]{2}[ \t]+){8,16}(?:\|[^\r\n]*\|)?[ \t]*$/gimu, marker)
      .replace(/(\[文件路径[^\]\r\n]*\])(?:[ \t]*\r?\n\1)+/gu, '$1');
  }
  function visit(input: unknown, depth: number, inherited: string): unknown {
    if (depth > MAX_DEPTH) return typeof input === 'string' ? plain(input, inherited) : input;
    if (typeof input === 'string') {
      if (/^[\[{]/u.test(input.trim())) {
        try {
          const parsed = JSON.parse(input);
          const changed = visit(parsed, depth + 1, inherited);
          if (JSON.stringify(parsed) !== JSON.stringify(changed)) return JSON.stringify(changed);
        } catch { /* 不完整JSON仍执行明文载荷识别。 */ }
      }
      return plain(input, inherited);
    }
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1, inherited));
    if (!input || typeof input !== 'object') return input;
    const object = input as Record<string, unknown>;
    const explicit = Object.entries(object).filter(([key, item]) => PATH_KEYS.has(key) && typeof item === 'string' && !item.startsWith('data:')).map(([, item]) => item as string);
    const marker = explicit.length === 1 ? `[文件路径 ${explicit[0]}]` : inherited;
    if (object.type === 'Buffer' && Array.isArray(object.data) || /^(?:base64|base85|hex|binary)$/iu.test(String(object.encoding)) && (typeof object.data === 'string' || Array.isArray(object.data))) return marker;
    if (typeof object.type === 'string' && MEDIA_TYPES.test(object.type)) {
      const media = object.image_url ?? object.audio ?? object.input_audio ?? object.file_data ?? object.data ?? object.url;
      if (typeof media === 'string' && (media.startsWith('data:') || encodedRun(media) || media.length > MIN_ENCODED_RUN && /(?:base64|hex)/iu.test(String(object.encoding)))) return { type: 'input_text', text: marker };
      if (media && typeof media === 'object') {
        const part = media as Record<string, unknown>;
        if (typeof part.data === 'string' || typeof part.url === 'string' && part.url.startsWith('data:')) return { type: 'input_text', text: marker };
      }
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => {
      if (PAYLOAD_KEYS.test(key) && (typeof item === 'string' && (encodedRun(item.replace(/\s/gu, '')) || /(?:base64|binary|hex)/iu.test(key) && item.length >= 64) || Array.isArray(item) && item.length >= 64 && item.every(byte => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255))) return [key, marker];
      return [key, visit(item, depth + 1, marker)];
    }));
  }
  const local = sourcePaths(value);
  const marker = local.length === 1 ? `[文件路径 ${local[0]}]` : fallback;
  try {
    const parsed = JSON.parse(value);
    const cleaned = visit(parsed, 0, marker);
    return JSON.stringify(parsed) === JSON.stringify(cleaned) ? value : JSON.stringify(cleaned);
  } catch { return plain(value, marker); }
}

/** 结果按call_id关联调用，老来源仅在最近调用唯一时使用其明确路径。 */
export function payloadPathResolver(messages: Message[]): (message: Message) => string[] {
  const calls = new Map<string, string[]>();
  const associations = new Map<number, string[]>();
  let previous: string[] = [];
  for (const message of messages) {
    if (message.role === 'tool-call') {
      previous = sourcePaths(message.content);
      if (message.toolCallId) calls.set(message.toolCallId, previous);
    }
    const own = sourcePaths(message.content);
    const related = message.toolCallId ? calls.get(message.toolCallId) ?? [] : previous;
    associations.set(message.position, own.length === 1 ? own : message.role === 'tool-result' ? related : own);
  }
  return message => associations.get(message.position) ?? [];
}
