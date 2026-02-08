#!/usr/bin/env bash
set -euo pipefail

VERSION="1.0.0"

# =========================
# PDF -> "phone scan look" -> PDF
# =========================
#
# Usage:
#   ./fakescanner.sh input.pdf [output.pdf]
#
# Notes:
# - Works offline
# - Keeps multipage PDFs
# - Produces a "phone scanned" look (B/W, non-uniform light, mild skew, noise/blur)
#

INPUT=""
OUTPUT=""

usage() {
  echo "Usage: $0 input.pdf [output.pdf]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -V|--version)
      echo "fakescanner ${VERSION}"
      exit 0
      ;;
    -*)
      echo "Error: unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -z "${INPUT}" ]]; then
        INPUT="$1"
      elif [[ -z "${OUTPUT}" ]]; then
        OUTPUT="$1"
      else
        echo "Error: too many positional arguments: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "${INPUT}" ]]; then
  usage
  exit 1
fi

if [[ ! -f "${INPUT}" ]]; then
  echo "Error: input file not found: ${INPUT}" >&2
  exit 1
fi

if [[ -z "${OUTPUT}" ]]; then
  base="$(basename "${INPUT}" .pdf)"
  OUTPUT="${base}_scannerizzato.pdf"
fi

# --- Dependencies ---
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: missing dependency: $1" >&2
    exit 1
  }
}
need ffmpeg
need gs
if command -v magick >/dev/null 2>&1; then
  IM_CMD=(magick)
elif command -v convert >/dev/null 2>&1; then
  IM_CMD=(convert)
else
  echo "Error: missing dependency: ImageMagick (magick or convert)" >&2
  echo "Hint (macOS): brew install imagemagick" >&2
  echo "Hint (Debian/Ubuntu): sudo apt-get install imagemagick" >&2
  exit 1
fi

# --- Temp workspace ---
WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "${WORKDIR}"; }
trap cleanup EXIT

# --- Tunables (edit these if you want) ---
DPI=200         # 150-300 typical scan range
NOISE=14        # 0-20 (more = dirtier)
BLUR=1.0        # 0.0-1.5 (more = softer)
CONTRAST=0.85   # 0.7-1.2
BRIGHTNESS=0.05 # -0.1 to 0.1
JPEG_QUALITY=70 # 1-100 (lower = smaller file)
LIGHT_GRAD_X=0.10
LIGHT_GRAD_Y=-0.05
LIGHT_HOTSPOT=0.14
VIGNETTE_ANGLE="PI/8"
PHONE_LIGHT_ARTIFACTS=1

# Optional "storto" effect (0 = off, 1 = on)
# Enabled by default with mild values to emulate a slightly misaligned phone shot.
SKEW=1

# Perspective params used when SKEW=1
# Mild values only, otherwise it looks like a crime scene photo.
PERSPECTIVE_VF="perspective=x0=0:y0=4:x1=W:y1=1:x2=5:y2=H:x3=W-4:y3=H-1"

echo "Input : ${INPUT}"
echo "Output: ${OUTPUT}"
echo "Working in: ${WORKDIR}"
echo

# 1) Normalize PDF via Ghostscript (helps ffmpeg behave with weird PDFs)
NORMPDF="${WORKDIR}/normalized.pdf"
echo "[1/4] Normalizing PDF with Ghostscript..."
gs -q -dNOPAUSE -dBATCH -dSAFER \
  -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.4 \
  -sOutputFile="${NORMPDF}" \
  "${INPUT}"

# 2) PDF -> PNG frames
echo "[2/4] Rendering pages to images (${DPI} dpi)..."
"${IM_CMD[@]}" -density "${DPI}" \
  "${NORMPDF}" \
  -background white -alpha remove -alpha off \
  "${WORKDIR}/page_%04d.png"

# 3) Apply "phone scan" effect (and optional skew)
echo "[3/4] Applying phone-scan effect..."
VF_BASE="format=gray,eq=contrast=${CONTRAST}:brightness=${BRIGHTNESS},noise=alls=${NOISE}:allf=t+u,gblur=sigma=${BLUR}"
VF_LIGHT="geq=lum='clip(p(X,Y)*(0.90+(${LIGHT_GRAD_X})*X/W+(${LIGHT_GRAD_Y})*Y/H+(${LIGHT_HOTSPOT})*exp(-((X-0.72*W)*(X-0.72*W)+(Y-0.25*H)*(Y-0.25*H))/(2*0.18*W*0.18*W))),0,255)',vignette=${VIGNETTE_ANGLE}"
if [[ "${PHONE_LIGHT_ARTIFACTS}" -eq 1 ]]; then
  VF="${VF_BASE},${VF_LIGHT}"
else
  VF="${VF_BASE}"
fi
if [[ "${SKEW}" -eq 1 ]]; then
  VF="${VF},${PERSPECTIVE_VF}"
fi

ffmpeg -hide_banner -loglevel error \
  -pattern_type glob -i "${WORKDIR}/page_*.png" \
  -vf "${VF},format=gray" \
  -q:v 5 \
  "${WORKDIR}/scan_%04d.jpg"

# 4) Images -> PDF
echo "[4/4] Assembling final PDF..."
"${IM_CMD[@]}" "${WORKDIR}"/scan_*.jpg \
  -compress jpeg -quality "${JPEG_QUALITY}" \
  "${OUTPUT}"

echo
echo "Done ✅  -> ${OUTPUT}"
