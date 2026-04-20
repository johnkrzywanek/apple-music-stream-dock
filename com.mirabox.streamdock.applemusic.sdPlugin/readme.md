# Apple Music Plugin for Mirabox HotSpot StreamDock

Control Apple Music directly from your [Mirabox HotSpot StreamDock](https://www.mirabox.com/) device.

## Features

- **Now Playing** — shows album art, track title, and artist on the button; press to focus Apple Music
- **Play / Pause** — toggle playback
- **Next / Previous Track** — skip tracks
- **Shuffle** — toggle shuffle on/off
- **Repeat** — cycle through off / repeat all / repeat one 
- **Volume** — adjust volume via knob

## Requirements

- macOS 10.15 or later
- Apple Music (Music.app)
- Mirabox HotSpot StreamDock with software version `3.10.189` or later

## Installation

1. Clone or download this repo
2. Copy `com.mirabox.streamdock.applemusic.sdPlugin` into your StreamDock plugins folder
3. Restart the StreamDock software
4. Drag the Apple Music actions onto your device buttons

## Development

The plugin backend runs as a Node.js process (`plugin/index.js`) and communicates with the StreamDock software via WebSocket. Apple Music is controlled via AppleScript using `osascript`.
