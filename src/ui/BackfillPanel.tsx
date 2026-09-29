import type { MergeResult, ReplayResult } from '../crdt/types';
import type { BackfillPreset } from '../samples';

export interface SnapSelection {
  terminal: string;
  /** 本地步号（0 = 初始空快照） */
  localStep: number;
}

interface Props {
  replay: Extract<ReplayResult, { ok: true }>;
  source: SnapSelection;
  target: SnapSelection;
  onChange: (which: 'source' | 'target', sel: SnapSelection) => void;
  onSwap: () => void;
  onApply: () => void;
  onReapply: () => void;
  merge: MergeResult | null;
  presets: BackfillPreset[];
  onPreset: (p: BackfillPreset) => void;
}

const STATUS_LABEL: Record<string, string> = {
  new: '新增保留',
  live: '原状保留',
  removed: '合并删除',
  suppressed: '上下文抑制',
};

function StepSelect({
  replay,
  sel,
  label,
  onChange,
}: {
  replay: Extract<ReplayResult, { ok: true }>;
  sel: SnapSelection;
  label: string;
  onChange: (s: SnapSelection) => void;
}) {
  const steps = replay.steps.filter((s) => s.terminal === sel.terminal);
  return (
    <div className="bf-snap">
      <div className="label">{label}</div>
      <select
        value={sel.terminal}
        onChange={(e) => onChange({ terminal: e.target.value, localStep: 0 })}
      >
        {replay.terminals.map((t) => (
          <option key={t} value={t}>
            终端 {t}
          </option>
        ))}
      </select>
      <select
        value={sel.localStep}
        onChange={(e) => onChange({ ...sel, localStep: Number(e.target.value) })}
      >
        <option value={0}>本地步 0 · 初始空快照</option>
        {steps.map((s, i) => (
          <option key={s.index} value={i + 1}>
            本地步 {i + 1} · {s.messageId}（{s.action}）
          </option>
        ))}
      </select>
    </div>
  );
}

export default function BackfillPanel({
  replay,
  source,
  target,
  onChange,
  onSwap,
  onApply,
  onReapply,
  merge,
  presets,
  onPreset,
}: Props) {
  return (
    <div className="backfill">
      <h4>单向补传（从步骤快照构造可交换状态增量）</h4>
      <p className="dim bf-hint">
        分别选取两台终端的任意步骤快照，向接收端单向补传：无需重放对方完整收件脚本，
        接收端结果等于两份快照的 OR-Set 合并。重复应用或交换方向，结果不变。
      </p>

      {presets.length > 0 && (
        <div className="samples">
          {presets.map((p) => (
            <button key={p.name} className="sample" onClick={() => onPreset(p)}>
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="bf-controls">
        <StepSelect replay={replay} sel={source} label="发送端快照（增量来源）" onChange={(s) => onChange('source', s)} />
        <button className="bf-swap" onClick={onSwap} title="交换补传方向">
          ⇄
        </button>
        <StepSelect replay={replay} sel={target} label="接收端快照（合并目标）" onChange={(s) => onChange('target', s)} />
        <button className="primary" onClick={onApply}>
          构造增量并补传
        </button>
      </div>

      {merge?.ok && (
        <div className="bf-reapply">
          <button onClick={onReapply} title="对已合并的接收端再次应用同一增量">
            ↻ 再次应用本增量（结果应不变）
          </button>
        </div>
      )}

      {merge && !merge.ok && (
        <div className="banner bad">
          非法或不相容的快照选择，已清空此前补传结果（原回放不变）：
          <ul>
            {merge.errors.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </div>
      )}

      {merge && merge.ok && (
        <div className="bf-result">
          <div className="banner ok">
            补传完成：{merge.delta.source}（步 {merge.delta.sourceStep}）→{' '}
            {merge.delta.target}（步 {merge.delta.targetStep}）；增量含新增点{' '}
            {merge.delta.adds.length} 个、撤销依据 {merge.delta.tombstones.length} 条
            {merge.view.idempotent ? '；本次应用未改变状态（重复应用幂等）' : ''}
          </div>

          <div className="row">
            <span className="label">合并版本向量</span>
            <span className="chips">
              {Object.entries(merge.view.vector).map(([k, v]) => (
                <span key={k} className="chip">
                  {k}={v}
                </span>
              ))}
            </span>
          </div>

          <div className="bf-cols">
            <div className="bf-col">
              <span className="label">合并后有效标签</span>
              {merge.view.zones.length === 0 ? (
                <span className="dim">（空）</span>
              ) : (
                <ul className="zones">
                  {merge.view.zones.map((z) => (
                    <li key={z.zone}>
                      <b>{z.zone}</b>
                      <span className="dots">
                        {z.dots.map((d) => (
                          <span key={d.dot} className="chip ok">
                            {d.dot}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bf-col">
              <span className="label">变化汇总</span>
              <ul className="bf-summary">
                <li className="pt-new">新增保留：{merge.view.added.join('、') || '无'}</li>
                <li className="pt-removed">合并删除：{merge.view.removed.join('、') || '无'}</li>
                <li className="pt-suppressed">
                  上下文抑制（迟到不复活）：{merge.view.suppressed.join('、') || '无'}
                </li>
              </ul>
            </div>
          </div>

          {merge.delta.excludedPending.length > 0 && (
            <div className="bf-excluded">
              <span className="label">暂存消息未纳入增量（仅基于已应用事件生成）：</span>
              <ul>
                {merge.delta.excludedPending.map((p) => (
                  <li key={p.messageId}>
                    <code>{p.messageId}</code> {p.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <table className="bf-table">
            <thead>
              <tr>
                <th>终端</th>
                <th>区域</th>
                <th>点标识</th>
                <th>事件</th>
                <th>处置</th>
                <th>逐点依据</th>
              </tr>
            </thead>
            <tbody>
              {merge.view.points.map((p) => (
                <tr key={p.eventId} className={`pt-row pt-${p.status}`}>
                  <td>{p.terminal}</td>
                  <td>{p.zone}</td>
                  <td>
                    <code>{p.dot}</code>
                  </td>
                  <td>
                    <code>{p.eventId}</code>
                  </td>
                  <td>
                    <span className={`badge pt-badge-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                  </td>
                  <td className="reason">{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
