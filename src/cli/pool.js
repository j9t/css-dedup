// A worker pool for multi-file runs. Workers only compute `file-pass.js`
// payloads; the main thread does all printing, in file order, so output matches
// a sequential run byte for byte.
//
// This file is both the pool and the worker script it starts (see
// `isMainThread` at the bottom), so the two halves can’t drift apart.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { computeFilePass, describePassError } from './file-pass.js';

// Below either floor, a run finishes before a pool would be done starting
const PARALLEL_MIN_FILES = 4;
const PARALLEL_MIN_SIZE = 192_000;

function workersRequested() {
  const requested = Number.parseInt(process.env.CSS_DEDUP_WORKERS ?? '', 10);
  return Number.isInteger(requested) && requested >= 0 ? requested : null;
}

// One core is left to the main thread, which renders throughout; more workers
// than files would just idle
export function poolSize(fileCount) {
  const requested = workersRequested();
  const size = requested ?? availableParallelism() - 1;
  return Math.max(Math.min(size, fileCount), 0);
}

// Whether a run is big enough to earn a pool. An explicit `CSS_DEDUP_WORKERS`
// bypasses both floors.
export function shouldParallelize(fileCount, totalSize) {
  const requested = workersRequested();
  if (requested !== null) return requested > 1 && fileCount > 1;
  return fileCount >= PARALLEL_MIN_FILES && totalSize >= PARALLEL_MIN_SIZE && poolSize(fileCount) > 1;
}

// A worker’s STDOUT is a pipe, not the terminal, so libraries that settle color
// support at import time (PostCSS’s error highlighting, via picocolors) would
// strip it. Compensating for just the missing TTY leaves `NO_COLOR`,
// `FORCE_COLOR`, and `CI` meaning exactly what they mean here.
function workerEnv() {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return process.env;
  return { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' };
}

// Runs every slot across the pool, handing each result to
// `onOutcome(index, { payload } | { error })` in slot order. A slot is either
// `{ css, label }` or `{ outcome }`—a file that couldn’t be read, already
// decided, kept in place so the run’s output stays interleaved correctly.
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
      // Dismissed, not terminated: A worker still holding a file may be mid
      // `--fix` write, and cutting the thread there could leave it half-written.
      // `null` queues behind that job, so the worker stops once it’s done.
      for (const worker of workers) worker.postMessage(null);
      workers.clear();
      if (err) reject(err);
      else resolve();
    }

    // Workers finish in any order; this releases results strictly in slot order
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

    // A worker that dies (out of memory, most plausibly) loses its in-flight
    // file to a per-file error rather than taking the run down. If it was the
    // last one, the rest finishes on the main thread—slower, but not a hang.
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

    // Every worker starts before anything is dispatched, so a pool that can’t
    // start at all has yet to write a file or print a line
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
        // A hard exit without an `error` first would otherwise leave the run
        // waiting on a result that is never coming
        worker.on('exit', code => {
          if (workers.has(worker)) retire(worker, new Error(`Worker exited unexpectedly (code ${code})`));
        });
        workers.add(worker);
      }
    } catch (err) {
      // Idle, so safe to cut immediately. The marker tells `main()` this is the
      // one failure it may still fall back from.
      for (const worker of workers) worker.terminate();
      workers.clear();
      err.poolStartFailed = true;
      settle(err);
      return;
    }

    for (const worker of [...workers]) dispatch(worker);
    deliver();
  });
}

// The worker half: one file per message, payload back. `null` means dismissed.
// The handler is async, so it yields at its first `await` and the next message
// is delivered straight away—a `null` arriving mid-job does not queue behind
// that job. Closing the port there would strand the in-flight result: Its
// `postMessage()` would land on a closed port and go nowhere, and the main
// thread’s `retire()` would read the silence as a worker that died rather than
// one that was dismissed. So the close waits for the outstanding work.
if (!isMainThread && workerData?.pool) {
  const { options, fix, quiet } = workerData;
  let pending = 0;
  let dismissed = false;

  function closeWhenIdle() {
    if (dismissed && pending === 0) parentPort.close();
  }

  parentPort.on('message', async job => {
    if (job === null) {
      dismissed = true;
      closeWhenIdle();
      return;
    }

    pending++;
    try {
      const payload = await computeFilePass(job.css, options, { fix, quiet, isStdin: false, label: job.label });
      parentPort.postMessage({ index: job.index, payload });
    } catch (err) {
      parentPort.postMessage({ index: job.index, error: describePassError(err) });
    } finally {
      pending--;
      closeWhenIdle();
    }
  });
}