#!/bin/bash
set -e

echo ""
echo "ComputeShare Agent — Installer"
echo "=============================="
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "[ERROR] Python 3 is not installed."
    echo "  Fix: https://www.python.org/downloads/"
    exit 1
fi

PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
REQUIRED="3.9"

if python3 -c "import sys; exit(0 if sys.version_info >= (3,9) else 1)"; then
    echo "  Python $PYTHON_VERSION ... OK"
else
    echo "[ERROR] Python $PYTHON_VERSION found, but 3.9+ is required."
    exit 1
fi

# Check Docker
if ! command -v docker &>/dev/null; then
    echo "[ERROR] Docker is not installed."
    echo "  Fix: https://docs.docker.com/get-docker/"
    exit 1
fi
echo "  Docker ... OK"

# one-time setup — downloads and registers the gVisor runtime
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install   # registers runsc as a Docker runtime
sudo systemctl restart docker

echo "  Installing agent binary..."
if [ -f "./dist/computeshare-agent" ]; then
    sudo cp ./dist/computeshare-agent /usr/local/bin/computeshare-agent
    sudo chmod +x /usr/local/bin/computeshare-agent
else
    echo "[ERROR] Binary not found. Run ./build.sh first (or download the release binary)."
    exit 1
fi

echo ""
echo "=============================="
echo "  Installation complete."
echo ""
echo "  Next step:"
echo "  computeshare-agent start --token <your-token-from-dashboard>"
echo ""