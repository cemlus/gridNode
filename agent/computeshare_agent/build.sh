#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Building ComputeShare Agent with PyInstaller..."
# Create a temporary build environment
python3 -m venv build_venv
source build_venv/bin/activate

# Install dependencies and pyinstaller
pip install --quiet -r requirements.txt
pip install --quiet pyinstaller

# Build the standalone binary
pyinstaller --onefile --name computeshare-agent computeshare_agent/agent.py

deactivate
rm -rf build_venv

echo "Build complete. Binary is located at dist/computeshare-agent"