# Requirements

## Dependencies

Required binaries:
- `bash`
- `ffmpeg`
- `gs` (Ghostscript)
- ImageMagick (`magick` on v7, `convert` on v6)

## Install

### macOS (Homebrew)

```bash
brew install bash ffmpeg ghostscript imagemagick
```

### Debian/Ubuntu

```bash
sudo apt-get install bash ffmpeg ghostscript imagemagick
```

## Troubleshooting

- `missing dependency: <name>`:
  - install the missing binary and re-run.
- output too large:
  - adjust script tunables manually in `scripts/fakescanner.sh` (outside this skill workflow).
- conversion fails on malformed PDF:
  - try re-saving the PDF from a viewer, then run again.
