const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { PcmMixer, buildLoudnessFilter, createEncoder, BLOCK_FRAMES, BYTES_PER_FRAME } = require('../audio-pipeline');

// Float32 LE samples: the format the mixer works in.
function pcm(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function sampleAt(buffer, index) {
  return buffer.readFloatLE(index * 4);
}

test('PcmMixer emits fixed 20 ms blocks and sums sources', () => {
  const mixer = new PcmMixer();
  assert.equal(mixer.blockBytes, BLOCK_FRAMES * BYTES_PER_FRAME);

  mixer.writeSource('music', pcm(new Array(BLOCK_FRAMES * 2).fill(0.5)));
  mixer.writeSource('mic', pcm(new Array(BLOCK_FRAMES * 2).fill(0.25)));

  const block = mixer.renderBlock();
  assert.equal(block.length, BLOCK_FRAMES * BYTES_PER_FRAME);
  assert.equal(sampleAt(block, 0), 0.75);
  assert.equal(sampleAt(block, 1), 0.75, 'both channels of the frame are summed');
});

test('PcmMixer pads with silence when a source runs dry', () => {
  const mixer = new PcmMixer({ blockFrames: 2 });
  // Two blocks worth of audio: 2 frames * 2 channels * 2 samples.
  mixer.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]));

  assert.equal(sampleAt(mixer.renderBlock(), 0), 0.5);
  assert.equal(sampleAt(mixer.renderBlock(), 0), 0.5);
  const silent = mixer.renderBlock();
  assert.equal(sampleAt(silent, 0), 0, 'no signal, no stall');
  assert.equal(silent.length, 2 * BYTES_PER_FRAME);
});

test('PcmMixer gains in float, so big boosts never wrap', () => {
  const boosted = new PcmMixer({ blockFrames: 2 });
  boosted.setSourceGain('music', 12);
  boosted.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5]));
  assert.equal(sampleAt(boosted.renderBlock(), 0), 6, '12x of 0.5 stays 6, not clipped');

  const hot = new PcmMixer({ blockFrames: 2 });
  hot.setSourceGain('a', 30);
  hot.setSourceGain('b', 30);
  hot.writeSource('a', pcm([0.9, 0.9, 0.9, 0.9]));
  hot.writeSource('b', pcm([0.9, 0.9, 0.9, 0.9]));
  const summed = sampleAt(hot.renderBlock(), 0);
  assert.equal(summed, 54, 'two loud sources add up instead of wrapping negative');
  assert.ok(summed > 1, 'ffmpeg sees the true level and does the limiting');

  const disabled = new PcmMixer({ blockFrames: 2 });
  disabled.setSourceEnabled('music', false);
  disabled.writeSource('music', pcm([0.5, 0.5, 0.5, 0.5]));
  assert.equal(sampleAt(disabled.renderBlock(), 0), 0);
});

test('PcmMixer caps the per-source buffer so a fast decoder cannot grow memory', () => {
  const mixer = new PcmMixer({ blockFrames: 1, maxPendingFrames: 4 });
  mixer.writeSource('music', pcm(new Array(64).fill(0.5)));
  assert.ok(mixer.sources.get('music').pending.length <= 4 * BYTES_PER_FRAME);
});

test('PcmMixer clocks itself and never buffers faster than real time', async () => {
  const mixer = new PcmMixer({ blockFrames: 960 });
  assert.equal(mixer.timer, null);

  mixer.start();
  assert.ok(mixer.timer, 'start() arms the wall clock');

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(mixer.readableLength > 0, 'blocks are produced without a consumer');
  assert.ok(
    mixer.readableLength <= mixer.blockBytes * 3,
    `slow consumer must not grow the buffer (${mixer.readableLength} bytes)`,
  );

  mixer.stop();
  const frozen = mixer.readableLength;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(mixer.readableLength, frozen, 'stop() halts the clock');

  mixer.destroy();
});

test('buildLoudnessFilter adds compression and limiting', () => {
  assert.equal(buildLoudnessFilter({ drive: 0, limiter: false }), 'anull');

  const boosted = buildLoudnessFilter({ drive: 40, limiter: true });
  assert.match(boosted, /^acompressor=/);
  assert.match(boosted, /alimiter=limit=0\.95/);
  assert.match(boosted, /level=disabled/, 'the limit has to be respected, not auto-normalised');

  const loudnormed = buildLoudnessFilter({ targetLufs: -9 });
  assert.match(loudnormed, /loudnorm=I=-9\.0/);

  assert.match(buildLoudnessFilter({ targetLufs: -80 }), /I=-31\.0/, 'LUFS is clamped to a sane range');
  assert.match(buildLoudnessFilter({ targetLufs: 'nonsense' }), /alimiter/, 'garbage target falls back to drive+limiter');
});

test('createEncoder pipes raw PCM through the injected ffmpeg', async () => {
  const spawned = [];
  const spawnImpl = (command, args) => {
    spawned.push({ command, args });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.pipe(child.stdout);
    return child;
  };

  const encoder = createEncoder({ ffmpegPath: 'fake-ffmpeg', filter: 'alimiter', spawnImpl });
  encoder.input.write(pcm([0.5, -0.5, 1, 0.25]));

  const output = await new Promise((resolve) => encoder.output.once('data', resolve));
  assert.equal(output.length, 16, 'four float samples came through unchanged');

  const { args } = spawned[0];
  assert.ok(args.includes('pipe:0'));
  assert.ok(args.includes('pipe:1'));
  assert.equal(args[args.indexOf('-af') + 1], 'alimiter');
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args[args.indexOf('-ac') + 1], '2');
  assert.equal(args[args.indexOf('-f') + 1], 'f32le', 'float in, so mixer gains cannot clip');
  assert.ok(args.includes('s16le'), 'Int16 out for Discord');
});
