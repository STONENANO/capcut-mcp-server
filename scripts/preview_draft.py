#!/usr/bin/env python3
"""
Preview a CapCut draft without opening CapCut.

Reads a saved project's draft_info.json and the assets beside it, and renders an
animated GIF, a labelled contact sheet, and a timeline diagram. Everything --
geometry, timings, keyframes, transitions, text content and styling -- is read
from the project file, so the output reflects what the MCP actually wrote rather
than what any script intended to write.

    THIS IS NOT CAPCUT'S RENDERER. It is an independent interpretation of
    CapCut's project format, written to verify that a draft is structurally
    correct. Layout, timing and content are faithful to the file; typography
    metrics are approximated, and effects are suggested rather than reproduced.
    Open the draft in CapCut for the authoritative render.

Usage:
    python3 scripts/preview_draft.py <draft-folder> [-o OUTDIR] [--fps N]
                                     [--no-gif] [--no-sheet] [--no-timeline]

Output defaults to a .smartcut_previews folder BESIDE the draft, never inside
it: VectCutAPI deletes the project directory on every save, and the MCP's
backups copy the project recursively.

Requires Pillow, which VectCutAPI already installs as a dependency of imageio.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

US = 1_000_000  # CapCut stores times in microseconds

TRACK_COLOURS = {
    "video": (58, 122, 208),
    "audio": (52, 160, 118),
    "text": (196, 128, 52),
    "effect": (150, 92, 190),
    "sticker": (200, 90, 130),
}

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arialbd.ttf",
]


def find_font() -> str:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    raise SystemExit(
        "No usable TrueType font found. Set one of: " + ", ".join(FONT_CANDIDATES)
    )


def hex_rgb(value: str | None, default=(255, 255, 255)):
    if not value:
        return default
    value = value.lstrip("#")
    if len(value) < 6:
        return default
    try:
        return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return default


class Draft:
    """A parsed CapCut project."""

    def __init__(self, folder: str):
        self.folder = folder
        info = os.path.join(folder, "draft_info.json")
        if not os.path.exists(info):
            raise SystemExit(f"No draft_info.json in {folder!r} -- is that a saved draft?")
        with open(info, encoding="utf-8") as handle:
            self.doc = json.load(handle)

        canvas = self.doc.get("canvas_config", {})
        self.width = canvas.get("width", 1080)
        self.height = canvas.get("height", 1920)
        self.duration = self.doc.get("duration", 0) / US
        if self.duration <= 0:
            raise SystemExit("The draft reports a zero duration; nothing to preview.")

        mats = self.doc.get("materials", {})
        self.videos = {m["id"]: m for m in mats.get("videos", [])}
        self.texts = {m["id"]: m for m in mats.get("texts", [])}
        self.audios = {m["id"]: m for m in mats.get("audios", [])}
        self.transitions = {m["id"]: m for m in mats.get("transitions", [])}
        self.effects = {m["id"]: m for m in mats.get("video_effects", [])}
        self.tracks = self.doc.get("tracks", [])
        self.warnings: list[str] = []

    # -- helpers ----------------------------------------------------------
    def asset_path(self, material) -> str | None:
        """
        Resolve a material's file.

        CapCut records an ABSOLUTE path per material, which is also why a draft
        folder is machine-specific and cannot simply be copied to another
        machine. Fall back to looking beside the project for a draft that has
        been moved.
        """
        raw = material.get("path") or ""
        if not raw:
            return None
        if os.path.isabs(raw) and os.path.exists(raw):
            return raw
        parts = raw.replace("\\", "/").strip("/").split("/")
        local = os.path.join(self.folder, "assets", *parts[-2:])
        return local if os.path.exists(local) else None

    @staticmethod
    def span(segment) -> tuple[float, float]:
        tr = segment["target_timerange"]
        return tr["start"] / US, (tr["start"] + tr["duration"]) / US

    @staticmethod
    def keyframe(segment, prop: str, t: float, default: float) -> float:
        """Linearly interpolate a keyframe track; times are segment-relative."""
        for group in segment.get("common_keyframes") or []:
            if group.get("property_type") != prop:
                continue
            points = sorted(
                (k["time_offset"] / US, k["values"][0])
                for k in group.get("keyframe_list", [])
                if k.get("values")
            )
            if not points:
                continue
            rel = t - Draft.span(segment)[0]
            if rel <= points[0][0]:
                return points[0][1]
            if rel >= points[-1][0]:
                return points[-1][1]
            for (t0, v0), (t1, v1) in zip(points, points[1:]):
                if t0 <= rel <= t1:
                    f = 0.0 if t1 == t0 else (rel - t0) / (t1 - t0)
                    return v0 + (v1 - v0) * f
        return default

    def transition_of(self, segment):
        for ref in segment.get("extra_material_refs") or []:
            if ref in self.transitions:
                return self.transitions[ref]
        return None

    def label_for(self, material_id: str) -> str:
        if material_id in self.texts:
            try:
                return json.loads(self.texts[material_id]["content"]).get("text", "")
            except (ValueError, KeyError):
                return "(text)"
        for table in (self.videos, self.audios):
            if material_id in table:
                return os.path.basename(table[material_id].get("path", "")) or "(media)"
        if material_id in self.effects:
            return self.effects[material_id].get("name", "effect")
        return ""


class Renderer:
    def __init__(self, draft: Draft, font_path: str):
        self.d = draft
        self.font_path = font_path
        self._cache: dict[str, Image.Image | None] = {}

    # -- media ------------------------------------------------------------
    def load(self, material) -> Image.Image | None:
        """
        Load an image material. Video materials cannot be decoded here (that
        needs ffmpeg), so they render as a labelled placeholder rather than
        silently vanishing.
        """
        key = material.get("id", "")
        if key in self._cache:
            return self._cache[key]

        path = self.d.asset_path(material)
        image = None
        if path is None:
            self.d.warnings.append(
                f"missing asset for material {key[:8]} ({material.get('path', '?')})"
            )
        elif material.get("type") == "video" or path.lower().endswith(
            (".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv")
        ):
            image = self.placeholder(os.path.basename(path), material)
            self.d.warnings.append(
                f"video material {os.path.basename(path)} shown as a placeholder "
                "(decoding video needs ffmpeg)"
            )
        else:
            try:
                image = Image.open(path).convert("RGBA")
            except OSError as error:
                self.d.warnings.append(f"could not read {os.path.basename(path)}: {error}")

        self._cache[key] = image
        return image

    def placeholder(self, name: str, material) -> Image.Image:
        w = material.get("width") or self.d.width
        h = material.get("height") or self.d.height
        img = Image.new("RGBA", (int(w), int(h)), (44, 48, 58, 255))
        draw = ImageDraw.Draw(img)
        step = max(40, int(min(w, h) / 12))
        for offset in range(-int(h), int(w), step):
            draw.line([(offset, 0), (offset + h, h)], fill=(60, 66, 78, 255), width=3)
        size = max(20, int(min(w, h) / 14))
        font = ImageFont.truetype(self.font_path, size)
        draw.text((w / 2, h / 2 - size), "video frame", font=font,
                  fill=(180, 188, 200, 255), anchor="mm")
        draw.text((w / 2, h / 2 + size), name, font=font,
                  fill=(140, 148, 162, 255), anchor="mm")
        return img

    # -- composition ------------------------------------------------------
    def draw_visual(self, canvas, segment, material, t, alpha_scale=1.0):
        img = self.load(material)
        if img is None:
            return
        clip = segment.get("clip") or {}
        scale = clip.get("scale") or {}
        transform = clip.get("transform") or {}

        fit = min(self.d.width / img.width, self.d.height / img.height)
        # A uniform_scale keyframe is written as KFTypeScaleX with the segment's
        # uniform flag set, so it multiplies both axes.
        k = self.d.keyframe(segment, "KFTypeScaleX", t, 1.0)
        w = max(1, int(img.width * fit * scale.get("x", 1) * k))
        h = max(1, int(img.height * fit * scale.get("y", 1) * k))
        img = img.resize((w, h), Image.LANCZOS)

        alpha = clip.get("alpha", 1.0) * alpha_scale
        alpha *= self.d.keyframe(segment, "KFTypeAlpha", t, 1.0)
        alpha = max(0.0, min(1.0, alpha))
        if alpha < 1.0:
            img.putalpha(img.getchannel("A").point(lambda v: int(v * alpha)))

        cx = self.d.width / 2 + transform.get("x", 0) * (self.d.width / 2)
        cy = self.d.height / 2 - transform.get("y", 0) * (self.d.height / 2)
        canvas.alpha_composite(img, (int(cx - w / 2), int(cy - h / 2)))

    def draw_text(self, canvas, segment, material):
        try:
            content = json.loads(material["content"])
        except (ValueError, KeyError):
            return
        body = content.get("text", "")
        if not body:
            return
        style = (content.get("styles") or [{}])[0]
        px = max(18, int(style.get("size", 8) * 9))
        font = ImageFont.truetype(self.font_path, px)

        solid = ((style.get("fill") or {}).get("content") or {}).get("solid") or {}
        fill = tuple(
            int(max(0.0, min(1.0, c)) * 255) for c in solid.get("color", [1, 1, 1])
        )

        layer = Image.new("RGBA", (self.d.width, self.d.height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)

        lines, current = [], ""
        for word in body.split():
            trial = f"{current} {word}".strip()
            if draw.textlength(trial, font=font) <= self.d.width * 0.86 or not current:
                current = trial
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)

        line_h = int(px * 1.25)
        block_h = line_h * len(lines)
        block_w = max((draw.textlength(l, font=font) for l in lines), default=0)

        clip = segment.get("clip") or {}
        transform = clip.get("transform") or {}
        cx = self.d.width / 2 + transform.get("x", 0) * (self.d.width / 2)
        cy = self.d.height / 2 - transform.get("y", 0) * (self.d.height / 2)
        top = cy - block_h / 2

        bg_alpha = material.get("background_alpha") or 0
        if bg_alpha > 0:
            pad_x, pad_y = int(px * 0.45), int(px * 0.28)
            draw.rounded_rectangle(
                [cx - block_w / 2 - pad_x, top - pad_y,
                 cx + block_w / 2 + pad_x, top + block_h + pad_y],
                radius=int(px * 0.28),
                fill=hex_rgb(material.get("background_color"), (0, 0, 0))
                + (int(bg_alpha * 255),),
            )

        for i, line in enumerate(lines):
            y = top + i * line_h
            if material.get("has_shadow"):
                draw.text((cx + px * 0.06, y + px * 0.06), line, font=font,
                          fill=(0, 0, 0, 190), anchor="ma")
            draw.text((cx, y), line, font=font, fill=fill + (255,), anchor="ma")

        canvas.alpha_composite(layer)

    def frame(self, t: float) -> Image.Image:
        canvas = Image.new("RGBA", (self.d.width, self.d.height), (0, 0, 0, 255))

        for track in self.d.tracks:
            if track.get("type") != "video":
                continue
            segments = sorted(
                track.get("segments", []), key=lambda s: s["target_timerange"]["start"]
            )
            for i, segment in enumerate(segments):
                s0, s1 = self.d.span(segment)
                transition = self.d.transition_of(segment)
                # A transition sits on the EARLIER clip and crossfades into the
                # next one on the same track.
                if transition and i + 1 < len(segments):
                    length = transition.get("duration", 0) / US
                    following = segments[i + 1]
                    n0 = self.d.span(following)[0]
                    if length > 0 and n0 - length <= t < n0:
                        if s0 <= t:
                            self.draw_visual(
                                canvas, segment, self.d.videos.get(segment["material_id"], {}), t
                            )
                        self.draw_visual(
                            canvas, following,
                            self.d.videos.get(following["material_id"], {}), t,
                            (t - (n0 - length)) / length,
                        )
                        continue
                if s0 <= t < s1:
                    self.draw_visual(
                        canvas, segment, self.d.videos.get(segment["material_id"], {}), t
                    )

        # Effects are suggested, not reproduced: a blur is the one we can show
        # honestly, at the strength the project records.
        for track in self.d.tracks:
            if track.get("type") != "effect":
                continue
            for segment in track.get("segments", []):
                s0, s1 = self.d.span(segment)
                if not (s0 <= t < s1):
                    continue
                effect = self.d.effects.get(segment["material_id"])
                if not effect or "blur" not in (effect.get("name") or "").lower():
                    continue
                value = next(
                    (p["value"] for p in effect.get("adjust_params", [])
                     if "blur" in p.get("name", "")),
                    0.5,
                )
                canvas = canvas.filter(ImageFilter.GaussianBlur(radius=value * 28))

        for track in self.d.tracks:
            if track.get("type") != "text":
                continue
            for segment in track.get("segments", []):
                s0, s1 = self.d.span(segment)
                if s0 <= t < s1:
                    material = self.d.texts.get(segment["material_id"])
                    if material:
                        self.draw_text(canvas, segment, material)

        return canvas.convert("RGB")


def write_gif(frames, fps, path):
    # Pillow merges runs of identical frames and ACCUMULATES their durations,
    # so the file has fewer frames than were rendered but the same total
    # playback time. Smaller file, correct timing.
    small = [f.resize((360, int(360 * f.height / f.width)), Image.LANCZOS) for f in frames]
    small[0].save(path, save_all=True, append_images=small[1:],
                  duration=int(1000 / fps), loop=0, optimize=True)


def write_sheet(draft, frames, fps, font_path, path, columns=4, count=8):
    picks = []
    for i in range(count):
        t = draft.duration * (i + 0.5) / count
        picks.append((t, frames[min(int(t * fps), len(frames) - 1)]))

    cw = 300
    ch = int(cw * draft.height / draft.width)
    pad, label_h = 14, 34
    rows = (len(picks) + columns - 1) // columns
    sheet = Image.new(
        "RGB",
        (cw * columns + pad * (columns + 1), (ch + label_h) * rows + pad * (rows + 1)),
        (22, 24, 28),
    )
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(font_path, 19)
    for i, (t, frame) in enumerate(picks):
        x = pad + (i % columns) * (cw + pad)
        y = pad + (i // columns) * (ch + label_h + pad)
        sheet.paste(frame.resize((cw, ch), Image.LANCZOS), (x, y))
        draw.text((x + cw / 2, y + ch + 8), f"t = {t:.1f}s", font=font,
                  fill=(215, 220, 230), anchor="ma")
    sheet.save(path)


def write_timeline(draft, font_path, path):
    rows = [t for t in draft.tracks if t.get("segments")]
    if not rows:
        return
    left, right, top, row_h, gap = 190, 60, 96, 52, 14
    width = 1400
    height = top + len(rows) * (row_h + gap) + 100
    img = Image.new("RGB", (width, height), (20, 22, 27))
    draw = ImageDraw.Draw(img)
    f_small = ImageFont.truetype(font_path, 15)
    f_row = ImageFont.truetype(font_path, 17)
    f_head = ImageFont.truetype(font_path, 19)
    plot = width - left - right

    def x_of(seconds):
        return left + (seconds / draft.duration) * plot

    draw.text((left, 28), f"CapCut project timeline  -  {os.path.basename(draft.folder)}",
              font=f_head, fill=(240, 244, 250))
    draw.text((left, 54),
              f"read from draft_info.json  -  {draft.duration:.1f}s  -  "
              f"{draft.width}x{draft.height}",
              font=f_small, fill=(150, 158, 172))

    for second in range(int(draft.duration) + 1):
        x = x_of(second)
        draw.line([(x, top - 8), (x, height - 74)], fill=(48, 52, 60), width=1)
        draw.text((x, height - 68), f"{second}s", font=f_small,
                  fill=(140, 148, 162), anchor="ma")

    for i, track in enumerate(rows):
        y = top + i * (row_h + gap)
        draw.text((left - 16, y + row_h / 2), track.get("name") or track["type"],
                  font=f_row, fill=(214, 220, 230), anchor="rm")
        draw.text((left - 16, y + row_h / 2 + 19), track["type"], font=f_small,
                  fill=(120, 128, 142), anchor="rm")
        draw.rectangle([left, y, left + plot, y + row_h], fill=(28, 31, 37))

        for segment in track["segments"]:
            t0, t1 = draft.span(segment)
            x0, x1 = x_of(t0), x_of(t1)
            draw.rounded_rectangle([x0 + 2, y + 4, x1 - 2, y + row_h - 4], radius=7,
                                   fill=TRACK_COLOURS.get(track["type"], (90, 90, 90)))
            label = draft.label_for(segment["material_id"])
            if label and x1 - x0 > 60:
                draw.text((x0 + 12, y + row_h / 2), label[:34], font=f_small,
                          fill=(255, 255, 255), anchor="lm")

            transition = draft.transition_of(segment)
            if transition:
                length = transition.get("duration", 0) / US
                tx = x_of(max(t0, t1 - length))
                draw.rectangle([tx, y + 4, x1 - 2, y + row_h - 4], fill=(255, 255, 255))
                draw.text(((tx + x1) / 2, y + row_h / 2),
                          f"{transition.get('name', 'transition')} {length:g}s",
                          font=f_small, fill=(20, 24, 30), anchor="mm")

            for group in segment.get("common_keyframes") or []:
                for k in group.get("keyframe_list", []):
                    kx = x_of(t0 + k["time_offset"] / US)
                    draw.ellipse([kx - 5, y + row_h / 2 - 5, kx + 5, y + row_h / 2 + 5],
                                 fill=(255, 232, 120), outline=(40, 34, 10))

    draw.text((left, height - 40),
              "yellow dots = keyframes    white band = transition (sits on the earlier clip)",
              font=f_small, fill=(150, 158, 172))
    img.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Preview a CapCut draft without opening CapCut.",
        epilog="This is NOT CapCut's renderer -- see the module docstring.",
    )
    parser.add_argument("draft", help="path to a saved draft folder (contains draft_info.json)")
    parser.add_argument(
        "-o", "--out", default=None,
        help="output directory (default: a .smartcut_previews folder beside the draft)",
    )
    parser.add_argument("--fps", type=int, default=10, help="render frame rate (default: 10)")
    parser.add_argument("--no-gif", action="store_true")
    parser.add_argument("--no-sheet", action="store_true")
    parser.add_argument("--no-timeline", action="store_true")
    args = parser.parse_args()

    draft = Draft(os.path.abspath(args.draft))
    # Never write inside the project directory: VectCutAPI deletes and rebuilds
    # it on every save, and the MCP's backups copy the project recursively, so
    # anything left in there is both doomed and carried into every snapshot.
    out = args.out or os.path.join(
        os.path.dirname(draft.folder), ".smartcut_previews", os.path.basename(draft.folder)
    )
    os.makedirs(out, exist_ok=True)
    font_path = find_font()
    renderer = Renderer(draft, font_path)

    print(f"draft     {os.path.basename(draft.folder)}")
    print(f"canvas    {draft.width}x{draft.height}   duration {draft.duration:.2f}s")
    for track in draft.tracks:
        if track.get("segments"):
            print(f"  {track['type']:<7} {track.get('name', ''):<12} "
                  f"{len(track['segments'])} segment(s)")

    frames = [renderer.frame(i / args.fps) for i in range(max(1, int(draft.duration * args.fps)))]
    print(f"\nrendered  {len(frames)} frames")

    written = []
    if not args.no_gif:
        path = os.path.join(out, "preview.gif")
        write_gif(frames, args.fps, path)
        written.append(path)
    if not args.no_sheet:
        path = os.path.join(out, "contact-sheet.png")
        write_sheet(draft, frames, args.fps, font_path, path)
        written.append(path)
    if not args.no_timeline:
        path = os.path.join(out, "timeline.png")
        write_timeline(draft, font_path, path)
        written.append(path)

    for path in written:
        print(f"  {path}  ({os.path.getsize(path)} bytes)")

    if draft.warnings:
        print("\nnotes:")
        for note in sorted(set(draft.warnings)):
            print(f"  - {note}")

    print("\nThis is an approximation, not CapCut's own render. Open the draft in "
          "CapCut for the authoritative result.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
