require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const { PcmMixer, buildLoudnessFilter, createEncoder, createDecoder, INT16_SAMPLE_BYTES, INT16_BYTES_PER_FRAME } = require('./audio-pipeline');
const { readTokenFile, writeTokenFile, diffTokenLists, mergeTokenFile } = require('./token-store');
const { renderHomePage } = require('./views/home');
const { renderMicRoutePage } = require('./views/mic-route');
const { renderTokenFilePage } = require('./views/token-file');

const MIC_WORKLET_SOURCE = `class VeeraPcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = options.processorOptions || {};
    this.blockFrames = opts.blockFrames || 960;
    this.buffer = new Float32Array(this.blockFrames);
    this.offset = 0;
  }
  process(inputs) {
    var input = inputs[0];
    var channel = input && input[0];
    if (!channel) return true;
    for (var i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === this.blockFrames) {
        var pcm = new Int16Array(this.blockFrames);
        for (var j = 0; j < this.blockFrames; j++) {
          var sample = this.buffer[j] < -1 ? -1 : (this.buffer[j] > 1 ? 1 : this.buffer[j]);
          pcm[j] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        this.port.postMessage({ type: 'pcm', buffer: pcm.buffer }, [pcm.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('veera-pcm-tap', VeeraPcmTap);
`;

function parseList(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const autoJoin = (process.env.AUTO_JOIN || 'false').toLowerCase() === 'true';
const channelIds = parseList(process.env.VOICE_CHANNEL_IDS || process.env.VOICE_CHANNEL_ID || process.env.CHANNEL_ID || '');
const host = process.env.HOST || process.env.HOSTNAME || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const keepAliveMs = Number(process.env.KEEPALIVE_MS || 15000);
const ffmpegPath = process.env.FFMPEG_PATH || ffmpeg;
const sharedAudioPath = path.resolve(process.cwd(), process.env.AUDIO_FILE || './shared_audio.mp3');
const tokenFilePath = path.resolve(process.cwd(), process.env.TOKENS_FILE || 'tokens.txt');
const tokenFileEnv = process.env.BOT_TOKENS || process.env.BOT_TOKEN || '';
// Optional gate for the endpoints that can read or write the raw token file.
const tokenFileKey = (process.env.TOKEN_FILE_KEY || '').trim();

const loudness = {
  volume: clampNumber(process.env.AUDIO_VOLUME, 0.5, 100, 12),
  drive: clampNumber(process.env.AUDIO_DRIVE, 0, 100, 40),
  limiter: (process.env.AUDIO_LIMITER || 'true').toLowerCase() !== 'false',
  targetLufs: process.env.AUDIO_TARGET_LUFS ? clampNumber(process.env.AUDIO_TARGET_LUFS, -31, -4, null) : null,
  duckMusic: (process.env.AUDIO_DUCK_MUSIC || 'true').toLowerCase() !== 'false',
  duckLevel: clampNumber(process.env.AUDIO_DUCK_LEVEL, 0, 1, 0.35),
  micGain: clampNumber(process.env.MIC_GAIN, 0.1, 20, 6),
};

const routing = {
  default: ['mix', 'music', 'mic', 'off'].includes(process.env.MIC_ROUTE_DEFAULT) ? process.env.MIC_ROUTE_DEFAULT : 'mix',
  bots: {},
};

const micState = { clients: new Set(), packets: 0, lastPacketAt: null, channels: 1 };
const tokenSync = { lastSyncAt: null, lastTrigger: 'startup', added: 0, removed: 0 };
let tokens = [];

// --- TOKEN FILE IS THE ONLY SOURCE OF TRUTH -------------------------------
function seedTokenFile() {
  if (readTokenFile(tokenFilePath).length > 0 || !tokenFileEnv.trim()) return;

  try {
    writeTokenFile(tokenFilePath, tokenFileEnv);
    console.log(`📝 Seeded ${tokenFilePath} from BOT_TOKENS/BOT_TOKEN (one-time migration).`);
  } catch (error) {
    console.warn(`⚠️ Could not write ${tokenFilePath}: ${error.message}`);
  }
}

function syncTokensFromFile(trigger = 'manual') {
  const fileTokens = readTokenFile(tokenFilePath);
  const { added, removed } = diffTokenLists(tokens, fileTokens);
  tokens = fileTokens;

  for (const token of removed) {
    const index = bots.findIndex((bot) => bot.token === token);
    if (index === -1) continue;
    const [bot] = bots.splice(index, 1);
    console.log(`🗑️ [${trigger}] Token ${maskToken(token)} removed from ${path.basename(tokenFilePath)}; logging out.`);
    bot.shutdown();
  }

  for (const token of added) {
    if (bots.some((bot) => bot.token === token)) continue;
    const bot = createBot(token, bots.length);
    bots.push(bot);
    console.log(`➕ [${trigger}] Token ${maskToken(token)} added from ${path.basename(tokenFilePath)}.`);
    loginBot(bot, bots.length - 1);
  }

  tokenSync.lastSyncAt = new Date().toISOString();
  tokenSync.lastTrigger = trigger;
  tokenSync.added = added.length;
  tokenSync.removed = removed.length;

  if (added.length === 0 && removed.length === 0) {
    console.log(`👀 [${trigger}] No token file changes (${tokens.length} token(s)).`);
  }

  return { added: added.length, removed: removed.length, count: tokens.length };
}

function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 12) return '***';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function tokenFileAllowed(req) {
  if (!tokenFileKey) return true;
  const provided = req.headers['x-token-key'];
  return typeof provided === 'string' && provided === tokenFileKey;
}

function describeTokenFile() {
  return {
    path: tokenFilePath,
    exists: fs.existsSync(tokenFilePath),
    count: tokens.length,
    lastSyncAt: tokenSync.lastSyncAt,
    lastTrigger: tokenSync.lastTrigger,
    added: tokenSync.added,
    removed: tokenSync.removed,
    protected: Boolean(tokenFileKey),
  };
}

function watchTokenFile() {
  fs.watchFile(tokenFilePath, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    clearTimeout(watchTokenFile.timer);
    watchTokenFile.timer = setTimeout(() => {
      console.log(`📄 ${path.basename(tokenFilePath)} changed on disk.`);
      syncTokensFromFile('file-watch');
    }, 400);
  });
}

// --- AUDIO BUSES ----------------------------------------------------------
// Every bus is a live PCM mixer -> ffmpeg loudness chain -> audio player.
// Sources that run dry are padded with silence, so a bus never stalls.
// The mixers hold a few hundred ms of source so a fast decoder never has to
// drop audio, and the decoder is throttled against that (see pushMusicChunk).
// 28800 frames at 48 kHz = 600 ms, i.e. a 230 kB buffer per source.
const MUSIC_SOURCE_FRAMES = 28800;
const buses = {
  mix: { mixer: new PcmMixer({ maxPendingFrames: MUSIC_SOURCE_FRAMES }), player: null, encoder: null, resource: null, retryTimer: null, broken: false },
  music: { mixer: new PcmMixer({ maxPendingFrames: MUSIC_SOURCE_FRAMES }), player: null, encoder: null, resource: null, retryTimer: null, broken: false },
  mic: { mixer: new PcmMixer(), player: null, encoder: null, resource: null, retryTimer: null, broken: false },
};

function currentFilter() {
  return buildLoudnessFilter(loudness);
}

function stopBus(name) {
  const bus = buses[name];
  if (!bus) return;

  bus.mixer.unpipe();
  bus.mixer.stop();
  if (bus.encoder) {
    bus.encoder.kill();
    bus.encoder = null;
  }
  if (bus.player) {
    try { bus.player.stop(true); } catch (error) { /* already stopped */ }
  }
  bus.resource = null;
}

function startBus(name) {
  const bus = buses[name];
  if (!bus || bus.encoder) return false;

  try {
    if (!bus.player) {
      bus.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      bus.player.on('error', (error) => console.error(`❌ Bus ${name} player error:`, error.message));
    }

    // The handlers ignore a stale encoder, so an intentional restart (kill on
    // stopBus) never looks like a crash and never triggers the retry loop.
    const encoder = createEncoder({
      ffmpegPath,
      filter: currentFilter(),
      label: `bus ${name}`,
      onLog: (message) => message && console.error(`FFmpeg [${name}]:`, message),
      onError: (error) => {
        if (bus.encoder !== encoder) return;
        bus.encoder = null;
        bus.broken = true;
        console.error(`❌ ffmpeg encoder for bus "${name}" failed: ${error.message}`);
        scheduleBusRetry(name);
      },
      onExit: (code) => {
        if (bus.encoder !== encoder) return;
        bus.encoder = null;
        bus.broken = true;
        console.error(`⚠️ ffmpeg encoder for bus "${name}" exited with code ${code}.`);
        scheduleBusRetry(name);
      },
    });

    bus.encoder = encoder;
    bus.mixer.start();
    bus.mixer.pipe(encoder.input);
    bus.resource = createAudioResource(encoder.output, {
      inputType: StreamType.Raw,
      inlineVolume: false,
    });
    bus.player.play(bus.resource);
    bus.broken = false;
    console.log(`🔊 Bus "${name}" running (${currentFilter()}).`);
    return true;
  } catch (error) {
    bus.broken = true;
    console.error(`❌ Could not start bus "${name}":`, error.message);
    scheduleBusRetry(name);
    return false;
  }
}

function scheduleBusRetry(name) {
  const bus = buses[name];
  if (!bus || bus.retryTimer) return;
  bus.retryTimer = setTimeout(() => {
    bus.retryTimer = null;
    if (!bus.broken) return;
    console.log(`🔁 Retrying bus "${name}"...`);
    startBus(name);
  }, 15000);
}

function applyLoudnessFilter() {
  for (const name of Object.keys(buses)) {
    if (!buses[name].encoder) continue;
    stopBus(name);
    startBus(name);
  }
  applyRouting();
}

function isMicActive() {
  return Boolean(micState.lastPacketAt) && Date.now() - micState.lastPacketAt < 250;
}

function refreshGains() {
  const ducked = isMicActive() && loudness.duckMusic;
  const musicGain = loudness.volume * (ducked ? loudness.duckLevel : 1);

  buses.mix.mixer.setSourceGain('music', musicGain);
  buses.music.mixer.setSourceGain('music', musicGain);
  buses.mix.mixer.setSourceGain('mic', loudness.micGain);
  buses.mic.mixer.setSourceGain('mic', loudness.micGain);
}

// The browser sends Int16 mono; the mixer works in float stereo.
function micToStereoFloat(buffer, channels) {
  const samples = Math.floor(buffer.length / INT16_SAMPLE_BYTES);
  const alreadyStereo = channels === 2 && samples % 2 === 0;
  const out = Buffer.allocUnsafe(alreadyStereo ? samples * 4 : samples * 8);

  for (let index = 0; index < samples; index++) {
    const sample = buffer.readInt16LE(index * INT16_SAMPLE_BYTES) / 32768;
    if (alreadyStereo) {
      out.writeFloatLE(sample, index * 4);
    } else {
      out.writeFloatLE(sample, index * 8);
      out.writeFloatLE(sample, index * 8 + 4);
    }
  }
  return out;
}

function pushMicChunk(chunk, channels) {
  if (!chunk || !chunk.length) return;
  const stereo = micToStereoFloat(chunk, channels || 1);
  buses.mix.mixer.writeSource('mic', stereo);
  buses.mic.mixer.writeSource('mic', stereo);
  micState.packets += 1;
  micState.lastPacketAt = Date.now();
}

let musicError = null;

function musicPending() {
  return Math.max(
    buses.mix.mixer.sourcePending('music'),
    buses.music.mixer.sourcePending('music'),
  );
}

function pushMusicChunk(chunk) {
  if (!chunk || !chunk.length) return;

  buses.mix.mixer.writeSource('music', chunk);
  buses.music.mixer.writeSource('music', chunk);
}

let musicDecoder = null;

// Decodes half a second to check ffmpeg can actually read the file, and
// returns a human-readable reason when it cannot.
function probeAudio(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) {
      resolve('the file is missing');
      return;
    }

    const size = fs.statSync(filePath).size;
    if (size === 0) {
      resolve('the file is empty (0 bytes)');
      return;
    }

    let child;
    try {
      child = require('child_process').spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-t', '0.5', '-i', filePath, '-f', 'null', '-',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve(`ffmpeg could not start: ${error.message}`);
      return;
    }

    let reason = '';
    child.stderr.on('data', (data) => {
      reason = (reason + data.toString()).split('\n').filter(Boolean).slice(-2).join(' ').trim();
    });
    child.on('error', (error) => resolve(`ffmpeg could not start: ${error.message}`));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(null);
        return;
      }
      // ffmpeg names the file in its complaint; the user does not care about our
      // temp path, only what is wrong with the audio.
      const clean = reason
        .split(filePath).join('the file')
        .split(path.basename(filePath)).join('the file')
        .replace(/\s+/g, ' ')
        .trim();

      resolve(clean || (size < 4096
        ? 'it is not audio data (too small and ffmpeg reported nothing)'
        : `ffmpeg exited with code ${code}`));
    });
  });
}

function playGlobalAudio() {
  if (!fs.existsSync(sharedAudioPath)) return false;
  stopGlobalAudio();

  const decoder = createDecoder({
    ffmpegPath,
    filePath: sharedAudioPath,
    realtime: true,
    onData: pushMusicChunk,
    onError: (error) => console.error('❌ ffmpeg decoder failed:', error.message),
    onExit: (code, signal, reason) => {
      // Stopping playback kills the decoder on purpose; that is not a failure.
      if (musicDecoder !== decoder) return;
      musicDecoder = null;
      if (code === 0) return;

      probeAudio(sharedAudioPath).then((problem) => {
        musicError = problem || reason || `ffmpeg exited with code ${code}${signal ? ` (${signal})` : ''}`;
        console.error(
          `❌ Could not play ${path.basename(sharedAudioPath)}: ${musicError}. `
          + 'Upload a different file - the previous upload was kept.',
        );
      });
    },
  });
  musicDecoder = decoder;

  return true;
}

function stopGlobalAudio() {
  musicError = null;
  buses.mix.mixer.clearSource('music');
  buses.music.mixer.clearSource('music');
  if (!musicDecoder) return;
  musicDecoder.kill();
  musicDecoder = null;
}

const ROUTE_MODES = ['mix', 'music', 'mic', 'off'];

function routeForBot(index) {
  const mode = routing.bots[index] || routing.default;
  return ROUTE_MODES.includes(mode) ? mode : 'mix';
}

function applyRouting() {
  bots.forEach((bot, index) => {
    const connection = bot.getConnection();
    if (!connection) return;

    const mode = routeForBot(index);
    if (mode === 'off') {
      try { connection.subscribe(null); } catch (error) { /* connection gone */ }
      return;
    }

    startBus(mode);
    try { connection.subscribe(buses[mode].player); } catch (error) { /* connection gone */ }
  });
}

// --- BOTS -----------------------------------------------------------------
function createBot(token, index) {
  const client = new Client({ checkUpdate: false });
  let voiceConnection = null;
  let readyPromise = null;

  const waitForReady = () => {
    if (readyPromise) return readyPromise;
    if (bot.status === 'ready' || client.readyTimestamp || client.isReady?.()) {
      return Promise.resolve();
    }
    readyPromise = new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        client.off('ready', onReady);
        client.off('error', onError);
      };
      client.once('ready', onReady);
      client.once('error', onError);
    });
    return readyPromise;
  };

  const bot = {
    client,
    token,
    channelId: null,
    guildId: null,
    status: 'offline',
    voiceState: 'disconnected',
    lastError: null,
    getConnection() {
      return voiceConnection;
    },
    getTag() {
      return client.user ? client.user.tag : null;
    },
    async joinChannel(targetChannelId, targetGuildId) {
      if (!targetChannelId) return false;
      if (voiceConnection && bot.channelId === targetChannelId && voiceConnection.state?.status === 'ready') {
        console.log(`ℹ️ [Bot ${index + 1}] Already in channel ${targetChannelId}`);
        bot.voiceState = 'connected';
        applyRoutingFor(bot, index, voiceConnection);
        return true;
      }

      if (voiceConnection) {
        try { voiceConnection.destroy(); } catch (error) { /* already gone */ }
        voiceConnection = null;
      }

      bot.voiceState = 'connecting';
      bot.lastError = null;
      bot.channelId = null;
      bot.guildId = null;

      try {
        await waitForReady();

        // A 403 here means the account is not in that server (or cannot see the
        // channel), which is a very different problem from a wrong channel id.
        let fetchError = null;
        const channel = await client.channels.fetch(targetChannelId).catch((error) => {
          fetchError = error;
          return null;
        });

        if (!channel || !channel.isVoice?.()) {
          const guildCount = client.guilds?.cache?.size ?? 0;
          const code = fetchError?.code ?? fetchError?.status;
          const text = String(fetchError?.message || '');
          let message;

          if (/Missing Access|403/i.test(text) || code === 403) {
            message = `Missing Access: this account cannot see that channel. It is probably not in that `
              + `server - join it first, or pick a channel in a server it is in.`;
          } else if (/Unknown Channel|404/i.test(text) || code === 404) {
            message = `Unknown Channel: ${targetChannelId} does not exist. Copy the channel id again.`;
          } else if (channel) {
            message = `Channel ${targetChannelId} is not a voice channel.`;
          } else {
            message = `Channel ${targetChannelId} could not be read${fetchError ? `: ${text}` : ''}. `
              + `This account is in ${guildCount} server(s).`;
          }

          bot.lastError = message;
          bot.voiceState = 'failed';
          console.error(`❌ [Bot ${index + 1}] ${message}`);
          return false;
        }

        const guild = targetGuildId
          ? client.guilds.cache.get(targetGuildId) || await client.guilds.fetch(targetGuildId).catch((error) => {
            console.error(`❌ [Bot ${index + 1}] Guild fetch failed:`, error?.message || error);
            return null;
          })
          : channel.guild || await client.guilds.fetch(channel.guildId || channel.guild?.id).catch((error) => {
            console.error(`❌ [Bot ${index + 1}] Guild fetch failed:`, error?.message || error);
            return null;
          });
        if (!guild) {
          const message = `Could not resolve guild for ${channel.id}`;
          bot.lastError = message;
          bot.voiceState = 'failed';
          console.error(`❌ [Bot ${index + 1}] ${message}`);
          return false;
        }

        console.log(`✅ [Bot ${index + 1}] Joining voice channel ${channel.name} (${channel.id})`);

        let joined = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            voiceConnection = joinVoiceChannel({
              channelId: channel.id,
              guildId: guild.id,
              adapterCreator: guild.voiceAdapterCreator,
              group: client.user.id,
              selfDeaf: globalDeaf,
              selfMute: globalMute,
            });

            applyRoutingFor(bot, index, voiceConnection);

            await entersState(voiceConnection, VoiceConnectionStatus.Ready, 30000);
            joined = true;
            break;
          } catch (error) {
            const message = error?.message || String(error);
            console.error(`⚠️ [Bot ${index + 1}] Join attempt ${attempt}/3 failed: ${message}`);
            voiceConnection?.destroy();
            voiceConnection = null;
            if (attempt === 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }

        if (!joined) {
          throw new Error('Voice join failed after retries');
        }

        bot.channelId = channel.id;
        bot.guildId = guild.id;
        bot.voiceState = 'connected';
        bot.lastError = null;

        voiceConnection.on('stateChange', (oldState, newState) => {
          // Discord re-emits stateChange for every heartbeat and every audio
          // update; only real transitions are worth a log line.
          if (oldState.status === newState.status) return;

          console.log(`🔌 [Bot ${index + 1}] Voice state: ${oldState.status} -> ${newState.status}`);
          if (newState.status === 'disconnected' || newState.status === 'destroyed') {
            bot.voiceState = 'disconnected';
            console.error(`❌ [Bot ${index + 1}] Voice disconnected, attempting reconnect...`);
            setTimeout(() => {
              if (bot.channelId && bot.guildId) {
                bot.joinChannel(bot.channelId, bot.guildId).catch(() => {});
              }
            }, 5000);
          }
        });

        // Progress ping: one line per account per hour, not per keepalive.
        let lastKeepAliveLog = 0;
        setInterval(() => {
          if (!voiceConnection || voiceConnection.state.status !== 'ready') return;
          if (Date.now() - lastKeepAliveLog < 3600000) return;
          lastKeepAliveLog = Date.now();
          console.log(`💚 [Bot ${index + 1}] Still connected`);
        }, keepAliveMs);
        return true;
      } catch (error) {
        const message = error?.message || String(error);
        bot.lastError = message;
        bot.voiceState = 'failed';
        console.error(`❌ [Bot ${index + 1}] Join failed: ${message}`);
        return false;
      }
    },

    leaveChannel() {
      if (voiceConnection) {
        console.log(`🟡 [Bot ${index + 1}] Leaving voice channel ${bot.channelId}`);
        voiceConnection.destroy();
        voiceConnection = null;
        bot.channelId = null;
        bot.guildId = null;
      }
    },
    shutdown() {
      try {
        if (voiceConnection) voiceConnection.destroy();
        client.destroy();
      } catch (error) { /* already gone */ }
    },
  };

  client.on('ready', async () => {
    bot.status = 'ready';
    console.log(`✅ [Bot ${index + 1}] ${client.user.tag} is ready`);

    if (!autoJoin) {
      console.log(`🟢 [Bot ${index + 1}] Staying online without auto-joining a channel`);
      return;
    }

    const targetChannelId = channelIds[index] || channelIds[0] || null;
    if (!targetChannelId) {
      console.log(`ℹ️ [Bot ${index + 1}] AUTO_JOIN enabled but no channel id was provided`);
      return;
    }

    await bot.joinChannel(targetChannelId);
  });

  client.on('error', (error) => {
    console.error(`❌ [Bot ${index + 1}] Client error:`, error);
  });

  return bot;
}

function applyRoutingFor(bot, index, connection) {
  if (!connection) return;

  const mode = routeForBot(index);
  if (mode === 'off') {
    try { connection.subscribe(null); } catch (error) { /* connection gone */ }
    return;
  }

  startBus(mode);
  try { connection.subscribe(buses[mode].player); } catch (error) { /* connection gone */ }
}

const bots = [];
let globalMute = true;
let globalDeaf = false;

async function loginBot(bot, index) {
  bot.status = 'logging_in';
  bot.lastError = null;
  console.log(`🔐 [Bot ${index + 1}] Login started`);

  try {
    await bot.client.login(bot.token);
    console.log(`🔐 [Bot ${index + 1}] Login request completed; waiting for ready event`);
    return bot;
  } catch (error) {
    bot.status = 'offline';
    bot.lastError = error?.message || String(error);
    console.error(`❌ [Bot ${index + 1}] Login failed: ${bot.lastError}`);
    return bot;
  }
}

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled rejection:', error);
});

function shutdownAll() {
  fs.unwatchFile(tokenFilePath);
  stopGlobalAudio();
  for (const name of Object.keys(buses)) {
    stopBus(name);
    buses[name].mixer.destroy();
  }
  bots.forEach((bot) => bot.shutdown());
}

process.on('SIGTERM', () => {
  shutdownAll();
  process.exit(0);
});

process.on('SIGINT', () => {
  shutdownAll();
  process.exit(0);
});

seedTokenFile();
syncTokensFromFile('startup');
watchTokenFile();

if (tokens.length > 0) {
  // syncTokensFromFile already logged every account in.
  console.log(`🚀 ${tokens.length} account(s) started from ${tokenFilePath}`);
} else {
  console.log(`🚀 Bot manager started with no accounts. Add tokens to ${tokenFilePath}.`);
}

console.log(`🧠 Loudness chain: ${currentFilter()}`);
console.log(`🎚️  ffmpeg: ${ffmpegPath}`);
setInterval(refreshGains, 200);
refreshGains();

function describeSettings() {
  return {
    loudness: { ...loudness },
    tokenFile: describeTokenFile(),
    mic: {
      active: isMicActive(),
      clients: micState.clients.size,
      packets: micState.packets,
      channels: micState.channels,
      routing: { default: routing.default, bots: { ...routing.bots } },
    },
    audio: {
      ffmpegPath,
      filter: currentFilter(),
      playing: Boolean(musicDecoder),
      error: musicError,
      bufferedBytes: musicPending(),
      file: sharedAudioPath,
      buses: Object.fromEntries(Object.entries(buses).map(([name, bus]) => [name, { running: Boolean(bus.encoder), broken: bus.broken }])),
    },
  };
}

function botStatusPayload() {
  return bots.map((bot, index) => ({
    index: index + 1,
    ready: bot.status === 'ready',
    connected: bot.voiceState === 'connected',
    voiceState: bot.voiceState,
    channelId: bot.channelId,
    guildId: bot.guildId,
    lastError: bot.lastError,
    tag: bot.getTag(),
    route: routeForBot(index),
  }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHomePage());
    return;
  }

  if (url.pathname === '/mic-route' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMicRoutePage());
    return;
  }

  if (url.pathname === '/mic-worklet.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(MIC_WORKLET_SOURCE);
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJSON(res, 200, { status: 'ok', bots: bots.length, tokens: tokens.length });
    return;
  }

  if (url.pathname === '/settings' && req.method === 'GET') {
    sendJSON(res, 200, describeSettings());
    return;
  }

  // Voice channels an account can actually see, so nobody has to type ids.
  if (url.pathname === '/channels' && req.method === 'GET') {
    const requested = Number(url.searchParams.get('index'));
    const candidates = bots.filter((bot) => bot.status === 'ready');
    const bot = Number.isInteger(requested) && requested >= 0
      ? bots[requested]
      : candidates[0];

    if (!bot || bot.status !== 'ready') {
      sendJSON(res, 200, { guilds: [], account: null, readyAccounts: candidates.length });
      return;
    }

    try {
      const guilds = await Promise.all([...bot.client.guilds.cache.values()].map(async (guild) => {
        let channels = [...guild.channels?.cache?.values?.() || []].filter((channel) => channel.type === 2 || channel.isVoice?.());
        if (!channels.length && typeof guild.channels?.fetch === 'function') {
          try {
            const fetched = await guild.channels.fetch();
            channels = [...fetched.values()].filter((channel) => channel.type === 2 || channel.isVoice?.());
          } catch (error) { /* no permission to list them */ }
        }
        return {
          id: guild.id,
          name: guild.name,
          channels: channels.map((channel) => ({ id: channel.id, name: channel.name, bitrate: channel.bitrate })),
        };
      }));

      sendJSON(res, 200, {
        account: { index: bots.indexOf(bot) + 1, tag: bot.getTag() },
        readyAccounts: candidates.length,
        guilds: guilds.filter((guild) => guild.channels.length),
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message, guilds: [] });
    }
    return;
  }

  if (url.pathname === '/status' && req.method === 'GET') {
    const payload = botStatusPayload();
    sendJSON(res, 200, {
      bots: payload,
      joinedAll: payload.length > 0 && payload.every((bot) => bot.connected),
      loudness: { ...loudness },
      routing: { default: routing.default, bots: { ...routing.bots } },
    });
    return;
  }

  if (url.pathname === '/token-file' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderTokenFilePage());
    return;
  }

  if (url.pathname === '/api/tokens/file' && req.method === 'GET') {
    if (!tokenFileAllowed(req)) {
      sendJSON(res, 401, { error: 'Token file key required', protected: true });
      return;
    }
    const content = fs.existsSync(tokenFilePath) ? fs.readFileSync(tokenFilePath, 'utf8') : '';
    sendJSON(res, 200, { content, tokenFile: describeTokenFile() });
    return;
  }

  if (url.pathname === '/api/tokens/save' && req.method === 'POST') {
    if (!tokenFileAllowed(req)) {
      sendJSON(res, 401, { error: 'Token file key required', protected: true });
      return;
    }
    try {
      const body = await parseJSONBody(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const before = readTokenFile(tokenFilePath);
      const after = writeTokenFile(tokenFilePath, content);
      const result = syncTokensFromFile('web-save');
      sendJSON(res, 200, {
        status: `Saved ${path.basename(tokenFilePath)}: ${after.length} token(s) in the file, ${result.added} account(s) logged in, ${result.removed} logged out.`,
        count: after.length,
        added: result.added,
        removed: result.removed,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message || 'Could not save the token file' });
    }
    return;
  }

  if (url.pathname === '/api/tokens/append' && req.method === 'POST') {
    if (!tokenFileAllowed(req)) {
      sendJSON(res, 401, { error: 'Token file key required', protected: true });
      return;
    }
    try {
      const body = await parseJSONBody(req);
      const incoming = body.tokens || body.token || '';
      const merged = mergeTokenFile(tokenFilePath, incoming);
      const result = syncTokensFromFile('web-add');
      sendJSON(res, 200, {
        status: merged.added > 0
          ? `Added ${merged.added} token(s) to ${path.basename(tokenFilePath)} (${merged.count} total).`
          : `No new tokens - already in ${path.basename(tokenFilePath)} (${merged.count} total).`,
        added: merged.added,
        count: merged.count,
        loggedIn: result.added,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message || 'Could not write the token file' });
    }
    return;
  }

  if (url.pathname === '/tokens' && req.method === 'GET') {
    const statusList = tokens.map((token, index) => {
      const bot = bots[index];
      let status = 'waiting';
      if (bot) {
        status = bot.status === 'ready' ? 'ready'
          : bot.status === 'logging_in' ? 'waiting'
          : bot.lastError && /invalid|token/i.test(bot.lastError) ? 'invalid'
          : 'offline';
      }
      return {
        index,
        masked: maskToken(token),
        status,
        lastError: bot ? bot.lastError || null : null,
        ready: bot ? bot.status === 'ready' : false,
      };
    });

    sendJSON(res, 200, {
      tokens: statusList,
      readyTokens: statusList.filter((item) => item.ready).map((item) => item.index),
      file: { path: tokenFilePath, count: tokens.length },
    });
    return;
  }

  if (url.pathname === '/tokens/reload' && req.method === 'POST') {
    const result = syncTokensFromFile('manual');
    sendJSON(res, 200, {
      status: `Reloaded ${tokenFilePath}: ${result.added} added, ${result.removed} removed, ${result.count} total.`,
      ...result,
    });
    return;
  }

  if (url.pathname === '/tokens/add' && req.method === 'POST') {
    sendJSON(res, 410, {
      error: 'Web token adding was removed. Add the token to the token file and press Reload.',
      tokenFile: tokenFilePath,
    });
    return;
  }

  if (url.pathname === '/tokens/delete' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const index = Number(body.index);
      if (!Number.isInteger(index) || index < 0 || index >= tokens.length) {
        sendJSON(res, 400, { error: 'Token index is invalid' });
        return;
      }

      const removed = tokens[index];
      tokens.splice(index, 1);
      writeTokenFile(tokenFilePath, tokens);

      const bot = bots[index];
      if (bot) {
        bot.shutdown();
        bots.splice(index, 1);
      }

      sendJSON(res, 200, {
        status: `${maskToken(removed)} removed from ${path.basename(tokenFilePath)} (${tokens.length} left).`,
        index,
        deleted: true,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message || 'Could not delete token' });
    }
    return;
  }

  if (url.pathname === '/audio/upload' && req.method === 'POST') {
    const tempPath = `${sharedAudioPath}.upload`;
    const fileStream = fs.createWriteStream(tempPath);
    req.pipe(fileStream);

    fileStream.on('finish', () => {
      // Decode a moment of it before replacing what is already loaded: a file
      // ffmpeg cannot read would otherwise stop playback with a bare exit code.
      probeAudio(tempPath).then((problem) => {
        if (problem) {
          fs.unlink(tempPath, () => {});
          sendJSON(res, 400, { error: `That file cannot be played: ${problem}` });
          return;
        }
        try {
          fs.renameSync(tempPath, sharedAudioPath);
        } catch (error) {
          sendJSON(res, 500, { error: error.message });
          return;
        }
        musicError = null;
        sendJSON(res, 200, { status: 'uploaded', file: sharedAudioPath });
      });
    });

    fileStream.on('error', (error) => {
      sendJSON(res, 500, { error: error.message });
    });
    return;
  }

  if (url.pathname === '/audio/play' && req.method === 'POST') {
    if (!fs.existsSync(sharedAudioPath)) {
      sendJSON(res, 400, { error: 'No audio uploaded yet' });
      return;
    }
    if (!playGlobalAudio()) {
      sendJSON(res, 500, { error: 'Could not start playback' });
      return;
    }
    // Decode in real time up front so playback is live before anyone joins.
    startBus('mix');
    startBus('music');
    applyRouting();
    sendJSON(res, 200, { status: 'playing', filter: currentFilter() });
    return;
  }

  if (url.pathname === '/audio/stop' && req.method === 'POST') {
    stopGlobalAudio();
    sendJSON(res, 200, { status: 'stopped' });
    return;
  }

  if ((url.pathname === '/audio/loudness' || url.pathname === '/audio/volume') && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      // Volume, mic gain and ducking are mixer-side and instant. Only a change
      // to the ffmpeg chain (drive / limiter / LUFS) needs the encoders rebuilt,
      // otherwise dragging a slider restarts every bus.
      const filterBefore = currentFilter();

      if (body.volume !== undefined) loudness.volume = clampNumber(body.volume, 0.5, 100, loudness.volume);
      if (body.micGain !== undefined) loudness.micGain = clampNumber(body.micGain, 0.1, 20, loudness.micGain);
      if (body.drive !== undefined) loudness.drive = clampNumber(body.drive, 0, 100, loudness.drive);
      if (body.duckLevel !== undefined) loudness.duckLevel = clampNumber(body.duckLevel, 0, 1, loudness.duckLevel);
      if (body.duckMusic !== undefined) loudness.duckMusic = Boolean(body.duckMusic);
      if (body.limiter !== undefined) loudness.limiter = Boolean(body.limiter);
      if (body.targetLufs !== undefined) {
        loudness.targetLufs = body.targetLufs === null || body.targetLufs === ''
          ? null
          : clampNumber(body.targetLufs, -31, -4, null);
      }

      refreshGains();
      if (currentFilter() !== filterBefore) {
        applyLoudnessFilter();
      }

      sendJSON(res, 200, { status: 'loudness updated', filter: currentFilter(), settings: describeSettings() });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/mic/status' && req.method === 'GET') {
    sendJSON(res, 200, {
      active: isMicActive(),
      clients: micState.clients.size,
      packets: micState.packets,
      channels: micState.channels,
      lastPacketAt: micState.lastPacketAt,
      routing: { default: routing.default, bots: { ...routing.bots } },
      loudness: { ...loudness },
    });
    return;
  }

  if (url.pathname === '/mic/routing' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      if (body.default !== undefined) {
        if (!['mix', 'music', 'mic', 'off'].includes(body.default)) {
          sendJSON(res, 400, { error: 'Unknown route' });
          return;
        }
        routing.default = body.default;
      }
      if (body.bots && typeof body.bots === 'object') {
        for (const [index, mode] of Object.entries(body.bots)) {
          if (!['mix', 'music', 'mic', 'off'].includes(mode)) continue;
          routing.bots[index] = mode;
        }
      }
      applyRouting();
      sendJSON(res, 200, {
        status: 'Routing updated.',
        routing: { default: routing.default, bots: { ...routing.bots } },
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/mic/stop' && req.method === 'POST') {
    const closed = micState.clients.size;
    for (const client of micState.clients) {
      try { client.close(1000, 'stopped by dashboard'); } catch (error) { /* already closed */ }
    }
    micState.clients.clear();
    micState.lastPacketAt = null;
    sendJSON(res, 200, { status: `Disconnected ${closed} mic client(s).` });
    return;
  }

  if (url.pathname.startsWith('/audio/') && ['mute', 'unmute', 'deafen', 'undeafen'].includes(url.pathname.slice(7))) {
    const action = url.pathname.slice(7);
    globalMute = action === 'mute' ? true : action === 'unmute' ? false : globalMute;
    globalDeaf = action === 'deafen' ? true : action === 'undeafen' ? false : globalDeaf;

    const labels = {
      mute: 'muted all bots',
      unmute: 'unmuted all bots',
      deafen: 'deafened all bots',
      undeafen: 'undeafened all bots',
    };

    for (const bot of bots) {
      if (bot.channelId && bot.guildId && bot.voiceState === 'connected') {
        await bot.joinChannel(bot.channelId, bot.guildId);
      }
    }

    sendJSON(res, 200, { status: labels[action], mute: globalMute, deaf: globalDeaf });
    return;
  }

  if (url.pathname === '/stay' && req.method === 'POST') {
    for (const bot of bots) {
      if (bot.channelId && bot.guildId) {
        bot.joinChannel(bot.channelId, bot.guildId);
      }
    }
    sendJSON(res, 200, { status: 'staying in vc' });
    return;
  }

  if (url.pathname === '/join' && req.method === 'POST') {
    try {
      const body = await parseJSONBody(req);
      const targetChannelId = body.channelId || body.channel || null;
      const targetGuildId = body.guildId || body.guild || null;
      if (!targetChannelId) {
        sendJSON(res, 400, { error: 'channelId is required' });
        return;
      }

      const results = [];
      // Small batches: Discord rate-limits, and 30 accounts serially take forever.
      const batchSize = 5;
      for (let start = 0; start < bots.length; start += batchSize) {
        const batch = bots.slice(start, start + batchSize).map((bot, offset) => async () => {
          const index = start + offset;
          if (bot.status !== 'ready') {
            return {
              bot: index + 1,
              ready: false,
              connected: false,
              voiceState: bot.voiceState,
              lastError: 'Account is offline',
              success: false,
            };
          }
          const success = await bot.joinChannel(targetChannelId, targetGuildId);
          return {
            bot: index + 1,
            ready: bot.status === 'ready',
            connected: bot.voiceState === 'connected',
            voiceState: bot.voiceState,
            channelId: bot.channelId,
            guildId: bot.guildId,
            lastError: bot.lastError,
            route: routeForBot(index),
            success,
          };
        });

        results.push(...await Promise.all(batch.map((run) => run())));
      }

      const joined = results.filter((item) => item.connected).length;
      const failed = results.filter((item) => !item.connected);
      console.log(
        `📡 Join ${targetChannelId}: ${joined}/${results.length} account(s) connected` +
        (failed.length ? `, ${failed.length} failed` : ''),
      );

      sendJSON(res, 200, {
        status: `${joined}/${results.length} account(s) connected to ${targetChannelId}.` +
          (failed.length ? ` ${failed.length} could not: ${failed.slice(0, 3).map((item) => `#${item.bot}`).join(', ')}${failed.length > 3 ? '…' : ''}` : ''),
        channelId: targetChannelId,
        guildId: targetGuildId,
        joinedAll: results.length > 0 && failed.length === 0,
        connected: joined,
        total: results.length,
        results,
      });
    } catch (error) {
      sendJSON(res, 500, { error: error.message });
    }
    return;
  }

  if (url.pathname === '/leave' && req.method === 'POST') {
    for (const bot of bots) {
      bot.leaveChannel();
    }
    sendJSON(res, 200, { status: 'left' });
    return;
  }

  sendJSON(res, 404, { error: 'not found' });
});

// --- MIC WEBSOCKET --------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/mic/stream', maxPayload: 512 * 1024 });

wss.on('connection', (socket) => {
  micState.clients.add(socket);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  // Keep the mix bus live so mic audio is ready even before anyone joins.
  startBus('mix');
  console.log(`🎙️  Mic client connected (${micState.clients.size} total).`);

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'format' && (message.channels === 1 || message.channels === 2)) {
          socket.channels = message.channels;
          micState.channels = message.channels;
        }
      } catch (error) { /* ignore malformed control frames */ }
      return;
    }
    pushMicChunk(Buffer.isBuffer(data) ? data : Buffer.from(data), socket.channels);
  });

  socket.on('error', (error) => console.error('⚠️ Mic socket error:', error.message));

  socket.on('close', () => {
    micState.clients.delete(socket);
    if (micState.clients.size === 0) micState.lastPacketAt = null;
    console.log(`🎙️  Mic client disconnected (${micState.clients.size} left).`);
  });
});

const heartbeat = setInterval(() => {
  for (const client of micState.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch (error) { /* socket already gone */ }
  }
}, 30000);

server.listen(port, host, () => {
  const address = server.address();
  const livePort = address && typeof address === 'object' ? address.port : port;
  console.log(`🌐 Health server listening on ${host}:${livePort}`);
  console.log(`🧩 Dashboard: http://${host}:${livePort}/  ·  Mic routing: http://${host}:${livePort}/mic-route`);
});

setInterval(() => {
  process.stdout.write('.');
}, 60000);

module.exports = {
  server,
  bots,
  buses,
  loudness,
  routing,
  micState,
  tokenFilePath,
  MUSIC_SOURCE_FRAMES,
  get tokens() {
    return tokens;
  },
  get musicDecoder() {
    return musicDecoder;
  },
  get musicBuffered() {
    return musicPending();
  },
  syncTokensFromFile,
  applyRouting,
  shutdownAll,
  stopHeartbeat() {
    clearInterval(heartbeat);
  },
};
