import { describe, expect, it } from 'vitest';
import { applyDelta, buildMerge, type SnapshotRef } from '../src/crdt/delta';
import { Replica } from '../src/crdt/engine';
import { parseScenario } from '../src/crdt/parse';
import { runReplay } from '../src/crdt/replay';
import type { ReplayResult, TerminalView } from '../src/crdt/types';
import { SAMPLES } from '../src/samples';

type OkReplay = Extract<ReplayResult, { ok: true }>;

function replayOf(index: number): OkReplay {
  const r = runReplay(SAMPLES[index].data);
  if (!r.ok) throw new Error('样例回放失败');
  return r;
}

/** 终端本地步号 → 全局回放步号 */
function g(r: OkReplay, terminal: string, localStep: number): number {
  if (localStep === 0) return 0;
  const local = r.steps.filter((s) => s.terminal === terminal);
  return local[localStep - 1].index + 1;
}

function ref(r: OkReplay, terminal: string, localStep: number): SnapshotRef {
  return { terminal, step: g(r, terminal, localStep) };
}

function zoneDots(v: TerminalView): Record<string, string[]> {
  return Object.fromEntries(v.zones.map((z) => [z.zone, z.dots.map((d) => d.dot).sort()]));
}

/**
 * 独立复核：把两份版本向量覆盖到的全部事件，按因果可应用顺序投递给一个全新副本，
 * 得到的状态即两份快照的 OR-Set 合并结果（不依赖被测 delta 代码）。
 */
function independentMerge(
  raw: unknown,
  v1: Record<string, number>,
  v2: Record<string, number>,
): { zones: Record<string, string[]>; vector: Record<string, number> } {
  const parsed = parseScenario(raw);
  if (!parsed.ok) throw new Error('场景非法');
  const sc = parsed.scenario;
  const r = new Replica('X', sc.terminals);
  const cap: Record<string, number> = {};
  for (const t of sc.terminals) cap[t] = Math.max(v1[t] ?? 0, v2[t] ?? 0);
  const pool = sc.messages.filter((m) => m.seq <= cap[m.from]);
  for (let pass = 0; pass < 20; pass += 1) {
    for (const m of pool) {
      if ((r.vector[m.from] ?? 0) >= m.seq) continue;
      if (r.pendingList.some((p) => p.id === m.id)) continue;
      r.deliver(m);
    }
    if (sc.terminals.every((t) => (r.vector[t] ?? 0) === cap[t])) break;
  }
  return { zones: zoneDots(r.view(0, 0)), vector: { ...r.vector } };
}

describe('可交换状态增量：构造与合并', () => {
  it('未见的并发新增必须保留（B 本地步1 → A 本地步1）', () => {
    const r = replayOf(3);
    const m = buildMerge(SAMPLES[3].data, r, ref(r, 'B', 1), ref(r, 'A', 1));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.view.zones).toHaveLength(1);
    expect(m.view.zones[0].dots.map((d) => d.dot).sort()).toEqual(['D-A1', 'D-B1']);
    expect(m.view.added).toEqual(['B#1']); // 接收端 A 未见的并发新增
    expect(m.view.removed).toEqual([]);
    expect(m.view.suppressed).toEqual([]);
    // 增量只携带对方未见的点
    expect(m.delta.adds.map((a) => a.eventId)).toEqual(['B#1']);
    expect(m.delta.tombstones).toEqual([]);
  });

  it('任一端已观察并撤销的点不得因迟到增量复活', () => {
    const r = replayOf(3);
    // A 本地步2 仍持有 D-B1；B 本地步3 早已通过 B#2 撤销了 D-B1
    const m = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 2), ref(r, 'B', 3));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.view.suppressed).toEqual(['B#1']);
    expect(zoneDots({ zones: m.view.zones } as TerminalView)).toEqual({
      'Z-1': ['D-A1'],
    });
    const p = m.view.points.find((x) => x.eventId === 'B#1')!;
    expect(p.status).toBe('suppressed');
    expect(p.reason).toContain('B#2');
    // 增量确实携带了该迟到新增，但接收端将其抑制
    expect(m.delta.adds.some((a) => a.eventId === 'B#1')).toBe(true);
  });

  it('增量墓碑让接收端合并删除已观察撤销的点', () => {
    const r = replayOf(3);
    // A 末态（已应用 A#2）为空；B 本地步3 仍持有 D-A1
    const m = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 4), ref(r, 'B', 3));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.view.zones).toEqual([]);
    expect(m.view.removed).toEqual(['A#1']);
    // 墓碑最小化：只携带接收端仍存活的 A#1，不携带 B 已删除的 B#1
    expect(m.delta.tombstones.map((t) => t.eventId)).toEqual(['A#1']);
    expect(m.delta.tombstones[0].observedBy).toBe('A#2');
  });

  it('重复应用同一增量：结果与幂等标志稳定', () => {
    const r = replayOf(3);
    const a = buildMerge(SAMPLES[3].data, r, ref(r, 'B', 1), ref(r, 'A', 1));
    const b = buildMerge(SAMPLES[3].data, r, ref(r, 'B', 1), ref(r, 'A', 1));
    expect(a).toEqual(b);
    if (!a.ok || !b.ok) return;
    // 第二次“应用”到已合并状态：无新增、无删除 → 幂等
    const again = buildMerge(
      SAMPLES[3].data,
      r,
      ref(r, 'B', 1),
      // 用 A 末态（已含 B#1）作为接收端
      { terminal: 'A', step: r.steps.length },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.view.added).toEqual([]);
    expect(again.view.removed).toEqual([]);
    expect(again.view.idempotent).toBe(true);
  });

  it('交换补传方向：合并标签集合与版本向量不变', () => {
    const r = replayOf(3);
    const pairs: Array<[string, number, string, number]> = [
      ['A', 2, 'B', 3],
      ['B', 1, 'A', 1],
      ['A', 4, 'B', 3],
      ['A', 1, 'B', 4],
    ];
    for (const [s, sl, t, tl] of pairs) {
      const ab = buildMerge(SAMPLES[3].data, r, ref(r, s, sl), ref(r, t, tl));
      const ba = buildMerge(SAMPLES[3].data, r, ref(r, t, tl), ref(r, s, sl));
      expect(ab.ok && ba.ok).toBe(true);
      if (!ab.ok || !ba.ok) continue;
      expect(zoneDots({ zones: ab.view.zones } as TerminalView)).toEqual(
        zoneDots({ zones: ba.view.zones } as TerminalView),
      );
      expect(ab.view.vector).toEqual(ba.view.vector);
    }
  });

  it('快照含暂存消息时只基于已应用事件，并标出未纳入项', () => {
    const r = replayOf(1); // 乱序样例
    // A 本地步2：已应用 A#1，B#2 在暂存队列；B 本地步2：已应用 B#1，B#2 仍暂存
    const m = buildMerge(SAMPLES[1].data, r, ref(r, 'A', 2), ref(r, 'B', 2));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.delta.excludedPending.map((p) => p.messageId)).toEqual(['B#2']);
    expect(m.delta.excludedPending[0].reason).toContain('不纳入');
    // 暂存的撤销未纳入：Z-NORTH 不得被删除
    expect(zoneDots({ zones: m.view.zones } as TerminalView)).toEqual({
      'Z-NORTH': ['D-11'],
      'Z-SOUTH': ['D-12'],
    });
    expect(m.delta.tombstones).toEqual([]);
  });

  it('合并版本向量 = 两快照向量逐分量取最大', () => {
    const r = replayOf(3);
    const m = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 2), ref(r, 'B', 3));
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const va = r.steps[g(r, 'A', 2) - 1].stateAfter.A.vector;
    const vb = r.steps[g(r, 'B', 3) - 1].stateAfter.B.vector;
    expect(m.view.vector).toEqual({ A: Math.max(va.A, vb.A), B: Math.max(va.B, vb.B) });
  });

  it('非法或不相容快照选择被拒绝（且不产生增量）', () => {
    const r = replayOf(3);
    const same = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 1), ref(r, 'A', 2));
    expect(same.ok).toBe(false);

    const badStep = buildMerge(
      SAMPLES[3].data,
      r,
      { terminal: 'A', step: 999 },
      ref(r, 'B', 1),
    );
    expect(badStep.ok).toBe(false);

    const unknown = buildMerge(
      SAMPLES[3].data,
      r,
      { terminal: 'Z', step: 0 },
      ref(r, 'B', 1),
    );
    expect(unknown.ok).toBe(false);

    // 终端集合不相容：用三终端样例的场景配两终端回放
    const other = buildMerge(SAMPLES[0].data, r, ref(r, 'A', 1), ref(r, 'B', 1));
    expect(other.ok).toBe(false);
  });
});

describe('可交换状态增量：applyDelta 幂等与方向汇流', () => {
  function viewAt(r: OkReplay, terminal: string, localStep: number): TerminalView {
    const globalStep = g(r, terminal, localStep);
    const total = r.inboxSizes[terminal];
    if (globalStep === 0) {
      const vector: Record<string, number> = {};
      for (const t of r.terminals) vector[t] = 0;
      return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal: total };
    }
    return r.steps[globalStep - 1].stateAfter[terminal];
  }

  function asView(zones: TerminalView['zones'], vector: Record<string, number>): TerminalView {
    return { vector, zones, pending: [], inboxDone: 0, inboxTotal: 0 };
  }

  it('同一增量重复应用：迟到点持续被抑制，结果与幂等标志稳定', () => {
    const r = replayOf(3);
    const built = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 2), ref(r, 'B', 3));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const t0 = viewAt(r, 'B', 3);
    const once = applyDelta(SAMPLES[3].data, built.delta, {
      terminal: 'B',
      step: g(r, 'B', 3),
      view: t0,
    });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(zoneDots({ zones: once.view.zones } as TerminalView)).toEqual({ 'Z-1': ['D-A1'] });
    expect(once.view.suppressed).toEqual(['B#1']);

    // 用合并结果作为新接收端状态，再次应用同一增量
    const twice = applyDelta(SAMPLES[3].data, built.delta, {
      terminal: 'B',
      step: g(r, 'B', 3),
      view: asView(once.view.zones, once.view.vector),
    });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(zoneDots({ zones: twice.view.zones } as TerminalView)).toEqual({ 'Z-1': ['D-A1'] });
    expect(twice.view.added).toEqual([]);
    expect(twice.view.removed).toEqual([]);
    expect(twice.view.suppressed).toEqual(['B#1']);
    expect(twice.view.idempotent).toBe(true);
  });

  it('墓碑增量重复应用：不复活，结果稳定为空', () => {
    const r = replayOf(3);
    const built = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 4), ref(r, 'B', 3));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const once = applyDelta(SAMPLES[3].data, built.delta, {
      terminal: 'B',
      step: g(r, 'B', 3),
      view: viewAt(r, 'B', 3),
    });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.view.removed).toEqual(['A#1']);
    expect(once.view.zones).toEqual([]);

    const twice = applyDelta(SAMPLES[3].data, built.delta, {
      terminal: 'B',
      step: g(r, 'B', 3),
      view: asView(once.view.zones, once.view.vector),
    });
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.view.zones).toEqual([]);
    expect(twice.view.idempotent).toBe(true);
  });

  it('交换补传方向：两个不同增量各自应用后殊途同归', () => {
    const r = replayOf(3);
    const ab = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 2), ref(r, 'B', 3));
    const ba = buildMerge(SAMPLES[3].data, r, ref(r, 'B', 3), ref(r, 'A', 2));
    expect(ab.ok && ba.ok).toBe(true);
    if (!ab.ok || !ba.ok) return;

    // 正向：把 A@2 的增量应用到 B@3（迟到 B#1 被抑制）
    const toB = applyDelta(SAMPLES[3].data, ab.delta, {
      terminal: 'B',
      step: g(r, 'B', 3),
      view: viewAt(r, 'B', 3),
    });
    // 反向：把 B@3 的增量应用到 A@2（墓碑删除 B#1）
    const toA = applyDelta(SAMPLES[3].data, ba.delta, {
      terminal: 'A',
      step: g(r, 'A', 2),
      view: viewAt(r, 'A', 2),
    });
    expect(toB.ok && toA.ok).toBe(true);
    if (!toB.ok || !toA.ok) return;
    expect(zoneDots({ zones: toB.view.zones } as TerminalView)).toEqual({ 'Z-1': ['D-A1'] });
    expect(zoneDots({ zones: toA.view.zones } as TerminalView)).toEqual({ 'Z-1': ['D-A1'] });
    expect(toB.view.vector).toEqual(toA.view.vector);
  });

  it('指纹/目标终端不匹配时拒绝应用，且不修改原状态', () => {
    const r = replayOf(3);
    const built = buildMerge(SAMPLES[3].data, r, ref(r, 'A', 4), ref(r, 'B', 3));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const badScene = applyDelta(SAMPLES[0].data, built.delta, {
      terminal: 'B',
      step: 1,
      view: viewAt(r, 'B', 3),
    });
    expect(badScene.ok).toBe(false);

    const badTarget = applyDelta(SAMPLES[3].data, built.delta, {
      terminal: 'A',
      step: 1,
      view: viewAt(r, 'A', 2),
    });
    expect(badTarget.ok).toBe(false);
  });
});

describe('可交换状态增量：全样例逐快照性质', () => {
  SAMPLES.forEach((sample, si) => {
    it(`样例${si}：任意两终端任意步快照合并 = 独立副本重放，且方向无关`, () => {
      const r = runReplay(sample.data);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const locals = (t: string) =>
        [0, ...r.steps.filter((s) => s.terminal === t).map((_, i) => i + 1)];
      for (const s of r.terminals) {
        for (const t of r.terminals) {
          if (s === t) continue;
          for (const sl of locals(s)) {
            for (const tl of locals(t)) {
              const m = buildMerge(
                sample.data,
                r,
                { terminal: s, step: g(r, s, sl) },
                { terminal: t, step: g(r, t, tl) },
              );
              expect(m.ok, `${s}@${sl} -> ${t}@${tl} 应合法`).toBe(true);
              if (!m.ok) continue;
              const vs =
                sl === 0
                  ? Object.fromEntries(r.terminals.map((x) => [x, 0]))
                  : r.steps[g(r, s, sl) - 1].stateAfter[s].vector;
              const vt =
                tl === 0
                  ? Object.fromEntries(r.terminals.map((x) => [x, 0]))
                  : r.steps[g(r, t, tl) - 1].stateAfter[t].vector;
              const expected = independentMerge(sample.data, vs, vt);
              expect(zoneDots({ zones: m.view.zones } as TerminalView)).toEqual(expected.zones);
              expect(m.view.vector).toEqual(expected.vector);

              // 构造出的增量必须可被 applyDelta 直接应用，且结果与直接合并逐项一致
              const tgtView =
                tl === 0
                  ? {
                      vector: Object.fromEntries(r.terminals.map((x) => [x, 0])),
                      zones: [],
                      pending: [],
                      inboxDone: 0,
                      inboxTotal: 0,
                    }
                  : r.steps[g(r, t, tl) - 1].stateAfter[t];
              const applied = applyDelta(sample.data, m.delta, {
                terminal: t,
                step: g(r, t, tl),
                view: tgtView,
              });
              expect(applied.ok, `applyDelta 应成功：${s}@${sl} -> ${t}@${tl}`).toBe(true);
              if (applied.ok) {
                expect(zoneDots({ zones: applied.view.zones } as TerminalView)).toEqual(
                  expected.zones,
                );
                expect(applied.view.vector).toEqual(expected.vector);
                expect(applied.view.added.sort()).toEqual(m.view.added.sort());
                expect(applied.view.removed.sort()).toEqual(m.view.removed.sort());
                expect(applied.view.suppressed.sort()).toEqual(m.view.suppressed.sort());
                expect(applied.view.idempotent).toBe(m.view.idempotent);
                expect(applied.view.excludedPending).toEqual(m.view.excludedPending);
              }

              // 交换方向：标签集合一致
              const rev = buildMerge(
                sample.data,
                r,
                { terminal: t, step: g(r, t, tl) },
                { terminal: s, step: g(r, s, sl) },
              );
              expect(rev.ok).toBe(true);
              if (!rev.ok) continue;
              expect(zoneDots({ zones: rev.view.zones } as TerminalView)).toEqual(expected.zones);
            }
          }
        }
      }
    });
  });
});
