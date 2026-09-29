const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// --- ffmpeg stand-in: pipes PCM through so the whole chain is observable ----
function fakeSpawn(command, args) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    child.stdin.end();
    child.stdout.end();
    setImmediate(() => child.emit('close', 0));
  };

  if (args.includes('pipe:0')) {
    child.stdin.pipe(child.stdout);
  } else {
    // Decoder stand-in: bursts far faster than real time (8 blocks per 20 ms),
    // which is what ffmpeg really does. The server must pace this itself.
    // Blocks are Float32 stereo, 20 ms each, like a real f32le decode.
    const block = Buffer.alloc(7680);
    let timer = setInterval(() => {
      if (child.killed) {
        clearInterval(timer);
        return;
      }
      block.fill(0);
      for (let offset = 0; offset < 3840; offset += 4) block.writeFloatLE(0.1, offset);
      for (let count = 0; count < 8; count++) child.stdout.write(block);
    }, 20);
    child.kill = () => {
      clearInterval(timer);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    };
  }

  return child;
}

// --- Discord stand-ins ----------------------------------------------------
const voiceConnections = [];

function makeFakeConnection(options) {
  const connection = new EventEmitter();
  connection.state = { status: 'ready' };
  connection.options = options;
  connection.subscribed = null;
  connection.subscribe = (player) => { connection.subscribed = player; };
  connection.destroy = () => connection.emit('stateChange', { status: 'ready' }, { status: 'destroyed' });
  voiceConnections.push(connection);
  return connection;
}

const players = [];

const stubs = {
  'discord.js-selfbot-v13': {
    Client: class extends EventEmitter {
      constructor() {
        super();
        this.setMaxListeners(50);
        this.user = null;
        this.channels = {
          fetch: async (id) => ({
            id,
            name: 'Test Voice',
            isVoice: () => true,
            guild: { id: 'guild-1', voiceAdapterCreator: {} },
          }),
        };
        this.guilds = { cache: new Map(), fetch: async () => ({ id: 'guild-1', voiceAdapterCreator: {} }) };
      }
      async login(token) {
        this.user = { id: `user-${token.slice(0, 4)}`, tag: `tester#${token.slice(0, 4)}` };
        setImmediate(() => this.emit('ready'));
        return this;
      }
      destroy() { this.emit('destroy'); }
    },
  },
  '@discordjs/voice': {
    joinVoiceChannel: makeFakeConnection,
    createAudioPlayer: () => {
      const player = new EventEmitter();
      player.play = (resource) => { player.resource = resource; };
      player.stop = () => { player.resource = null; };
      players.push(player);
      return player;
    },
    createAudioResource: (stream) => {
      // The real AudioPlayer consumes the stream in real time; without any
      // consumer the stream stalls and the mixer correctly throttles itself.
      if (stream && typeof stream.on === 'function') stream.on('data', () => {});
      return { stream, volume: { setVolume() {} } };
    },
    NoSubscriberBehavior: { Play: 'play', Pause: 'pause', Stop: 'stop' },
    StreamType: { Raw: 'raw', OggOpus: 'ogg_opus' },
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' },
    entersState: async (connection, status) => {
      if (connection.state.status === status) return connection;
      throw new Error(`never reached ${status}`);
    },
  },
  'ffmpeg-static': path.join(__dirname, 'fake-ffmpeg'),
  child_process: { ...require('child_process'), spawn: fakeSpawn },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.apply(this, arguments);
};

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yadav-test-'));
const tokenFilePath = path.join(workDir, 'tokens.txt');
fs.writeFileSync(tokenFilePath, '# comment line\ntoken-aaaa1111\ntoken-bbbb2222\n');

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.TOKENS_FILE = tokenFilePath;
process.env.AUDIO_FILE = path.join(workDir, 'shared_audio.mp3');
process.env.MAX_BOTS = '0';
// Also covers the optional gate on the endpoints that touch the raw file.
process.env.TOKEN_FILE_KEY = 'test-file-key';

const app = require('../kolaru');
const { WebSocket } = require('ws');

let baseUrl = '';

test.before(async () => {
  if (!app.server.listening) {
    await new Promise((resolve) => app.server.once('listening', resolve));
  }
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(() => {
  app.shutdownAll();
  app.stopHeartbeat();
  app.server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  Module._load = originalLoad;
});

const FILE_KEY = 'test-file-key';

async function request(pathname, options) {
  try {
    return await fetch(baseUrl + pathname, options);
  } catch (error) {
    throw new Error(`${pathname} request failed: ${error.message} (${error.cause ? error.cause.message : 'no cause'})`);
  }
}

async function getJson(pathname) {
  const res = await request(pathname);
  return { status: res.status, body: await res.json() };
}

async function postJson(pathname, body) {
  const res = await request(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

// Token file endpoints: same as postJson but sends the file key.
async function filePost(pathname, body, key = FILE_KEY) {
  const res = await request(pathname, {
    method: 'POST',
    headers: key ? { 'Content-Type': 'application/json', 'x-token-key': key } : { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

async function fileGet(pathname, key = FILE_KEY) {
  const res = await request(pathname, key ? { headers: { 'x-token-key': key } } : {});
  return { status: res.status, body: await res.json() };
}

test('token file is the only source of tokens', async () => {
  const { status, body } = await getJson('/settings');
  assert.equal(status, 200);
  assert.equal(body.tokenFile.path, tokenFilePath);
  assert.equal(body.tokenFile.count, 2, 'comment line must be ignored');
  assert.equal(body.tokenFile.lastTrigger, 'startup');
  assert.equal(app.bots.length, 2);

  const tokens = await getJson('/tokens');
  assert.equal(tokens.body.tokens.length, 2);
  assert.equal(tokens.body.tokens[0].masked, 'token-aa...1111');
  assert.equal(tokens.body.tokens[0].token, undefined, 'raw tokens must not be exposed');

  const rejected = await postJson('/tokens/add', { token: 'token-cccc3333' });
  assert.equal(rejected.status, 410);
  assert.match(rejected.body.error, /token file/i);
});

test('dashboard, token file and mic routing pages render', async () => {
  const home = await fetch(baseUrl + '/');
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, /Token Manager/);
  assert.match(homeHtml, /id="addBulkBtn"/, 'bulk add from the dashboard');
  assert.match(homeHtml, /\/token-file/);
  assert.match(homeHtml, /\/mic-route/);
  assert.doesNotMatch(homeHtml, /__NEXT__/);

  const tokenFile = await fetch(baseUrl + '/token-file');
  const tokenFileHtml = await tokenFile.text();
  assert.equal(tokenFile.status, 200);
  assert.match(tokenFileHtml, /Token File/);
  assert.match(tokenFileHtml, /id="bulkInput"/);
  assert.match(tokenFileHtml, /id="fileText"/);
  assert.doesNotMatch(tokenFileHtml, /__NEXT__/);

  const mic = await fetch(baseUrl + '/mic-route');
  const micHtml = await mic.text();
  assert.equal(mic.status, 200);
  assert.match(micHtml, /Mic Routing/);
  assert.match(micHtml, /mic-worklet\.js/);

  const worklet = await fetch(baseUrl + '/mic-worklet.js');
  const workletJs = await worklet.text();
  assert.equal(worklet.status, 200);
  assert.match(workletJs, /registerProcessor\('veera-pcm-tap'/);
});

test('loudness controls drive the mixer and the ffmpeg chain', async () => {
  const { status, body } = await postJson('/audio/loudness', { volume: 30, drive: 60, targetLufs: -9 });
  assert.equal(status, 200);
  assert.equal(app.loudness.volume, 30);
  assert.equal(app.loudness.drive, 60);
  assert.equal(app.loudness.targetLufs, -9);
  assert.match(body.filter, /acompressor=/);
  assert.match(body.filter, /loudnorm=I=-9\.0/);
  assert.match(body.filter, /alimiter=/);
  assert.equal(app.buses.mix.mixer.sources.get('music').gain, 30, 'volume applies instantly in the mixer');

  const legacy = await postJson('/audio/volume', { volume: 5 });
  assert.equal(legacy.status, 200);
  assert.equal(app.loudness.volume, 5);

  const off = await postJson('/audio/loudness', { drive: 0, limiter: false, targetLufs: null });
  assert.equal(off.body.filter, 'anull');
  await postJson('/audio/loudness', { volume: 30, drive: 40, targetLufs: null, limiter: true });
});

test('music is paced to real time even when the decoder bursts', async () => {
  fs.writeFileSync(process.env.AUDIO_FILE, 'fake-audio-payload');
  const play = await postJson('/audio/play');
  assert.equal(play.status, 200);
  assert.equal(play.body.status, 'playing');

  const mixer = app.buses.mix.mixer;
  let rendered = 0;
  let nonSilent = 0;
  const original = mixer.renderBlock.bind(mixer);
  mixer.renderBlock = () => {
    rendered++;
    const block = original();
    if (block.some((byte) => byte !== 0)) nonSilent++;
    return block;
  };

  await new Promise((resolve) => setTimeout(resolve, 1500));
  mixer.renderBlock = original;

  const perSecond = rendered / 1.5;
  const ratio = (100 * nonSilent) / rendered;
  console.log(`      rendered ${rendered} blocks (${perSecond.toFixed(1)}/s), audio in ${ratio.toFixed(0)}% of them`);

  assert.ok(perSecond > 30 && perSecond < 70, `mixer should run near 50 blocks/s (got ${perSecond.toFixed(1)})`);
  assert.ok(ratio > 80, `audio should be present in nearly every block (got ${ratio.toFixed(0)}%)`);
  assert.ok(app.musicBuffered <= 1200 * 384000 / 48, 'the decoder is throttled, not buffered to the brim');

  const stop = await postJson('/audio/stop');
  assert.equal(stop.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.musicBuffered, 0, 'stopping clears the mixers');
});

test('mic audio streams over the websocket into the mix buses', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/mic/stream`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  socket.send(JSON.stringify({ type: 'format', channels: 1, sampleRate: 48000 }));

  const frame = Buffer.alloc(960 * 2);
  for (let index = 0; index < 960; index++) frame.writeInt16LE(8000, index * 2);
  for (let count = 0; count < 5; count++) socket.send(frame);

  // A real mic keeps sending, and refreshGains() runs on a 200 ms timer.
  const sender = setInterval(() => socket.send(frame), 20);
  await new Promise((resolve) => setTimeout(resolve, 450));
  clearInterval(sender);

  const status = await getJson('/mic/status');
  assert.equal(status.body.clients, 1);
  assert.ok(status.body.packets >= 5, `expected the frames to be counted (got ${status.body.packets})`);
  assert.equal(status.body.active, true);
  assert.equal(status.body.channels, 1);
  assert.ok(app.buses.mix.mixer.sources.get('mic').received > 0, 'mic reached the mix bus');
  assert.ok(app.buses.mic.mixer.sources.get('mic').received > 0, 'mic reached the mic-only bus');
  assert.equal(app.buses.music.mixer.sources.has('mic'), false, 'music-only bus stays clean');

  // Music is ducked while the mic is live.
  assert.ok(app.buses.mix.mixer.sources.get('music').gain < 30, 'music is ducked');

  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await getJson('/mic/status')).body.clients, 0);
});

test('routing picks the bus each account subscribes to', async () => {
  for (let attempt = 0; attempt < 40 && app.bots.some((bot) => bot.status !== 'ready'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(app.bots.every((bot) => bot.status === 'ready'), 'stubbed clients reach ready');

  await postJson('/mic/routing', { default: 'music', bots: { 0: 'mic' } });
  assert.equal(app.routing.default, 'music');
  assert.equal(app.routing.bots['0'], 'mic');

  const joined = await postJson('/join', { channelId: '123456' });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.joinedAll, true);

  const connections = voiceConnections.slice(-2);
  assert.equal(connections[0].subscribed, app.buses.mic.player, 'account 1 hears the mic only');
  assert.equal(connections[1].subscribed, app.buses.music.player, 'account 2 hears music only');
  assert.ok(app.buses.mic.player, 'mic bus has its own player');
  assert.ok(app.buses.music.player, 'music bus has its own player');
  assert.notEqual(app.buses.mic.player, app.buses.music.player);

  await postJson('/mic/routing', { bots: { 0: 'off' } });
  assert.equal(voiceConnections[voiceConnections.length - 2].subscribed, null, 'off unsubscribes');

  await postJson('/mic/routing', { default: 'mix', bots: { 0: 'mix' } });
  assert.ok(app.buses.mix.player, 'mix bus starts once an account routes to it');
});

test('token file page is served and shows the add controls', async () => {
  const res = await fetch(baseUrl + '/token-file');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Token File/);
  assert.match(html, /id="singleInput"/);
  assert.match(html, /id="bulkInput"/);
  assert.match(html, /id="fileText"/);
  assert.match(html, /api\/tokens\/save/);
  assert.doesNotMatch(html, /__NEXT__/);
});

test('tokens can be added one at a time or in bulk, and the file page can rewrite the file', async () => {
  assert.equal((await getJson('/settings')).body.tokenFile.protected, true, 'key gate is on');

  // Bulk paste: newline separated, comma separated, a blank line and a comment.
  const bulk = await filePost('/api/tokens/append', {
    tokens: 'token-dddd4444\n\ntoken-eeee5555, token-ffff6666\n# a comment\ntoken-dddd4444',
  });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.body.added, 3, 'duplicates, blanks and comments are ignored');
  assert.equal(bulk.body.count, 5);

  // One at a time.
  const single = await filePost('/api/tokens/append', { token: 'token-gggg7777' });
  assert.equal(single.body.added, 1);
  assert.equal(single.body.count, 6);

  const again = await filePost('/api/tokens/append', { token: 'token-gggg7777' });
  assert.equal(again.body.added, 0, 're-adding the same token is a no-op');

  const file = await fileGet('/api/tokens/file');
  assert.equal(file.status, 200);
  assert.deepEqual(
    file.body.content.trim().split('\n'),
    ['token-aaaa1111', 'token-bbbb2222', 'token-dddd4444', 'token-eeee5555', 'token-ffff6666', 'token-gggg7777'],
  );
  assert.equal(file.body.tokenFile.count, 6);
  assert.equal(app.tokens.length, 6, 'every added token became an account');

  // Those endpoints refuse to work without the key.
  assert.equal((await fileGet('/api/tokens/file', '')).status, 401);
  assert.equal((await filePost('/api/tokens/append', { token: 'sneaky' }, 'wrong')).status, 401);
  assert.equal((await filePost('/api/tokens/save', { content: 'sneaky' }, '')).status, 401);
  assert.equal(app.tokens.length, 6, 'rejected writes changed nothing');

  // Rewriting the whole file from the page syncs accounts in and out.
  const save = await filePost('/api/tokens/save', { content: 'token-hhhh8888\ntoken-iiii9999\n' });
  assert.equal(save.status, 200);
  assert.equal(save.body.count, 2);
  assert.equal(save.body.added, 2, 'the two new tokens logged in');
  assert.equal(save.body.removed, 6, 'the six old ones logged out');
  assert.equal(app.tokens.length, 2);
  assert.equal(app.bots.length, 2);
  assert.equal(fs.readFileSync(tokenFilePath, 'utf8'), 'token-hhhh8888\ntoken-iiii9999\n');
});

test('join reports per-account reasons instead of a generic channel error', async () => {
  // One stubbed account has no access to the channel at all.
  const blocked = app.bots[0];
  const originalFetch = blocked.client.channels.fetch;
  blocked.client.channels.fetch = async () => {
    const error = new Error('Missing Access');
    error.code = 50035;
    throw error;
  };

  const joined = await postJson('/join', { channelId: '999' });
  blocked.client.channels.fetch = originalFetch;

  assert.equal(joined.status, 200);
  assert.equal(joined.body.connected, app.bots.length - 1, 'only the blocked account fails');
  assert.equal(joined.body.total, app.bots.length);
  assert.equal(joined.body.joinedAll, false);
  assert.match(joined.body.results[0].lastError, /Missing Access/);
  assert.match(joined.body.results[0].lastError, /not in that server/i, 'says what to actually do');
  assert.match(joined.body.status, /\d+\/\d+ account\(s\) connected/);
});

test('an empty upload is rejected before it can break playback', async () => {
  const res = await fetch(`${baseUrl}/audio/upload`, { method: 'POST', body: Buffer.alloc(0) });
  const payload = await res.json();
  assert.equal(res.status, 400);
  assert.match(payload.error, /empty/i);
});

test('voice channels can be listed for an account', async () => {
  const { status, body } = await getJson('/channels');
  assert.equal(status, 200);
  assert.ok(body.readyAccounts >= 1, 'reports how many accounts are ready');
  assert.ok(Array.isArray(body.guilds));
});

test('volume changes do not restart the ffmpeg buses', async () => {
  const before = app.buses.mix.encoder;
  await postJson('/audio/loudness', { volume: 9, micGain: 4, duckLevel: 0.5 });
  assert.equal(app.buses.mix.encoder, before, 'mixer-side settings are instant, no respawn');

  const beforeDrive = app.buses.mix.encoder;
  await postJson('/audio/loudness', { drive: 55 });
  assert.notEqual(app.buses.mix.encoder, beforeDrive, 'a drive change does rebuild the chain');

  await postJson('/audio/loudness', { volume: 12, drive: 40 });
});

test('the mixer can buffer at least as much as the decoder throttle allows', () => {
  // 48 kHz stereo Float32 = 384000 bytes/second, 8 bytes per frame.
  const bufferBytes = app.MUSIC_SOURCE_FRAMES * 8;
  assert.ok(
    bufferBytes >= app.MUSIC_PAUSE_BYTES,
    `source buffer (${bufferBytes} B) must hold the pause threshold (${app.MUSIC_PAUSE_BYTES} B), `
    + 'otherwise the decoder outruns the mixer and audio is dropped',
  );
  assert.ok(app.MUSIC_PAUSE_BYTES > app.MUSIC_RESUME_BYTES, 'hysteresis, or it thrashes pause/resume');
  assert.ok(bufferBytes <= 2 * 1024 * 1024, 'and it stays small enough to be memory-safe');
});

test('reloading the token file logs accounts in and out', async () => {
  fs.appendFileSync(tokenFilePath, 'token-cccc3333\n');
  const reloaded = await postJson('/tokens/reload');
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.added, 1);
  assert.equal(reloaded.body.count, 3);
  assert.equal(app.bots.length, 3);

  const removed = await postJson('/tokens/delete', { index: 0 });
  assert.equal(removed.status, 200);
  assert.equal(app.tokens.length, 2);
  assert.equal(app.bots.length, 2);

  const fileLines = fs.readFileSync(tokenFilePath, 'utf8').trim().split('\n');
  assert.deepEqual(fileLines, ['token-iiii9999', 'token-cccc3333'], 'file is rewritten, one token per line');
});
