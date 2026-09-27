import assert from 'node:assert';
import React from 'react';
import { renderToString } from 'react-dom/server';
import TermModal from '../src/components/TermModal';
import SplitModal from '../src/components/SplitModal';
import CueTable from '../src/components/CueTable';
import type { Cue } from '../src/types';
import type { TermRule } from '../src/lib/terms';

/** SSR 输出中 React 会在插值处插入 <!-- -->，先归一化再断言 */
function render(props: Parameters<typeof TermModal>[0]): string {
  return renderToString(React.createElement(TermModal, props)).replace(/<!-- -->/g, '');
}

const noop = () => {};

const cues: Cue[] = [
  { id: 'c1', start: 0.5, end: 2, text: '<b>帐号</b> 与 &amp; 实体 hello' },
  { id: 'c2', start: 2.5, end: 4, text: '无命中行' },
  { id: 'c3', start: 4.5, end: 6, text: 'hello hello 帐号' },
];
const rules: TermRule[] = [
  { id: 'r1', source: '帐号', target: '账号' },
  { id: 'r2', source: 'hello', target: '你好' },
  { id: 'r3', source: '', target: '' },
];

// 正常预览渲染：c1 命中 2 处（帐号、hello），c3 命中 3 处（hello×2、帐号）
const html = render({ cues, rules, onRulesChange: noop, onClose: noop, onApply: noop });
assert(html.includes('术语审校'), '标题缺失');
assert(html.includes('应用替换（2）'), '应默认勾选 2 条命中字幕');
assert(html.includes('帐号→账号'), '命中标签缺失');
assert(html.includes('mark-old') && html.includes('mark-new'), '高亮缺失');
assert(html.includes('&lt;b&gt;'), '标签应按原样转义显示');
assert(html.includes('预览：2 条字幕共 5 处命中，已勾选 2 条。'), '汇总缺失');

// 非法规则（重复原词）→ 显示错误、禁止应用
const bad = render({
  cues,
  rules: [
    { id: 'r1', source: 'a', target: 'x' },
    { id: 'r2', source: 'a', target: 'y' },
  ],
  onRulesChange: noop,
  onClose: noop,
  onApply: noop,
});
assert(bad.includes('原词重复'), '重复校验缺失');
assert(bad.includes('应用替换（0）'), '无预览时应用数应为 0');

// 空规则 → 提示语
const empty = render({
  cues,
  rules: [{ id: 'r1', source: '', target: '' }],
  onRulesChange: noop,
  onClose: noop,
  onApply: noop,
});
assert(empty.includes('请先填写至少一条完整规则'), '空规则提示缺失');

// ---------- 字幕拆分 ----------
const renderSplit = (cue: Cue): string =>
  renderToString(React.createElement(SplitModal, { cue, onClose: noop, onApply: noop })).replace(
    /<!-- -->/g,
    '',
  );

// 正常渲染：显示原字幕时间、可见字数（标签不计）与切点输入
const splitHtml = renderSplit({ id: 's1', start: 1, end: 3, text: '<b>hello</b> world' });
assert(splitHtml.includes('拆分字幕'), '拆分弹窗标题缺失');
assert(splitHtml.includes('可见 11 字'), '可见字数缺失'); // "hello world" = 11 字
assert(splitHtml.includes('切点 N'), '切点输入缺失');
assert(splitHtml.includes('应用拆分'), '应用按钮缺失');
assert(splitHtml.includes('disabled'), '未输入切点时应用按钮应禁用');

// 未知标签：立即报错并禁止应用
const badTag = renderSplit({ id: 's2', start: 0, end: 2, text: 'a<font>b</font>' });
assert(badTag.includes('不支持的标签'), '未知标签报错缺失');
assert(badTag.includes('disabled'), '标签错误时应用按钮应禁用');

// 内联时间戳：立即报错
const inlineTs = renderSplit({ id: 's3', start: 0, end: 2, text: 'a<00:00:01.000>b' });
assert(inlineTs.includes('内联时间戳'), '内联时间戳报错缺失');

// 字幕列表行内有拆分入口（✂）
const tableHtml = renderToString(
  React.createElement(CueTable, {
    cues,
    selectedId: null,
    playhead: 0,
    onSelect: noop,
    onEditTimes: noop,
    onEditText: noop,
    onDelete: noop,
    onInsert: noop,
    onSplit: noop,
  }),
).replace(/<!-- -->/g, '');
assert(tableHtml.includes('✂'), '字幕列表拆分入口缺失');
assert(tableHtml.includes('按切点拆分为两段'), '拆分入口提示缺失');

console.log('UI 冒烟测试通过 ✅');
