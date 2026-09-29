const AUDIO_DEFAULTS = Object.freeze({
  volume: 24,
  drive: 65,
  limiter: true,
  micGain: 6,
});

const MUSIC_BUFFER = Object.freeze({
  maxFrames: 96000,
  pauseBytes: 230400,
  resumeBytes: 76800,
});

module.exports = { AUDIO_DEFAULTS, MUSIC_BUFFER };