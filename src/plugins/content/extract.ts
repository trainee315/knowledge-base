import path from 'node:path';
import MarkdownIt from 'markdown-it';

// 首期正文解析只接受 UTF-8 的轻量文本格式。
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json']);
const RESOURCE_URI = /^kb:\/\/resource\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[?#].*)?$/iu; // 正式Markdown引用以UUID定位资源。
const markdown = new MarkdownIt({ html: false, linkify: false });

export interface MarkdownReference { uri: string; resourceId?: string; kind: 'link' | 'image' }

export interface ExtractedContent {
  status: 'parsed' | 'unsupported' | 'failed';
  text: string;
  filename: string;
  format: string;
  error?: string;
  markdownReferences: MarkdownReference[];
}

/** 只读取真实Markdown链接/图片token，代码围栏和行内代码不会登记引用。 */
function references(text: string): MarkdownReference[] {
  const result: MarkdownReference[] = [];
  const visit = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const token of tokens) {
      const attribute = token.type === 'link_open' ? token.attrGet('href') : token.type === 'image' ? token.attrGet('src') : null;
      const uri = attribute === null ? null : String(attribute);
      if (uri && /^kb:/iu.test(uri)) {
        const match = RESOURCE_URI.exec(uri);
        result.push({ uri, ...(match ? { resourceId: match[1].toLowerCase() } : {}), kind: token.type === 'image' ? 'image' : 'link' });
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(text, {}));
  return result;
}

/** 解析失败也保留文件名，使任何格式的资源都可继续组织。 */
export function extractContent(filename: string, bytes: Uint8Array): ExtractedContent {
  const format = path.extname(filename).toLowerCase();
  const result: ExtractedContent = { status: 'unsupported', text: '', filename, format, markdownReferences: [] };
  if (!TEXT_EXTENSIONS.has(format)) return result;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
    if (format === '.json') JSON.parse(decoded);
    return { ...result, status: 'parsed', text: decoded, markdownReferences: ['.md', '.markdown'].includes(format) ? references(decoded) : [] };
  } catch (error) {
    return { ...result, status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
