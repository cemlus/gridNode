import os
import json

CONFIG_DIR  = os.path.expanduser("~/.computeshare")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")


def load():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return None


def save(data):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump(data, f, indent=2)


def clear():
    if os.path.exists(CONFIG_FILE):
        os.remove(CONFIG_FILE)