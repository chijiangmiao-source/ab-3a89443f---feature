/** 内置样例场景：覆盖并发新增/撤销收敛、乱序暂存释放、重复投递幂等 */

export interface Sample {
  name: string;
  data: unknown;
}

/** 单向补传快照预设（步号为该终端自身的本地步号，0=初始空快照） */
export interface BackfillPreset {
  name: string;
  src: { terminal: string; localStep: number };
  dst: { terminal: string; localStep: number };
}

const concurrentAddRemove = {
  terminals: ['A', 'B', 'C'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-01',
      tag: { zone: 'Z-ALPHA', lat: 39.904, lng: 116.407, radiusKm: 3 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-02',
      tag: { zone: 'Z-ALPHA', lat: 39.905, lng: 116.408, radiusKm: 3 },
      ctx: { B: 1 },
    },
    { id: 'A#2', kind: 'remove', zone: 'Z-ALPHA', ctx: { A: 2 } },
    {
      id: 'C#1',
      kind: 'add',
      dot: 'D-03',
      tag: { zone: 'Z-BETA', lat: 31.23, lng: 121.47, radiusKm: 5 },
      ctx: { C: 1, A: 1 },
    },
  ],
  inbox: {
    A: ['A#1', 'A#2', 'B#1', 'C#1'],
    B: ['B#1', 'A#2', 'A#1', 'C#1'],
    C: ['C#1', 'A#1', 'B#1', 'A#2'],
  },
};

const outOfOrderRelease = {
  terminals: ['A', 'B'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-11',
      tag: { zone: 'Z-NORTH', lat: 40.1, lng: 116.9, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-12',
      tag: { zone: 'Z-SOUTH', lat: 22.5, lng: 114.0, radiusKm: 4 },
      ctx: { B: 1 },
    },
    { id: 'B#2', kind: 'remove', zone: 'Z-NORTH', ctx: { B: 2, A: 1 } },
  ],
  inbox: {
    A: ['A#1', 'B#2', 'B#1'],
    B: ['B#2', 'B#1', 'A#1'],
  },
};

const duplicateDelivery = {
  terminals: ['A', 'B', 'C', 'D'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-21',
      tag: { zone: 'Z-1', lat: 30.6, lng: 104.0, radiusKm: 2 },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-22',
      tag: { zone: 'Z-1', lat: 30.7, lng: 104.1, radiusKm: 2 },
      ctx: { B: 1 },
    },
    { id: 'C#1', kind: 'remove', zone: 'Z-1', ctx: { C: 1, A: 1 } },
    {
      id: 'D#1',
      kind: 'add',
      dot: 'D-23',
      tag: { zone: 'Z-2', lat: 23.1, lng: 113.3, radiusKm: 6 },
      ctx: { D: 1, B: 1 },
    },
  ],
  inbox: {
    A: ['A#1', 'A#1', 'B#1', 'C#1', 'D#1', 'C#1'],
    B: ['B#1', 'A#1', 'C#1', 'D#1', 'D#1'],
    C: ['C#1', 'A#1', 'B#1', 'D#1'],
    D: ['D#1', 'B#1', 'A#1', 'C#1', 'A#1'],
  },
};

/**
 * 补传演示场景（A / B 两台终端）：
 * - A#1：A 先在 Z-1 新增 D-A1；
 * - B#1：B 在 Z-1 并发新增 D-B1（未见过 A#1）；
 * - A#2：A 观察到 B#1 后撤销 Z-1（ctx 同时覆盖两点，Z-1 应整体消失）；
 * - B#2：B 仅凭本地观察撤销 Z-1，只覆盖 D-B1（D-A1 迟到后也不得复活）。
 *
 * 收件顺序刻意制造分歧快照：
 * - A 依次收到 A#1、B#1、B#2、A#2；
 * - B 依次收到 B#1、B#2、A#1、A#2。
 */
const backfillDemo = {
  terminals: ['A', 'B'],
  messages: [
    {
      id: 'A#1',
      kind: 'add',
      dot: 'D-A1',
      tag: { zone: 'Z-1', lat: 39.904, lng: 116.407, radiusKm: 3, note: 'A 端率先划设' },
      ctx: { A: 1 },
    },
    {
      id: 'B#1',
      kind: 'add',
      dot: 'D-B1',
      tag: { zone: 'Z-1', lat: 39.91, lng: 116.42, radiusKm: 2, note: 'B 端并发划设' },
      ctx: { B: 1 },
    },
    { id: 'B#2', kind: 'remove', zone: 'Z-1', ctx: { B: 2 } },
    { id: 'A#2', kind: 'remove', zone: 'Z-1', ctx: { A: 2, B: 1 } },
  ],
  inbox: {
    A: ['A#1', 'B#1', 'B#2', 'A#2'],
    B: ['B#1', 'B#2', 'A#1', 'A#2'],
  },
};

export const SAMPLES: Sample[] = [
  { name: '并发新增与撤销（add-wins 收敛）', data: concurrentAddRemove },
  { name: '乱序投递与暂存释放', data: outOfOrderRelease },
  { name: '重复投递幂等（四终端）', data: duplicateDelivery },
  { name: '单向补传：并发新增·撤销合并·迟到不复活', data: backfillDemo },
];

/** 各样例的补传预设；未列出的样例不提供一键演示 */
export const BACKFILL_PRESETS: Record<number, BackfillPreset[]> = {
  1: [
    {
      name: '暂存消息不纳入增量（A 本地步2 → B 本地步2）',
      src: { terminal: 'A', localStep: 2 },
      dst: { terminal: 'B', localStep: 2 },
    },
  ],
  3: [
    {
      name: '并发新增合并（B 本地步1 → A 本地步1）',
      src: { terminal: 'B', localStep: 1 },
      dst: { terminal: 'A', localStep: 1 },
    },
    {
      name: '迟到增量不复活（A 本地步2 → B 本地步3）',
      src: { terminal: 'A', localStep: 2 },
      dst: { terminal: 'B', localStep: 3 },
    },
    {
      name: '增量墓碑合并删除（A 末态 → B 本地步3）',
      src: { terminal: 'A', localStep: 4 },
      dst: { terminal: 'B', localStep: 3 },
    },
  ],
};
