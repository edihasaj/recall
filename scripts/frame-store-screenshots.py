"""Frame native sandbox dashboard captures at Apple's 1440x900 Mac screenshot size."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("attachments", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((args.attachments / "manifest.json").read_text())
    font = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", 32)
    label = ImageFont.truetype("/System/Library/Fonts/Avenir Next.ttc", 20)
    for test in manifest:
        for attachment in test["attachments"]:
            name = attachment["suggestedHumanReadableName"].split("_")[0]
            if name not in ("01-memory", "02-graph"):
                continue
            canvas = Image.new("RGB", (1440, 900), "#102326")
            draw = ImageDraw.Draw(canvas)
            title = "Keep the rules your agent should remember." if name == "01-memory" else "See how your project knowledge connects."
            draw.text((62, 24), title, font=font, fill="#f3f0e8")
            draw.text((62, 856), "RECALL  /  LOCAL CODING MEMORY", font=label, fill="#d7a357")
            image = Image.open(args.attachments / attachment["exportedFileName"]).convert("RGB")
            image.thumbnail((1320, 710), Image.Resampling.LANCZOS)
            x, y = (1440 - image.width) // 2, 100
            draw.rounded_rectangle((x - 3, y - 3, x + image.width + 3, y + image.height + 3),
                                   radius=12, fill="#476164")
            canvas.paste(image, (x, y))
            destination = args.output / (name + ".png")
            canvas.save(destination)
            print(destination)


if __name__ == "__main__":
    main()
