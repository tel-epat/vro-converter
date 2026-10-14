# VRO Converter

Convert DVD-VR `.VRO` recordings (DVD-RAM / DVD-RW discs, camcorders and DVD recorders from Canon, Panasonic, Hitachi, Sony…) to **MP4** — or MOV, MKV, WebM, MPG, MP3, M4A — from a browser app or the terminal.

With the disc's `VR_MANGR.IFO` index it produces **one file per recording**, named and dated by when it was filmed, with the correct aspect ratio.

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

This opens <http://localhost:5173>. **Drop the whole `DVD_RTAV` folder** from the disc or camcorder — or `VR_MOVIE.VRO` and `VR_MANGR.IFO` together — pick a format, and you get a list of recordings with a download link each, plus **Download all (.zip)**. A plain `.VRO` (or any other video) without its index is converted as one file.

Close the server with `Ctrl+C` — temporary files are deleted.

Options: `npm run serve -- --port 8080 --work-dir /Volumes/BigDisk/tmp`

> The browser hands the file to the local server, so a 4 GB VRO temporarily needs ~4 GB in the work dir plus the output. Use `--work-dir` if your system disk is tight, or use the CLI, which reads the file in place.

## Terminal

```sh
node src/cli.js /Volumes/CAMCORDER/DVD_RTAV -o ~/Movies/camcorder   # one file per recording
node src/cli.js VR_MOVIE.VRO --list                                # show what's on the disc
node src/cli.js VR_MOVIE.VRO -r 5-9,12 -f mov                      # only some recordings
node src/cli.js VR_MOVIE.VRO --join                                # one file for everything
node src/cli.js holiday.vro -f mkv -q high                         # any VRO/video, no index needed
```

`VR_MANGR.IFO` is picked up automatically when it sits next to the VRO, as it does on the disc. Output files are named `001 2017-12-11 22-46-01.mp4`, … in a folder named after the VRO (or the `-o` folder). If a run is interrupted, run the same command again: finished recordings are skipped.

```
$ node src/cli.js VR_MOVIE.VRO --list
VR_MOVIE.VRO
  index: VR_MANGR.IFO (DVD-VR 1.0)
  47 recordings, 20:27 total, PAL 720×576 16:9 AC3

   #  recorded             length      size  label
   1  2017-12-11 22:46:01    1:30   88.7 MB
   2  2017-12-11 22:52:09    2:49  158.6 MB
   …
```

Install it as a global `vroconv` command with `npm link` (or `npm install -g .`).

| Option | Values | Default |
|---|---|---|
| `-f, --format` | `mp4` `mov` `mkv` `webm` `mpg` `mp3` `m4a` | `mp4` |
| `-q, --quality` | `high` (CRF 18) · `balanced` (CRF 21) · `small` (CRF 26) | `balanced` |
| `-d, --deinterlace` | `auto` · `on` · `off` | `auto` |
| `-o, --output` | file or folder | next to input |
| `--overwrite` | replace existing outputs | off (skip) |
| `--list` | print the recordings in the index | |
| `-r, --recordings` | e.g. `1,3,5-8` | all |
| `--join` | one file instead of one per recording | off |
| `--ifo` | path to `VR_MANGR.IFO` if it isn't next to the VRO | auto |

## What it does

**With the index (`VR_MANGR.IFO`)** — the converter reads, for every recording, its exact byte range inside the VRO, the date and time it was filmed, and the video format. Then:

- Each recording is converted straight from its byte range in the VRO (ffmpeg's `subfile` input) — no temporary copies of the multi-GB file.
- **Aspect ratio comes from the index.** Many camcorders flag widescreen footage as 4:3 inside the MPEG stream and record the real 16:9 only in the index; without this fix the video plays squashed.
- **The recording date is kept**: embedded as the file's creation time (Apple Photos, Google Photos and most players read it) and set as the file's modified date, so Finder sorts by when things were filmed. The camcorder clock has no time zone; it's interpreted in your computer's time zone.
- An index from a different disc is detected (it describes more data than the VRO holds) and refused with an explanation.

**Always:**

- **Regenerates timestamps and drops corrupt packets** (`-fflags +genpts+discardcorrupt`). In `--join` mode or without an index, all recordings — each with its clock restarting at zero — end up in order in one file.
- **Deinterlaces** with `yadif`. In `auto` mode only frames flagged as interlaced are touched. DVD recordings are almost always interlaced; without this you get comb artefacts on motion.
- Encodes **H.264 + AAC** for MP4/MOV/MKV, **VP9 + Opus** for WebM. `mpg` is a lossless remux with no re-encode (the aspect flag is still corrected) — fastest, and a good archival copy.
- Keeps the first video and first audio track; drops DVD navigation and subtitle data.
- Writes to a hidden `.name.partial.ext` file and renames it when done, so an interrupted conversion never leaves a truncated file under the real name.

## Limitations

- Recordings follow the disc's **original** program list. User-made playlists and edits done on the camcorder/recorder (trimmed scenes, combined titles) are not applied.
- Discs with more than one program table (rare; mixed formats) — only the first table is read.
- **CPRM-protected recordings** (copy-once TV broadcasts) are encrypted and can't be converted. The tool warns when a disc is marked as CPRM.
- The browser app is a local tool, not a public website: the server binds to `127.0.0.1` and has no authentication. Don't expose it to a network.

## Development

```sh
npm test   # needs ffmpeg + unzip on PATH; builds synthetic DVD-VR discs and converts them every supported way
```

```
src/convert.js   ffmpeg/ffprobe wrapper — presets, byte ranges, progress, cancel (shared core)
src/ifo.js       VR_MANGR.IFO parser and per-recording planning
src/zip.js       streaming store-only ZIP writer (ZIP64 when needed) for "Download all"
src/cli.js       terminal interface + `serve`
src/server.js    local HTTP server (node:http) — upload, queue, progress, downloads
public/          browser UI (plain HTML/CSS/JS, no build step)
test/            node:test suite; ifo-writer.js builds synthetic indexes
```

Real `VR_MANGR.IFO` files placed in `test/fixtures/` are automatically checked for sane structure — useful when adding support for another camcorder.

Environment variables `FFMPEG_PATH` and `FFPROBE_PATH` override the binaries used.

The DVD-VR index layout was worked out with the help of Pádraig Brady's [dvd-vr](https://github.com/pixelb/dvd-vr) (GPL-2.0); `src/ifo.js` is an independent implementation.

## License

MIT
