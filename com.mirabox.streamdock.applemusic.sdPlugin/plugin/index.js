const { WebSocket } = require('ws');
const { execSync, spawnSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function escapeXml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadPng(filename) {
    try {
        const data = fs.readFileSync(path.join(__dirname, '..', 'static', filename));
        return `data:image/png;base64,${data.toString('base64')}`;
    } catch(e) {
        return null;
    }
}

// Wrap a PNG data URI in SVG: hueRotate purple→red, slight scale-up
function makeRedImage(dataUri) {
    if (!dataUri) return null;
    const svg = `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg">` +
        `<defs><filter id="r">` +
        `<feColorMatrix type="hueRotate" values="84"/>` +
        `<feColorMatrix type="saturate" values="1.4"/>` +
        `</filter></defs>` +
        `<image filter="url(#r)" href="${dataUri}" x="-8" y="-8" width="160" height="160"/>` +
        `</svg>`;
    return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

const elgImages = {
    play:       makeRedImage(loadPng('elg-play.png')),
    pause:      makeRedImage(loadPng('elg-pause.png')),
    next:       makeRedImage(loadPng('elg-next.png')),
    previous:   makeRedImage(loadPng('elg-previous.png')),
    shuffleOn:  makeRedImage(loadPng('elg-shuffle-on.png')),
    shuffleOff: makeRedImage(loadPng('elg-shuffle-off.png')),
};

const artCache = new Map();
const pendingArtFetches = new Set();

// ============================================================
// Apple Music Helper - using JavaScript for Automation (JXA)
// Works with modern macOS and SIP restrictions
// ============================================================

// JXA script template for getting track info
const getTrackInfoScript = `
try
    tell application "Music"
        if player state is playing then
            set _state to "playing"
        else if player state is paused then
            set _state to "paused"
        else
            set _state to "stopped"
        end if

        try
            set _name to name of current track
        on error
            set _name to ""
        end try

        try
            set _artist to artist of current track
        on error
            set _artist to ""
        end try

        try
            set _album to album of current track
        on error
            set _album to ""
        end try

        try
            set _duration to duration of current track
        on error
            set _duration to 0
        end try

        try
            set _position to player position
        on error
            set _position to 0
        end try

        try
            set _shuffle to shuffle enabled
        on error
            set _shuffle to false
        end try

        return _state & "|" & _name & "|" & _artist & "|" & _album & "|" & (_duration as text) & "|" & (_position as text) & "|" & (_shuffle as text)
    end tell
on error e
    return "ERROR:" & e
end try
`;

// JXA script for repeat state (using JavaScript syntax to avoid AppleScript reserved word)
const getRepeatStateScript = `
try
    tell application "Music"
        return (get repetition) as text
    end tell
on error e
    return "ERROR:" & e
end try
`;

// JXA script for setting repeat state
const setRepeatStateScript = function(state) {
    return `
    try
        tell application "Music"
            set repetition to ${state}
        end tell
    on error e
        return "ERROR:" & e
    end try
    `;
};

const AppleMusic = {
    isPlaying: function() {
        try {
            const isRunning = execSync('osascript -e \'application "Music" is running\'').toString().trim();
            if (isRunning !== 'true') return false;
            const proc = spawnSync('osascript', ['-e', 'tell application "Music" to (player state = playing) as text'], { encoding: 'utf8' });
            return (proc.stdout || '').trim() === 'true';
        } catch (e) {
            console.error('AppleMusic.isPlaying error:', e.message);
            return false;
        }
    },

    getTrackInfo: function() {
        try {
            const proc = spawnSync('osascript', ['-e', getTrackInfoScript], { encoding: 'utf8' });
            const result = (proc.stdout || '').trim();

            if (!result || result.startsWith('ERROR:')) {
                if (result) console.error('AppleMusic.getTrackInfo AppleScript error:', result);
                return null;
            }

            const parts = result.split('|');
            return {
                playbackState: parts[0] || 'stopped',
                name: parts[1] || 'Unknown',
                artist: parts[2] || 'Unknown',
                album: parts[3] || 'Unknown',
                duration: parseInt(parts[4]) || 0,
                position: parseInt(parts[5]) || 0,
                volume: this.getCurrentVolume(),
                shuffle: parts[6] === 'true',
                repeat: 'off'
            };
        } catch (e) {
            console.error('AppleMusic.getTrackInfo error:', e.message);
            return null;
        }
    },

    playPause: function() {
        try {
            execSync('osascript -e \'tell application "Music" to play pause\'');
            return true;
        } catch (e) {
            console.error('AppleMusic.playPause error:', e.message);
            return false;
        }
    },

    nextTrack: function() {
        try {
            execSync('osascript -e \'tell application "Music" to next track\'');
            return true;
        } catch (e) {
            console.error('AppleMusic.nextTrack error:', e.message);
            return false;
        }
    },

    previousTrack: function() {
        try {
            execSync('osascript -e \'tell application "Music" to previous track\'');
            return true;
        } catch (e) {
            console.error('AppleMusic.previousTrack error:', e.message);
            return false;
        }
    },

    setVolume: function(volume) {
        try {
            volume = Math.max(0, Math.min(100, Math.round(volume)));
            execSync(`osascript -e 'tell application "Music" to set sound volume to ${volume}'`);
            return true;
        } catch (e) {
            console.error('AppleMusic.setVolume error:', e.message);
            return false;
        }
    },

    getCurrentVolume: function() {
        try {
            const isRunning = execSync('osascript -e \'application "Music" is running\'').toString().trim();
            if (isRunning !== 'true') return 50;
            const result = execSync('osascript -e \'tell application "Music" to get sound volume\'').toString().trim();
            const vol = parseInt(result);
            return isNaN(vol) ? 50 : vol;
        } catch (e) {
            console.error('AppleMusic.getCurrentVolume error:', e.message);
            return 50;
        }
    },

    toggleShuffle: function() {
        try {
            const proc = spawnSync('osascript', ['-e', 'tell application "Music" to get shuffle enabled'], { encoding: 'utf8' });
            const current = (proc.stdout || '').trim();
            const newState = current === 'true' ? 'false' : 'true';
            spawnSync('osascript', ['-e', `tell application "Music" to set shuffle enabled to ${newState}`], { encoding: 'utf8' });
            return newState === 'true';
        } catch (e) {
            console.error('AppleMusic.toggleShuffle error:', e.message);
            return false;
        }
    },

    getRepeatState: function() {
        try {
            const proc = spawnSync('osascript', ['-e', 'tell application "Music" to return song repeat as text'], { encoding: 'utf8' });
            return (proc.stdout || '').trim().toLowerCase() || 'off';
        } catch (e) {
            return 'off';
        }
    },

    toggleRepeat: function() {
        try {
            const states = ['off', 'one', 'all'];
            const current = this.getRepeatState();
            const idx = states.indexOf(current);
            const next = states[(idx + 1) % states.length];
            spawnSync('osascript', ['-e', `tell application "Music" to set song repeat to ${next}`], { encoding: 'utf8' });
            console.log(`[Repeat] ${current} → ${next}`);
            return next;
        } catch (e) {
            console.error('AppleMusic.toggleRepeat error:', e.message);
            return 'off';
        }
    },

    _bg: `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#7a2535"/><stop offset="100%" style="stop-color:#3a1020"/></linearGradient></defs><rect width="144" height="144" fill="url(#bg)" rx="20"/>`,

    _uri: function(svg) {
        return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
    },

    getPlayButtonImage: function(isPlaying) {
        const icon = isPlaying
            ? `<rect x="44" y="42" width="18" height="60" rx="4" fill="white"/><rect x="82" y="42" width="18" height="60" rx="4" fill="white"/>`
            : `<polygon points="54,42 54,102 110,72" fill="white"/>`;
        return this._uri(`<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg">${this._bg}${icon}</svg>`);
    },

    getNextImage: function() {
        return this._uri(`<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg">${this._bg}<polygon points="40,42 40,102 76,72" fill="white"/><polygon points="80,42 80,102 116,72" fill="white"/></svg>`);
    },

    getPreviousImage: function() {
        return this._uri(`<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg">${this._bg}<polygon points="104,42 104,102 68,72" fill="white"/><polygon points="64,42 64,102 28,72" fill="white"/></svg>`);
    },

    getShuffleImage: function(isShuffled) {
        const arrows = `<path d="M30,82 L54,82 C68,82 82,56 108,56" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><polyline points="100,48 108,56 100,64" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M30,62 L54,62 C68,62 82,88 108,88" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><polyline points="100,80 108,88 100,96" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
        const slash = isShuffled ? '' : `<line x1="110" y1="40" x2="34" y2="104" stroke="white" stroke-width="6" stroke-linecap="round"/>`;
        const inner = isShuffled ? arrows : `<g opacity="0.45">${arrows}</g>${slash}`;
        return this._uri(`<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg">${this._bg}${inner}</svg>`);
    },

    getRepeatSvg: function(repeatState) {
        const isOff = repeatState === 'off';
        const arrows = `<path d="M38,52 L96,52 Q118,52 118,72 L118,82" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/><path d="M106,92 L50,92 Q26,92 26,72 L26,62" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/><polyline points="110,74 118,82 126,74" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><polyline points="34,70 26,62 18,70" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
        const oneLabel = repeatState === 'one' ? `<text x="72" y="78" font-family="-apple-system,Arial" font-size="18" font-weight="bold" fill="white" text-anchor="middle">1</text>` : '';
        const slash = isOff ? `<line x1="110" y1="40" x2="34" y2="104" stroke="white" stroke-width="6" stroke-linecap="round"/>` : '';
        const inner = isOff ? `<g opacity="0.45">${arrows}</g>${slash}` : `${arrows}${oneLabel}`;
        return `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#7a2535"/><stop offset="100%" style="stop-color:#3a1020"/></linearGradient></defs><rect width="144" height="144" fill="url(#bg)" rx="20"/>${inner}</svg>`;
    },

    getAlbumArtSvg: function(trackInfo) {
        const name = escapeXml((trackInfo?.name || 'Not Playing').substring(0, 18));
        const artist = escapeXml((trackInfo?.artist || '').substring(0, 20));
        return `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#2a2a2a"/><stop offset="100%" style="stop-color:#1a1a1a"/></linearGradient></defs><rect width="144" height="144" fill="url(#bg)" rx="20"/><circle cx="72" cy="46" r="26" fill="none" stroke="#fc3158" stroke-width="3"/><circle cx="72" cy="46" r="7" fill="#1a1a1a" stroke="#fc3158" stroke-width="2"/><text x="72" y="92" font-family="Arial" font-size="11" font-weight="bold" fill="white" text-anchor="middle">${name}</text><text x="72" y="108" font-family="Arial" font-size="10" fill="rgba(255,255,255,0.6)" text-anchor="middle">${artist}</text></svg>`;
    },

    getVolumeSvg: function(volume) {
        const pct = Math.round(volume);
        const barWidth = Math.round((pct / 100) * 100);
        const isMuted = pct === 0;
        return `<svg width="144" height="144" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#2a2a2a"/><stop offset="100%" style="stop-color:#1a1a1a"/></linearGradient><linearGradient id="bar" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#ff607a"/><stop offset="100%" style="stop-color:#c41236"/></linearGradient></defs><rect width="144" height="144" fill="url(#bg)" rx="20"/><text x="72" y="62" font-family="Arial" font-size="36" font-weight="bold" fill="#fc3158" text-anchor="middle">${pct}%</text><rect x="22" y="76" width="100" height="8" rx="4" fill="rgba(255,255,255,0.15)"/><rect x="22" y="76" width="${barWidth}" height="8" rx="4" fill="url(#bar)"/><text x="72" y="110" font-family="Arial" font-size="11" fill="rgba(255,255,255,0.5)" text-anchor="middle">${isMuted ? 'MUTED' : 'VOLUME'}</text></svg>`;
    }
};

// ============================================================
// WebSocket Connection to Stream Dock
// ============================================================
const port = process.argv[3];
const uuid = process.argv[5];
const registerEvent = process.argv[7];

console.log('=== Apple Music Plugin Starting ===');
console.log('Port:', port);
console.log('UUID:', uuid);
console.log('Register Event:', registerEvent);

let ws;

function connect() {
    ws = new WebSocket('ws://127.0.0.1:' + port);

    ws.on('open', function() {
        console.log('Connected to Stream Dock, sending registration...');
        ws.send(JSON.stringify({ event: registerEvent, uuid: uuid }));
    });

    ws.on('message', function(message) {
        try {
            const data = JSON.parse(message.toString());
            console.log('>>> RECEIVED:', JSON.stringify(data, null, 2));
            handleMessage(data);
        } catch (e) {
            console.error('Error processing message:', e.message, message.toString());
        }
    });

    ws.on('error', function(error) {
        console.error('WebSocket error:', error);
    });

    ws.on('close', function() {
        console.log('Disconnected from Stream Dock');
    });
}

// Store settings for each action context
const actionSettings = {};

function handleMessage(data) {
    const action = data.action;       // Full UUID like "com.mirabox.streamdock.applemusic.play"
    const event = data.event;         // Event name like "keyDown", "willAppear"
    const context = data.context;     // Unique instance identifier
    const payload = data.payload || {};

    console.log(`>>> Action: ${action}, Event: ${event}, Context: ${context}`);

    // Initialize settings storage if needed
    if (!actionSettings[context]) {
        actionSettings[context] = {};
    }

    // Route to appropriate handler based on full UUID
    switch (action) {
        case 'com.mirabox.streamdock.applemusic.play':
            handlePlayEvent(context, event, payload);
            break;
        case 'com.mirabox.streamdock.applemusic.next':
            handleNextEvent(context, event, payload);
            break;
        case 'com.mirabox.streamdock.applemusic.previous':
            handlePreviousEvent(context, event, payload);
            break;
        case 'com.mirabox.streamdock.applemusic.shuffle':
            handleShuffleEvent(context, event, payload);
            break;
        case 'com.mirabox.streamdock.applemusic.repeat':
            handleRepeatEvent(context, event, payload);
            break;
        case 'com.mirabox.streamdock.applemusic.nowplaying':
            handleNowPlayingEvent(context, event, payload);
            break;
        case 'com.mirabox.streamdock.applemusic.volume':
            handleVolumeEvent(context, event, payload);
            break;
        default:
            console.log(`>>> Unknown action: ${action}`);
    }
}

function sendToStreamDeck(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('<<< SENDING:', JSON.stringify(message));
        ws.send(JSON.stringify(message));
    } else {
        console.error('>>> WebSocket not connected, cannot send:', message);
    }
}

// ============================================================
// Action: Play/Pause
// ============================================================
function handlePlayEvent(context, event, payload) {
    console.log(`[Play] Event: ${event}`);

    if (event === 'willAppear' || event === 'didReceiveSettings') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        updatePlayImage(context, settings);
        if (!actionSettings[context + '_timer']) {
            actionSettings[context + '_timer'] = setInterval(() => {
                updatePlayImage(context, actionSettings[context] || {});
            }, 2000);
        }
    } else if (event === 'willDisappear') {
        clearInterval(actionSettings[context + '_timer']);
        delete actionSettings[context + '_timer'];
    } else if (event === 'keyDown') {
        console.log('[Play] Button pressed - toggling play/pause');
        AppleMusic.playPause();
        setTimeout(() => {
            const settings = actionSettings[context] || {};
            updatePlayImage(context, settings);
        }, 200);
    } else if (event === 'keyUp') {
        console.log('[Play] Button released');
    } else if (event === 'sendToPlugin') {
        // Handle both direct payload and nested settings format
        let newSettings = {...(actionSettings[context] || {})};
        if (payload.settings) {
            Object.assign(newSettings, payload.settings);
        } else {
            // Property inspector sends settings directly in payload
            Object.assign(newSettings, payload);
        }
        actionSettings[context] = newSettings;
        updatePlayImage(context, newSettings);
    }
}

function updatePlayImage(context, settings) {
    try {
        const isPlaying = AppleMusic.isPlaying();
        console.log('[Play] Current state:', isPlaying ? 'playing' : 'stopped');
        console.log('[Play] showTitle setting:', settings.showTitle);
        const image = AppleMusic.getPlayButtonImage(isPlaying);

        sendToStreamDeck({
            event: 'setImage',
            context: context,
            payload: { target: 0, image }
        });

        // Handle title visibility based on showTitle setting
        if (settings.showTitle === false) {
            // Hide title by setting empty string
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: '', target: 0}
            });
            console.log('[Play] Title hidden');
        } else {
        // Show title
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: { title: isPlaying ? 'Pause' : 'Play', target: 0 }
            });
            console.log('[Play] Title shown:', isPlaying ? 'Pause' : 'Play');
        }
    } catch (e) {
        console.error('[Play] Error updating image:', e);
    }
}

// ============================================================
// Action: Next Track
// ============================================================
function handleNextEvent(context, event, payload) {
    console.log(`[Next] Event: ${event}`);

    if (event === 'willAppear' || event === 'didReceiveSettings') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: AppleMusic.getNextImage() } });
    } else if (event === 'keyDown') {
        console.log('[Next] Button pressed - skipping to next track');
        AppleMusic.nextTrack();
    } else if (event === 'sendToPlugin') {
        let newSettings = {...(actionSettings[context] || {})};
        if (payload.settings) Object.assign(newSettings, payload.settings);
        else Object.assign(newSettings, payload);
        actionSettings[context] = newSettings;
        sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: AppleMusic.getNextImage() } });
    }
}

// ============================================================
// Action: Previous Track
// ============================================================
function handlePreviousEvent(context, event, payload) {
    console.log(`[Previous] Event: ${event}`);

    if (event === 'willAppear' || event === 'didReceiveSettings') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: AppleMusic.getPreviousImage() } });
    } else if (event === 'keyDown') {
        console.log('[Previous] Button pressed - going to previous track');
        AppleMusic.previousTrack();
    } else if (event === 'sendToPlugin') {
        let newSettings = {...(actionSettings[context] || {})};
        if (payload.settings) Object.assign(newSettings, payload.settings);
        else Object.assign(newSettings, payload);
        actionSettings[context] = newSettings;
        sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: AppleMusic.getPreviousImage() } });
    }
}

// ============================================================
// Action: Shuffle
// ============================================================
function handleShuffleEvent(context, event, payload) {
    console.log(`[Shuffle] Event: ${event}`);

    if (event === 'willAppear' || event === 'didReceiveSettings') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        const trackInfo = AppleMusic.getTrackInfo();
        console.log('[Shuffle] Current shuffle:', trackInfo?.shuffle);
        updateShuffleImage(context, trackInfo?.shuffle, settings);
    } else if (event === 'keyDown') {
        console.log('[Shuffle] Button pressed - toggling shuffle');
        const newShuffle = AppleMusic.toggleShuffle();
        setTimeout(() => {
            const trackInfo = AppleMusic.getTrackInfo();
            updateShuffleImage(context, trackInfo?.shuffle, actionSettings[context]);
        }, 200);
    } else if (event === 'sendToPlugin') {
        let newSettings = {...(actionSettings[context] || {})};
        if (payload.settings) Object.assign(newSettings, payload.settings);
        else Object.assign(newSettings, payload);
        actionSettings[context] = newSettings;
        const trackInfo = AppleMusic.getTrackInfo();
        updateShuffleImage(context, trackInfo?.shuffle, newSettings);
    }
}

function updateButtonImage(context, svgFn, settings, title = '') {
    try {
        const svg = typeof svgFn === 'function' ? svgFn() : svgFn;

        sendToStreamDeck({
            event: 'setImage',
            context: context,
            payload: {target: 0, image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`}
        });

        // Handle title visibility based on showTitle setting
        if (settings.showTitle === false) {
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: '', target: 0}
            });
        } else {
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: title || 'Button', target: 0}
            });
        }
    } catch (e) {
        console.error(`[${context}] Error updating image:`, e);
    }
}

function updateShuffleImage(context, isShuffled, settings) {
    try {
        sendToStreamDeck({
            event: 'setImage',
            context: context,
            payload: {target: 0, image: AppleMusic.getShuffleImage(isShuffled)}
        });

        // Handle title visibility based on showTitle setting
        if (settings.showTitle === false) {
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: '', target: 0}
            });
            console.log('[Shuffle] Title hidden');
        } else {
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: isShuffled ? 'Shuffle On' : 'Shuffle', target: 0}
            });
        }
    } catch (e) {
        console.error('[Shuffle] Error updating image:', e);
    }
}

// ============================================================
// Action: Repeat
// ============================================================
function handleRepeatEvent(context, event, payload) {
    console.log(`[Repeat] Event: ${event}`);

    if (event === 'willAppear' || event === 'didReceiveSettings') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        updateRepeatImage(context, settings);
    } else if (event === 'keyDown') {
        console.log('[Repeat] Button pressed - toggling repeat');
        const newRepeat = AppleMusic.toggleRepeat();
        const svg = AppleMusic.getRepeatSvg(newRepeat);
        sendToStreamDeck({
            event: 'setImage',
            context: context,
            payload: { target: 0, image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}` }
        });
    } else if (event === 'sendToPlugin') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        updateRepeatImage(context, settings);
    }
}

function updateRepeatImage(context, settings) {
    try {
        const repeatState = AppleMusic.getRepeatState();
        console.log('[Repeat] Current repeat state:', repeatState);
        const svg = AppleMusic.getRepeatSvg(repeatState);

        sendToStreamDeck({
            event: 'setImage',
            context: context,
            payload: { target: 0, image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}` }
        });

        // Handle title visibility based on showTitle setting
        if (settings.showTitle === false) {
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: '', target: 0}
            });
        } else {
            const repeatLabels = {off: 'Repeat Off', all: 'Repeat All', one: 'Repeat One'};
            sendToStreamDeck({
                event: 'setTitle',
                context: context,
                payload: {title: repeatLabels[repeatState] || 'Repeat', target: 0}
            });
        }
    } catch (e) {
        console.error('[Repeat] Error updating image:', e);
    }
}

// ============================================================
// Action: Now Playing (displays current track info)
// ============================================================
function handleNowPlayingEvent(context, event, payload) {
    console.log(`[NowPlaying] Event: ${event}`);

    if (event === 'keyDown') {
        spawnSync('osascript', ['-e', 'tell application "Music" to activate'], { encoding: 'utf8' });
        return;
    }

    if (event === 'willAppear') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        const refreshRate = settings.refreshRate || 1000;

        updateNowPlayingDisplay(context);

        // Set up periodic refresh
        if (!actionSettings[context + '_timer']) {
            actionSettings[context + '_timer'] = setInterval(() => {
                updateNowPlayingDisplay(context);
            }, refreshRate);
        }
    } else if (event === 'willDisappear') {
        if (actionSettings[context + '_timer']) {
            clearInterval(actionSettings[context + '_timer']);
            delete actionSettings[context + '_timer'];
        }
    } else if (event === 'didReceiveSettings' || event === 'sendToPlugin') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;

        // Restart timer with new refresh rate
        if (actionSettings[context + '_timer']) {
            clearInterval(actionSettings[context + '_timer']);
        }
        timers[context] = setInterval(() => {
            updateNowPlayingDisplay(context);
        }, settings.refreshRate || 1000);

        updateNowPlayingDisplay(context);
    }
}

function fetchAlbumArtAndApply(context, trackName, artist) {
    const key = `${artist}|${trackName}`;
    if (artCache.has(key)) {
        const uri = artCache.get(key);
        if (uri) {
            sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: uri } });
            sendToStreamDeck({ event: 'setTitle', context, payload: { title: trackName.substring(0, 20), target: 0 } });
        }
        return;
    }
    if (pendingArtFetches.has(key)) return;
    pendingArtFetches.add(key);

    const q = encodeURIComponent(`${trackName} ${artist}`);
    exec(`curl -sf "https://itunes.apple.com/search?term=${q}&entity=song&limit=1" --max-time 5`, (err, stdout) => {
        if (err) { artCache.set(key, null); pendingArtFetches.delete(key); return; }
        try {
            const data = JSON.parse(stdout);
            const url = data.results?.[0]?.artworkUrl100?.replace('100x100bb', '300x300bb');
            if (!url) { artCache.set(key, null); pendingArtFetches.delete(key); return; }
            exec(`curl -sf "${url}" --max-time 5 | base64`, (err2, b64) => {
                if (!err2 && b64 && b64.trim()) {
                    const uri = `data:image/jpeg;base64,${b64.trim()}`;
                    artCache.set(key, uri);
                    sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: uri } });
                    sendToStreamDeck({ event: 'setTitle', context, payload: { title: trackName.substring(0, 20), target: 0 } });
                } else {
                    artCache.set(key, null);
                }
                pendingArtFetches.delete(key);
            });
        } catch (e) {
            artCache.set(key, null);
            pendingArtFetches.delete(key);
        }
    });
}

function updateNowPlayingDisplay(context) {
    try {
        const trackInfo = AppleMusic.getTrackInfo();
        const hasTrack = trackInfo?.name && trackInfo.name !== 'Unknown';

        if (hasTrack) {
            const key = `${trackInfo.artist || ''}|${trackInfo.name}`;
            const cachedArt = artCache.get(key);
            if (cachedArt) {
                // Art already loaded — just keep it, don't flash with SVG
                sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: cachedArt } });
                sendToStreamDeck({ event: 'setTitle', context, payload: { title: trackInfo.name.substring(0, 20), target: 0 } });
            } else {
                // Show SVG placeholder while art loads (only sent once until art arrives)
                const svg = AppleMusic.getAlbumArtSvg(trackInfo);
                sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}` } });
                sendToStreamDeck({ event: 'setTitle', context, payload: { title: '', target: 0 } });
                fetchAlbumArtAndApply(context, trackInfo.name, trackInfo.artist || '');
            }
        } else {
            const svg = AppleMusic.getAlbumArtSvg(trackInfo);
            sendToStreamDeck({ event: 'setImage', context, payload: { target: 0, image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}` } });
            sendToStreamDeck({ event: 'setTitle', context, payload: { title: '', target: 0 } });
        }
    } catch (e) {
        console.error('[NowPlaying] Error:', e);
    }
}

// ============================================================
// Action: Volume Knob (dial control)
// ============================================================
function handleVolumeEvent(context, event, payload) {
    console.log(`[Volume] Event: ${event}, Payload:`, JSON.stringify(payload));

    if (event === 'willAppear' || event === 'didReceiveSettings') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;

        // Get current volume from Apple Music
        try {
            const vol = AppleMusic.getCurrentVolume();
            console.log('[Volume] Current system volume:', vol);
            settings.currentVolume = vol;
            actionSettings[context] = settings;
        } catch (e) {
            console.error('[Volume] Error getting current volume:', e.message);
            settings.currentVolume = 50;
        }

        updateVolumeDisplay(context, settings);
    } else if (event === 'dialRotate') {
        const settings = actionSettings[context] || {};
        let currentVolume = settings.currentVolume !== undefined ? settings.currentVolume : AppleMusic.getCurrentVolume();
        const step = settings.volumeStep || 5;

        const rawTicks = payload?.ticks ?? payload?.payload?.ticks ?? 1;
        const ticks = Math.abs(rawTicks);
        const explicitDir = payload?.direction ?? payload?.payload?.direction;
        const direction = explicitDir !== undefined ? explicitDir : (rawTicks < 0 ? 1 : 0);

        console.log('[Volume] Dial rotated, direction:', direction, 'ticks:', ticks, 'current volume:', currentVolume);

        if (direction === 0) {
            // Clockwise - increase volume
            currentVolume = Math.min(100, currentVolume + step * ticks);
            console.log('[Volume] Increasing to:', currentVolume);
        } else {
            // Counter-clockwise - decrease volume
            currentVolume = Math.max(0, currentVolume - step * ticks);
            console.log('[Volume] Decreasing to:', currentVolume);
        }

        AppleMusic.setVolume(currentVolume);
        settings.currentVolume = currentVolume;
        actionSettings[context] = settings;

        sendToStreamDeck({
            event: 'setSettings',
            context: context,
            payload: settings
        });

        updateVolumeDisplay(context, settings);
    } else if (event === 'dialDown') {
        // Dial press - mute toggle
        console.log('[Volume] Dial pressed - toggling mute');
        const settings = actionSettings[context] || {};
        let currentVolume = settings.currentVolume !== undefined ? settings.currentVolume : AppleMusic.getCurrentVolume();

        if (currentVolume > 0) {
            settings.previousVolume = currentVolume;
            currentVolume = 0;
            console.log('[Volume] Muting, previous volume:', settings.previousVolume);
        } else {
            currentVolume = settings.previousVolume || 50;
            console.log('[Volume] Unmuting to:', currentVolume);
        }

        AppleMusic.setVolume(currentVolume);
        settings.currentVolume = currentVolume;
        actionSettings[context] = settings;

        sendToStreamDeck({
            event: 'setSettings',
            context: context,
            payload: settings
        });

        updateVolumeDisplay(context, settings);
    } else if (event === 'keyDown') {
        // Key press - volume up by step
        console.log('[Volume] Key pressed');
        const settings = actionSettings[context] || {};
        let currentVolume = settings.currentVolume !== undefined ? settings.currentVolume : AppleMusic.getCurrentVolume();
        const step = settings.volumeStep || 5;
        currentVolume = Math.min(100, currentVolume + step);

        AppleMusic.setVolume(currentVolume);
        settings.currentVolume = currentVolume;
        actionSettings[context] = settings;

        sendToStreamDeck({
            event: 'setSettings',
            context: context,
            payload: settings
        });

        updateVolumeDisplay(context, settings);
    } else if (event === 'sendToPlugin') {
        const settings = payload.settings || {};
        actionSettings[context] = settings;
        updateVolumeDisplay(context, settings);
    }
}

function updateVolumeDisplay(context, settings) {
    try {
        const volume = settings?.currentVolume !== undefined ? settings.currentVolume : 50;
        console.log('[Volume] Display update:', volume);
        const svg = AppleMusic.getVolumeSvg(volume);
        sendToStreamDeck({
            event: 'setImage',
            context: context,
            payload: { target: 0, image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}` }
        });
    } catch (e) {
        console.error('[Volume] Error updating display:', e);
    }
}

// ============================================================
// Start connection
// ============================================================
connect();

console.log('Apple Music plugin registered with UUID:', uuid);
