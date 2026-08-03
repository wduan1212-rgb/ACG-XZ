#!/usr/bin/env python3
"""Build transparent, consistently framed StarMatrix brand assets."""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
BRAND_DIR = ROOT / "assets" / "brand"


def _distance(left: tuple[int, int, int], right: tuple[int, int, int]) -> float:
    return sum((left[index] - right[index]) ** 2 for index in range(3)) ** 0.5


def remove_connected_background(source: Path, destination: Path, threshold: float = 54.0) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    width, height = image.size
    rgb = image.convert("RGB")
    pixels = rgb.load()
    corners = (
        pixels[0, 0],
        pixels[width - 1, 0],
        pixels[0, height - 1],
        pixels[width - 1, height - 1],
    )
    background = tuple(round(sum(color[channel] for color in corners) / len(corners)) for channel in range(3))

    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        index = y * width + x
        if visited[index] or _distance(pixels[x, y], background) > threshold:
            continue
        visited[index] = 1
        if x:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    background_mask = Image.new("L", (width, height), 0)
    background_mask.putdata([255 if value else 0 for value in visited])
    softened = background_mask.filter(ImageFilter.GaussianBlur(0.7))
    alpha = ImageChops.invert(softened)
    image.putalpha(alpha)

    bbox = alpha.getbbox()
    if bbox:
        subject = image.crop(bbox)
        side = max(subject.size)
        padding = max(18, round(side * 0.1))
        canvas_side = side + padding * 2
        canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
        canvas.alpha_composite(
            subject,
            ((canvas_side - subject.width) // 2, (canvas_side - subject.height) // 2),
        )
        image = canvas.resize((512, 512), Image.Resampling.LANCZOS)

    image.save(destination, optimize=True)
    return image


def _dark_components(image: Image.Image) -> list[tuple[int, tuple[int, int, int, int]]]:
    """Return connected dark-blue regions used to locate the mascot eyes."""

    width, height = image.size
    pixels = image.load()
    mask = bytearray(width * height)
    for y in range(height // 2, height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha > 180 and red < 55 and green < 105 and blue < 150:
                mask[y * width + x] = 1

    seen = bytearray(width * height)
    components: list[tuple[int, tuple[int, int, int, int]]] = []
    for y in range(height // 2, height):
        for x in range(width):
            index = y * width + x
            if not mask[index] or seen[index]:
                continue
            queue: deque[tuple[int, int]] = deque([(x, y)])
            seen[index] = 1
            points: list[tuple[int, int]] = []
            while queue:
                current_x, current_y = queue.popleft()
                points.append((current_x, current_y))
                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if not (0 <= next_x < width and height // 2 <= next_y < height):
                        continue
                    next_index = next_y * width + next_x
                    if mask[next_index] and not seen[next_index]:
                        seen[next_index] = 1
                        queue.append((next_x, next_y))
            if len(points) < 200:
                continue
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            components.append(
                (len(points), (min(xs), min(ys), max(xs) + 1, max(ys) + 1))
            )
    return components


def _right_eye_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    components = _dark_components(image)
    if len(components) < 2:
        raise RuntimeError("Unable to locate both mascot eyes for wink animation")
    eye_candidates = sorted(components, key=lambda component: component[0], reverse=True)[:2]
    return max(eye_candidates, key=lambda component: component[1][0])[1]


def _anti_aliased_ellipse_mask(
    size: tuple[int, int],
    bbox: tuple[int, int, int, int],
    scale: int = 4,
) -> Image.Image:
    mask = Image.new("L", (size[0] * scale, size[1] * scale), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(tuple(value * scale for value in bbox), fill=255)
    return mask.resize(size, Image.Resampling.LANCZOS)


def _eye_background(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
) -> Image.Image:
    """Reconstruct the smooth blue body behind one eye."""

    clean = image.copy()
    source = image.load()
    pixels = clean.load()
    width, height = image.size
    left, top, right, bottom = bbox
    sample_top = max(0, top - 5)
    sample_bottom = min(height - 1, bottom + 5)
    span = max(1, bottom - top)

    for y in range(top, bottom + 1):
        progress = min(1.0, max(0.0, (y - top) / span))
        eased = progress * progress * (3.0 - 2.0 * progress)
        for x in range(max(0, left), min(width, right + 1)):
            top_pixel = source[x, sample_top]
            bottom_pixel = source[x, sample_bottom]
            pixels[x, y] = tuple(
                round(top_pixel[channel] * (1.0 - eased) + bottom_pixel[channel] * eased)
                for channel in range(3)
            ) + (source[x, y][3],)
    return clean


def _wink_frame(
    source: Image.Image,
    clean: Image.Image,
    eye_bbox: tuple[int, int, int, int],
    progress: float,
) -> Image.Image:
    if progress <= 0:
        return source.copy()

    left, top, right, bottom = eye_bbox
    eye_width = right - left
    eye_height = bottom - top
    expanded = (
        max(0, left - 2),
        max(0, top - 2),
        min(source.width - 1, right + 2),
        min(source.height - 1, bottom + 2),
    )
    eye_mask = _anti_aliased_ellipse_mask(source.size, expanded)

    scale = 4
    closure_mask_large = Image.new("L", (source.width * scale, source.height * scale), 0)
    closure_draw = ImageDraw.Draw(closure_mask_large)
    center_y = (top + bottom) / 2 + eye_height * 0.04
    visible_half_height = eye_height * (1.0 - progress) / 2
    upper_edge = round((center_y - visible_half_height) * scale)
    lower_edge = round((center_y + visible_half_height) * scale)
    closure_draw.rectangle((0, 0, source.width * scale, upper_edge), fill=255)
    closure_draw.rectangle(
        (0, lower_edge, source.width * scale, source.height * scale),
        fill=255,
    )
    closure_mask = closure_mask_large.resize(source.size, Image.Resampling.LANCZOS)
    cover_mask = ImageChops.multiply(eye_mask, closure_mask)
    frame = Image.composite(clean, source, cover_mask)

    if progress >= 0.68:
        line_scale = 4
        line_layer = Image.new(
            "RGBA",
            (source.width * line_scale, source.height * line_scale),
            (0, 0, 0, 0),
        )
        line_draw = ImageDraw.Draw(line_layer)
        start = (left + eye_width * 0.08, center_y - eye_height * 0.02)
        control = (left + eye_width * 0.51, center_y + eye_height * 0.17)
        end = (right - eye_width * 0.08, center_y)
        points: list[tuple[int, int]] = []
        for step in range(25):
            amount = step / 24
            inverse = 1.0 - amount
            x = inverse * inverse * start[0] + 2 * inverse * amount * control[0] + amount * amount * end[0]
            y = inverse * inverse * start[1] + 2 * inverse * amount * control[1] + amount * amount * end[1]
            points.append((round(x * line_scale), round(y * line_scale)))
        opacity = round(255 * min(1.0, (progress - 0.68) / 0.32))
        line_draw.line(
            points,
            fill=(4, 36, 103, opacity),
            width=max(1, round(3.2 * line_scale)),
            joint="curve",
        )
        line_layer = line_layer.resize(source.size, Image.Resampling.LANCZOS)
        frame = Image.alpha_composite(frame, line_layer)

    # The animation may alter colors only inside the eye. Reusing the exact
    # source alpha keeps the transparent silhouette identical on every frame.
    frame.putalpha(source.getchannel("A"))
    return frame


def build_winking_mascot(source: Image.Image, destination: Path) -> None:
    source = source.convert("RGBA")
    eye_bbox = _right_eye_bbox(source)
    expanded_bbox = (
        max(0, eye_bbox[0] - 3),
        max(0, eye_bbox[1] - 3),
        min(source.width - 1, eye_bbox[2] + 3),
        min(source.height - 1, eye_bbox[3] + 3),
    )
    clean = _eye_background(source, expanded_bbox)

    # Two subtly irregular self-triggered winks avoid a robotic fixed beat.
    timeline = (
        (0.00, 2700),
        (0.32, 55),
        (0.68, 55),
        (1.00, 95),
        (1.00, 85),
        (0.62, 60),
        (0.25, 65),
        (0.00, 4450),
        (0.32, 55),
        (0.68, 55),
        (1.00, 95),
        (1.00, 85),
        (0.62, 60),
        (0.25, 65),
        (0.00, 1600),
    )
    frames = [
        _wink_frame(source, clean, eye_bbox, progress)
        for progress, _duration in timeline
    ]
    durations = [duration for _progress, duration in timeline]
    frames[0].save(
        destination,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        lossless=True,
        quality=100,
        method=6,
    )


def main() -> None:
    mascot = remove_connected_background(
        BRAND_DIR / "starmatrix-mascot-normal.png",
        BRAND_DIR / "starmatrix-mascot-transparent.png",
    )
    build_winking_mascot(
        mascot,
        BRAND_DIR / "starmatrix-mascot-wink.webp",
    )
    remove_connected_background(
        BRAND_DIR / "starmatrix-logo-black.png",
        BRAND_DIR / "starmatrix-logo-black-transparent.png",
    )
    remove_connected_background(
        BRAND_DIR / "starmatrix-logo-login.png",
        BRAND_DIR / "starmatrix-logo-login-transparent.png",
        threshold=42.0,
    )

    favicon = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    icon = mascot.resize((112, 112), Image.Resampling.LANCZOS)
    favicon.alpha_composite(icon, (8, 8))
    favicon.save(BRAND_DIR / "starmatrix-favicon.png", optimize=True)


if __name__ == "__main__":
    main()
