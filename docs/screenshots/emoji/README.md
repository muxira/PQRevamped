# Emoji artwork used by the rendered previews

`clap.png` and `medal-*.png` are 64 px PNGs cropped from **Noto Color Emoji**
(<https://github.com/googlefonts/noto-emoji>), taken from the
[`emoji-datasource-google`](https://www.npmjs.com/package/emoji-datasource-google) package.

They are used only to draw the 👏 button and the 🥇🥈🥉 medals in
`docs/screenshots/*.png`; nothing in the shipped web client references these files.

Noto Color Emoji is licensed under the Apache License, Version 2.0 — see
[`LICENSE-Noto-Emoji.txt`](LICENSE-Noto-Emoji.txt). No modifications were made beyond
downscaling.
