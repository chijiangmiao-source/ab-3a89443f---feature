/**
 * 单向补传：从两份回放步骤快照构造可交换（commutative）OR-Set 状态增量。
 *
 * 语义（observed-remove / add-wins）：
 * - 增量携带发送端快照的“存活点集”中接收端尚不知道的点，以及
 *   仅针对“接收端当前仍存活点”的撤销事实（墓碑最小化）。
 * - 合并结果 = 两份快照点集之并，减去任一端已观察撤销的点：
 *       merged = (S_live ∪ T_live) \\ (killedBy(S) ∪ killedBy(T))
 * - 迟到增量不得复活：若接收端早已通过某条 remove 观察撤销了该点，
 *   发送端迟到的同名新增点只会被标记为“上下文抑制”，不重新生效。
 * - 整个合并是 {并集, 交集判定} 纯集合运算：重复应用同一增量、交换补传
 *   方向，合并结果均不变（幂等、可交换）。
 * - 发送端暂存队列中的消息尚未应用，一律不纳入增量，只在结果中标出。
 */
import { parseEventId } from './engine';
import { parseScenario } from './parse';
import type {
  AddMessage,
  DeltaAddDot,
  DeltaExcludedPending,
  DeltaTombstone,
  MergeError,
  MergePointEntry,
  MergeResult,
  MergeView,
  Message,
  RemoveMessage,
  Scenario,
  StateDelta,
  TerminalView,
  Vector,
  ZoneView,
} from './types';
import type { ReplayResult } from './types';

export interface SnapshotRef {
  terminal: string;
  /** 全局回放步号：0 = 初始空快照，k = 第 k 步之后的快照 */
  step: number;
}

/** 场景指纹：终端集合、消息集合与收件顺序，用于判定两份快照是否相容 */
export function scenarioFingerprint(sc: Scenario): string {
  const term = sc.terminals.join('~');
  const ids = sc.messages
    .map((m) => m.id)
    .sort()
    .join(',');
  const inboxes = sc.terminals.map((t) => `${t}:${sc.inbox[t].join(',')}`).join('|');
  return `v1:${term}#${ids}#${inboxes}`;
}

function fail(...messages: string[]): MergeResult {
  return { ok: false, errors: messages.map((message) => ({ message })) };
}

/** 某终端在给定版本向量下“已应用”的撤销 → 被其观察清除的点（同区域且 ctx 覆盖） */
function buildKillIndex(
  sc: Scenario,
  vector: Vector,
): Map<string, RemoveMessage[]> {
  const addsByZone = new Map<string, AddMessage[]>();
  for (const m of sc.messages) {
    if (m.kind !== 'add') continue;
    const list = addsByZone.get(m.tag.zone) ?? [];
    list.push(m);
    addsByZone.set(m.tag.zone, list);
  }
  const kills = new Map<string, RemoveMessage[]>();
  for (const m of sc.messages) {
    if (m.kind !== 'remove') continue;
    if ((vector[m.from] ?? 0) < m.seq) continue; // 该 remove 尚未在此快照应用
    for (const a of addsByZone.get(m.zone) ?? []) {
      if ((m.ctx[a.from] ?? 0) >= a.seq) {
        const list = kills.get(a.id) ?? [];
        list.push(m);
        kills.set(a.id, list);
      }
    }
  }
  for (const list of kills.values()) {
    list.sort((x, y) =>
      x.from === y.from ? x.seq - y.seq : x.from.localeCompare(y.from),
    );
  }
  return kills;
}

/** 收集快照视图中的全部存活点：事件 id -> {zone, dot} */
function livePoints(view: TerminalView): Map<string, { zone: string; dot: string }> {
  const out = new Map<string, { zone: string; dot: string }>();
  for (const z of view.zones) {
    for (const d of z.dots) {
      for (const eventId of d.events) out.set(eventId, { zone: z.zone, dot: d.dot });
    }
  }
  return out;
}

function snapshotView(result: Extract<ReplayResult, { ok: true }>, ref: SnapshotRef): TerminalView {
  const total = result.inboxSizes[ref.terminal] ?? 0;
  if (ref.step === 0) {
    const vector: Vector = {};
    for (const t of result.terminals) vector[t] = 0;
    return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal: total };
  }
  return result.steps[ref.step - 1].stateAfter[ref.terminal];
}

function describePending(
  sc: Scenario,
  messageId: string,
  vector: Vector,
): string {
  const m: Message | undefined = sc.messagesById[messageId];
  if (!m) return `暂存消息 ${messageId} 尚未应用，不纳入增量`;
  const missing: string[] = [];
  const vf = vector[m.from] ?? 0;
  if (vf < m.seq - 1) {
    missing.push(`发送方前序 ${m.from}#${vf + 1}..${m.from}#${m.seq - 1} 未齐`);
  }
  for (const u of sc.terminals) {
    if (u === m.from) continue;
    const need = m.ctx[u] ?? 0;
    if ((vector[u] ?? 0) < need) missing.push(`因果依赖 ${u}≥${need} 未满足`);
  }
  return `暂存消息 ${messageId} 尚未应用（${missing.join('；') || '等待级联释放'}），仅基于已应用事件生成增量，此项不纳入`;
}

function mergeVector(a: Vector, b: Vector, terminals: string[]): Vector {
  const out: Vector = {};
  for (const t of terminals) out[t] = Math.max(a[t] ?? 0, b[t] ?? 0);
  return out;
}

function byTerminal(aId: string, bId: string): number {
  const x = parseEventId(aId);
  const y = parseEventId(bId);
  return x.t === y.t ? x.n - y.n : x.t.localeCompare(y.t);
}

/**
 * 从两份快照构造增量并在接收端上求合并结果。
 * 纯函数：同一入参重复调用 / 交换 src、dst，合并标签集合一致。
 */
export function buildMerge(
  rawScenario: unknown,
  replay: ReplayResult | null | undefined,
  source: SnapshotRef,
  target: SnapshotRef,
): MergeResult {
  if (!replay || !replay.ok) {
    return fail('回放结果无效：请先完成一次合法回放，再发起单向补传');
  }
  const termSet = new Set(replay.terminals);
  for (const [label, ref] of [
    ['发送端', source],
    ['接收端', target],
  ] as const) {
    if (!termSet.has(ref.terminal)) return fail(`${label}终端 "${ref.terminal}" 不在当前回放中`);
    if (!Number.isInteger(ref.step) || ref.step < 0 || ref.step > replay.steps.length) {
      return fail(`${label}快照步号非法：${ref.step}（允许 0..${replay.steps.length}）`);
    }
  }
  if (source.terminal === target.terminal) {
    return fail('发送端与接收端须为两台不同终端，不能对同一终端补传');
  }

  const parsed = parseScenario(rawScenario);
  if (!parsed.ok) {
    return fail(
      '快照选择与当前场景不相容：场景已无法通过校验，已清空补传结果（原回放不变）',
      ...parsed.errors.map((e) => `${e.path} ${e.message}`),
    );
  }
  const sc = parsed.scenario;
  if (sc.terminals.join('~') !== replay.terminals.join('~')) {
    return fail('快照选择与当前回放不相容：终端集合不一致，已清空补传结果（原回放不变）');
  }

  const srcView = snapshotView(replay, source);
  const tgtView = snapshotView(replay, target);
  const srcLive = livePoints(srcView);
  const tgtLive = livePoints(tgtView);
  const srcKills = buildKillIndex(sc, srcView.vector);
  const tgtKills = buildKillIndex(sc, tgtView.vector);

  const addsById = new Map<string, AddMessage>();
  for (const m of sc.messages) if (m.kind === 'add') addsById.set(m.id, m);

  // ---- 增量新增点：发送端存活、接收端尚未持有（含会被接收端上下文抑制的迟到点） ----
  const adds: DeltaAddDot[] = [];
  for (const [eventId] of srcLive) {
    if (tgtLive.has(eventId)) continue; // 接收端已持有，重传无益，最小化裁剪
    const a = addsById.get(eventId);
    if (!a) continue;
    adds.push({ zone: a.tag.zone, dot: a.dot, eventId: a.id, tag: a.tag });
  }
  adds.sort((x, y) =>
    x.zone === y.zone
      ? x.dot === y.dot
        ? byTerminal(x.eventId, y.eventId)
        : x.dot.localeCompare(y.dot)
      : x.zone.localeCompare(y.zone),
  );

  // ---- 增量墓碑：发送端已观察撤销、且接收端当前仍存活的点（最小化） ----
  const tombstones: DeltaTombstone[] = [];
  for (const [eventId, removers] of srcKills) {
    if (!tgtLive.has(eventId)) continue; // 接收端本就不持有/已删除，无需携带
    const a = addsById.get(eventId);
    const r = removers[0];
    if (!a || !r) continue;
    tombstones.push({
      zone: a.tag.zone,
      eventId: a.id,
      dot: a.dot,
      observedBy: r.id,
      ctx: { ...r.ctx },
    });
  }
  tombstones.sort((x, y) =>
    x.zone === y.zone
      ? x.dot === y.dot
        ? byTerminal(x.eventId, y.eventId)
        : x.dot.localeCompare(y.dot)
      : x.zone.localeCompare(y.zone),
  );

  // ---- 暂存消息：只能基于已应用事件，未应用项标出且不纳入 ----
  const excludedPending: DeltaExcludedPending[] = srcView.pending.map((messageId) => ({
    messageId,
    reason: describePending(sc, messageId, srcView.vector),
  }));

  const delta: StateDelta = {
    fingerprint: scenarioFingerprint(sc),
    source: source.terminal,
    target: target.terminal,
    sourceStep: source.step,
    targetStep: target.step,
    vector: { ...srcView.vector },
    adds,
    tombstones,
    excludedPending,
  };

  // ---- 求合并：逐点判定新增 / 已持有 / 删除 / 上下文抑制 ----
  const union = new Set<string>([...srcLive.keys(), ...tgtLive.keys()]);
  const points: MergePointEntry[] = [];
  const surviving = new Map<string, AddMessage>();
  const added: string[] = [];
  const removed: string[] = [];
  const suppressed: string[] = [];

  for (const eventId of union) {
    const a = addsById.get(eventId);
    if (!a) continue;
    const inS = srcLive.has(eventId);
    const inT = tgtLive.has(eventId);
    const sk = srcKills.get(eventId)?.[0];
    const tk = tgtKills.get(eventId)?.[0];
    const { t: from, n: seq } = parseEventId(eventId);

    let status: MergePointEntry['status'];
    let reason: string;
    if (inT && sk) {
      // 接收端仍存活，但发送端早已观察撤销：增量墓碑令其删除
      status = 'removed';
      reason =
        `发送端 ${source.terminal} 的撤销 ${sk.id} 已观察该点` +
        `（产生时 ctx[${from}]=${sk.ctx[from] ?? 0} ≥ ${seq}）：接收端合并后删除`;
      removed.push(eventId);
    } else if (inS && tk) {
      // 发送端迟到新增，接收端此前已观察撤销：add-wins 也不允许复活
      status = 'suppressed';
      reason =
        `接收端 ${target.terminal} 已由撤销 ${tk.id} 观察并清除该点` +
        `（ctx[${from}]=${tk.ctx[from] ?? 0} ≥ ${seq}）：迟到增量被上下文抑制，不复活`;
      suppressed.push(eventId);
    } else if (!inT) {
      // 发送端存活、接收端未见、两端均无撤销：未见的并发新增保留
      status = 'new';
      reason =
        `接收端未见的并发新增（发送端 ${source.terminal} 已应用 ${eventId}，` +
        `两端均无覆盖它的撤销）：合并后存活`;
      surviving.set(eventId, a);
      added.push(eventId);
    } else {
      status = 'live';
      reason = inS
        ? '两份快照均持有该点：重复补传不改变结果'
        : '接收端原已持有该点：补传不改变结果';
      surviving.set(eventId, a);
    }

    points.push({ terminal: from, zone: a.tag.zone, dot: a.dot, eventId, status, reason });
  }

  points.sort((x, y) =>
    x.terminal === y.terminal
      ? x.zone === y.zone
        ? x.dot === y.dot
          ? byTerminal(x.eventId, y.eventId)
          : x.dot.localeCompare(y.dot)
        : x.zone.localeCompare(y.zone)
      : x.terminal.localeCompare(y.terminal),
  );
  added.sort(byTerminal);
  removed.sort(byTerminal);
  suppressed.sort(byTerminal);

  // ---- 合并后有效标签：按区域、点标识稳定分组 ----
  const byZone = new Map<string, Map<string, string[]>>();
  for (const eventId of surviving.keys()) {
    const a = surviving.get(eventId)!;
    let zone = byZone.get(a.tag.zone);
    if (!zone) {
      zone = new Map();
      byZone.set(a.tag.zone, zone);
    }
    const dots = zone.get(a.dot) ?? [];
    dots.push(eventId);
    zone.set(a.dot, dots);
  }
  const zones: ZoneView[] = [...byZone.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([zone, dotMap]) => ({
      zone,
      dots: [...dotMap.entries()]
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([dot, events]) => ({ dot, events: [...events].sort(byTerminal) })),
    }));

  const view: MergeView = {
    vector: mergeVector(srcView.vector, tgtView.vector, sc.terminals),
    zones,
    points,
    added,
    removed,
    suppressed,
    excludedPending,
    idempotent: added.length === 0 && removed.length === 0,
  };

  return { ok: true, delta, view };
}

export type DeltaApplyResult =
  | { ok: false; errors: MergeError[] }
  | { ok: true; view: MergeView };

/** 把可交换状态增量幂等地应用到接收端快照视图（不重放对方收件脚本） */
export function applyDelta(
  rawScenario: unknown,
  delta: StateDelta,
  target: { terminal: string; step: number; view: TerminalView },
): DeltaApplyResult {
  const parsed = parseScenario(rawScenario);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [{ message: '增量与当前场景不相容：场景未通过校验，拒绝应用（原回放不变）' }],
    };
  }
  const sc = parsed.scenario;
  if (scenarioFingerprint(sc) !== delta.fingerprint) {
    return {
      ok: false,
      errors: [{ message: '增量指纹与当前场景不一致：拒绝应用（可能来自其他回放）' }],
    };
  }
  if (target.terminal !== delta.target || !sc.terminals.includes(target.terminal)) {
    return { ok: false, errors: [{ message: '增量目标终端与接收端不匹配，拒绝应用' }] };
  }

  const tgtView = target.view;
  const tgtLive = livePoints(tgtView);
  const tgtKills = buildKillIndex(sc, tgtView.vector);
  const addsById = new Map<string, AddMessage>();
  for (const m of sc.messages) if (m.kind === 'add') addsById.set(m.id, m);

  const surviving = new Map<string, AddMessage>();
  for (const eventId of tgtLive.keys()) {
    const a = addsById.get(eventId);
    if (a) surviving.set(eventId, a);
  }
  const added: string[] = [];
  const removed: string[] = [];
  const suppressed: string[] = [];
  const points: MergePointEntry[] = [];

  // 增量新增点：已持有则去重；接收端已观察撤销则抑制（迟到不复活）；否则并入
  for (const d of delta.adds) {
    const a = addsById.get(d.eventId);
    if (!a) continue;
    const { t: from, n: seq } = parseEventId(d.eventId);
    const known =
      (tgtView.vector[from] ?? 0) >= seq || tgtLive.has(d.eventId) || surviving.has(d.eventId);
    const killer = tgtKills.get(d.eventId)?.[0];
    let status: MergePointEntry['status'];
    let reason: string;
    if (killer) {
      // 接收端早已观察撤销：迟到增量绝不复活（优先级最高）
      status = 'suppressed';
      reason =
        `接收端 ${delta.target} 已由撤销 ${killer.id} 观察并清除该点` +
        `（ctx[${from}]=${killer.ctx[from] ?? 0} ≥ ${seq}）：迟到增量被上下文抑制，不复活`;
      suppressed.push(d.eventId);
    } else if (known) {
      status = 'live';
      reason = '接收端已持有该点：重复应用增量不改变结果（幂等）';
      surviving.set(d.eventId, a);
    } else {
      status = 'new';
      reason =
        `接收端未见的并发新增（发送端 ${delta.source} 补传，无覆盖它的撤销）：合并后存活`;
      surviving.set(d.eventId, a);
      added.push(d.eventId);
    }
    points.push({ terminal: from, zone: d.zone, dot: d.dot, eventId: d.eventId, status, reason });
  }

  // 增量墓碑：仅清除接收端当前仍存活、且撤销 ctx 确实覆盖的点；重复应用为空操作
  for (const tb of delta.tombstones) {
    const a = addsById.get(tb.eventId);
    if (!a) continue;
    const { t: from, n: seq } = parseEventId(tb.eventId);
    const covers = (tb.ctx[from] ?? 0) >= seq;
    if (surviving.has(tb.eventId) && covers) {
      surviving.delete(tb.eventId);
      removed.push(tb.eventId);
      points.push({
        terminal: from,
        zone: tb.zone,
        dot: tb.dot,
        eventId: tb.eventId,
        status: 'removed',
        reason:
          `增量墓碑：发送端 ${delta.source} 的撤销 ${tb.observedBy} 已观察该点` +
          `（ctx[${from}]=${tb.ctx[from] ?? 0} ≥ ${seq}）：接收端合并后删除`,
      });
    } else {
      // 重复应用：该点此前已被删除，保持“合并删除”分类不变（幂等空操作）
      points.push({
        terminal: from,
        zone: tb.zone,
        dot: tb.dot,
        eventId: tb.eventId,
        status: 'removed',
        reason:
          '该点此前已被该墓碑删除（或上下文未覆盖）：重复应用增量为空操作，结果不变（幂等）',
      });
    }
  }

  // 接收端原有、增量未提及的存活点：原状保留
  for (const [eventId, a] of surviving) {
    if (points.some((p) => p.eventId === eventId)) continue;
    const { t: from } = parseEventId(eventId);
    points.push({
      terminal: from,
      zone: a.tag.zone,
      dot: a.dot,
      eventId,
      status: 'live',
      reason: '接收端原已持有该点：补传不改变结果',
    });
  }

  points.sort((x, y) =>
    x.terminal === y.terminal
      ? x.zone === y.zone
        ? x.dot === y.dot
          ? byTerminal(x.eventId, y.eventId)
          : x.dot.localeCompare(y.dot)
        : x.zone.localeCompare(y.zone)
      : x.terminal.localeCompare(y.terminal),
  );
  added.sort(byTerminal);
  removed.sort(byTerminal);
  suppressed.sort(byTerminal);

  const byZone = new Map<string, Map<string, string[]>>();
  for (const [eventId, a] of surviving) {
    let zone = byZone.get(a.tag.zone);
    if (!zone) {
      zone = new Map();
      byZone.set(a.tag.zone, zone);
    }
    const dots = zone.get(a.dot) ?? [];
    dots.push(eventId);
    zone.set(a.dot, dots);
  }
  const zones: ZoneView[] = [...byZone.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([zone, dotMap]) => ({
      zone,
      dots: [...dotMap.entries()]
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([dot, events]) => ({ dot, events: [...events].sort(byTerminal) })),
    }));

  return {
    ok: true,
    view: {
      vector: mergeVector(delta.vector, tgtView.vector, sc.terminals),
      zones,
      points,
      added,
      removed,
      suppressed,
      excludedPending: delta.excludedPending,
      idempotent: added.length === 0 && removed.length === 0,
    },
  };
}
