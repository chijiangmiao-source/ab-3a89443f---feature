import { useCallback, useEffect, useRef, useState } from 'react';
import ReplayWorker from '../worker/replay.worker?worker';
import { buildMerge, applyDelta } from '../crdt/delta';
import type { MergeResult, ReplayResult, TerminalView } from '../crdt/types';
import { BACKFILL_PRESETS, SAMPLES, type BackfillPreset } from '../samples';
import ScenarioEditor from './ScenarioEditor';
import Controls from './Controls';
import TerminalPanel from './TerminalPanel';
import StepLog from './StepLog';
import BackfillPanel, { type SnapSelection } from './BackfillPanel';

function emptyView(terminals: string[], inboxTotal: number): TerminalView {
  const vector: Record<string, number> = {};
  for (const t of terminals) vector[t] = 0;
  return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal };
}

export default function App() {
  const [text, setText] = useState(() => JSON.stringify(SAMPLES[0].data, null, 2));
  const [sampleIndex, setSampleIndex] = useState(0);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [source, setSource] = useState<SnapSelection>({ terminal: 'A', localStep: 0 });
  const [target, setTarget] = useState<SnapSelection>({ terminal: 'B', localStep: 0 });
  const [merge, setMerge] = useState<MergeResult | null>(null);
  const workerRef = useRef<Worker | null>(null);
  /** 最近一次实际提交给回放 Worker 的场景对象（补传增量必须基于它构造） */
  const scenarioRef = useRef<unknown>(null);

  useEffect(() => {
    const w = new ReplayWorker();
    w.onmessage = (e: MessageEvent<ReplayResult>) => {
      setResult(e.data);
      setStep(0);
      setPlaying(false);
      setMerge(null);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  /** 启动新回放：先清除旧回放，再在 Worker 中校验并计算 */
  const run = useCallback((jsonText: string) => {
    setResult(null);
    setStep(0);
    setPlaying(false);
    setMerge(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setResult({
        ok: false,
        errors: [{ path: '$', message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }],
      });
      return;
    }
    workerRef.current?.postMessage(parsed);
    scenarioRef.current = parsed;
  }, []);

  const loadSample = useCallback(
    (index: number) => {
      const json = JSON.stringify(SAMPLES[index].data, null, 2);
      setText(json);
      setSampleIndex(index);
      const terms = (SAMPLES[index].data as { terminals: string[] }).terminals;
      setSource({ terminal: terms[0], localStep: 0 });
      setTarget({ terminal: terms[1] ?? terms[0], localStep: 0 });
      run(json);
    },
    [run],
  );

  // 首次挂载自动回放默认样例
  useEffect(() => {
    run(JSON.stringify(SAMPLES[0].data, null, 2));
  }, [run]);

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

  /** 本地步号（该终端自己的第 k 次投递）→ 全局回放步号 */
  const toGlobalStep = useCallback(
    (sel: SnapSelection): number => {
      if (!result || !result.ok) return 0;
      if (sel.localStep === 0) return 0;
      const local = result.steps.filter((s) => s.terminal === sel.terminal);
      return local[Math.min(sel.localStep, local.length) - 1].index + 1;
    },
    [result],
  );

  const computeMerge = useCallback(
    (src: SnapSelection, dst: SnapSelection) => {
      if (!result || !result.ok) {
        setMerge(null);
        return;
      }
      // 非法或不相容的选择由 buildMerge 拒绝；此前补传结果随本次设置一并清空
      setMerge(
        buildMerge(
          scenarioRef.current,
          result,
          { terminal: src.terminal, step: toGlobalStep(src) },
          { terminal: dst.terminal, step: toGlobalStep(dst) },
        ),
      );
    },
    [result, toGlobalStep],
  );

  const onSelectChange = useCallback((which: 'source' | 'target', sel: SnapSelection) => {
    if (which === 'source') setSource(sel);
    else setTarget(sel);
    setMerge(null);
  }, []);

  const onSwap = useCallback(() => {
    const hadResult = merge !== null;
    const next = { src: target, dst: source };
    setSource(next.src);
    setTarget(next.dst);
    // 已有补传结果时立即反向构造：标签/向量集合应保持不变（可交换）
    if (hadResult) computeMerge(next.src, next.dst);
    else setMerge(null);
  }, [source, target, merge, computeMerge]);

  const onPreset = useCallback(
    (p: BackfillPreset) => {
      const src = { ...p.src };
      const dst = { ...p.dst };
      setSource(src);
      setTarget(dst);
      computeMerge(src, dst);
    },
    [computeMerge],
  );

  /** 对已合并的接收端状态再次应用同一增量：结果应保持不变（幂等演示） */
  const reapply = useCallback(() => {
    if (!merge || !merge.ok) return;
    const res = applyDelta(scenarioRef.current, merge.delta, {
      terminal: merge.delta.target,
      step: merge.delta.targetStep,
      view: {
        vector: merge.view.vector,
        zones: merge.view.zones,
        pending: [],
        inboxDone: 0,
        inboxTotal: 0,
      },
    });
    if (res.ok) setMerge({ ok: true, delta: merge.delta, view: res.view });
    else setMerge(res);
  }, [merge]);

  return (
    <div className="app">
      <header>
        <h1>禁飞标签 OR-Set 因果回放台</h1>
        <p className="sub">
          断网期间多地面终端维护禁飞标签 · 点集 + 因果上下文 observed-remove 归并 · 乱序暂存 · 重复幂等
        </p>
      </header>
      <div className="layout">
        <ScenarioEditor
          text={text}
          onText={setText}
          onRun={() => run(text)}
          onLoadSample={loadSample}
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
              <StepLog steps={steps} current={step} messages={result.messages} onJump={setStep} />
              <BackfillPanel
                replay={result}
                source={source}
                target={target}
                onChange={onSelectChange}
                onSwap={onSwap}
                onApply={() => computeMerge(source, target)}
                onReapply={reapply}
                merge={merge}
                presets={BACKFILL_PRESETS[sampleIndex] ?? []}
                onPreset={onPreset}
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
