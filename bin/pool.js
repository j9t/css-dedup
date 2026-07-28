// A worker pool for multi-file runs.
//
// Consolidation is independent per style sheet and entirely CPU-bound, so a
// directory run is embarrassingly parallel—but only the computation is.
// Ordering, color, terminal width, and the run’s totals all belong to one
// terminal, so workers only ever compute `file-pass.js` payloads and the main
// thread does every bit of printing, in file order (see `deliver()` below).
// Output is therefore identical to a sequential run’s, byte for byte.
//
// This module is both the pool and the worker script it starts: the `Worker`
// below points at this same file, and the bottom half runs only inside one
// (see `isMainThread`). One file, so the two halves of the protocol can’t
// drift apart.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { computeFilePass, describePassError } from './file-pass.js';

// Fewer files than this finish before a pool would be done starting—each
// worker costs its own module graph and a few tens of milliseconds
const PARALLEL_MIN_FILES = 4;

// …and enough total CSS to be worth it regardless of file count—a directory
// of small style sheets is dominated by startup, not consolidation
const PARALLEL_MIN_SIZE = 192_000;

// `CSS_DEDUP_WORKERS=0` forces the sequential path (and any other number sets
// the pool size), so a run can be compared against it directly
function workersRequested() {
  const requested = Number.parseInt(process.env.CSS_DEDUP_WORKERS ?? '', 10);
  return Number.isInteger(requested) && requested >= 0 ? requested : null;
}

// One thread is left to the main thread, which renders every file’s report and
// stays busy throughout; more workers than files would just idle
export function poolSize(fileCount) {
  const requested = workersRequested();
  const size = requested ?? availableParallelism() - 1;
  return Math.max(Math.min(size, fileCount), 0);
}

// Whether a run is big enough to earn a pool. `totalSize` is the combined
// length of everything actually read—the prefetch already has it, so this
// costs nothing to ask.
export function shouldParallelize(fileCount, totalSize) {
  const requested = workersRequested();
  if (requested !== null) return requested > 1 && fileCount > 1;
  return fileCount >= PARALLEL_MIN_FILES && totalSize >= PARALLEL_MIN_SIZE && poolSize(fileCount) > 1;
}

// A worker’s STDOUT is a pipe back to this process, never the terminal, so a
// library that decides about color as it loads (PostCSS’s syntax-error
// highlighting goes through picocolors, which reads this at import time) would
// strip color from output the terminal is in fact going to show. Compensating
// for exactly that one missing TTY—and passing the environment through
// otherwise untouched—keeps `NO_COLOR`, `FORCE_COLOR`, `CI`, and the rest
// meaning in a worker precisely what they mean here, rather than this having
// to re-derive some other library’s idea of when color applies.
function workerEnv() {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return process.env;
  return { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' };
}

// Runs every dispatchable slot across a pool, handing each result to
// `onOutcome(index, outcome)` in slot order. A slot is either `{ css, label }`
// (work for a worker) or `{ outcome }` (already decided—a file that couldn’t
// be read), so the two kinds stay interleaved in the order the run’s output
// needs them.
//
// `onOutcome` receives `{ payload }` for a completed pass, or `{ error }` in
// the `describePassError()` shape for one that threw.
export function runPool(slots, settings, onOutcome) {
  return new Promise((resolve, reject) => {
    const ready = new Map();
    const queue = [];
    for (const [index, slot] of slots.entries()) {
      if (slot.outcome) ready.set(index, slot.outcome);
      else queue.push(index);
    }

    const workers = new Set();
    const inFlight = new Map();
    let nextQueued = 0;
    let nextDelivered = 0;
    let settled = false;

    function settle(err) {
      if (settled) return;
      settled = true;
      for (const worker of workers) worker.terminate();
      workers.clear();
      if (err) reject(err);
      else resolve();
    }

    // Results arrive in whatever order the workers finish; this releases them
    // strictly in slot order, so the printed run reads like a sequential one
    function deliver() {
      while (ready.has(nextDelivered)) {
        const outcome = ready.get(nextDelivered);
        ready.delete(nextDelivered);
        try {
          onOutcome(nextDelivered, outcome);
        } catch (err) {
          settle(err);
          return;
        }
        nextDelivered++;
      }
      if (nextDelivered === slots.length) settle(null);
    }

    function record(index, outcome) {
      ready.set(index, outcome);
      deliver();
    }

    function dispatch(worker) {
      if (settled) return;
      if (nextQueued >= queue.length) {
        inFlight.delete(worker);
        workers.delete(worker);
        worker.postMessage(null);
        return;
      }
      const index = queue[nextQueued++];
      inFlight.set(worker, index);
      worker.postMessage({ index, ...slots[index] });
    }

    // A worker that dies (out of memory, most plausibly) takes its in-flight
    // file down as a per-file error rather than the whole run; whatever it
    // hadn’t started yet goes back to the queue for the others. If it was the
    // last one, the rest of the run finishes on the main thread—slower than
    // planned, but finished, which beats a CLI that hangs waiting for a thread
    // that is never going to answer.
    function retire(worker, err) {
      if (settled) return;
      const index = inFlight.get(worker);
      inFlight.delete(worker);
      workers.delete(worker);
      if (index !== undefined) record(index, { error: { syntax: false, message: err.message } });
      if (settled || workers.size) return;
      runRemainingInline(queue.slice(nextQueued)).then(deliver, settle);
      nextQueued = queue.length;
    }

    async function runRemainingInline(indexes) {
      for (const index of indexes) {
        const { css, label } = slots[index];
        try {
          const payload = await computeFilePass(css, settings.options, { fix: settings.fix, quiet: settings.quiet, isStdin: false, label });
          ready.set(index, { payload });
        } catch (err) {
          ready.set(index, { error: describePassError(err) });
        }
      }
    }

    // Every worker is started before anything is dispatched or printed, so a
    // pool that can’t start at all (see `main()`’s fallback) has yet to produce
    // a single line of output
    const size = Math.min(poolSize(queue.length), queue.length);
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(new URL(import.meta.url), {
          env: workerEnv(),
          workerData: { pool: true, options: settings.options, fix: settings.fix, quiet: settings.quiet },
        });
        worker.on('message', message => {
          record(message.index, message);
          dispatch(worker);
        });
        worker.on('error', err => retire(worker, err));
        // A worker that goes away without an `error` first (a hard exit) would
        // otherwise leave its file’s result outstanding and the run hanging on
        // a thread that is never going to answer
        worker.on('exit', code => {
          if (workers.has(worker)) retire(worker, new Error(`Worker exited unexpectedly (code ${code})`));
        });
        workers.add(worker);
      }
    } catch (err) {
      for (const worker of workers) worker.terminate();
      settle(err);
      return;
    }

    for (const worker of [...workers]) dispatch(worker);
    deliver();
  });
}

// The worker half: one file per message, the payload (or the failure, reduced
// to printable strings) back. `null` means the queue is empty and this worker
// is done.
if (!isMainThread && workerData?.pool) {
  const { options, fix, quiet } = workerData;

  parentPort.on('message', async job => {
    if (job === null) {
      parentPort.close();
      return;
    }
    try {
      const payload = await computeFilePass(job.css, options, { fix, quiet, isStdin: false, label: job.label });
      parentPort.postMessage({ index: job.index, payload });
    } catch (err) {
      parentPort.postMessage({ index: job.index, error: describePassError(err) });
    }
  });
}