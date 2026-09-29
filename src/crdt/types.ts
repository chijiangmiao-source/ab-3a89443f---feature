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

// ---- 单向补传：从任意步骤快照构造可交换状态增量 ----

export interface SyncEndpoint {
  terminal: string;
  /** 回放步号（0 = 初始空状态，k = 第 k 步后的全终端快照中的该终端视图） */
  step: number;
  view: TerminalView;
}

/** 增量内事件相对“合并所必需”的角色 */
export type DeltaEventRole = 'live-add' | 'remove-tombstone' | 'causal-filler';

export interface DeltaEventInfo {
  eventId: string;
  kind: 'add' | 'remove';
  role: DeltaEventRole;
  zone: string;
  dot?: string;
}

export interface PendingNote {
  terminal: string;
  messageIds: string[];
}

/**
 * 可交换状态增量：只含源快照“已应用事件”的因果闭包
 * （存活点 live-add + 撤销依据 remove-tombstone + 因果填充 causal-filler），
 * 暂存（未应用）消息一律不纳入，只在 excludedPending 中标出。
 */
export interface SyncDelta {
  format: 'nfz-or-set-delta';
  version: 1;
  source: string;
  target: string;
  sourceStep: number;
  targetStep: number;
  sourceVector: Vector;
  targetVector: Vector;
  /** 源快照已应用事件（因果序、稳定排列） */
  events: DeltaEventInfo[];
  /** 其中目标尚未观察、真正需要补传的事件 */
  newToTarget: string[];
  /** 未纳入增量的暂存消息（源端 / 目标端） */
  excludedPending: PendingNote[];
}

/**
 * 逐点依据（以接收端 target 为视角）：
 * - added：增量带来的、目标未见且合并后存活的新增
 * - kept-concurrent：目标已存活，源端同区撤销的上下文不覆盖该点，并发新增保留
 * - kept：目标已存活，合并保持
 * - removed：目标存活点被源端已观察撤销删除，或目标已撤销的点被迟到增量重新带来（不复活）
 * - suppressed：随因果上下文到达、源端早已撤销的填充点，不进入合并结果
 */
export type PointStatus = 'added' | 'kept-concurrent' | 'kept' | 'removed' | 'suppressed';

export interface PointReason {
  terminal: string; // 点的产生终端（事件 from）
  zone: string;
  dot: string;
  eventId: string;
  observedBySource: boolean;
  observedByTarget: boolean;
  liveInSource: boolean;
  liveInTarget: boolean;
  liveInMerged: boolean;
  status: PointStatus;
  /** 造成该点被清除的撤销事件（若有） */
  removedBy: string | null;
  reason: string;
}

export interface MergeOutcome {
  ok: true;
  delta: SyncDelta;
  mergedVector: Vector;
  zones: ZoneView[];
  points: PointReason[];
  counts: Record<PointStatus, number>;
  /** 同一增量在接收端二次应用后结果是否完全不变 */
  idempotent: boolean;
}

export type SyncResult = MergeOutcome | { ok: false; errors: ValidationError[] };
