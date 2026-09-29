const { BASE_STYLES } = require('./styles');

// Dashboard: token file status, voice control, loudness control, bot list.
function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Veera.exe Self Bot Monitor</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <h1>Veera.exe Self Bot Monitor</h1>
  <p>Self bot monitor for Veera.exe. Tokens load from a text file, audio runs through a louder chain, and the mic can be routed per account.</p>

  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/token-file">Token File</a>
    <a href="/mic-route">Mic Routing</a>
  </div>

  <div class="card">
    <h2>Token Manager</h2>
    <p class="hint">Tokens live in a text file, one per line. Paste a single token or a whole list here, or edit the file itself on the <a href="/token-file">Token File</a> page. Blank lines and <code>#</code> comments are ignored and duplicates are skipped.</p>
    <div class="kv"><span>Token file</span><span class="mono" id="tokenFilePath">loading…</span></div>
    <div class="kv"><span>Tokens in file</span><span id="tokenFileCount">loading…</span></div>
    <div class="kv"><span>Last sync</span><span id="tokenFileSync">loading…</span></div>

    <div class="form-row" style="margin-top:18px;">
      <input type="text" id="tokenInput" placeholder="Paste one token" />
    </div>
    <div class="form-row">
      <textarea id="tokenBulkInput" class="short" placeholder="Or paste many at once, one per line"></textarea>
    </div>
    <div class="form-row">
      <input type="file" id="tokenTxtFile" accept=".txt,text/plain" />
    </div>

    <div class="actions">
      <button id="addTokenBtn" style="background:#22c55e;color:#0f172a;">Add Token</button>
      <button id="addBulkBtn" style="background:#8b5cf6;color:#fff;">Add All</button>
      <button id="importTxtBtn" style="background:#0f766e;color:#fff;">Add from .txt</button>
      <a href="/token-file" style="flex:1 1 160px; text-align:center; padding:14px 18px; border-radius:14px; background:#0ea5e9;color:#fff;font-weight:700;">Edit tokens.txt</a>
    </div>
    <div class="actions" style="margin-top:10px;">
      <button id="reloadTokensBtn" style="background:#475569;color:#fff;">Reload token file</button>
      <button id="refreshTokensBtn" style="background:#475569;color:#fff;">Refresh</button>
    </div>
    <div id="tokenMessage" class="msg"></div>
    <div id="tokenList" style="margin-top:16px; display:grid; gap:10px;"></div>
  </div>

  <div class="card">
    <h2>Voice Channel Control</h2>
    <div class="form-row">
      <select id="accountSelect"><option value="">Reading accounts…</option></select>
    </div>
    <div class="form-row">
      <select id="channelSelect"><option value="">Pick a voice channel</option></select>
    </div>
    <div class="actions">
      <button id="pickChannelBtn" style="background:#0ea5e9;color:#fff;">Load channels</button>
      <button id="useChannelBtn" style="background:#6366f1;color:#fff;">Use selected</button>
    </div>
    <div class="form-row" style="margin-top:20px;">
      <input id="inputGuild" placeholder="Guild ID (optional)" />
      <input id="inputChannel" placeholder="Voice Channel ID" />
    </div>
    <div class="actions">
      <button id="joinBtn" style="background:#22c55e;color:#0f172a;">Join Channel</button>
      <button id="stay" style="background:#0ea5e9;color:#fff;">Rejoin Saved Channel</button>
      <button id="leave" style="background:#ef4444;color:#fff;">Leave Channel</button>
      <button id="refresh" style="background:#475569;color:#fff;">Refresh Status</button>
    </div>
    <div class="hint" style="margin-top:12px;">Accounts that cannot see the channel (not in that server) fail the join and say so under Accounts below - they need joining the server first.</div>
    <div id="message" class="msg"></div>
  </div>

  <div class="card">
    <h2 style="color:#f43f5e;">God Volume Audio Player</h2>
    <div class="kv"><span>Audio file</span><span class="mono" id="audioFileName">-</span></div>
    <div class="form-row">
      <input type="file" id="audioFile" accept="audio/*" />
    </div>

    <div class="control">
      <label>Volume (pre-gain): <span id="volDisplay">12x</span></label>
      <input type="range" id="volSlider" min="0.5" max="100" step="0.1" value="12" />
      <div class="hint">The loudness knob. Applied in float before the chain, so it never clips on its own - the limiter holds the peak at 0.95.</div>
    </div>

    <div class="control">
      <label>Drive / Compression: <span id="driveDisplay">40</span></label>
      <input type="range" id="driveSlider" min="0" max="100" step="1" value="40" />
      <div class="hint">Character, not level: squeezes the peaks so the whole track sits closer to the limit. Higher = punchier and more even, on music you'll hear it as "in your face".</div>
    </div>

    <div class="control">
      <label>Target Loudness (LUFS, blank = off): <span id="lufsDisplay">off</span></label>
      <input id="lufsInput" placeholder="e.g. -9" />
      <div class="hint">Measures the audio and pulls it to this loudness. Use this when you want a guaranteed level rather than a raw multiplier.</div>
    </div>

    <div class="control check">
      <input type="checkbox" id="limiterCheck" checked />
      <label for="limiterCheck">Limiter on (prevents clipping after boost)</label>
    </div>

    <div class="control check">
      <input type="checkbox" id="duckCheck" checked />
      <label for="duckCheck">Duck music while the mic is live</label>
    </div>

    <div class="control">
      <label>Duck level: <span id="duckDisplay">0.35</span></label>
      <input type="range" id="duckSlider" min="0" max="1" step="0.05" value="0.35" />
    </div>

    <div class="actions">
      <button id="uploadPlayBtn" style="background:#8b5cf6;color:#fff;">Upload &amp; Play to All</button>
      <button id="playSavedBtn" style="background:#0ea5e9;color:#fff;">Play Saved Audio</button>
      <button id="stopAudioBtn" style="background:#ef4444;color:#fff;">Stop Audio</button>
    </div>
    <div class="actions" style="margin-top:16px;">
      <button id="muteAllBtn" style="background:#4b5563;color:#fff;">Mute All</button>
      <button id="unmuteAllBtn" style="background:#10b981;color:#fff;">Unmute All</button>
      <button id="deafAllBtn" style="background:#4b5563;color:#fff;">Deafen All</button>
      <button id="undeafAllBtn" style="background:#3b82f6;color:#fff;">Undeafen All</button>
    </div>
    <div class="actions" style="margin-top:16px;">
      <a href="/mic-route" style="flex:1 1 160px; text-align:center; padding:14px 18px; border-radius:14px; background:#db2777;color:#fff;font-weight:700;">Open Mic Routing</a>
    </div>
    <div id="audioMessage" class="msg"></div>
  </div>

  <div class="card">
    <h2>Browser Mic Enhancer</h2>
    <p class="hint">Optional. Patches <code>getUserMedia</code> on this page so a voice app running in this tab captures your mic through the boosted, un-processed chain (echo cancellation, noise suppression and auto gain disabled). Reload the page after toggling.</p>
    <div class="control check">
      <input type="checkbox" id="enhancerCheck" />
      <label for="enhancerCheck">Enable browser mic enhancer</label>
    </div>
    <div class="control">
      <label>Enhancer output gain: <span id="enhancerGainDisplay">1.0x</span></label>
      <input type="range" id="enhancerGain" min="0.1" max="20" step="0.1" value="1" />
    </div>
    <div id="enhancerMessage" class="msg"></div>
  </div>

  <div class="card" id="bots"></div>

  <script>
    var el = function (id) { return document.getElementById(id); };
    var post = function (url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (res) { return res.json(); });
    };
    var debounce = function (fn, wait) {
      var timer = null;
      return function () {
        var args = arguments, self = this;
        clearTimeout(timer);
        timer = setTimeout(function () { fn.apply(self, args); }, wait);
      };
    };

    var statusEl = el('message');
    var tokenMessageEl = el('tokenMessage');
    var tokenListEl = el('tokenList');
    var tokenInput = el('tokenInput');
    var tokenBulkInput = el('tokenBulkInput');
    var tokenTxtFile = el('tokenTxtFile');
    var apiKey = sessionStorage.getItem('veera.tokenKey') || '';
    var authHeaders = function (extra) {
      var headers = extra || {};
      if (apiKey) headers['x-token-key'] = apiKey;
      return headers;
    };

    var addTokens = function (value) {
      if (!value) {
        tokenMessageEl.textContent = 'Paste a token first.';
        return;
      }
      tokenMessageEl.textContent = 'Adding to the token file...';
      fetch('/api/tokens/append', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tokens: value })
      }).then(function (res) {
        return res.json().then(function (payload) {
          if (res.status === 401) {
            var key = window.prompt('This token file is protected. Enter TOKEN_FILE_KEY:');
            if (key) {
              apiKey = key;
              sessionStorage.setItem('veera.tokenKey', key);
              return addTokens(value);
            }
            tokenMessageEl.textContent = payload.error || 'Token file key required.';
            return;
          }
          tokenMessageEl.textContent = payload.status || payload.error || 'Done';
          tokenInput.value = '';
          tokenBulkInput.value = '';
          return Promise.all([fetchTokens(), fetchSettings()]);
        });
      }).catch(function (error) {
        tokenMessageEl.textContent = 'Error: ' + error.message;
      });
    };

    el('addTokenBtn').addEventListener('click', function () {
      addTokens(tokenInput.value.trim());
    });

    el('addBulkBtn').addEventListener('click', function () {
      addTokens(tokenBulkInput.value.trim());
    });

    el('importTxtBtn').addEventListener('click', function () {
      var file = tokenTxtFile.files && tokenTxtFile.files[0];
      if (!file) {
        tokenMessageEl.textContent = 'Choose a .txt file first.';
        return;
      }
      file.text().then(function (content) {
        if (!content.trim()) {
          tokenMessageEl.textContent = 'The selected file is empty.';
          return;
        }
        tokenTxtFile.value = '';
        addTokens(content);
      }).catch(function (error) {
        tokenMessageEl.textContent = 'Could not read file: ' + error.message;
      });
    });

    [tokenInput, tokenBulkInput].forEach(function (field) {
      field.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          addTokens(field.value.trim());
        }
      });
    });
    var botsEl = el('bots');
    var audioMessage = el('audioMessage');
    var guildInput = el('inputGuild');
    var channelInput = el('inputChannel');
    var volSlider = el('volSlider');
    var volDisplay = el('volDisplay');
    var driveSlider = el('driveSlider');
    var driveDisplay = el('driveDisplay');
    var lufsInput = el('lufsInput');
    var lufsDisplay = el('lufsDisplay');
    var limiterCheck = el('limiterCheck');
    var duckCheck = el('duckCheck');
    var duckSlider = el('duckSlider');
    var duckDisplay = el('duckDisplay');

    var renderTokenList = function (data) {
      var list = (data && data.tokens) || [];
      if (!list.length) {
        tokenListEl.innerHTML = '<div class="hint">No tokens in the file yet.</div>';
        return;
      }

      tokenListEl.innerHTML = list.map(function (item) {
        var status = item.status || 'waiting';
        var label = status === 'ready' ? 'Ready' : status === 'invalid' ? 'Invalid' : status === 'offline' ? 'Offline' : 'Waiting';
        var color = status === 'ready' ? '#22c55e' : status === 'invalid' ? '#f97316' : status === 'offline' ? '#fbbf24' : '#38bdf8';
        var errorText = item.lastError ? '<div class="hint danger">' + item.lastError + '</div>' : '';
        return '<div style="padding:12px;border:1px solid rgba(148,163,184,.22);border-radius:12px;background:#0f172a;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">'
          + '<div style="flex:1;min-width:220px;">'
          + '<div><strong>Account ' + (item.index + 1) + '</strong> <span style="color:' + color + ';font-weight:700;">' + label + '</span></div>'
          + '<div class="hint mono">' + (item.masked || 'hidden') + '</div>'
          + errorText
          + '</div>'
          + '<button type="button" data-token-index="' + item.index + '" class="delete-token-btn" style="background:#ef4444;color:#fff;padding:8px 12px;border-radius:10px;border:none;cursor:pointer;font-weight:700;">Remove from file</button>'
          + '</div>';
      }).join('');

      Array.prototype.forEach.call(document.querySelectorAll('.delete-token-btn'), function (button) {
        button.addEventListener('click', function () {
          var index = Number(button.dataset.tokenIndex);
          if (isNaN(index)) return;
          tokenMessageEl.textContent = 'Removing account ' + (index + 1) + ' from the token file...';
          post('/tokens/delete', { index: index }).then(function (payload) {
            tokenMessageEl.textContent = payload.status || payload.error || 'Token removed';
            return fetchTokens();
          }).then(fetchStatus).catch(function (error) {
            tokenMessageEl.textContent = 'Error: ' + error.message;
          });
        });
      });
    };

    var fetchTokens = function () {
      return fetch('/tokens').then(function (res) { return res.json(); }).then(renderTokenList).catch(function () {
        tokenListEl.innerHTML = '<div class="hint">Could not load tokens.</div>';
      });
    };

    var renderTokenFile = function (info) {
      var file = (info && info.tokenFile) || {};
      el('tokenFilePath').textContent = file.path || 'unknown';
      el('tokenFileCount').textContent = String(file.count === undefined ? 0 : file.count);
      el('tokenFileSync').textContent = file.lastSyncAt
        ? new Date(file.lastSyncAt).toLocaleTimeString() + ' (' + (file.lastTrigger || 'manual') + ')'
        : 'never';
    };

    var renderSettings = function (info) {
      var loudness = (info && info.loudness) || {};
      volSlider.value = loudness.volume;
      volDisplay.textContent = Number(loudness.volume).toFixed(1) + 'x';
      driveSlider.value = loudness.drive;
      driveDisplay.textContent = String(loudness.drive);
      lufsInput.value = loudness.targetLufs === null || loudness.targetLufs === undefined ? '' : loudness.targetLufs;
      lufsDisplay.textContent = loudness.targetLufs ? loudness.targetLufs + ' LUFS' : 'off';
      limiterCheck.checked = loudness.limiter !== false;
      duckCheck.checked = loudness.duckMusic !== false;
      duckSlider.value = loudness.duckLevel;
      duckDisplay.textContent = Number(loudness.duckLevel).toFixed(2);
      renderTokenFile(info);
    };

    var saveLoudness = function (overrides) {
      return post('/audio/loudness', overrides).then(function (payload) {
        renderSettings(payload.settings || {});
        return payload;
      });
    };

    var renderStatus = function (data) {
      var list = (data && data.bots) || [];
      statusEl.textContent = 'Loaded ' + list.length + ' bot' + (list.length !== 1 ? 's' : '') + '.';

      // Account picker for the channel list.
      var select = el('accountSelect');
      var previous = select.value;
      var ready = list.filter(function (bot) { return bot.ready; });
      if (ready.length) {
        select.innerHTML = '<option value="">First ready account</option>' + ready.map(function (bot) {
          return '<option value="' + (bot.index - 1) + '">Account ' + bot.index
            + (bot.tag ? ' · ' + bot.tag : '') + '</option>';
        }).join('');
        select.value = previous;
      } else {
        select.innerHTML = '<option value="">No accounts ready yet</option>';
      }

      if (!list.length) {
        botsEl.innerHTML = '<p>No tokens in the token file yet. Add one, save the file, then press Reload.</p>';
        return;
      }

      botsEl.innerHTML = list.map(function (bot) {
        return '<div class="bot">'
          + '<div><strong>Account ' + bot.index + '</strong> <span class="' + (bot.ready ? 'status-ready' : 'status-offline') + '">' + (bot.ready ? 'Ready' : 'Offline') + '</span></div>'
          + '<div><span>Voice:</span><span class="status-vc">' + (bot.voiceState || 'disconnected') + '</span></div>'
          + '<div><span>Channel:</span><span>' + (bot.channelId || 'None') + '</span></div>'
          + '<div><span>Guild:</span><span>' + (bot.guildId || 'None') + '</span></div>'
          + '<div><span>Route:</span><span>' + (bot.route || 'mix') + '</span></div>'
          + '</div>';
      }).join('');
    };

    var fetchStatus = function () {
      return fetch('/status').then(function (res) { return res.json(); }).then(renderStatus).catch(function () {
        statusEl.textContent = 'Failed to load status';
        botsEl.innerHTML = '';
      });
    };

    var fetchSettings = function () {
      return fetch('/settings').then(function (res) { return res.json(); }).then(renderSettings).catch(function () {});
    };

    el('reloadTokensBtn').addEventListener('click', function () {
      tokenMessageEl.textContent = 'Reloading token file...';
      post('/tokens/reload').then(function (payload) {
        tokenMessageEl.textContent = payload.status || payload.error || 'Reloaded';
        return Promise.all([fetchTokens(), fetchStatus(), fetchSettings()]);
      }).catch(function (error) {
        tokenMessageEl.textContent = 'Error: ' + error.message;
      });
    });

    el('refreshTokensBtn').addEventListener('click', function () { fetchTokens(); fetchSettings(); });
    el('refresh').addEventListener('click', fetchStatus);

    var loadChannels = function () {
      var select = el('accountSelect');
      var index = select.value;
      statusEl.textContent = 'Loading voice channels...';
      return fetch('/channels' + (index === '' ? '' : '?index=' + encodeURIComponent(index)))
        .then(function (res) { return res.json(); })
        .then(function (payload) {
          var target = el('channelSelect');
          if (!payload.guilds || !payload.guilds.length) {
            target.innerHTML = '<option value="">No voice channels found for that account</option>';
            statusEl.textContent = 'No voice channels visible. If this account is not in the server, add it there first.';
            return;
          }

          target.innerHTML = payload.guilds.map(function (guild) {
            return '<optgroup label="' + guild.name + '">'
              + guild.channels.map(function (channel) {
                return '<option value="' + channel.id + '" data-guild="' + guild.id + '">'
                  + channel.name + ' (' + channel.id + ')</option>';
              }).join('')
              + '</optgroup>';
          }).join('');

          statusEl.textContent = 'Loaded ' + payload.guilds.length + ' server(s) from '
            + (payload.account ? payload.account.tag || 'account ' + payload.account.index : 'an account') + '.';
        })
        .catch(function (error) { statusEl.textContent = 'Error: ' + error.message; });
    };

    el('pickChannelBtn').addEventListener('click', loadChannels);

    el('useChannelBtn').addEventListener('click', function () {
      var option = el('channelSelect').selectedOptions[0];
      if (!option || !option.value) {
        statusEl.textContent = 'Pick a channel from the list first.';
        return;
      }
      channelInput.value = option.value;
      guildInput.value = option.dataset.guild || '';
      statusEl.textContent = 'Channel filled in. Press Join Channel.';
    });

    el('accountSelect').addEventListener('change', loadChannels);

    el('joinBtn').addEventListener('click', function () {
      var channelId = channelInput.value.trim();
      if (!channelId) {
        statusEl.textContent = 'Channel ID is required to join.';
        return;
      }
      statusEl.textContent = 'Joining bots to channel...';
      post('/join', { channelId: channelId, guildId: guildInput.value.trim() }).then(function (data) {
        statusEl.textContent = data.status || 'Join requested';
        fetchStatus();
      }).catch(function (error) { statusEl.textContent = 'Error: ' + error.message; });
    });

    el('stay').addEventListener('click', function () {
      statusEl.textContent = 'Rejoining saved channel...';
      post('/stay').then(function (data) { statusEl.textContent = data.status || 'Stay requested'; fetchStatus(); });
    });

    el('leave').addEventListener('click', function () {
      statusEl.textContent = 'Leaving voice channel...';
      post('/leave').then(function (data) { statusEl.textContent = data.status || 'Leave requested'; fetchStatus(); });
    });

    var pushLoudness = debounce(function (overrides) {
      saveLoudness(overrides).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    }, 250);

    volSlider.addEventListener('input', function (event) {
      volDisplay.textContent = Number(event.target.value).toFixed(1) + 'x';
      pushLoudness({ volume: Number(event.target.value) });
    });

    driveSlider.addEventListener('input', function (event) {
      driveDisplay.textContent = event.target.value;
      pushLoudness({ drive: Number(event.target.value) });
    });

    lufsInput.addEventListener('change', function (event) {
      var value = event.target.value.trim();
      lufsDisplay.textContent = value ? value + ' LUFS' : 'off';
      saveLoudness({ targetLufs: value === '' ? null : Number(value) });
    });

    limiterCheck.addEventListener('change', function (event) { saveLoudness({ limiter: event.target.checked }); });
    duckCheck.addEventListener('change', function (event) { saveLoudness({ duckMusic: event.target.checked }); });
    duckSlider.addEventListener('input', function (event) {
      duckDisplay.textContent = Number(event.target.value).toFixed(2);
      pushLoudness({ duckLevel: Number(event.target.value) });
    });

    el('uploadPlayBtn').addEventListener('click', function () {
      var file = el('audioFile').files[0];
      if (!file) {
        audioMessage.textContent = 'Please select an audio file first.';
        return;
      }
      audioMessage.textContent = 'Uploading audio file...';
      fetch('/audio/upload', { method: 'POST', body: file }).then(function (res) {
        if (!res.ok) throw new Error('Upload failed');
        audioMessage.textContent = 'Playing audio to all bots...';
        return post('/audio/play');
      }).then(function (data) {
        audioMessage.textContent = (data && (data.status || data.error)) || 'Playing';
      }).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    });

    el('playSavedBtn').addEventListener('click', function () {
      audioMessage.textContent = 'Playing saved audio to all bots...';
      post('/audio/play').then(function (data) {
        audioMessage.textContent = (data && (data.status || data.error)) || 'Playing';
      }).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    });

    el('stopAudioBtn').addEventListener('click', function () {
      audioMessage.textContent = 'Stopping audio...';
      post('/audio/stop').then(function (data) { audioMessage.textContent = (data && data.status) || 'stopped'; });
    });

    var voiceCommand = function (url) {
      audioMessage.textContent = 'Updating voice state...';
      post(url).then(function (data) {
        audioMessage.textContent = (data && (data.status || data.error)) || 'done';
        fetchStatus();
      }).catch(function (error) { audioMessage.textContent = 'Error: ' + error.message; });
    };

    el('muteAllBtn').addEventListener('click', function () { voiceCommand('/audio/mute'); });
    el('unmuteAllBtn').addEventListener('click', function () { voiceCommand('/audio/unmute'); });
    el('deafAllBtn').addEventListener('click', function () { voiceCommand('/audio/deafen'); });
    el('undeafAllBtn').addEventListener('click', function () { voiceCommand('/audio/undeafen'); });

    var enhancerMessage = el('enhancerMessage');
    var enhancerCheck = el('enhancerCheck');
    var enhancerGain = el('enhancerGain');
    var enhancerGainDisplay = el('enhancerGainDisplay');

    // Opt-in getUserMedia patch: strips browser voice processing and runs the
    // mic through a boosted chain. window.__CB_GAIN__ is the output gain.
    var enhanceGetUserMedia = function () {
      if (window.__CB__ || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
      window.__CB__ = true;
      window.__CB_GAIN__ = window.__CB_GAIN__ || Number(enhancerGain.value) || 1;

      var oldGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function (c) {
        if (c && c.audio && c.audio.__raw !== true) {
          c.audio.echoCancellation = false;
          c.audio.noiseSuppression = false;
          c.audio.autoGainControl = false;
        }

        var real = await oldGUM(c);
        if (c && c.audio && c.audio.__raw === true) return real;

        var ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.resume();

        var src = ctx.createMediaStreamSource(real);
        var dst = ctx.createMediaStreamDestination();
        var gain = function (value) { var node = ctx.createGain(); node.gain.value = value; return node; };
        var filter = function (type, frequency, filterGain, q) {
          var node = ctx.createBiquadFilter();
          node.type = type;
          node.frequency.value = frequency;
          node.gain.value = filterGain;
          if (q) node.Q.value = q;
          return node;
        };
        var shaper = function (amount, size) {
          var node = ctx.createWaveShaper();
          var curve = new Float32Array(size || 65536);
          for (var i = 0; i < curve.length; i++) {
            curve[i] = Math.tanh((i * 2 / curve.length - 1) * amount);
          }
          node.curve = curve;
          node.oversample = '4x';
          return node;
        };

        var dry = gain(1);
        src.connect(dry);
        dry.connect(dst);

        var v1 = gain(220);
        var v2 = gain(170);
        var v3 = gain(70);
        var v4 = gain(110);
        var bass = filter('lowshelf', 90, 24);
        var dip = filter('peaking', 1200, -4, 0.8);
        var presence = filter('peaking', 2600, 56, 0.6);
        var air = filter('highshelf', 9000, 44);
        var body = filter('peaking', 1800, 20, 0.5);

        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -36;
        comp.knee.value = 20;
        comp.ratio.value = 6;
        comp.attack.value = 0.002;
        comp.release.value = 0.08;
        var compMakeup = gain(12);

        var dist = shaper(6, 44100);
        var sat = shaper(8);

        var conv = ctx.createConvolver();
        var ir = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
        for (var ch = 0; ch < 2; ch++) {
          var irData = ir.getChannelData(ch);
          for (var j = 0; j < irData.length; j++) {
            irData[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / irData.length, 2.5);
          }
        }
        conv.buffer = ir;
        var reverbGain = gain(0.5);

        var e1D = ctx.createDelay(5.0); e1D.delayTime.value = 0.25;
        var e1F = gain(0.36); e1D.connect(e1F); e1F.connect(e1D);
        var e1W = gain(0.36);
        var e2D = ctx.createDelay(5.0); e2D.delayTime.value = 0.12;
        var e2F = gain(0.16); e2D.connect(e2F); e2F.connect(e2D);
        var e2W = gain(0.16);

        var sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 42;
        var subGain = gain(0.16);
        var master = gain(240);
        var limiter = shaper(1.35);
        var baseCurve = limiter.curve;
        var softCurve = new Float32Array(baseCurve.length);
        for (var i = 0; i < softCurve.length; i++) { softCurve[i] = baseCurve[i] * 0.89; }
        limiter.curve = softCurve;

        src.connect(v1); v1.connect(v2); v2.connect(master);
        src.connect(v3); v3.connect(master);
        src.connect(v4); v4.connect(master);
        v1.connect(bass); bass.connect(dip); dip.connect(presence); presence.connect(air); air.connect(body);
        body.connect(comp); comp.connect(compMakeup); compMakeup.connect(dist);
        dist.connect(sat); sat.connect(master);
        sat.connect(conv); conv.connect(reverbGain); reverbGain.connect(master);
        dist.connect(e1D); e1D.connect(e1W); e1W.connect(master);
        dist.connect(e2D); e2D.connect(e2W); e2W.connect(master);
        sub.connect(subGain); subGain.connect(master);
        master.connect(limiter); limiter.connect(dst);
        sub.start();

        window.__CB_MASTER__ = master;
        window.__CB_BYPASS__ = false;
        setInterval(function () {
          if (ctx.state === 'suspended') ctx.resume();
          master.gain.value = 240 * (window.__CB_BYPASS__ ? 0 : (window.__CB_GAIN__ || 1));
        }, 100);

        window.__CB_TOGGLE__ = function () { window.__CB_BYPASS__ = !window.__CB_BYPASS__; };
        return dst.stream;
      };
      return true;
    };

    if (localStorage.getItem('veera.enhancer') === 'on') { enhancerCheck.checked = true; }
    if (window.__CB_GAIN__) { enhancerGain.value = window.__CB_GAIN__; }
    enhancerGainDisplay.textContent = Number(enhancerGain.value).toFixed(1) + 'x';

    if (enhancerCheck.checked) {
      enhanceGetUserMedia();
      enhancerMessage.textContent = 'Audio enhancement enabled for this tab.';
    } else {
      enhancerMessage.textContent = 'Enhancer off. Enable it, then reload the page.';
    }

    enhancerCheck.addEventListener('change', function (event) {
      localStorage.setItem('veera.enhancer', event.target.checked ? 'on' : 'off');
      enhancerMessage.textContent = event.target.checked
        ? 'Enabled - reload the page to apply it to this tab.'
        : 'Disabled - reload the page to remove it.';
    });

    enhancerGain.addEventListener('input', function (event) {
      window.__CB_GAIN__ = Number(event.target.value);
      enhancerGainDisplay.textContent = Number(event.target.value).toFixed(1) + 'x';
    });

    fetchTokens();
    fetchStatus();
    fetchSettings();
    setInterval(function () { fetchStatus(); fetchTokens(); fetchSettings(); }, 10000);
  </script>
</body>
</html>`;
}

module.exports = { renderHomePage };
