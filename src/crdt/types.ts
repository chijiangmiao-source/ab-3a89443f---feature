/**
 * 核心类型：点集（dot set）+ 因果上下文（版本向量）的 observed-remove 归并。
 *
 * - 每条消息是一个因果事件，事件标识为 `终端#序号`（如 `A#2`）。
 * - 新增（add）携带全局唯一点标识 dot 与标签载荷 tag；事件 id 即 OR-Set 中的“点”。
 * - 撤销（remove）按区域 zone 清除其产生时已观察到的点（由 ctx 版本向量界定）。
 * - 版本向量 ctx[T] = 产生消息时已应用的来自 T 的事件数（含本条自身）。
 */

export type Vector = Record<string, number>;

/** 禁飞标签载荷（集合元素的业务内容，元素身份 = zone） */
export interface TagPayload {
  zone: string;
  lat: number;
  lng: number;
  radiusKm: number;
  note?: string;
}

export interface AddMessage {
  kind: 'add';
  id: string; // 事件标识 "T#n"
  from: string; // 产生终端 T
  seq: number; // 该终端链上的序号 n（从 1 开始连续）
  dot: string; // 全局唯一点标识（业务侧）
  tag: TagPayload;
  ctx: Vector; // 产生时已见上下文（含自身），已归一化为全终端键
}

export interface RemoveMessage {
  kind: 'remove';
  id: string;
  from: string;
  seq: number;
  zone: string; // 撤销目标区域：清除 ctx 覆盖到的该区域全部观测点
  ctx: Vector;
}

export type Message = AddMessage | RemoveMessage;

export interface Scenario {
  terminals: string[];
  messages: Message[];
  messagesById: Record<string, Message>;
  inbox: Record<string, string[]>; // 每台终端的收件顺序（允许重复投递）
}

export interface ValidationError {
  path: string; // 出错位置（JSON 路径）
  message: string;
}

export interface ZoneDotView {
  dot: string; // 业务点标识
  events: string[]; // 支撑该点的存活事件 id
}

export interface ZoneView {
  zone: string;
  dots: ZoneDotView[];
}

/** 某台终端在某一时刻的可视状态 */
export interface TerminalView {
  vector: Vector;
  zones: ZoneView[]; // 有效标签（observed-remove 归并结果）
  pending: string[]; // 暂存队列（缺因果前序的消息）
  inboxDone: number;
  inboxTotal: number;
}

export type StepAction = 'applied' | 'duplicate' | 'buffered' | 'released';

export interface Step {
  index: number;
  round: number;
  terminal: string;
  messageId: string;
  kind: 'add' | 'remove';
  action: StepAction;
  reason: string; // 因果依据
  effect: string; // 状态影响
  stateAfter: Record<string, TerminalView>; // 全终端快照
}

/* ========================================================================== */
/* 单向补传：从两份步骤快照构造的可交换 OR-Set 状态增量                          */
/* ========================================================================== */

/** 增量中的一个新增点（仅在发送端已应用、且承载其的全部撤销都已在发送端观察到时纳入） */
export interface DeltaAddDot {
  zone: string;
  dot: string;
  eventId: string;
  tag: TagPayload;
}

/**
 * 增量中的撤销依据：某区域一条“已观察到的点已被某条 remove 观察”的事实。
 * 仅携带最终状态必需的点（对方存活的点），但每条依据保留其观测边界 ctx，
 * 使接收端能够逐点核对“该撤销产生时是否已观察到此点”。
 */
export interface DeltaTombstone {
  zone: string;
  eventId: string; // 被清除点的 add 事件 id
  dot: string;
  observedBy: string; // 观察到该点的 remove 事件 id
  ctx: Vector; // 该 remove 产生时的已见上下文
}

/** 发送端快照中尚未应用、因而不得纳入增量的暂存消息 */
export interface DeltaExcludedPending {
  messageId: string;
  reason: string;
}

/**
 * 可交换状态增量（commutative delta）：
 * 与增量、与应用次序均无关地把接收端推进到两份快照的 OR-Set 合并结果。
 */
export interface StateDelta {
  /** 源场景终端集合指纹，跨场景选择不相容时拒绝 */
  fingerprint: string;
  source: string; // 发送端终端
  target: string; // 接收端终端
  sourceStep: number; // 发送端快照步号
  targetStep: number; // 接收端快照步号
  vector: Vector; // 发送端已应用版本向量（OR 合并进接收端，仅元数据）
  adds: DeltaAddDot[];
  tombstones: DeltaTombstone[];
  excludedPending: DeltaExcludedPending[];
}

/** 合并后逐点的处置分类 */
export type MergePointStatus = 'new' | 'live' | 'removed' | 'suppressed';

export interface MergePointEntry {
  terminal: string; // 点的产生终端（add 事件的 from）
  zone: string;
  dot: string;
  eventId: string;
  status: MergePointStatus;
  reason: string; // 逐点依据
}

/** 补传后接收端的合并视图（OR-Set 合并结果 + 逐点依据） */
export interface MergeView {
  vector: Vector;
  zones: ZoneView[]; // 合并后有效标签
  points: MergePointEntry[]; // 全部相关点（含删除/抑制），按 终端/区域/点标识 稳定排序
  added: string[]; // 相对接收端原快照新存活的事件 id
  removed: string[]; // 被增量抑制的、接收端原存活事件 id
  suppressed: string[]; // 增量携带但未生效（迟到/重复）的点事件 id
  excludedPending: DeltaExcludedPending[];
  idempotent: boolean; // 本次应用是否未改变任何状态（重复应用）
}

export interface MergeError {
  message: string;
}

export type MergeResult =
  | { ok: false; errors: MergeError[] }
  | { ok: true; delta: StateDelta; view: MergeView };

export interface MessageSummary {
  id: string;
  kind: 'add' | 'remove';
  from: string;
  seq: number;
  label: string;
  ctx: Vector;
}

export type ReplayResult =
  | { ok: false; errors: ValidationError[] }
  | {
      ok: true;
      terminals: string[];
      steps: Step[];
      messages: Record<string, MessageSummary>;
      inboxSizes: Record<string, number>;
      converged: boolean;
      finalZones: string[];
      convergenceDetail: string;
    };
