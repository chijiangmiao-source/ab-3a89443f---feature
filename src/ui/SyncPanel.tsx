import type {
  MergeOutcome,
  PointReason,
  PointStatus,
  SyncDelta,
  ValidationError,
  Vector,
} from '../crdt/types';
import type { SyncReport, SyncSelection } from '../crdt/sync';
import type { ReplayResult } from '../crdt/types';

const STATUS_META: Record<PointStatus, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'added' },
  'kept-concurrent': { label: '并发保留', cls: 'kept-concurrent' },
  kept: { label: '保持', cls: 'kept' },
  removed: { label: '删除', cls: 'removed' },
  suppressed: { label: '上下文抑制', cls: 'suppressed' },
};

const ROLE_LABEL: Record<SyncDelta['events'][number]['role'], string> = {
  'live-add': '存活点',
  'remove-tombstone': '撤销墓碑',
  'causal-filler': '因果填充',
};

function VectorChips({ vector }: { vector: Vector }) {
  return (
    <span className="chips">
      {Object.entries(vector).map(([k, v]) => (
        <span key={k} className="chip">
          {k}={v}
        </span>
      ))}
    </span>
  );
}

function StepSelect({
  replay,
  selection,
  onChange,
}: {
  replay: Extract<ReplayResult, { ok: true }>;
  selection: SyncSelection;
  onChange: (step: number) => void;
}) {
  return (
    <select
      value={selection.step}
      onChange={(e) => onChange(Number(e.target.value))}
      title="全局回放步号；每一步后都含全部终端的快照"
    >
      <option value={0}>步 0 · 初始空状态</option>
      {replay.steps.map((s) => (
        <option key={s.index} value={s.index + 1}>
          全局步 {s.index + 1} · {s.terminal} 处理 {s.messageId}（{s.action}）
        </option>
      ))}
    </select>
  );
}

function SnapshotSummary({
  replay,
  terminal,
  step,
}: {
  replay: Extract<ReplayResult, { ok: true }>;
  terminal: string;
  step: number;
}) {
  const view = step === 0 ? null : replay.steps[step - 1]?.stateAfter[terminal];
  const vector = view?.vector ?? Object.fromEntries(replay.terminals.map((t) => [t, 0]));
  const zoneCount = view?.zones.length ?? 0;
  const dotCount = view?.zones.reduce((n, z) => n + z.dots.length, 0) ?? 0;
  return (
    <div className="snapshot-summary" title="所选步骤快照（增量仅基于其中已应用事件生成）">
      <span className="chips">
        {Object.entries(vector).map(([k, v]) => (
          <span key={k} className="chip">
            {k}={v}
          </span>
        ))}
      </span>
      <span className="dim">
        存活标签 {zoneCount}（{dotCount} 点）
        {view && view.pending.length > 0 ? ` · 暂存 ${view.pending.length} 条` : ' · 无暂存'}
      </span>
    </div>
  );
}

interface Props {
  replay: Extract<ReplayResult, { ok: true }>;
  source: SyncSelection;
  target: SyncSelection;
  busy: boolean;
  applyCount: number;
  report: SyncReport | null;
  errors: ValidationError[] | null;
  onSelectSource: (sel: SyncSelection) => void;
  onSelectTarget: (sel: SyncSelection) => void;
  onSwap: () => void;
  onRun: () => void;
  onRepeat: () => void;
  onClear: () => void;
}

export default function SyncPanel(props: Props) {
  const { replay, source, target, busy, applyCount, report, errors } = props;
  const sameTerminal = source.terminal === target.terminal;
  const out: MergeOutcome | null = report?.ok ? report.forward : null;

  return (
    <div className="sync">
      <h4>单向补传（快照状态增量 → OR-Set 合并）</h4>
      <div className="sync-controls">
        <div className="sync-endpoint">
          <span className="label">源端快照</span>
          <select
            value={source.terminal}
            onChange={(e) => props.onSelectSource({ ...source, terminal: e.target.value })}
          >
            {replay.terminals.map((t) => (
              <option key={t} value={t}>
                终端 {t}
              </option>
            ))}
          </select>
          <StepSelect
            replay={replay}
            selection={source}
            onChange={(step) => props.onSelectSource({ ...source, step })}
          />
          <SnapshotSummary replay={replay} terminal={source.terminal} step={source.step} />
        </div>
        <button className="swap" onClick={props.onSwap} title="交换补传方向（结果应保持不变）">
          ⇄
        </button>
        <div className="sync-endpoint">
          <span className="label">接收端快照</span>
          <select
            value={target.terminal}
            onChange={(e) => props.onSelectTarget({ ...target, terminal: e.target.value })}
          >
            {replay.terminals.map((t) => (
              <option key={t} value={t}>
                终端 {t}
              </option>
            ))}
          </select>
          <StepSelect
            replay={replay}
            selection={target}
            onChange={(step) => props.onSelectTarget({ ...target, step })}
          />
          <SnapshotSummary replay={replay} terminal={target.terminal} step={target.step} />
        </div>
        <div className="sync-actions">
          <button className="primary" onClick={props.onRun} disabled={busy || sameTerminal}>
            发起补传
          </button>
          <button onClick={props.onRepeat} disabled={busy || !report || sameTerminal}>
            重复应用
          </button>
          <button onClick={props.onClear} disabled={!report && !errors}>
            清空补传结果
          </button>
        </div>
      </div>

      {sameTerminal && (
        <div className="banner bad" style={{ marginTop: 8 }}>
          非法选择：源端与接收端须为两台不同终端（已清空补传结果，原回放不变）
        </div>
      )}
      {errors && !sameTerminal && (
        <div className="banner bad" style={{ marginTop: 8 }}>
          <div>快照选择非法或与场景不相容，已清空此前补传结果（原回放不变）：</div>
          <ul className="sync-errors">
            {errors.map((e, i) => (
              <li key={i}>
                <code>{e.path}</code> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {out && report && (
        <SyncResultView report={report} out={out} applyCount={applyCount} />
      )}
    </div>
  );
}

function SyncResultView({
  report,
  out,
  applyCount,
}: {
  report: SyncReport;
  out: MergeOutcome;
  applyCount: number;
}) {
  const d = out.delta;
  const counts = out.counts;
  const countChips = (Object.keys(STATUS_META) as PointStatus[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${STATUS_META[s].label} ${counts[s]}`);

  return (
    <div className="sync-result">
      <div className="sync-badges">
        <span className={`badge2 ${report.idempotent ? 'ok' : 'bad'}`}>
          幂等：重复应用结果不变 {report.idempotent ? '✓' : '✗'}
          {applyCount > 1 ? `（已应用 ${applyCount} 次）` : ''}
        </span>
        <span className={`badge2 ${report.commutative ? 'ok' : 'bad'}`}>
          可交换：反向补传合并结果一致 {report.commutative ? '✓' : '✗'}
        </span>
        <span className="badge2 dim">
          增量事件 {d.events.length} 条 · {countChips.join(' · ')}
        </span>
      </div>

      <div className="sync-vectors">
        <div className="vec-box">
          <span className="label">
            源端 {d.source}（步 {d.sourceStep}）向量
          </span>
          <VectorChips vector={d.sourceVector} />
        </div>
        <div className="vec-arrow">→</div>
        <div className="vec-box">
          <span className="label">
            接收端 {d.target}（步 {d.targetStep}）合并后向量
          </span>
          <VectorChips vector={out.mergedVector} />
        </div>
      </div>

      <div className="sync-cols">
        <div className="sync-col">
          <span className="label">合并后有效标签（接收端视角）</span>
          {out.zones.length === 0 ? (
            <span className="dim">（空）</span>
          ) : (
            <ul className="zones">
              {out.zones.map((z) => (
                <li key={z.zone}>
                  <b>{z.zone}</b>
                  <span className="dots">
                    {z.dots.map((dot) => (
                      <span key={dot.dot} className="chip ok" title={`支撑事件：${dot.events.join('、')}`}>
                        {dot.dot}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="sync-col">
          <span className="label">状态增量内容（只含必需点与因果上下文）</span>
          {d.events.length === 0 ? (
            <span className="dim">（空增量：接收端已观察源端全部相关事件）</span>
          ) : (
            <ul className="delta-events">
              {d.events.map((e) => (
                <li key={e.eventId} className={`role-${e.role}`}>
                  <code>{e.eventId}</code>
                  <span className={`mini-badge role-${e.role}`}>{ROLE_LABEL[e.role]}</span>
                  <span className="dim">
                    {e.kind} · {e.zone}
                    {e.dot ? ` · ${e.dot}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d.excludedPending.length > 0 && (
            <div className="excluded">
              <span className="label">未纳入项（暂存消息，仅基于已应用事件生成增量）</span>
              <ul>
                {d.excludedPending.map((n) => (
                  <li key={n.terminal}>
                    终端 {n.terminal} 暂存：
                    {n.messageIds.map((m) => (
                      <span key={m} className="chip warn">
                        {m}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="sync-points">
        <span className="label">逐点依据（按终端、区域、点标识稳定排序）</span>
        <table>
          <thead>
            <tr>
              <th>终端</th>
              <th>区域</th>
              <th>点</th>
              <th>事件</th>
              <th>结果</th>
              <th>依据</th>
            </tr>
          </thead>
          <tbody>
            {out.points.map((p: PointReason) => (
              <tr key={p.eventId} className={`point-${STATUS_META[p.status].cls}`}>
                <td>{p.terminal}</td>
                <td>{p.zone}</td>
                <td>
                  <code>{p.dot}</code>
                </td>
                <td>
                  <code>{p.eventId}</code>
                </td>
                <td>
                  <span className={`mini-badge point-${STATUS_META[p.status].cls}`}>
                    {STATUS_META[p.status].label}
                  </span>
                </td>
                <td className="reason-cell">{p.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
