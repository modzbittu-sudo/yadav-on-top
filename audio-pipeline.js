const { spawn } = require('child_process');
const { Readable, PassThrough } = require('stream');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
// The mixer works in 32-bit float. Integer samples would wrap the moment a gain
// pushed the signal past full scale, which silently flattened everything before
// the compressor and limiter ever saw it - that is what made the loudness
// controls do nothing. All limiting now happens in ffmpeg, after the mix.
const SAMPLE_BYTES = 4;
const BYTES_PER_FRAME = CHANNELS * SAMPLE_BYTES;
const BLOCK_FRAMES = 960;          // 20 ms of 48 kHz audio
const MAX_PENDING_FRAMES = 4800;   // 100 ms head-room per source
const SILENCE = Buffer.alloc(0);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Mixes any number of Float32 LE sources into one continuous Float32 LE stereo
// 48 kHz stream. Sources that run dry are padded with silence so the output
// stream never stalls.
class PcmMixer extends Readable {
  constructor(options = {}) {
    super();
    this.channels = options.channels || CHANNELS;
    this.bytesPerFrame = this.channels * SAMPLE_BYTES;
    this.blockFrames = options.blockFrames || BLOCK_FRAMES;
    this.blockBytes = this.blockFrames * this.bytesPerFrame;
    this.maxPendingBytes = (options.maxPendingFrames || MAX_PENDING_FRAMES) * this.bytesPerFrame;
    this.outputGain = 1;
    this.sources = new Map();
    this.timer = null;
  }

  ensureSource(name) {
    if (!this.sources.has(name)) {
      this.sources.set(name, { pending: SILENCE, gain: 1, enabled: true, received: 0 });
    }
    return this.sources.get(name);
  }

  setSourceGain(name, gain) {
    this.ensureSource(name).gain = Number.isFinite(gain) ? gain : 1;
    return this;
  }

  setSourceEnabled(name, enabled) {
    this.ensureSource(name).enabled = Boolean(enabled);
    return this;
  }

  setOutputGain(gain) {
    this.outputGain = Number.isFinite(gain) ? Math.max(0, gain) : 1;
    return this;
  }

  // Accepts raw Float32 LE audio for `name` (stereo interleaved).
  writeSource(name, chunk) {
    if (!chunk || !chunk.length) return false;

    const source = this.ensureSource(name);
    const data = chunk.length % this.bytesPerFrame === 0
      ? chunk
      : chunk.subarray(0, chunk.length - (chunk.length % this.bytesPerFrame));
    if (!data.length) return false;

    source.pending = source.pending.length ? Buffer.concat([source.pending, data]) : Buffer.from(data);
    source.received += data.length;

    if (source.pending.length > this.maxPendingBytes) {
      source.pending = source.pending.subarray(source.pending.length - this.maxPendingBytes);
    }
    return true;
  }

  clearSource(name) {
    const source = this.sources.get(name);
    if (source) source.pending = SILENCE;
    return this;
  }

  // Bytes currently queued for a source. A decoder should be throttled while
  // this stays high, otherwise it delivers the whole file in a burst and the
  // capped buffer skips most of it.
  sourcePending(name) {
    const source = this.sources.get(name);
    return source ? source.pending.length : 0;
  }

  renderBlock() {
    const out = Buffer.alloc(this.blockBytes);

    for (const source of this.sources.values()) {
      const pending = source.pending;
      if (!pending.length) continue;

      const take = Math.min(pending.length, this.blockBytes);
      const chunk = pending.subarray(0, take);
      source.pending = take >= pending.length ? SILENCE : pending.subarray(take);

      if (!source.enabled) continue;

      const sourceGain = source.gain;
      for (let offset = 0; offset + 3 < take; offset += SAMPLE_BYTES) {
        const value = chunk.readFloatLE(offset);
        if (value === 0) continue;
        out.writeFloatLE(out.readFloatLE(offset) + value * sourceGain, offset);
      }
    }

    if (this.outputGain !== 1) {
      for (let offset = 0; offset + 3 < this.blockBytes; offset += SAMPLE_BYTES) {
        const value = out.readFloatLE(offset) * this.outputGain;
        if (value !== 0) out.writeFloatLE(value, offset);
      }
    }

    return out;
  }

  // Runs the mixer off a wall clock (20 ms per block) instead of off the
  // consumer: ffmpeg reads raw PCM as fast as it can, so a pull-driven mixer
  // would spin the CPU and drop audio. Timers are coarse (Windows ticks at
  // 15.6 ms), so the block count is anchored to elapsed time and catches up
  // rather than drifting. A slow consumer is skipped instead of buffered.
  start() {
    if (this.timer || this.destroyed) return this;

    const blockMs = (this.blockFrames / SAMPLE_RATE) * 1000;
    const period = Math.max(1, Math.round(blockMs));
    let lastTickAt = Date.now();
    let owed = 0;

    this.timer = setInterval(() => {
      if (this.destroyed) return;

      const now = Date.now();
      owed = Math.min(owed + (now - lastTickAt) / blockMs, 4);
      lastTickAt = now;

      while (owed >= 1) {
        owed -= 1;
        if (this.readableLength > this.blockBytes * 2) return;
        if (typeof this.onTick === 'function') this.onTick(this);
        this.push(this.renderBlock());
      }
    }, period);

    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (!this.timer) return this;
    clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  _read() {
    // Blocks are produced by start(); nothing to do on pull.
  }

  _destroy(error, callback) {
    this.stop();
    callback(error);
  }
}

// ffmpeg filter chain applied after the mixer: compression "drive" (adds
// apparent loudness) plus a brick-wall limiter so the boost never clips.
function buildLoudnessFilter(options = {}) {
  const drive = clamp(Number(options.drive) || 0, 0, 100);
  const limiter = options.limiter !== false;
  const rawTarget = options.targetLufs;
  const targetLufs = rawTarget === null || rawTarget === undefined || rawTarget === '' ? null : Number(rawTarget);
  const parts = [];

  if (drive > 0) {
    const ratio = 1 + (drive / 100) * 19;
    const threshold = 0.5 - (drive / 100) * 0.45;
    const makeup = 1 + (drive / 100) * 6;
    parts.push(`acompressor=threshold=${threshold.toFixed(4)}:ratio=${ratio.toFixed(2)}:attack=5:release=120:makeup=${makeup.toFixed(2)}:knee=6`);
    parts.push('asoftclip=type=tanh:threshold=0.85:output=1');
  }

  if (targetLufs !== null && Number.isFinite(targetLufs)) {
    parts.push(`loudnorm=I=${clamp(targetLufs, -31, -4).toFixed(1)}:TP=-1.5:LRA=11`);
  }

  if (limiter) {
    // level=disabled keeps alimiter from auto-normalising away the limit, which
    // is what actually protects the output when the volume and drive are high.
    parts.push('alimiter=limit=0.95:level=disabled:attack=5:release=60');
  }

  return parts.length ? parts.join(',') : 'anull';
}

// Encodes a raw PCM stream (mixer output) through the loudness chain.
function createEncoder(options = {}) {
  const { ffmpegPath, filter, spawnImpl = spawn, onLog, onError, onExit, label = 'encoder' } = options;

  if (!ffmpegPath) {
    throw new Error('createEncoder requires an ffmpeg path');
  }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    // Float in (so the mixer's gains cannot clip), Int16 out for Discord.
    '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
    '-af', filter || 'anull',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1',
  ];

  const child = spawnImpl(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = new PassThrough();

  if (child.stdout) child.stdout.pipe(output);
  if (child.stderr) child.stderr.on('data', (data) => onLog && onLog(`${label}: ${data.toString().trim()}`));
  if (child.stdin) {
    // ffmpeg going away closes its stdin. Without this handler the error is
    // re-thrown by pipe() and takes the whole process (and every account) down.
    child.stdin.on('error', () => {});
  }
  if (child.on) child.on('error', (error) => onError && onError(error));
  if (child.on) child.on('close', (code, signal) => {
    output.end();
    if (onExit) onExit(code, signal);
  });

  return {
    process: child,
    input: child.stdin,
    output,
    kill() {
      try { child.kill(); } catch (error) { /* already gone */ }
      try { output.end(); } catch (error) { /* already closed */ }
    },
  };
}

// Decodes any ffmpeg-readable file into raw Float32 LE stereo 48 kHz PCM.
function createDecoder(options = {}) {
  const { ffmpegPath, filePath, spawnImpl = spawn, onLog, onError, onExit, onData, loop = false, realtime = false } = options;

  if (!ffmpegPath) {
    throw new Error('createDecoder requires an ffmpeg path');
  }

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (realtime) args.push('-re');
  if (loop) args.push('-stream_loop', '-1');
  args.push('-i', filePath, '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1');

  const child = spawnImpl(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // ffmpeg explains itself on stderr; keep the tail so a failure can say why.
  let stderrTail = '';
  let stdoutPaused = false;
  const rememberStderr = (data) => {
    stderrTail = (stderrTail + data.toString()).split('\n').filter(Boolean).slice(-4).join(' | ').trim();
    if (onLog) onLog(`decoder: ${data.toString().trim()}`);
  };

  if (child.stdout) child.stdout.on('data', (data) => onData && onData(data));
  if (child.stderr) child.stderr.on('data', rememberStderr);
  if (child.on) child.on('error', (error) => onError && onError(error));
  if (child.on) child.on('close', (code, signal) => {
    if (onExit) onExit(code, signal, stderrTail);
  });

  return {
    process: child,
    pause() {
      if (stdoutPaused || !child.stdout) return;
      stdoutPaused = true;
      child.stdout.pause();
    },
    resume() {
      if (!stdoutPaused || !child.stdout) return;
      stdoutPaused = false;
      child.stdout.resume();
    },
    kill() {
      stdoutPaused = false;
      try { child.kill(); } catch (error) { /* already gone */ }
    },
  };
}

module.exports = {
  SAMPLE_RATE,
  CHANNELS,
  SAMPLE_BYTES,
  BYTES_PER_FRAME,
  BLOCK_FRAMES,
  PcmMixer,
  buildLoudnessFilter,
  createEncoder,
  createDecoder,
};
