import { runReplay } from '../crdt/replay';
import { runSync } from '../crdt/sync';
import type { SyncSelection } from '../crdt/sync';

/**
 * 回放计算 Worker：
 * - { kind: 'replay', scenario }  → 逐步回放结果
 * - { kind: 'sync', scenario, source, target } → 单向补传增量 + 合并结果
 * 计算全部在此线程完成，UI 只负责渲染。
 */
export interface SyncRequest {
  kind: 'sync';
  seq: number;
  scenario: unknown;
  source: SyncSelection;
  target: SyncSelection;
}

export interface ReplayRequest {
  kind: 'replay';
  scenario: unknown;
}

type WorkerRequest = ReplayRequest | SyncRequest;

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerRequest | unknown>) => void) | null;
  postMessage: (msg: unknown) => void;
};

scope.onmessage = (ev: MessageEvent<WorkerRequest | unknown>) => {
  try {
    const req = ev.data;
    // 兼容旧协议：直接投递场景 JSON 即回放
    if (typeof req === 'object' && req !== null && 'kind' in req) {
      const r = req as WorkerRequest;
      if (r.kind === 'sync') {
        scope.postMessage({
          kind: 'sync',
          seq: r.seq,
          result: runSync(r.scenario, r.source, r.target),
        });
        return;
      }
      if (r.kind === 'replay') {
        scope.postMessage(r.scenario === undefined ? null : runReplay(r.scenario));
        return;
      }
    }
    scope.postMessage(runReplay(req));
  } catch (e) {
    scope.postMessage({
      ok: false,
      errors: [{ path: '$', message: `计算内部错误：${e instanceof Error ? e.message : String(e)}` }],
    });
  }
};
