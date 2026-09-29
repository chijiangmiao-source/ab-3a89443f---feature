import { useCallback, useEffect, useRef, useState } from 'react';
import ReplayWorker from '../worker/replay.worker?worker';
import type { ReplayResult, Step, ValidationError } from '../crdt/types';
import type { SyncReport, SyncSelection } from '../crdt/sync';
import { SAMPLES } from '../samples';
import type { TerminalView } from '../crdt/types';
import ScenarioEditor from './ScenarioEditor';
import Controls from './Controls';
import TerminalPanel from './TerminalPanel';
import StepLog from './StepLog';
import SyncPanel from './SyncPanel';

function emptyView(terminals: string[], inboxTotal: number): TerminalView {
  const vector: Record<string, number> = {};
  for (const t of terminals) vector[t] = 0;
  return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal };
}

/** 找到某终端首次“应用/释放”指定消息的回放步号（步号从 1 起，0 表示初始） */
function stepAfterApplied(steps: Step[], terminal: string, messageId: string | null): number {
  if (!messageId) return 0;
  const s = steps.find(
    (x) =>
      x.terminal === terminal &&
      x.messageId === messageId &&
      (x.action === 'applied' || x.action === 'released'),
  );
  return s ? s.index + 1 : 0;
}

type WorkerResponse =
  | ReplayResult
  | {
      kind: 'sync';
      seq: number;
      result: SyncReport | { ok: false; errors: ValidationError[] };
    };

export default function App() {
  const [text, setText] = useState(() => JSON.stringify(SAMPLES[0].data, null, 2));
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [source, setSource] = useState<SyncSelection>({ terminal: 'B', step: 0 });
  const [target, setTarget] = useState<SyncSelection>({ terminal: 'A', step: 0 });
  const [syncReport, setSyncReport] = useState<SyncReport | null>(null);
  const [syncErrors, setSyncErrors] = useState<ValidationError[] | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [applyCount, setApplyCount] = useState(0);
  const [activeSample, setActiveSample] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const scenarioRef = useRef<unknown>(SAMPLES[0].data);
  /** 选择镜像，供 Worker 消息回调读取最新值 */
  const sourceRef = useRef(source);
  const targetRef = useRef(target);
  /** 补传请求序号：只接受最后一次请求的响应 */
  const syncReqRef = useRef(0);
  /** 下一次回放成功后待应用的演示快照选择（step=-1 为占位，步号由一次性监听器换算） */
  const pendingDemoRef = useRef<{ source: SyncSelection; target: SyncSelection } | null>(null);

  const postSync = useCallback((s: SyncSelection, t: SyncSelection) => {
    syncReqRef.current += 1;
    setSyncBusy(true);
    workerRef.current?.postMessage({
      kind: 'sync',
      seq: syncReqRef.current,
      scenario: scenarioRef.current,
      source: s,
      target: t,
    });
  }, []);

  useEffect(() => {
    const w = new ReplayWorker();
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (typeof msg === 'object' && msg !== null && 'kind' in msg && msg.kind === 'sync') {
        // 丢弃过期请求的响应（快速切换选择/方向时）
        if (msg.seq !== syncReqRef.current) return;
        setSyncBusy(false);
        const r = msg.result;
        if (r.ok) {
          setSyncReport(r);
          setSyncErrors(null);
          setApplyCount((n) => n + 1);
        } else {
          // 非法/不相容选择：清空此前补传结果，不动原回放
          setSyncReport(null);
          setSyncErrors(r.errors);
          setApplyCount(0);
        }
        return;
      }
      const replay = msg as ReplayResult;
      setResult(replay);
      setStep(0);
      setPlaying(false);
      setSyncReport(null);
      setSyncErrors(null);
      setApplyCount(0);
      if (!replay.ok) pendingDemoRef.current = null;

      if (replay.ok) {
        const clamp = (sel: SyncSelection): SyncSelection => ({
          terminal: replay.terminals.includes(sel.terminal)
            ? sel.terminal
            : replay.terminals[0],
          step: Math.min(Math.max(sel.step, 0), replay.steps.length),
        });
        let nextSource: SyncSelection;
        let nextTarget: SyncSelection;
        const demo = pendingDemoRef.current;
        if (demo && demo.source.step >= 0 && demo.target.step >= 0) {
          // 演示快照：步号已由一次性监听器换算
          pendingDemoRef.current = null;
          nextSource = demo.source;
          nextTarget = demo.target;
        } else if (demo) {
          // 演示步号尚未换算（占位）：本次只校正占位，不发起补传，监听器会补发
          nextSource = { terminal: demo.source.terminal, step: 0 };
          nextTarget = { terminal: demo.target.terminal, step: 0 };
        } else {
          nextSource = clamp(sourceRef.current);
          nextTarget = clamp(targetRef.current);
          // 同终端（如终端数变化后）自动纠正为两台不同终端
          if (nextSource.terminal === nextTarget.terminal) {
            nextTarget = { ...nextTarget, terminal: replay.terminals[1] ?? nextTarget.terminal };
          }
        }
        sourceRef.current = nextSource;
        targetRef.current = nextTarget;
        setSource(nextSource);
        setTarget(nextTarget);
        if (!(demo && (demo.source.step < 0 || demo.target.step < 0))) {
          postSync(nextSource, nextTarget);
        }
      }
    };
    workerRef.current = w;
    return () => w.terminate();
  }, [postSync]);

  /** 启动新回放：先清除旧回放，再在 Worker 中校验并计算 */
  const run = useCallback(
    (jsonText: string) => {
      setResult(null);
      setStep(0);
      setPlaying(false);
      setSyncReport(null);
      setSyncErrors(null);
      setSyncBusy(false);
      setApplyCount(0);
      syncReqRef.current += 1; // 使在途补传响应失效
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch (e) {
        setResult({
          ok: false,
          errors: [
            { path: '$', message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` },
          ],
        });
        return;
      }
      scenarioRef.current = parsed;
      pendingDemoRef.current = null;
      workerRef.current?.postMessage({ kind: 'replay', scenario: parsed });
    },
    [],
  );

  const loadSample = useCallback(
    (index: number) => {
      const sample = SAMPLES[index];
      const json = JSON.stringify(sample.data, null, 2);
      setText(json);
      setActiveSample(index);
      // 演示快照步号依赖回放结果：先放占位，回放消息到达后再换算步号
      pendingDemoRef.current = sample.demoSync
        ? {
            source: { terminal: sample.demoSync.source.terminal, step: -1 },
            target: { terminal: sample.demoSync.target.terminal, step: -1 },
          }
        : null;
      run(json);
      if (sample.demoSync) {
        const ds = sample.demoSync;
        const w = workerRef.current;
        if (w) {
          const handler = (e: MessageEvent<WorkerResponse>) => {
            const msg = e.data;
            if (typeof msg === 'object' && msg !== null && !('kind' in msg)) {
              const replay = msg as ReplayResult;
              if (replay.ok && pendingDemoRef.current) {
                const sel = {
                  source: {
                    terminal: ds.source.terminal,
                    step: stepAfterApplied(replay.steps, ds.source.terminal, ds.source.after),
                  },
                  target: {
                    terminal: ds.target.terminal,
                    step: stepAfterApplied(replay.steps, ds.target.terminal, ds.target.after),
                  },
                };
                pendingDemoRef.current = sel;
                sourceRef.current = sel.source;
                targetRef.current = sel.target;
                setSource(sel.source);
                setTarget(sel.target);
                postSync(sel.source, sel.target);
              }
              w.removeEventListener('message', handler);
            }
          };
          w.addEventListener('message', handler);
        }
      }
    },
    [run],
  );

  // 首次挂载：加载默认样例并自动演示其补传快照
  useEffect(() => {
    loadSample(0);
  }, [loadSample]);

  const clearSync = useCallback(() => {
    setSyncReport(null);
    setSyncErrors(null);
    setApplyCount(0);
  }, []);

  /** 修改任一端选择即清空此前补传结果（快照已变，旧结果不再对应当前选择） */
  const changeSource = useCallback((sel: SyncSelection) => {
    sourceRef.current = sel;
    setSource(sel);
    setSyncReport(null);
    setSyncErrors(null);
    setApplyCount(0);
  }, []);
  const changeTarget = useCallback((sel: SyncSelection) => {
    targetRef.current = sel;
    setTarget(sel);
    setSyncReport(null);
    setSyncErrors(null);
    setApplyCount(0);
  }, []);

  /** 交换补传方向：清空旧结果并立即用反向选择重算（结果应保持不变） */
  const swap = useCallback(() => {
    const s = targetRef.current;
    const t = sourceRef.current;
    sourceRef.current = s;
    targetRef.current = t;
    setSource(s);
    setTarget(t);
    setSyncReport(null);
    setSyncErrors(null);
    setApplyCount(0);
    postSync(s, t);
  }, [postSync]);

  const steps = result && result.ok ? result.steps : [];
  const total = steps.length;

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep((s) => Math.min(s + 1, total)), 650);
    return () => clearTimeout(timer);
  }, [playing, step, total]);

  const viewAt = (t: string): TerminalView => {
    if (!result || !result.ok) return emptyView([], 0);
    if (step === 0) return emptyView(result.terminals, result.inboxSizes[t] ?? 0);
    return steps[step - 1].stateAfter[t];
  };

  const current = step > 0 && step <= total ? steps[step - 1] : null;

  return (
    <div className="app">
      <header>
        <h1>禁飞标签 OR-Set 因果回放台</h1>
        <p className="sub">
          断网期间多地面终端维护禁飞标签 · 点集 + 因果上下文 observed-remove 归并 · 乱序暂存 ·
          重复幂等 · 快照单向补传（可交换状态增量）
        </p>
      </header>
      <div className="layout">
        <ScenarioEditor
          text={text}
          onText={setText}
          onRun={() => run(text)}
          onLoadSample={loadSample}
          activeSample={activeSample}
          errors={result && !result.ok ? result.errors : null}
          running={result === null}
        />
        <main>
          {result && !result.ok && (
            <div className="banner bad">
              场景校验失败，已清除旧回放：共 {result.errors.length} 处问题（见左侧面板）
            </div>
          )}
          {result && result.ok && (
            <>
              <div className={`banner ${result.converged ? 'ok' : 'bad'}`}>
                {result.convergenceDetail}
              </div>
              <Controls
                step={step}
                total={total}
                playing={playing}
                onStep={(s) => {
                  setStep(s);
                  setPlaying(false);
                }}
                onTogglePlay={() => setPlaying((p) => !p && step < total)}
              />
              {current ? (
                <div className={`current action-${current.action}`}>
                  <span className="cur-head">
                    第 {current.index + 1} 步 · 终端 {current.terminal} · {current.messageId}{' '}
                    {result.messages[current.messageId]?.label}
                  </span>
                  <span className="cur-reason">{current.reason}</span>
                  {current.effect && <span className="cur-effect">{current.effect}</span>}
                </div>
              ) : (
                <div className="current idle">初始状态：尚未投递任何消息，使用上方控制条逐步回放</div>
              )}
              <div className="panels">
                {result.terminals.map((t) => (
                  <TerminalPanel key={t} id={t} view={viewAt(t)} />
                ))}
              </div>

              <SyncPanel
                replay={result}
                source={source}
                target={target}
                busy={syncBusy}
                applyCount={applyCount}
                report={syncReport}
                errors={syncErrors}
                onSelectSource={changeSource}
                onSelectTarget={changeTarget}
                onSwap={swap}
                onRun={() => postSync(source, target)}
                onRepeat={() => postSync(source, target)}
                onClear={clearSync}
              />

              <StepLog steps={steps} current={step} messages={result.messages} onJump={setStep} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
