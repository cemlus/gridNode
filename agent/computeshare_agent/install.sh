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

# # Create virtualenv
# echo ""
# echo "  Creating virtual environment..."
# python3 -m venv ~/.computeshare/venv

# echo "  Upgrading core build tools..."
# # ADD THESE TWO LINES
# ~/.computeshare/venv/bin/pip install -q --upgrade pip setuptools wheel

# echo "  Installing agent..."
# ~/.computeshare/venv/bin/pip install -q --upgrade pip
# ~/.computeshare/venv/bin/pip install -e "$PWD"

# Create virtualenv with clear-on-start to ensure no old files remain
echo "  Creating virtual environment..."
python3 -m venv --clear ~/.computeshare/venv

echo "  Upgrading core build tools..."
# We use --no-cache-dir to ensure we aren't pulling a buggy cached version
~/.computeshare/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel

echo "  Installing agent..."
# Try a regular install first (no -e) to verify the pyproject.toml is valid
~/.computeshare/venv/bin/pip install "$PWD"


# Create a launcher script in /usr/local/bin
echo "  Creating launcher..."
sudo tee /usr/local/bin/computeshare-agent > /dev/null <<EOF
#!/bin/bash
~/.computeshare/venv/bin/computeshare-agent "\$@"
EOF
sudo chmod +x /usr/local/bin/computeshare-agent

echo ""
echo "=============================="
echo "  Installation complete."
echo ""
echo "  Next step:"
echo "  computeshare-agent start --token <your-token-from-dashboard>"
echo ""