import MarkdownIt from 'markdown-it';

// UUID 引用只允许已约定的资源协议，禁止任意本地路径进入页面。
const RESOURCE_REFERENCE = /^kb:\/\/resource\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:#.*)?$/i;
const parser = new MarkdownIt({ html: false, linkify: false, breaks: false });
const validateLink = parser.validateLink.bind(parser);
parser.validateLink = (url) => RESOURCE_REFERENCE.test(url) || validateLink(url);

/** 原始 HTML 作为文字显示，图片只解析 UUID，外链限制为 HTTP(S)。 */
export function renderMarkdown(source: string): string {
  const tokens = parser.parse(source, {});
  const walk = (items: typeof tokens): void => {
    for (const token of items) {
      if (token.type === 'image') {
        const match = RESOURCE_REFERENCE.exec(String(token.attrGet('src') ?? ''));
        token.attrSet('src', match ? `/api/resources/${match[1]}/file?inline=1` : '');
        token.attrSet('loading', 'lazy');
        token.attrSet('referrerpolicy', 'no-referrer');
      }
      if (token.type === 'link_open') {
        const href = String(token.attrGet('href') ?? '');
        const match = RESOURCE_REFERENCE.exec(href);
        if (match) token.attrSet('href', `#resource/${match[1]}`);
        else if (/^https?:\/\//i.test(href)) {
          token.attrSet('rel', 'noopener noreferrer');
          token.attrSet('target', '_blank');
        } else token.attrSet('href', '#');
      }
      if (token.children) walk(token.children);
    }
  };
  walk(tokens);
  return parser.renderer.render(tokens, parser.options, {});
}
