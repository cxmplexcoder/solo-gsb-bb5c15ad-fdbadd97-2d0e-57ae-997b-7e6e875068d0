import { useMemo, useState } from 'react';
import type { Cue } from '../types';
import { formatTimestamp } from '../lib/time';
import { countTokens, previewSplit, tokenizeCueText } from '../lib/split';

interface SplitModalProps {
  cue: Cue;
  onClose: () => void;
  onApply: (id: string, n: number) => void;
}

export default function SplitModal({ cue, onClose, onApply }: SplitModalProps) {
  const [input, setInput] = useState('');

  // 标签扫描与可见字数统计：输入 N 之前完成，标签问题立即报错并禁止应用
  const scan = useMemo(() => {
    const tk = tokenizeCueText(cue.text);
    return tk.ok ? { ok: true as const, total: countTokens(tk.tokens) } : tk;
  }, [cue]);

  const trimmed = input.trim();
  const n = trimmed !== '' && /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
  const badNumber = trimmed !== '' && n === null;

  // N 任何变动都会触发预览重算；存在错误时不出预览
  const result = useMemo(
    () => (scan.ok && n !== null ? previewSplit(cue, n) : null),
    [scan, cue, n],
  );

  const tooShort = scan.ok && scan.total < 2;
  const error = !scan.ok
    ? scan.error
    : tooShort
      ? '可见文本不足 2 字，无法拆分为两段非空字幕'
      : badNumber
        ? '切点 N 须为正整数'
        : result && !result.ok
          ? result.error
          : null;

  const preview = result && result.ok ? result.preview : null;
  const canApply = preview !== null && n !== null;

  const apply = () => {
    if (canApply) onApply(cue.id, n);
  };

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>拆分字幕</h2>
          <button className="btn icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-hint">
          按可见字数拆分：换行计 1 字；标签（如 <code>&lt;b&gt;</code>）不计字，切点处按嵌套顺序闭合左段、
          原样重开右段（仅支持正确嵌套的 b/i/u/c/v/lang）；实体（如 <code>&amp;amp;</code>、
          <code>&amp;#65;</code>）各计 1 字并保持原样。分割时间 = 原起点 + 原时长 × N / 总字数
          （四舍五入到毫秒），两段首尾相接且均不得短于 300ms。
        </p>

        <div className="split-orig">
          <div className="split-time">
            原字幕 {formatTimestamp(cue.start)} → {formatTimestamp(cue.end)}
            {scan.ok ? ` · 可见 ${scan.total} 字` : ''}
          </div>
          <div className="split-text">{cue.text}</div>
        </div>

        <div className="split-input-row">
          <label htmlFor="split-n">切点 N（左段字数）</label>
          <input
            id="split-n"
            value={input}
            spellCheck={false}
            autoFocus
            disabled={!scan.ok || tooShort}
            placeholder={scan.ok && !tooShort ? `1 ~ ${scan.total - 1}` : ''}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
          />
          {scan.ok && !tooShort && <span className="dim">共 {scan.total} 字，两段均须非空</span>}
        </div>

        {error && <div className="modal-error">{error}</div>}

        {preview && (
          <>
            <div className="split-summary ok">
              分割点 {formatTimestamp(preview.splitTime)}：左段 {preview.leftCount} 字 / 右段{' '}
              {preview.rightCount} 字，确认后原条将被两条新字幕替换（可一次撤销）。
            </div>
            <div className="split-grid">
              <div className="split-panel">
                <div className="split-time">
                  左段 {formatTimestamp(preview.leftStart)} → {formatTimestamp(preview.leftEnd)}（
                  {Math.round((preview.leftEnd - preview.leftStart) * 1000)}ms）
                </div>
                <div className="split-text">{preview.leftText}</div>
              </div>
              <div className="split-panel">
                <div className="split-time">
                  右段 {formatTimestamp(preview.rightStart)} → {formatTimestamp(preview.rightEnd)}（
                  {Math.round((preview.rightEnd - preview.rightStart) * 1000)}ms）
                </div>
                <div className="split-text">{preview.rightText}</div>
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!canApply}
            title={canApply ? '用两条新字幕替换原条（一次撤销记录）' : '存在错误时禁止应用'}
            onClick={apply}
          >
            应用拆分
          </button>
        </div>
      </div>
    </div>
  );
}
