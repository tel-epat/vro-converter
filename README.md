# VRO Converter

Convert DVD-VR `.VRO` recordings (DVD-RAM / DVD-RW discs, Panasonic/Hitachi/Sony DVD recorders and camcorders) to **MP4** — or MOV, MKV, WebM, MPG, MP3, M4A — from a browser app or the terminal.

Everything runs locally on top of [ffmpeg](https://ffmpeg.org). No files are sent anywhere. No npm dependencies.

## Requirements

- **Node.js 20+**
- **ffmpeg** (includes `ffprobe`)

macOS:

```sh
brew install node ffmpeg
```

Linux: `sudo apt install ffmpeg nodejs` · Windows: `winget install Gyan.FFmpeg OpenJS.NodeJS`

## Browser app

```sh
git clone https://github.com/<you>/vro-converter.git
cd vro-converter
npm start
```

This opens <http://localhost:5173>. Drop one or more `.VRO` files on the page, pick a format, and download the results. Close the server with `Ctrl+C` — temporary files are deleted.

Options: `npm run serve -- --port 8080 --work-dir /Volumes/BigDisk/tmp`

> The browser hands the file to the local server, so a 4 GB VRO temporarily needs ~4 GB in the work dir plus the output. Use `--work-dir` if your system disk is tight, or use the CLI, which reads the file in place.

## Terminal

```sh
node src/cli.js VR_MOVIE.VRO                       # → VR_MOVIE.mp4 next to it
node src/cli.js /Volumes/DVD_VR -o ~/Movies/dvd/   # every .VRO in a folder (recursive)
node src/cli.js holiday.vro -f mkv -q high
node src/cli.js --list-formats
```

Install it as a global `vroconv` command with `npm link` (or `npm install -g .`).

| Option | Values | Default |
|---|---|---|
| `-f, --format` | `mp4` `mov` `mkv` `webm` `mpg` `mp3` `m4a` | `mp4` |
| `-q, --quality` | `high` (CRF 18) · `balanced` (CRF 21) · `small` (CRF 26) | `balanced` |
| `-d, --deinterlace` | `auto` · `on` · `off` | `auto` |
| `-o, --output` | file (single input) or folder | next to input |
| `--overwrite` | replace existing outputs | off |

## What it does with a VRO

A VRO is an MPEG-2 program stream. The converter:

- **Regenerates timestamps and drops corrupt packets** (`-fflags +genpts+discardcorrupt`). A single VRO usually holds every recording on the disc back to back, each with its clock restarting at zero — this keeps all of them, in order, in one output file.
- **Deinterlaces** with `yadif`. In `auto` mode only frames flagged as interlaced are touched, so it's safe for progressive sources too. DVD recordings are almost always interlaced; without this you get comb artefacts on motion.
- **Keeps the aspect ratio** (4:3 / 16:9 flags carry over).
- Encodes **H.264 + AAC** for MP4/MOV/MKV, **VP9 + Opus** for WebM. `mpg` is a lossless remux with no re-encode — fastest, and a good archival copy.
- Keeps the first video and first audio track; drops DVD navigation and subtitle data.

## Limitations

- **One file per disc, not per recording.** Chapter/title boundaries and edits (deleted scenes, playlists) live in `VR_MANGR.IFO`, which this tool doesn't read. Scenes you "deleted" on the recorder but that weren't physically erased may reappear.
- **CPRM-protected recordings** (copy-once TV broadcasts) are encrypted and can't be converted.
- The browser app is a local tool, not a public website: the server binds to `127.0.0.1` and has no authentication. Don't expose it to a network.

## Development

```sh
npm test   # needs ffmpeg on PATH; builds a synthetic DVD-VR file and converts it every supported way
```

```
src/convert.js   ffmpeg/ffprobe wrapper — presets, progress, cancel (shared core)
src/cli.js       terminal interface + `serve`
src/server.js    local HTTP server (node:http) — upload, queue, progress, download
public/          browser UI (plain HTML/CSS/JS, no build step)
test/            node:test suite
```

Environment variables `FFMPEG_PATH` and `FFPROBE_PATH` override the binaries used.

## License

MIT
