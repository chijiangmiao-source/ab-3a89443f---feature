/** 内置样例场景：覆盖并发新增/撤销收敛、乱序暂存释放、重复投递幂等 */

export interface DemoSyncSelection {
  terminal: string;
  /** null = 初始空快照；否则取该终端“首次应用此消息”之后的快照 */
  after: string | null;
}

export interface Sample {
  name: string;
  data: unknown;
  /** 补传演示的建议快照选择（源端 → 接收端） */
  demoSync?: {
    source: DemoSyncSelection;
    target: DemoSyncSelection;
  };
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

const syncShowcase = {
  terminals: ['A', 'B', 'C'],
  messages: [
    {
      // D-41：A 新增；B 观察后撤销，而 C 收到撤销较晚——补传时迟到状态不得复活
      id: 'A#1',
      kind: 'add',
      dot: 'D-41',
      tag: { zone: 'Z-NORTH', lat: 40.1, lng: 116.9, radiusKm: 2 },
      ctx: { A: 1 },
    },
    { id: 'B#1', kind: 'remove', zone: 'Z-NORTH', ctx: { B: 1, A: 1 } },
    {
      // D-51：C 新增后随即自撤销——补传 D-43 时只作因果上下文到场，须被抑制
      id: 'C#1',
      kind: 'add',
      dot: 'D-51',
      tag: { zone: 'Z-TEMP', lat: 34.3, lng: 108.9, radiusKm: 1 },
      ctx: { C: 1, A: 1 },
    },
    { id: 'C#2', kind: 'remove', zone: 'Z-TEMP', ctx: { C: 2, A: 1 } },
    {
      // D-43：C 在观察 A#1 后的并发新增，B 未见——补传后须作为并发新增保留
      id: 'C#3',
      kind: 'add',
      dot: 'D-43',
      tag: { zone: 'Z-WEST', lat: 34.3, lng: 108.9, radiusKm: 3 },
      ctx: { C: 3, A: 1 },
    },
    // B#2 早于 B#1 到达 C：因缺发送方前序持续暂存，补传增量须将其排除
    {
      id: 'B#2',
      kind: 'add',
      dot: 'D-53',
      tag: { zone: 'Z-SOUTH', lat: 22.5, lng: 114.0, radiusKm: 4 },
      ctx: { B: 2, A: 1, C: 3 },
    },
  ],
  inbox: {
    A: ['A#1', 'B#1', 'C#1', 'C#2', 'C#3', 'B#2'],
    B: ['B#1', 'A#1', 'C#1', 'C#2', 'C#3', 'B#2'],
    C: ['A#1', 'C#1', 'B#2', 'C#2', 'C#3', 'B#1'],
  },
};

export const SAMPLES: Sample[] = [
  {
    name: '并发新增与撤销（add-wins 收敛）',
    data: concurrentAddRemove,
    demoSync: {
      // C 在 A#1 应用时级联释放 C#1（持有 D-03），补传给已释放 A#2 撤销的 B：
      // D-03 作为未见并发新增加入；D-02 源端未见、保持；原逐步回放不受影响
      source: { terminal: 'C', after: 'A#1' },
      target: { terminal: 'B', after: 'A#1' },
    },
  },
  {
    name: '乱序投递与暂存释放',
    data: outOfOrderRelease,
    demoSync: {
      // A 已应用 A#1、B#2 因缺前序暂存中；B 仅有 B#1：
      // 增量只基于已应用事件补传 A#1，B#2 作为未纳入项标出
      source: { terminal: 'A', after: 'A#1' },
      target: { terminal: 'B', after: 'B#1' },
    },
  },
  { name: '重复投递幂等（四终端）', data: duplicateDelivery },
  {
    name: '补传专题：并发新增/撤销合并·迟到不复活·暂存排除',
    data: syncShowcase,
    demoSync: {
      // C 已收敛但尚未收到 B#1（D-41 仍存活，D-45 已自撤销）→ 补传给 B：
      // D-43 未见并发新增加入；D-41 迟到不复活（B#1 墓碑抑制）；
      // D-45/C#3 仅作因果上下文到场被抑制；B#1 在 C 端暂存，列为未纳入项
      source: { terminal: 'C', after: 'C#3' },
      target: { terminal: 'B', after: 'A#1' },
    },
  },
];
