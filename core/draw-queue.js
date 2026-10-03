// NovelAI request queue. One account allows one image at a time; when friends share an account, requests that
// collide get 429 and too many of them can get the account flagged. So:
//   - requests from this browser run one at a time, also across tavern tabs (Web Locks when available);
//   - two requests are at least `gap` apart (the last request time is shared through localStorage);
//   - a 429 ("account busy") waits and retries with growing pauses, up to `retries` times, instead of failing.
//   - with a shared cloud queue (remote), each request also waits for its turn among everyone using the account;
//     when the cloud cannot be reached the job goes ahead with the local rules and remoteError says why.
// Job states: waiting (in line) · spacing (keeping the gap) · remote (waiting in the cloud queue) · busy (429, waiting to retry) · running.

const LAST_KEY = 'sttts.nai.lastRequest';
const cancelled = () => Object.assign(Error('已取消'), {cancelled: true});

function memoryStorage() {
  let value = 0;
  try {
    const s = globalThis.localStorage;
    if (s) return {get: () => Number(s.getItem(LAST_KEY)) || 0, set: v => { try { s.setItem(LAST_KEY, String(v)); } catch { value = v; } }};
  } catch { /* storage blocked */ }
  return {get: () => value, set: v => { value = v; }};
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(cancelled()); }, {once: true});
  });
}

export class DrawQueue {
  /**
   * gap(): milliseconds between two requests. retries(): how often a 429 is retried.
   * onChange(list, {remoteError}): called whenever the line changes. backoff(attempt): pause before retry `attempt` (1-based).
   * remote(): the shared cloud queue to wait in, or null.
   */
  constructor({gap = () => 3000, retries = () => 4, onChange = () => {}, remote = () => null, locks = globalThis.navigator?.locks, storage = memoryStorage(), now = Date.now, wait = pause,
    backoff = attempt => Math.min(120000, 15000 * 2 ** (attempt - 1)) + Math.random() * 3000} = {}) {
    Object.assign(this, {gap, retries, onChange, remote, locks, storage, now, wait, backoff});
    this.jobs = [];
    this.remoteError = '';
    this.running = false;
  }
  /** Adds a job; the same key joins the job already in line. task(signal) makes the request. */
  add({key = crypto.randomUUID(), label = '', task}) {
    const existing = this.jobs.find(j => j.key === key);
    if (existing) return existing.promise;
    const job = {key, label, task, state: 'waiting', attempt: 0, until: 0, controller: new AbortController()};
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    this.jobs.push(job);
    this.changed();
    this.pump();
    return job.promise;
  }
  list() {
    return this.jobs.map(({key, label, state, attempt, until, cloud}, position) => ({key, label, state, attempt, until, position, cloud: cloud || null}));
  }
  get(key) { return this.list().find(j => j.key === key) || null; }
  get pending() { return this.jobs.some(job => !job.settled); }
  cancel(key) {
    const index = this.jobs.findIndex(j => j.key === key);
    if (index < 0) return false;
    const job = this.jobs[index];
    job.controller.abort();
    // The head job is stopped by its own run(); later jobs leave the line right away.
    if (index > 0 || !this.running) { this.jobs.splice(index, 1); job.reject(cancelled()); this.changed(); }
    return true;
  }
  cancelAll() { for (const job of [...this.jobs].reverse()) this.cancel(job.key); }
  changed() { try { this.onChange(this.list(), {remoteError: this.remoteError}); } catch { /* a listener cannot stop the queue */ } }
  /** Takes a turn in the shared cloud queue; null when there is none or it cannot be reached. */
  async turn(job, signal) {
    const remote = this.remote();
    if (!remote) { this.remoteError = ''; return null; }
    try {
      const lease = await remote.acquire({label: job.label, signal, onWait: info => {
        job.state = 'remote'; job.cloud = {position: info.position, holder: info.holder || '', cooldown: info.cooldown || 0}; this.changed();
      }});
      this.remoteError = '';
      return lease;
    } catch (error) {
      if (signal.aborted || error.cancelled) throw cancelled();
      this.remoteError = error.message;
      return null;
    }
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        const run = () => this.run(job);
        await (this.locks?.request ? this.locks.request('st-iphonie-novelai', run) : run());
        const index = this.jobs.indexOf(job);
        if (index >= 0) this.jobs.splice(index, 1);
        this.changed();
      }
    } finally { this.running = false; }
  }
  async run(job) {
    const signal = job.controller.signal;
    try {
      for (let attempt = 0; ; attempt++) {
        const readyAt = this.storage.get() + this.gap();
        if (readyAt > this.now()) {
          job.state = 'spacing'; job.until = readyAt; this.changed();
          await this.wait(readyAt - this.now(), signal);
        }
        const lease = await this.turn(job, signal);
        job.state = 'running'; job.attempt = attempt; job.until = 0; job.cloud = null; this.changed();
        try {
          const result = await job.task(signal);
          this.storage.set(this.now());
          lease?.release('done');
          job.settled = true;
          job.resolve(result);
          return;
        } catch (error) {
          this.storage.set(this.now());
          const delay = error?.status === 429 ? this.backoff(attempt + 1) : 0;
          // A 429 makes everyone in the cloud queue wait as well.
          lease?.release(delay ? 'busy' : 'done', delay);
          if (signal.aborted) throw cancelled();
          if (error?.status !== 429 || attempt >= this.retries()) throw error;
          job.state = 'busy'; job.attempt = attempt + 1; job.until = this.now() + delay; this.changed();
          await this.wait(delay, signal);
        }
      }
    } catch (error) {
      job.settled = true;
      job.reject(signal.aborted ? cancelled() : error);
    }
  }
}
