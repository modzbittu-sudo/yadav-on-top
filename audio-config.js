const AUDIO_DEFAULTS = Object.freeze({
  volume: 32,
  drive: 85,
  limiter: true,
  busRetryMs: 2000,
});

const MUSIC_BUFFER = Object.freeze({
  maxFrames: 96000,
  pauseBytes: 230400,
  resumeBytes: 76800,
});

module.exports = { AUDIO_DEFAULTS, MUSIC_BUFFER };