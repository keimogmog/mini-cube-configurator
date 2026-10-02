# mini cube Configurator

Browser Configurator for mini cube USB MIDI controllers. Open the HTTPS app, connect a device with Web MIDI, and edit settings in the browser.

**App:** https://keimogmog.github.io/mini-cube-configurator/

Supported models:

- **MP9** — MIDI Channel and Pad 1–9 CC numbers, plus Firmware Update
- **MF5** — MIDI Channel and Fader 1–5 CC numbers, plus Firmware Update

This repository contains only the static web files (`index.html`, CSS, JavaScript). Firmware, hardware, and internal design docs are not published here.


## Use

1. Open the [Configurator](https://keimogmog.github.io/mini-cube-configurator/) in **Chrome** or **Edge** (desktop).
2. Connect a mini cube device over USB.
3. Click **Connect** (first time) and allow MIDI / SysEx, or let the page reconnect automatically after that.
4. Edit Channel / CC values and **Save to device**.
5. If an update is available, use **Firmware Update** and follow **Continue** when prompted.

Safari and iOS do not support Web MIDI. Opening `index.html` as `file://` will not work.

## Local preview

```text
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome.
