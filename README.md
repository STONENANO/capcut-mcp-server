# CapCut MCP Server — local-only fork

An MCP server for driving CapCut edits from Claude Code or Codex, hardened for
local use. It speaks **stdio only**, talks to a **loopback-only** VectCutAPI, and
**backs up your CapCut project before every destructive write**.

This is a security-focused fork of
[Atx-Guy/capcut-mcp-server](https://github.com/Atx-Guy/capcut-mcp-server). See
[`docs/SECURITY.md`](docs/SECURITY.md) for the audit findings and the threat
model.

```
Claude Code / Codex
   |  stdio only — this process never opens a port
   v
capcut-mcp-server
   |  HTTP to 127.0.0.1 only — anything else is refused at startup
   v
VectCutAPI (loopback)
   |
   v
CapCut draft files
```

## What is different from upstream

- **No HTTP transport.** Removed, not gated. `TRANSPORT=http` does nothing;
  `express` is no longer a dependency.
- **`CAPCUT_API_URL` must be loopback.** Public IPs, LAN ranges, arbitrary
  domains and HTTPS remotes are rejected before the server starts.
- **Media references are validated.** HTTPS only, with private, loopback,
  link-local and cloud-metadata destinations blocked — including through
  redirects. Local files are allowed only from directories you approve.
- **Automatic backups.** VectCutAPI *deletes and rebuilds* a project directory
  when it saves. Every save is preceded by a complete snapshot, stored outside
  the project so the save cannot destroy it, restorable with one tool.
- **Compatibility fixes.** Several tools could not have worked against current
  VectCutAPI; see [Compatibility fixes](#compatibility-fixes).
- **Pinned dependencies** with a committed lockfile.

## Requirements

- Node.js 20.11+
- Python 3 and a VectCutAPI checkout
- CapCut installed (to open the saved drafts)

## Setup

### 1. Harden and start VectCutAPI

Upstream VectCutAPI binds `0.0.0.0`, exposing unauthenticated editing routes to
your whole network, and requires the Alibaba OSS SDK even though uploads default
to off. The `vectcutapi/` directory fixes both:

```bash
git clone https://github.com/sun-guannan/VectCutAPI.git
cd VectCutAPI

git apply /path/to/capcut-mcp-server/vectcutapi/bind-localhost.patch
git apply /path/to/capcut-mcp-server/vectcutapi/disable-cloud-upload.patch
cp /path/to/capcut-mcp-server/vectcutapi/config.json .

pip install -r /path/to/capcut-mcp-server/vectcutapi/requirements-pinned.txt
python capcut_server.py --host 127.0.0.1 --port 9000
```

After the patch, `--host` defaults to loopback and refuses anything else.

> VectCutAPI's code default is port **9000**; its own `config.json.example` says
> **9001**. The bundled `config.json` pins 9000 to match `CAPCUT_API_URL` below.

### 2. Build the MCP server

```bash
git clone <your-fork-url>
cd capcut-mcp-server
npm ci
npm run build
npm test
```

### 3. Configure your MCP client

`~/Library/Application Support/Claude/claude_desktop_config.json`, or your Codex
MCP config:

```json
{
  "mcpServers": {
    "capcut": {
      "command": "node",
      "args": ["/absolute/path/to/capcut-mcp-server/dist/index.js"],
      "env": {
        "CAPCUT_API_URL": "http://127.0.0.1:9000",
        "CAPCUT_DRAFT_DIR": "/Users/you/Movies/CapCut/User Data/Projects/com.lveditor.draft",
        "CAPCUT_MEDIA_DIRS": "/Users/you/Movies/capcut-media"
      }
    }
  }
}
```

Confirm `CAPCUT_DRAFT_DIR` against your own CapCut install before pointing the
server at it — the path varies by CapCut version. Start with a scratch directory
if you want to try it first.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CAPCUT_API_URL` | `http://127.0.0.1:9000` | VectCutAPI base URL. Must be plain-HTTP loopback. |
| `CAPCUT_DRAFT_DIR` | *(unset)* | CapCut projects directory. Required for saving and restoring. |
| `CAPCUT_MEDIA_DIRS` | *(unset)* | `:`-separated directories local media may be read from. Unset means HTTPS only. |
| `CAPCUT_MAX_DOWNLOAD_BYTES` | `536870912` (512 MiB) | Largest media file accepted. |
| `CAPCUT_MAX_BACKUP_BYTES` | `2147483648` (2 GiB) | Largest project that will be snapshotted. Over this, saving is refused. |
| `CAPCUT_REQUEST_TIMEOUT_MS` | `120000` | Network timeout. |
| `CAPCUT_MEDIA_PREFLIGHT` | `1` | Check media URLs and their redirects before use. |
| `CAPCUT_MAX_REDIRECTS` | `5` | Redirect hops allowed during preflight. |
| `CAPCUT_BACKUP_COALESCE_SECONDS` | `300` | Suppress a new backup if one is newer than this. |
| `CAPCUT_ALLOW_CLOUD_UPLOAD` | *(unset)* | Must stay unset. Setting it stops the server from starting. |

An invalid value is a startup error, never a silent fallback.

## Tools

Every tool's description begins with `[READ-ONLY]` or `[MUTATING]`.

| Tool | Kind | Purpose |
| --- | --- | --- |
| `capcut_create_draft` | MUTATING | Create an empty draft, returns `draft_id`. |
| `capcut_add_video` | MUTATING | Add a video clip. |
| `capcut_add_audio` | MUTATING | Add an audio track. |
| `capcut_add_text` | MUTATING | Add a styled text overlay. |
| `capcut_add_image` | MUTATING | Add an image overlay. |
| `capcut_add_subtitle` | MUTATING | Add SRT subtitles. |
| `capcut_add_keyframe` | MUTATING | Animate track properties. |
| `capcut_add_effect` | MUTATING | Apply a CapCut visual effect. |
| `capcut_add_sticker` | MUTATING | Add a CapCut sticker by resource id. |
| `capcut_save_draft` | MUTATING (destructive) | Write into `CAPCUT_DRAFT_DIR`, after a backup. |
| `capcut_list_asset_types` | READ-ONLY | List valid effect/transition/font/animation names. |
| `capcut_restore_backup` | MUTATING (destructive) | List or restore automatic backups. |

`capcut_get_duration` was removed: VectCutAPI exposes no `/get_duration` HTTP
route, so the tool could never have worked.

CapCut matches effects, transitions, fonts and animations by **exact name**.
Call `capcut_list_asset_types` first rather than guessing.

Segments on a single track may not overlap in time — CapCut rejects the second
one. Layer overlapping elements by giving them different `track_name` values.
This applies to video, image, audio, text and effect segments alike.

A `transition` attaches to the **earlier** clip of a pair on the same track — it
plays between that segment and the next one. Set on the later clip, or on a clip
nothing follows, it is written into the project and renders nothing, with no
error. Only the transition *name* is validated.

### Example

```jsonc
// 1. create
{"tool": "capcut_create_draft", "args": {"width": 1080, "height": 1920}}

// 2. find a real effect name
{"tool": "capcut_list_asset_types", "args": {"category": "video_scene_effect"}}

// 3. build
{"tool": "capcut_add_video",  "args": {"draft_id": "dfd_...", "video_url": "https://cdn.example.com/clip.mp4", "start": 0, "end": 10, "target_start": 0}}
{"tool": "capcut_add_text",   "args": {"draft_id": "dfd_...", "text": "Hello", "start": 1, "end": 4, "transform_y": -0.6}}
{"tool": "capcut_add_effect", "args": {"draft_id": "dfd_...", "effect_type": "Blur", "start": 0, "end": 2}}

// 4. save (a backup is taken first)
{"tool": "capcut_save_draft", "args": {"draft_id": "dfd_..."}}
```

## Backups

`capcut_save_draft` snapshots the whole project to:

```
<CAPCUT_DRAFT_DIR>/.smartcut_backups/<draft_id>/YYYY-MM-DD_HH-MM-SS/
```

Deliberately **outside** the project directory: VectCutAPI's save removes the
project directory entirely, so an in-project backup would be deleted by the very
operation it exists to protect.

- Saves within `CAPCUT_BACKUP_COALESCE_SECONDS` share one snapshot, so a single
  editing session does not leave dozens of copies.
- If a complete snapshot cannot be taken, **the save does not happen**.
- Restoring takes its own snapshot first, so a restore is undoable.
- Nothing is pruned automatically. Clear old snapshots yourself.

```jsonc
{"tool": "capcut_restore_backup", "args": {"draft_id": "dfd_..."}}                                  // list
{"tool": "capcut_restore_backup", "args": {"draft_id": "dfd_...", "version": "2026-09-07_14-31-05"}} // restore
```

## Compatibility fixes

Verified against a running VectCutAPI, not just by reading its source. Upstream
sent these; the backend does not accept them.

| Area | Upstream sent | VectCutAPI expects |
| --- | --- | --- |
| Response payload | `result` | `output` — so *every* tool failed |
| Keyframes | `POST /add_keyframe` | `POST /add_video_keyframe` |
| Keyframe arrays | `times`/`values` only | `property_types`, `times`, `values` all equal length |
| Subtitles | `srt_content` | `srt` |
| Effects | `effect_name`, `intensity` | `effect_type`, `effect_category`, `params[]` |
| Effect params | omitted when unset | must always be sent (backend does `params[::-1]`) |
| Effect names | `blur`, `sharpen`, … | exact CapCut enum names, e.g. `Blur`, `Fade_In` |
| Stickers | `sticker_url` | `sticker_id` (a CapCut resource id, not a URL) |
| Positioning | `position_x`/`position_y` (0–1) | `transform_x`/`transform_y` (≈ −1–1, 0 = centre) |
| Sizing | `scale`, `rotation` | `scale_x`/`scale_y`; images have no rotation |
| Font size | points (12–200) | CapCut's own scale (≈1–100, default 8) |
| Animations | `fade_in`, `slide_up`, … | `intro_animation`/`outro_animation` with exact names |
| Audio fades | `fade_in`/`fade_out` | not supported — removed from the schema |
| Draft creation | `fps` | not supported — derived from source media |
| Default port | `9001` | `9000` in code (`9001` only in the example config) |
| Saved project identity | template copied verbatim | `draft_meta_info.json` must point at *this* machine — see below |

### Why drafts didn't appear in CapCut

VectCutAPI builds each saved draft by copying a template directory and never
rewrites `draft_meta_info.json`, so every draft shipped the template author's
own values:

```
draft_fold_path  /Users/sunguannan/Movies/CapCut/.../com.lveditor.draft/0707
draft_root_path  /Users/sunguannan/Movies/CapCut/.../com.lveditor.draft
draft_id         989869B1-B560-489C-9C6F-4B444F24BF36   (identical in every draft)
draft_name       0707
tm_duration      0
```

CapCut builds its Projects list from that file, so drafts claiming a directory
that doesn't exist on your machine — all sharing one UUID — don't show up. The
timeline itself was always correct; only its identity was wrong.

`capcut_save_draft` now rewrites those fields to the real project path, a UUID
derived from the draft id (stable across re-saves, so CapCut doesn't accumulate
duplicates), the real duration, and clears the cover reference when no
`draft_cover.jpg` exists. Content is untouched. If the repair can't run, the
tool result says the draft may not appear rather than reporting a clean save.

## Development

```bash
npm run typecheck   # tsc over src and tests
npm test            # 94 tests, no network or backend needed
npm run build
npm run smoke       # manual: needs a running VectCutAPI (see scripts/smoke.mjs)
```

`npm test` stubs the backend and DNS so it runs anywhere. `npm run smoke` drives
the real built server over stdio against a live loopback VectCutAPI.

### Previewing a draft without opening CapCut

```bash
python3 scripts/preview_draft.py "$CAPCUT_DRAFT_DIR/dfd_..."
# writes preview.gif, contact-sheet.png and timeline.png into
# $CAPCUT_DRAFT_DIR/.smartcut_previews/<draft_id>/
```

Reads the saved `draft_info.json` and the assets beside it, so what you see
reflects what the MCP actually wrote. Useful for checking an edit landed before
switching to CapCut, and for seeing a timeline of tracks, segments, keyframes
and transitions at a glance.

**It is not CapCut's renderer.** Layout, timing, keyframes, transitions and text
come from the project file, but typography is approximated and effects are only
suggested — a blur is shown at the recorded strength, other effects are not
drawn. Video clips need ffmpeg to decode, so they appear as labelled
placeholders; images, text and subtitles render fully. Open the draft in CapCut
for the authoritative result.

Needs Pillow, which VectCutAPI already installs as a dependency of `imageio`. It
is a developer aid only: no MCP tool invokes it and it is not part of the build.

## License

MIT. CapCut is a trademark of Bytedance Ltd. This is an unofficial project.
Built on [VectCutAPI](https://github.com/sun-guannan/VectCutAPI) by sun-guannan.
