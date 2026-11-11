import type { Component } from 'vue';

export interface PreviewPanel { pluginId: string; title: string; component?: Component }
// 插件面板随页面构建注册，运行时仅展示当前启用的插件分区。
export const previewPanels: PreviewPanel[] = [
  { pluginId: 'content', title: '正文解析' },
  { pluginId: 'keywords', title: '关键词' },
  { pluginId: 'tags', title: '标签与归属判断' },
  { pluginId: 'systems', title: '体系' },
  { pluginId: 'organizer', title: '整理结果' },
];

export function registerPreviewPanel(panel: PreviewPanel): void {
  if (previewPanels.some((item) => item.pluginId === panel.pluginId)) throw new Error(`重复预览面板 ${panel.pluginId}`);
  previewPanels.push(panel);
}
