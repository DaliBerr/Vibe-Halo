// Vibe Halo's DSH answerer. Node builtins only; no client UI or model hooks.
// Uses the public approval/question waterfalls, as do dsh-windows-notification
// and dsh-notify-zeta. Implementation is independent; native next() owns fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const name = 'vibe-halo-dsh';
const LIMIT = 256 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fits = (s, max, required = false) => typeof s === 'string' && s.length <= max && (!required || s.trim().length > 0);
const short = (s, max = 2000) => typeof s === 'string' ? s.slice(0, max) : '';

// UserQuestionService dispatches a mutable event copy. Its public signal belongs
// to the answer UI, while the service retains the original Turn/timed signal.
// Give next() a separate lifetime so an island answer can withdraw the native
// card through the normal Gateway cancellation frame without aborting the Turn.
export function parallelQuestion(request, next, answerInIsland) {
  const parent = request.signal;
  if (parent?.aborted) return next();
  const native = new AbortController();
  const island = new AbortController();
  const hadSignal = Object.hasOwn(request, 'signal');
  try { request.signal = native.signal; }
  catch { return next(); } // An immutable future event remains fully native.
  let settled = false;
  let nativeDone = false, islandDone = false, nativeValue, nativeError;
  let abort;
  const result = new Promise((resolve, reject) => {
    const finish = (value, error, winner) => {
      if (settled) return;
      settled = true;
      if (error !== undefined) reject(error); else resolve(value);
      if (winner !== 'native') native.abort();
      if (winner !== 'island') island.abort();
    };
    const exhausted = () => {
      if (nativeDone && islandDone) finish(nativeValue, nativeError, 'native');
    };
    abort = () => finish(undefined, parent?.reason || Object.assign(new Error('question cancelled'), { code: 'ASK_ABORTED' }), 'abort');
    parent?.addEventListener('abort', abort, { once: true });
    if (parent?.aborted) { abort(); return; }
    // Start native UI immediately, never after the island's timeout/close.
    void Promise.resolve().then(next).then(value => {
      nativeDone = true; nativeValue = value;
      if (record(value) && Array.isArray(value.answers)) finish(value, undefined, 'native');
      else exhausted();
    }, error => {
      nativeDone = true; nativeError = error;
      // Native user cancellation and the native timed-question deadline are
      // authoritative; unavailable/disconnected answerers leave the island live.
      if (['ASK_ABORTED', 'ASK_TIMED_OUT'].includes(error?.code)) finish(undefined, error, 'native');
      else exhausted();
    }).finally(() => {
      // Keep the child signal until next() finishes: a queued Gateway frame may
      // not have read it yet. Never replace the caller's original signal.
      if (request.signal === native.signal) {
        if (hadSignal) request.signal = parent; else delete request.signal;
      }
    }).catch(() => {});
    void Promise.resolve().then(() => answerInIsland(island.signal)).then(value => {
      islandDone = true;
      if (record(value) && Array.isArray(value.answers)) finish(value, undefined, 'island');
      else exhausted();
    }, () => { islandDone = true; exhausted(); });
  });
  return result.finally(() => parent?.removeEventListener('abort', abort));
}

export function questionForm(questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) return null;
  if (new Set(questions.map(q => q?.id)).size !== questions.length) return null;
  const form = [];
  for (const [i, q] of questions.entries()) {
    if (!record(q) || !fits(q.id, 2000, true) || !fits(q.question, 1000, true)
      || (q.detail !== undefined && !fits(q.detail, 16000))
      || (q.header !== undefined && !fits(q.header, 120))
      || (q.intent && !['approval', 'plan-review'].includes(q.intent.kind))) return null;
    const options = q.options ?? [];
    if (!Array.isArray(options) || options.length > 20
      || options.some(o => !fits(o?.label, 240, true) || (o.description !== undefined && !fits(o.description, 600)))) return null;
    form.push({ id: `q_${i + 1}`, question: q.question, detail: q.detail || '', header: q.header || '',
      multiSelect: q.multiSelect === true, allowText: q.intent?.kind !== 'approval', answerFormat: 'dsh',
      options: options.map((o, j) => ({ id: `option_${j + 1}`, label: o.label, description: o.description || '' })) });
  }
  return form;
}

export function decodeAnswers(questions, form, values) {
  if (!record(values) || Object.keys(values).length !== form.length) return null;
  const answers = [];
  for (const [i, q] of form.entries()) {
    const v = values[q.id];
    if (v === 'skip:' && q.allowText) { answers.push({ id: questions[i].id, selected: [] }); continue; }
    const list = Array.isArray(v) ? v : [v];
    if (!list.length || list.length > 21 || (!q.multiSelect && list.length !== 1) || new Set(list).size !== list.length) return null;
    const selected = [];
    let custom;
    for (const value of list) {
      if (!fits(value, 2000, true)) return null;
      const j = q.options.findIndex(o => o.id === value);
      if (j >= 0) selected.push(questions[i].options[j].label);
      else if (q.allowText && value.startsWith('text:') && value.slice(5).trim() && custom === undefined) custom = value.slice(5);
      else return null;
    }
    answers.push({ id: questions[i].id, selected, ...(custom === undefined ? {} : { custom }) });
  }
  return { answers };
}

function runtime(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 4096) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.app !== 'vibe-halo' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || !/^[a-f0-9]{64}$/.test(value.token) || !Number.isInteger(value.ownerPid) || value.ownerPid < 1) return null;
    process.kill(value.ownerPid, 0);
    return value;
  } catch { return null; }
}

export function post(file, route, body, signal, timeout = 125000) {
  const target = runtime(file);
  if (!target || signal?.aborted) return Promise.resolve(null);
  let data;
  try { data = JSON.stringify(body); } catch { return Promise.resolve(null); }
  if (Buffer.byteLength(data) > LIMIT) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const req = http.request({ hostname: '127.0.0.1', port: target.port, method: 'POST', path: route, signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-vibe-halo-token': target.token } }, res => {
      if (res.statusCode !== 200 && res.statusCode !== 204 || res.headers['x-vibe-halo'] !== 'vibe-halo') {
        res.resume(); done(null); return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > LIMIT) req.destroy(); else chunks.push(chunk); });
      res.on('error', () => done(null));
      res.on('end', () => { try { done(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); } catch { done(null); } });
    });
    const timer = setTimeout(() => req.destroy(), timeout);
    req.on('error', () => done(null));
    req.on('close', () => done(null));
    req.end(data);
  });
}

export function apply(ctx, config = {}) {
  const runtimePath = config.runtimePath || path.join(os.homedir(), '.vibe-halo', 'runtime.json');
  const sessions = new WeakMap();
  const pending = new Set();
  const late = new Map();
  let disposed = false;
  const service = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
  const info = session => {
    if (!sessions.has(session)) sessions.set(session, { calls: new Map(), output: '', title: '' });
    return sessions.get(session);
  };
  const root = agent => agent?.session && agent.session.header?.origin !== 'subagent';
  const base = agent => {
    const session = agent?.session || agent;
    let cwd = session.header?.cwd;
    try { cwd = service('workingDirectory')?.get(session) || cwd; } catch {}
    return { agent_id: 'deepseek-harness', session_id: `deepseek-harness:${session.id}`,
      cwd: short(cwd), source_pid: process.pid };
  };
  const run = async (body, signal) => {
    if (disposed || pending.size >= 128 || signal?.aborted) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    pending.add(controller);
    try { return await post(runtimePath, '/permission', body, controller.signal); }
    finally { pending.delete(controller); signal?.removeEventListener('abort', abort); }
  };
  const event = (agent, type, extra = {}) => {
    if (disposed || pending.size >= 128) return;
    const controller = new AbortController();
    pending.add(controller);
    void post(runtimePath, '/event', { ...base(agent), event: type, ...extra }, controller.signal, 2000)
      .finally(() => pending.delete(controller));
  };
  const ask = async (request, next, continued = false) => {
    const { agent, questions } = request;
    const form = questionForm(questions);
    if (!root(agent) || !form || disposed || request.signal?.aborted) return next();
    const q = questions[0];
    const approval = questions.length === 1 && q.intent?.kind === 'approval';
    const actions = approval ? { allow: q.intent.approve, deny: q.intent.reject, ...(q.intent.always ? { always: q.intent.always } : {}) } : null;
    if (approval && (q.multiSelect || !q.detail || new Set(Object.values(actions)).size !== Object.keys(actions).length
      || q.options?.length !== Object.keys(actions).length
      || Object.values(actions).some(label => !fits(label, 160, true) || !q.options?.some(o => o.label === label)))) return next();
    const result = await run({ ...base(agent), event: approval ? 'PermissionRequest' : 'Elicitation',
      request_id: randomUUID(), tool_name: approval ? 'Permission' : q.intent?.kind === 'plan-review' ? 'PlanReview' : 'ask_user_question',
      description: approval ? q.question : '', tool_input: approval ? { detail: q.detail } : {},
      ...(approval ? { dsh_actions: actions } : { questions: form }) }, request.signal);
    if (request.signal?.aborted || disposed || !result) return next();
    if (approval) {
      const label = Object.hasOwn(actions, result.decision) ? actions[result.decision] : null;
      return label ? { answers: [{ id: q.id, selected: [label] }] } : next();
    }
    const answer = result.decision === 'answer' ? decodeAnswers(questions, form, result.answers) : null;
    if (!answer) return next();
    if (continued) {
      try { return service('userQuestions').answer(agent, request.wait.callId, answer); } catch { return false; }
    }
    return answer;
  };
  const startLate = (request, callId) => {
    if (!root(request.agent) || disposed || late.size >= 128) return;
    const key = `${request.agent.session.id}:${callId}`;
    if (late.has(key)) return;
    const controller = new AbortController();
    late.set(key, controller);
    void ask({ ...request, signal: controller.signal, wait: { callId } }, () => false, true)
      .catch(() => false)
      .finally(() => { if (late.get(key) === controller) late.delete(key); });
  };
  const restore = agent => {
    if (!root(agent) || disposed) return;
    try {
      const view = service('sessionProjections')?.snapshot(agent.session, ['userQuestions'])?.values?.userQuestions;
      for (const question of view?.active || []) if (question.state === 'continued') {
        startLate({ agent, questions: question.questions }, question.callId);
      }
    } catch { /* Older runtimes without this public projection retain native UI. */ }
  };
  ctx.on('approval/request', async (request, next) => {
    if (!root(request.agent) || disposed || request.signal?.aborted) return next();
    const call = info(request.agent.session).calls.get(request.callId);
    let input;
    try { input = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments; } catch {}
    const result = await run({ ...base(request.agent), event: 'PermissionRequest', request_id: randomUUID(),
      tool_name: short(request.toolName, 160) || 'Permission', description: short(request.reason, 1000),
      dsh_context_complete: record(input) && short(request.reason, 1000) === (request.reason || ''),
      tool_input: record(input) ? input : { reason: short(request.reason, 16000) } }, request.signal);
    if (disposed || request.signal?.aborted) return next();
    if (result?.decision === 'allow') return 'allowed-once';
    if (result?.decision === 'deny') return 'rejected';
    return next();
  }, { prepend: true });
  ctx.on('user-questions/request', (request, next) => {
    if (root(request.agent) && request.wait?.callId) {
      const calls = info(request.agent.session).calls;
      const call = calls.get(request.wait.callId) || {};
      calls.set(request.wait.callId, { ...call, request });
    }
    // The native Client owns its normal attachWait/countdown. Both UIs receive
    // the request now; the first actual answer wins and withdraws the other UI.
    return parallelQuestion(request, next, signal => ask({ ...request, signal }, () => undefined));
  }, { prepend: true });
  ctx.on('session/event', (session, e) => {
    if (!session || session.header?.origin === 'subagent' || disposed) return;
    const state = info(session);
    if (e.type === 'tool/call') {
      state.calls.set(e.data.callId, e.data);
      if (state.calls.size > 128) state.calls.delete(state.calls.keys().next().value);
    } else if (e.type === 'assistant/message') {
      state.output = short(e.data.content?.filter(x => x.type === 'text').map(x => x.text).join('\n'), 16000);
    } else if (e.type === 'session/title') state.title = short(e.data.title, 500);
    else if (e.type === 'turn/start') { state.output = ''; event(session, 'UserPromptSubmit'); }
    else if (e.type === 'turn/end' && e.data.reason?.kind === 'completed') {
      event(session, 'Stop', { assistant_last_output: state.output, session_title: state.title });
    } else if (e.type === 'tool/result' || e.type === 'tool/ptc-dispatch') {
      const callId = e.type === 'tool/result' ? e.data.message?.toolCallId : e.data.subCallId;
      const call = state.calls.get(callId);
      // The tool's durable pending result is the transition to the late-answer API.
      let result;
      try { result = JSON.parse((e.type === 'tool/result' ? e.data.message?.content : e.data.content)?.filter(x => x.type === 'text').map(x => x.text).join('')); } catch {}
      if (call?.request?.wait?.timed && result?.pending === true && typeof service('userQuestions')?.answer === 'function') {
        startLate(call.request, callId);
      }
    } else if (e.type === 'user/message' && e.data.source?.kind === 'user-question-reply') {
      late.get(`${session.id}:${e.data.source.callId}`)?.abort();
    }
  }, { global: true });
  ctx.on('agent/created', ({ agent }) => { queueMicrotask(() => restore(agent)); }, { global: true });
  if (typeof ctx.inject === 'function') ctx.inject(['agents', 'sessionProjections', 'userQuestions'], scope => {
    for (const agent of scope.agents.roots()) restore(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (!agent?.session) return;
    for (const [key, controller] of late) if (key.startsWith(`${agent.session.id}:`)) { controller.abort(); late.delete(key); }
  }, { global: true });
  ctx.on('dispose', () => {
    disposed = true;
    for (const controller of pending) controller.abort();
    for (const controller of late.values()) controller.abort();
    pending.clear(); late.clear();
  });
}
