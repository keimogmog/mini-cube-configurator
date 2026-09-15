# mini cube Configurator

Browser Configurator for mini cube USB MIDI controllers. Open the HTTPS app, connect a device with Web MIDI, and edit settings in the browser.

**App:** https://keimogmog.github.io/mini-cube-configurator/

The first supported model is **MP9** (MIDI Channel and pad CC numbers). MF5 is a placeholder in the UI and is not connected yet.

This repository contains only the static web files (`index.html`, CSS, JavaScript). Firmware, hardware, and internal design docs are not published here.

## Use

1. Open the [Configurator](https://keimogmog.github.io/mini-cube-configurator/) in **Chrome** or **Edge** (desktop).
2. Connect a mini cube device over USB.
3. Click **Connect** and allow MIDI / SysEx.
4. Edit Channel / CC values and **Save to device**.

Safari and iOS do not support Web MIDI. Opening `index.html` as `file://` will not work.

Firmware Update (MP9 0.3.0+) asks the device to reboot into UF2 / BOOTSEL (`RPI-RP2`). **Connect to Bootloader** claims the ROM PICOBOOT USB interface over WebUSB. The published site’s **UF2 Flash Plan** is a dry run: it parses a UF2 in the browser and may `PC_READ` EEPROM. This published page does not erase or write flash.

## Local preview

```text
python3 -m http.server 8080
```

Open `http://localhost:8080` in Chrome.
