import { Replica, parseEventId } from './engine';
import { parseScenario } from './parse';
import { runReplay } from './replay';
import type {
  DeltaEventInfo,
  MergeOutcome,
  Message,
  PointReason,
  PointStatus,
  RemoveMessage,
  Scenario,
  Step,
  SyncDelta,
  SyncResult,
  TerminalView,
  ValidationError,
  Vector,
  ZoneView,
} from './types';

/**
 * 单向补传：从两台终端各自的任意步骤快照构造“可交换状态增量”并做 OR-Set 合并。
 *
 * 增量内容（只含合并结果所必需的点与因果上下文，且仅列接收端尚未应用的事件）：
 *  1. live-add        ：源快照点集中的存活新增点；
 *  2. remove-tombstone：源端“已应用”、上下文覆盖某个相关点的撤销；
 *  3. causal-filler   ：上述事件因果闭包内的其余事件（如源端早已撤销的旧点及其撤销）。
 * 暂存（未应用）消息一律不进入增量，仅在 excludedPending 中标出。
 *
 * 合并在“按版本向量重建的接收端状态”上按因果拓扑重放增量，因此：
 *  - 幂等：重复应用同一增量，事件全部判重，结果不变；
 *  - 可交换：交换补传方向（各取对方增量）得到相同的合并向量与标签；
 *  - add-wins：撤销只清除其 ctx 覆盖的点，未见的并发新增保留；
 *  - 不复活：接收端已观察并撤销的点，迟到增量重新带来时仍被墓碑抑制。
 */

export interface SyncSelection {
  terminal: string;
  /** 回放步号：0 = 初始空状态；k = 第 k 步之后的快照 */
  step: number;
}

export interface SyncEndpoint extends SyncSelection {
  view: TerminalView;
}

export interface SyncReport {
  ok: true;
  forward: MergeOutcome;
  reverse: MergeOutcome;
  idempotent: boolean;
  commutative: boolean;
}

export type SyncResponse = SyncReport | { ok: false; errors: ValidationError[] };

function covers(r: RemoveMessage, eventId: string): boolean {
  const { t, n } = parseEventId(eventId);
  return (r.ctx[t] ?? 0) >= n;
}

function vecGet(v: Vector, t: string): number {
  return v[t] ?? 0;
}

/** 版本向量界定的“已应用事件”集合（每终端序号前缀） */
function appliedEventIds(v: Vector, sc: Scenario): Set<string> {
  const ids = new Set<string>();
  for (const m of sc.messages) if (vecGet(v, m.from) >= m.seq) ids.add(m.id);
  return ids;
}

/**
 * 事件集合的因果闭包：事件 e 要求其 ctx 中声明观察过的全部事件到场
 * （ctx[自身]=自身序号，自然包含同链前序）。
 */
function causalClosure(sc: Scenario, seeds: Message[]): Set<string> {
  const byId = sc.messagesById;
  const have = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (have.has(e.id)) continue;
    have.add(e.id);
    for (const u of sc.terminals) {
      for (let n = vecGet(e.ctx, u); n >= 1; n -= 1) {
        const dep = byId[`${u}#${n}`];
        if (dep && !have.has(dep.id)) stack.push(dep);
      }
    }
  }
  return have;
}

/** 按依赖拓扑序排列（ctx 依赖在前），供 Replica 无暂存重放；遍历顺序按终端、序号稳定 */
function topoSort(sc: Scenario, ids: Set<string>): Message[] {
  const placed = new Set<string>();
  const out: Message[] = [];
  const visit = (m: Message) => {
    if (placed.has(m.id)) return;
    for (const u of sc.terminals) {
      for (let n = vecGet(m.ctx, u); n >= 1; n -= 1) {
        const dep = sc.messagesById[`${u}#${n}`];
        // ctx[自身]=自身序号 表示“含本条自身”，自引用不作为拓扑前序
        if (dep && dep.id !== m.id && ids.has(dep.id)) visit(dep);
      }
    }
    placed.add(m.id);
    out.push(m);
  };
  for (const t of sc.terminals) {
    for (let n = 1; ; n += 1) {
      const m = sc.messagesById[`${t}#${n}`];
      if (!m) break;
      if (ids.has(m.id)) visit(m);
    }
  }
  return out;
}

/** 从版本向量前缀重建一台终端的状态（不含任何暂存消息） */
function reconstructReplica(sc: Scenario, id: string, v: Vector): Replica {
  const r = new Replica(id, sc.terminals);
  const ids = appliedEventIds(v, sc);
  for (const m of topoSort(sc, ids)) r.deliver(m);
  return r;
}

function liveEventIds(view: TerminalView): Set<string> {
  const ids = new Set<string>();
  for (const z of view.zones) for (const d of z.dots) for (const e of d.events) ids.add(e);
  return ids;
}

/**
 * 计算相关事件闭包。以两端存活点并集为种子，不动点地补入：
 *  - 因果闭包（filler）；
 *  - 源端已应用、且覆盖闭包内任意新增点的撤销（墓碑）——
 *    包括源端为撤销旧点而随上下文带入的撤销，保证迟到增量不会让旧点复活。
 */
function computeClosure(sc: Scenario, sourceApplied: Set<string>, seedIds: Set<string>): Set<string> {
  let tombstones = new Set<string>();
  let closure = new Set<string>();
  for (;;) {
    const seeds = sc.messages.filter((m) => seedIds.has(m.id) || tombstones.has(m.id));
    closure = causalClosure(sc, seeds);

    const next = new Set(tombstones);
    for (const m of sc.messages) {
      if (m.kind !== 'remove' || !sourceApplied.has(m.id)) continue;
      for (const a of sc.messages) {
        if (a.kind === 'add' && closure.has(a.id) && a.tag.zone === m.zone && covers(m, a.id)) {
          next.add(m.id);
          break;
        }
      }
    }
    const same = next.size === tombstones.size && [...next].every((id) => tombstones.has(id));
    tombstones = next;
    if (same) break;
  }
  return closure;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function chainLen(sc: Scenario, t: string): number {
  return sc.messages.filter((m) => m.from === t).length;
}

function validateSelection(
  terminals: string[],
  maxStep: number,
  ep: SyncSelection,
  other: SyncSelection,
  label: string,
  errors: ValidationError[],
): void {
  const path = `$.${label}`;
  if (typeof ep.terminal !== 'string' || !terminals.includes(ep.terminal)) {
    errors.push({ path, message: `${label}终端 "${ep.terminal}" 不在场景终端列表中` });
  }
  if (ep.terminal === other.terminal) {
    errors.push({
      path,
      message: '单向补传须选取两台不同终端的快照（源端与接收端为同一终端）',
    });
  }
  if (!Number.isInteger(ep.step) || ep.step < 0 || ep.step > maxStep) {
    errors.push({
      path: `${path}.step`,
      message: `${label}快照步号非法：${ep.step}（允许 0..${maxStep}）`,
    });
  }
}

/** 从回放步骤序列中选取某终端在某步后的快照（step=0 为初始空状态） */
export function selectView(
  terminals: string[],
  steps: Step[],
  inboxSizes: Record<string, number>,
  sel: SyncSelection,
): TerminalView | null {
  if (!terminals.includes(sel.terminal)) return null;
  if (sel.step === 0) {
    const vector: Vector = {};
    for (const t of terminals) vector[t] = 0;
    return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal: inboxSizes[sel.terminal] ?? 0 };
  }
  const s = steps[sel.step - 1];
  if (!s) return null;
  return s.stateAfter[sel.terminal] ?? null;
}

function validateView(sc: Scenario, ep: SyncEndpoint, label: string, errors: ValidationError[]): void {
  const path = `$.${label}.view`;
  const v = ep.view.vector;
  for (const t of sc.terminals) {
    if (!isInt(v[t])) {
      errors.push({ path: `${path}.vector.${t}`, message: `${label}快照版本向量缺少或非法：${t}` });
    } else if (v[t] > chainLen(sc, t)) {
      errors.push({
        path: `${path}.vector.${t}`,
        message: `${label}快照版本向量超出已知事件链：${t}=${v[t]}`,
      });
    }
  }
  const known = new Set(sc.messages.map((m) => m.id));
  for (const z of ep.view.zones) {
    for (const d of z.dots) {
      for (const eid of d.events) {
        const m = sc.messagesById[eid];
        if (!known.has(eid) || !m) {
          errors.push({ path, message: `${label}快照引用未知事件点 ${eid}` });
          continue;
        }
        if (m.kind !== 'add' || m.dot !== d.dot || m.tag.zone !== z.zone) {
          errors.push({
            path,
            message: `${label}快照与场景不相容：存活点 ${eid} 与消息定义不一致`,
          });
        }
        if (vecGet(v, m.from) < m.seq) {
          errors.push({
            path,
            message: `${label}快照不相容：存活点 ${eid} 尚未在版本向量中应用`,
          });
        }
      }
    }
  }
  for (const p of ep.view.pending) {
    if (!known.has(p)) {
      errors.push({ path: `${path}.pending`, message: `${label}快照暂存队列引用未知消息 ${p}` });
    }
  }
}

/**
 * 发起一次单向补传：从源快照构造增量，在接收端快照上合并，
 * 返回增量、合并后的标签/版本向量与逐点依据，并自检幂等性。
 */
export function buildSync(sc: Scenario, source: SyncEndpoint, target: SyncEndpoint): SyncResult {
  const errors: ValidationError[] = [];
  validateView(sc, source, 'source', errors);
  validateView(sc, target, 'target', errors);
  if (errors.length > 0) return { ok: false, errors };

  const vS = source.view.vector;
  const vT = target.view.vector;
  const sourceApplied = appliedEventIds(vS, sc);
  const targetApplied = appliedEventIds(vT, sc);
  const liveS = liveEventIds(source.view);
  const liveT = liveEventIds(target.view);

  // ---- 两端存活点并集作为相关闭包的种子 ----
  const seedIds = new Set<string>();
  for (const id of liveS) if (sourceApplied.has(id)) seedIds.add(id);
  for (const id of liveT) seedIds.add(id);

  const closure = computeClosure(sc, sourceApplied, seedIds);

  // ---- 实际进入增量的事件：闭包内接收端尚未应用的部分 ----
  const deltaIds = new Set<string>();
  for (const id of closure) if (!targetApplied.has(id)) deltaIds.add(id);

  const events: DeltaEventInfo[] = [];
  for (const m of sc.messages) {
    if (!deltaIds.has(m.id)) continue;
    let role: DeltaEventInfo['role'];
    if (m.kind === 'add' && liveS.has(m.id)) {
      role = 'live-add';
    } else if (
      m.kind === 'remove' &&
      sc.messages.some(
        // 墓碑：覆盖闭包内任意新增点（含为抑制因果填充点而必须携带的撤销）
        (a) => a.kind === 'add' && closure.has(a.id) && a.tag.zone === m.zone && covers(m, a.id),
      )
    ) {
      role = 'remove-tombstone';
    } else {
      role = 'causal-filler';
    }
    events.push({
      eventId: m.id,
      kind: m.kind,
      role,
      zone: m.kind === 'add' ? m.tag.zone : m.zone,
      dot: m.kind === 'add' ? m.dot : undefined,
    });
  }

  const excludedPending = [
    { terminal: source.terminal, messageIds: [...source.view.pending] },
    { terminal: target.terminal, messageIds: [...target.view.pending] },
  ].filter((n) => n.messageIds.length > 0);

  const delta: SyncDelta = {
    format: 'nfz-or-set-delta',
    version: 1,
    source: source.terminal,
    target: target.terminal,
    sourceStep: source.step,
    targetStep: target.step,
    sourceVector: { ...vS },
    targetVector: { ...vT },
    events,
    newToTarget: events.map((e) => e.eventId),
    excludedPending,
  };

  // ---- 在重建的接收端状态上按拓扑序重放增量（无暂存） ----
  const replica = reconstructReplica(sc, target.terminal, vT);
  const ordered = topoSort(sc, deltaIds);
  for (const m of ordered) replica.deliver(m);
  const mergedView = replica.view(target.view.inboxDone, target.view.inboxTotal);
  // 合并版本向量 = 两端已观察集合的按位最大值（交换、幂等）；
  // 闭包只含合并结果所必需事件，故可能小于源端向量，展示层以完整合并上下文为准。
  const mergedVector: Vector = {};
  for (const t of sc.terminals) mergedVector[t] = Math.max(vecGet(vT, t), vecGet(vS, t));

  // ---- 二次应用同一增量：必须完全幂等 ----
  const before2nd = JSON.stringify({ vector: { ...replica.vector }, zones: mergedView.zones });
  for (const m of ordered) replica.deliver(m);
  const after2nd = replica.view(target.view.inboxDone, target.view.inboxTotal);
  const idempotent =
    before2nd === JSON.stringify({ vector: { ...replica.vector }, zones: after2nd.zones });

  const points = buildPointReasons(sc, delta, source.view, target.view, mergedView.zones, closure);
  const counts: Record<PointStatus, number> = {
    added: 0,
    'kept-concurrent': 0,
    kept: 0,
    removed: 0,
    suppressed: 0,
  };
  for (const p of points) counts[p.status] += 1;

  const outcome: MergeOutcome = {
    ok: true,
    delta,
    mergedVector,
    zones: mergedView.zones,
    points,
    counts,
    idempotent,
  };
  return outcome;
}

function buildPointReasons(
  sc: Scenario,
  delta: SyncDelta,
  sv: TerminalView,
  tv: TerminalView,
  mergedZones: ZoneView[],
  closure: Set<string>,
): PointReason[] {
  const vS = delta.sourceVector;
  const vT = delta.targetVector;
  const liveS = liveEventIds(sv);
  const liveT = liveEventIds(tv);
  const mergedLive = liveEventIds({
    vector: {},
    zones: mergedZones,
    pending: [],
    inboxDone: 0,
    inboxTotal: 0,
  });
  const removes = sc.messages.filter(
    (m): m is RemoveMessage =>
      m.kind === 'remove' && (vecGet(vT, m.from) >= m.seq || closure.has(m.id)),
  );

  // 候选点：两端存活点并集（新增/删除/保留）+ 增量带来的上下文中的点（抑制/不复活）
  const candidateIds = new Set<string>();
  for (const id of liveS) candidateIds.add(id);
  for (const id of liveT) candidateIds.add(id);
  for (const e of delta.events) if (e.kind === 'add') candidateIds.add(e.eventId);

  const points: PointReason[] = [];
  for (const m of sc.messages) {
    if (m.kind !== 'add' || !candidateIds.has(m.id)) continue;
    const id = m.id;
    const observedBySource = vecGet(vS, m.from) >= m.seq;
    const observedByTarget = vecGet(vT, m.from) >= m.seq;
    const inSource = liveS.has(id);
    const inTarget = liveT.has(id);
    const inMerged = mergedLive.has(id);
    const killers = removes.filter((r) => r.zone === m.tag.zone && covers(r, id));
    const sourceKillers = killers.filter((k) => vecGet(vS, k.from) >= k.seq);
    const targetKillers = killers.filter((k) => vecGet(vT, k.from) >= k.seq);

    let status: PointStatus;
    let reason: string;

    if (inMerged && !inTarget && inSource) {
      status = 'added';
      reason = `接收端未见的并发新增（源端 ${delta.source} 步 ${delta.sourceStep} 快照存活点），增量补传后加入；无任何已观察撤销覆盖该点`;
    } else if (inMerged && inTarget && !inSource) {
      status = 'kept-concurrent';
      reason =
        sourceKillers.length > 0
          ? `接收端存活点：源端撤销 ${sourceKillers.map((k) => k.id).join('、')} 的上下文不覆盖该并发点（源端未见此新增），observed-remove 保留`
          : `接收端存活点：源端尚未观察该新增，无覆盖它的撤销，并发新增保留`;
    } else if (inMerged) {
      status = 'kept';
      reason = '两端快照均存活，OR-Set 并集合并后保持';
    } else if (inTarget) {
      status = 'removed';
      reason = `接收端原存活点：源端已观察并撤销（${sourceKillers.map((k) => k.id).join('、') || killers.map((k) => k.id).join('、')} 的上下文覆盖该点），合并按 observed-remove 删除，不复活`;
    } else if (inSource && observedByTarget) {
      status = 'suppressed';
      reason = `迟到增量：接收端此前已应用撤销（${targetKillers.map((k) => k.id).join('、') || '墓碑'} 覆盖该点）；该点接收端已观察故不重复传输，重放判重，墓碑仍在，不予复活`;
    } else {
      status = 'suppressed';
      const who = sourceKillers.length > 0 ? `源端 ${sourceKillers.map((k) => k.id).join('、')}` : '';
      reason = `${who ? `${who} 在源端产生后即撤销该点；` : ''}仅作为因果上下文随增量到场，合并结果中被上下文抑制，不计入有效标签`;
    }

    points.push({
      terminal: m.from,
      zone: m.tag.zone,
      dot: m.dot,
      eventId: id,
      observedBySource,
      observedByTarget,
      liveInSource: inSource,
      liveInTarget: inTarget,
      liveInMerged: inMerged,
      status,
      removedBy: killers[0]?.id ?? null,
      reason,
    });
  }

  // 稳定排序：终端顺序 → 区域 → 点标识 → 事件
  points.sort((a, b) => {
    const ti = sc.terminals.indexOf(a.terminal) - sc.terminals.indexOf(b.terminal);
    if (ti !== 0) return ti;
    if (a.zone !== b.zone) return a.zone.localeCompare(b.zone);
    if (a.dot !== b.dot) return a.dot.localeCompare(b.dot);
    return a.eventId.localeCompare(b.eventId);
  });
  return points;
}

function outcomeSignature(o: MergeOutcome): string {
  return JSON.stringify({
    vector: Object.fromEntries(Object.entries(o.mergedVector).sort()),
    zones: o.zones
      .map((z) => [z.zone, z.dots.map((d) => d.dot).sort().join(',')])
      .sort(),
  });
}

/**
 * 补传完整入口：校验场景与两端选择，计算正向（source→target）与反向（target→source）
 * 合并，并复核幂等性（同增量重复应用）与交换性（交换补传方向结果一致）。
 */
export function runSync(raw: unknown, sourceSel: SyncSelection, targetSel: SyncSelection): SyncResponse {
  const replay = runReplay(raw);
  if (!replay.ok) return { ok: false, errors: replay.errors };

  const errors: ValidationError[] = [];
  validateSelection(replay.terminals, replay.steps.length, sourceSel, targetSel, 'source', errors);
  validateSelection(replay.terminals, replay.steps.length, targetSel, sourceSel, 'target', errors);
  if (errors.length > 0) return { ok: false, errors };

  const parsed = parseScenario(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const sc = parsed.scenario;

  const sourceView = selectView(sc.terminals, replay.steps, replay.inboxSizes, sourceSel);
  const targetView = selectView(sc.terminals, replay.steps, replay.inboxSizes, targetSel);
  if (!sourceView || !targetView) {
    return {
      ok: false,
      errors: [{ path: '$', message: '快照选取失败：指定步号在回放结果中不存在' }],
    };
  }

  const forward = buildSync(sc, { ...sourceSel, view: sourceView }, { ...targetSel, view: targetView });
  if (!forward.ok) return forward;
  const reverse = buildSync(sc, { ...targetSel, view: targetView }, { ...sourceSel, view: sourceView });
  if (!reverse.ok) return reverse;

  return {
    ok: true,
    forward,
    reverse,
    idempotent: forward.idempotent && reverse.idempotent,
    commutative: outcomeSignature(forward) === outcomeSignature(reverse),
  };
}
