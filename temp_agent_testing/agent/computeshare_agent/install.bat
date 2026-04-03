@echo off
echo.
echo ComputeShare Agent — Installer
echo ==============================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python is not installed or not on PATH.
    echo   Fix: https://www.python.org/downloads/
    pause
    exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not running. Start Docker Desktop first.
    pause
    exit /b 1
)

echo   Creating virtual environment...
python -m venv "%USERPROFILE%\.computeshare\venv"

echo   Installing agent...
"%USERPROFILE%\.computeshare\venv\Scripts\pip" install -q --upgrade pip
"%USERPROFILE%\.computeshare\venv\Scripts\pip" install -q git+https://github.com/yourname/computeshare-agent.git

echo.
echo ==============================
echo   Installation complete.
echo.
echo   Next step:
echo   computeshare-agent start --token your-token-here
echo.
pause
```

---

## `.gitignore`
```
__pycache__/
*.pyc
*.egg-info/
dist/
build/
.env
~/.computeshare/
/workspaces/
*.log