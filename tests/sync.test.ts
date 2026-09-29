import { describe, expect, it } from 'vitest';
import { Replica } from '../src/crdt/engine';
import { parseScenario } from '../src/crdt/parse';
import { runReplay } from '../src/crdt/replay';
import { runSync } from '../src/crdt/sync';
import type { Scenario, Step } from '../src/crdt/types';
import type { SyncSelection } from '../src/crdt/sync';
import { SAMPLES } from '../src/samples';

function stepAfter(steps: Step[], terminal: string, messageId: string | null): number {
  if (!messageId) return 0;
  const s = steps.find(
    (x) =>
      x.terminal === terminal &&
      x.messageId === messageId &&
      (x.action === 'applied' || x.action === 'released'),
  );
  return s ? s.index + 1 : 0;
}

function statusMap(report: Awaited<ReturnType<typeof runSync>>) {
  if (!report.ok) throw new Error('report not ok');
  return new Map(report.forward.points.map((p) => [p.dot, p.status]));
}

function dotsOf(out: { zones: Array<{ zone: string; dots: Array<{ dot: string }> }> }) {
  return out.zones.flatMap((z) => z.dots.map((d) => `${z.zone}/${d.dot}`)).sort();
}

/** 独立参考实现：两端已观察事件的并集直接重放（两遍以消解跨端暂存） */
function referenceUnion(raw: unknown, vS: Record<string, number>, vT: Record<string, number>) {
  const parsed = parseScenario(raw);
  if (!parsed.ok) throw new Error('bad scenario');
  const sc: Scenario = parsed.scenario;
  const r = new Replica('REF', sc.terminals);
  const union: Record<string, number> = {};
  for (const t of sc.terminals) union[t] = Math.max(vS[t] ?? 0, vT[t] ?? 0);
  const deliverable = sc.messages.filter((m) => union[m.from] >= m.seq);
  for (const m of deliverable) r.deliver(m);
  for (const m of deliverable) r.deliver(m); // 第二遍兜底级联释放
  return new Set(
    r
      .view(0, 0)
      .zones.flatMap((z) => z.dots.map((d) => `${z.zone}/${d.dot}`)),
  );
}

describe('单向补传：增量构造与 OR-Set 合并', () => {
  const showcase = SAMPLES[3].data;

  it('补传专题：并发新增加入、迟到不复活、上下文填充抑制、暂存项排除', () => {
    const replay = runReplay(showcase);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    const source: SyncSelection = {
      terminal: 'C',
      step: stepAfter(replay.steps, 'C', 'C#3'),
    };
    const target: SyncSelection = {
      terminal: 'B',
      step: stepAfter(replay.steps, 'B', 'A#1'),
    };
    const report = runSync(showcase, source, target);
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const f = report.forward;
    expect(dotsOf(f)).toEqual(['Z-WEST/D-43']);
    const st = statusMap(report);
    expect(st.get('D-43')).toBe('added'); // 接收端未见的并发新增保留
    expect(st.get('D-41')).toBe('suppressed'); // 迟到状态不复活（接收端已撤销）
    expect(st.get('D-51')).toBe('suppressed'); // 因果填充点被源端撤销抑制

    // 增量角色：C#3 存活点、C#2 撤销墓碑、C#1 因果填充；B#2 绝不能出现
    const roles = new Map(f.delta.events.map((e) => [e.eventId, e.role]));
    expect(roles.get('C#3')).toBe('live-add');
    expect(roles.get('C#2')).toBe('remove-tombstone');
    expect(roles.get('C#1')).toBe('causal-filler');
    expect(roles.has('B#2')).toBe(false);

    // 暂存消息只标为未纳入项
    const excluded = f.delta.excludedPending.find((n) => n.terminal === 'C');
    expect(excluded?.messageIds).toContain('B#2');

    expect(report.idempotent).toBe(true);
    expect(report.commutative).toBe(true);
  });

  it('幂等：同增量重复应用与单次结果完全一致（内部自检 + 外部复核）', () => {
    const replay = runReplay(showcase);
    if (!replay.ok) throw new Error('replay failed');
    const report = runSync(
      showcase,
      { terminal: 'C', step: stepAfter(replay.steps, 'C', 'C#3') },
      { terminal: 'B', step: stepAfter(replay.steps, 'B', 'A#1') },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.forward.idempotent).toBe(true);
    // 外部独立复核：再算一遍结果必须字节级一致
    const again = runSync(
      showcase,
      { terminal: 'C', step: stepAfter(replay.steps, 'C', 'C#3') },
      { terminal: 'B', step: stepAfter(replay.steps, 'B', 'A#1') },
    );
    if (!again.ok) throw new Error('re-run failed');
    expect(JSON.stringify(again.forward.zones)).toBe(JSON.stringify(report.forward.zones));
    expect(JSON.stringify(again.forward.mergedVector)).toBe(
      JSON.stringify(report.forward.mergedVector),
    );
  });

  it('可交换：交换补传方向后合并向量与标签一致', () => {
    const replay = runReplay(showcase);
    if (!replay.ok) throw new Error('replay failed');
    const s: SyncSelection = { terminal: 'C', step: stepAfter(replay.steps, 'C', 'C#3') };
    const t: SyncSelection = { terminal: 'B', step: stepAfter(replay.steps, 'B', 'A#1') };
    const ab = runSync(showcase, s, t);
    const ba = runSync(showcase, t, s);
    expect(ab.ok && ba.ok).toBe(true);
    if (!ab.ok || !ba.ok) return;
    expect(ab.forward.mergedVector).toEqual(ba.forward.mergedVector);
    expect(dotsOf(ab.forward)).toEqual(dotsOf(ba.forward));
    expect(ab.commutative).toBe(true);
  });

  it('任意两端任意步快照：合并结果等于两份快照的 OR-Set 并集', () => {
    for (const sample of SAMPLES) {
      const replay = runReplay(sample.data);
      if (!replay.ok) continue;
      for (const a of replay.terminals) {
        for (const b of replay.terminals) {
          if (a === b) continue;
          for (let sa = 0; sa <= replay.steps.length; sa += 1) {
            for (let sb = 0; sb <= replay.steps.length; sb += 1) {
              const r = runSync(sample.data, { terminal: a, step: sa }, { terminal: b, step: sb });
              if (!r.ok) throw new Error(`sync failed ${a}@${sa} -> ${b}@${sb}`);
              const ref = referenceUnion(
                sample.data,
                r.forward.delta.sourceVector,
                r.forward.delta.targetVector,
              );
              expect(dotsOf(r.forward), `${a}@${sa} -> ${b}@${sb}`).toEqual([...ref].sort());
              // 合并向量 = 两端向量按位最大值
              for (const t of replay.terminals) {
                expect(r.forward.mergedVector[t]).toBe(
                  Math.max(r.forward.delta.sourceVector[t] ?? 0, r.forward.delta.targetVector[t] ?? 0),
                );
              }
              expect(r.idempotent).toBe(true);
              expect(r.commutative).toBe(true);
            }
          }
        }
      }
    }
  });

  it('源端撤销的点在接收端被删除（removed），不依赖重放对方收件脚本', () => {
    const raw = {
      terminals: ['A', 'B'],
      messages: [
        {
          id: 'A#1',
          kind: 'add',
          dot: 'D-X',
          tag: { zone: 'Z1', lat: 0, lng: 0, radiusKm: 1 },
          ctx: { A: 1 },
        },
        {
          id: 'B#1',
          kind: 'add',
          dot: 'D-Y',
          tag: { zone: 'Z1', lat: 0, lng: 0, radiusKm: 1 },
          ctx: { B: 1 },
        },
        { id: 'A#2', kind: 'remove', zone: 'Z1', ctx: { A: 2, B: 1 } },
      ],
      inbox: {
        A: ['A#1', 'B#1', 'A#2'],
        B: ['B#1', 'A#1', 'A#2'],
      },
    };
    const replay = runReplay(raw);
    if (!replay.ok) throw new Error('replay failed');
    // 源端 A 末态（两个点均已撤销）→ 接收端 B 在 A#1 之后（D-X、D-Y 都存活）
    const report = runSync(
      raw,
      { terminal: 'A', step: replay.steps.length },
      { terminal: 'B', step: stepAfter(replay.steps, 'B', 'A#1') },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const st = statusMap(report);
    expect(st.get('D-X')).toBe('removed');
    expect(st.get('D-Y')).toBe('removed');
    expect(dotsOf(report.forward)).toEqual([]);
  });

  it('非法或不相容的快照选择被拒绝', () => {
    const replay = runReplay(showcase);
    if (!replay.ok) throw new Error('replay failed');
    // 同一终端
    const same = runSync(showcase, { terminal: 'A', step: 1 }, { terminal: 'A', step: 2 });
    expect(same.ok).toBe(false);
    // 未知终端
    const unknown = runSync(showcase, { terminal: 'Z', step: 1 }, { terminal: 'A', step: 1 });
    expect(unknown.ok).toBe(false);
    // 步号越界
    const badStep = runSync(
      showcase,
      { terminal: 'A', step: 999 },
      { terminal: 'B', step: 1 },
    );
    expect(badStep.ok).toBe(false);
  });

  it('源端已撤销且接收端从未见过的点不进入增量（最小化），更不会复活', () => {
    // A 自撤销 D-Z；B 停留在初始空状态。A 末态补传给 B：
    // 两端点集均无 D-Z，没有任何理由传输它或其撤销——增量为空，Z 区保持空
    const raw = {
      terminals: ['A', 'B'],
      messages: [
        {
          id: 'A#1',
          kind: 'add',
          dot: 'D-Z',
          tag: { zone: 'Z-GONE', lat: 0, lng: 0, radiusKm: 1 },
          ctx: { A: 1 },
        },
        { id: 'A#2', kind: 'remove', zone: 'Z-GONE', ctx: { A: 2 } },
      ],
      inbox: {
        A: ['A#1', 'A#2'],
        B: ['A#1', 'A#2'],
      },
    };
    const replay = runReplay(raw);
    if (!replay.ok) throw new Error('replay failed');
    const report = runSync(
      raw,
      { terminal: 'A', step: replay.steps.length },
      { terminal: 'B', step: 0 },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(dotsOf(report.forward)).toEqual([]);
    expect(report.forward.delta.events.map((e) => e.eventId)).toEqual([]);
  });

  it('源端存活、接收端已撤销的点经迟到增量到达时被墓碑抑制（不复活）', () => {
    // A 新增 D-R；B 观察后撤销；A 的收件顺序使 A 在补传时仍持有 D-R
    const raw = {
      terminals: ['A', 'B'],
      messages: [
        {
          id: 'A#1',
          kind: 'add',
          dot: 'D-R',
          tag: { zone: 'Z-RIP', lat: 0, lng: 0, radiusKm: 1 },
          ctx: { A: 1 },
        },
        { id: 'B#1', kind: 'remove', zone: 'Z-RIP', ctx: { B: 1, A: 1 } },
      ],
      inbox: {
        A: ['A#1', 'B#1'], // 源端选 B#1 到达之前的快照（D-R 仍存活）
        B: ['A#1', 'B#1'],
      },
    };
    const replay = runReplay(raw);
    if (!replay.ok) throw new Error('replay failed');
    const report = runSync(
      raw,
      { terminal: 'A', step: stepAfter(replay.steps, 'A', 'A#1') },
      { terminal: 'B', step: replay.steps.length },
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(dotsOf(report.forward)).toEqual([]);
    const st = statusMap(report);
    expect(st.get('D-R')).toBe('suppressed');
  });
});
