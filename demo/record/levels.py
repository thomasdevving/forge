"""Measures the loudness of the intro and of every voice-over line in src/vo.ts, so the edit can bring
each one to the same level. Run after record/takes.sh or after changing a line in src/vo.ts:

    python3 demo/record/levels.py

Writes src/data/vo-levels.json: integrated loudness (LUFS, EBU R128) per line, keyed
"<take>@<from>-<to>", plus "intro".
"""

import json
import re
import subprocess
from pathlib import Path

DEMO = Path(__file__).resolve().parent.parent
FOOTAGE = DEMO / "footage"


def lufs(path: Path, start: float | None = None, end: float | None = None) -> float:
    cut = ["-ss", str(start), "-to", str(end)] if start is not None else []
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", *cut, "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    ).stderr
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", out)[-1])


def main() -> None:
    src = (DEMO / "src" / "vo.ts").read_text()
    head = src.split("export const VO")[0]
    alias = dict(re.findall(r'(\w+) = "([^"]+)"', head))
    lines = re.findall(r'\{ take: (\w+|"[^"]+"), from: ([\d.]+), to: ([\d.]+)', src)
    levels: dict[str, float] = {}
    if (FOOTAGE / "intro.mp4").exists():
        levels["intro"] = lufs(FOOTAGE / "intro.mp4")
    for take_ref, start, end in lines:
        take = alias.get(take_ref, take_ref.strip('"'))
        key = f"{take}@{float(start):g}-{float(end):g}"
        levels[key] = lufs(FOOTAGE / "cam" / f"{take}.mp4", float(start), float(end))
        print(f"{key:28} {levels[key]:6.1f} LUFS")
    out = DEMO / "src" / "data" / "vo-levels.json"
    out.write_text(json.dumps(levels, indent=2) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
