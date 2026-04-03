__version__ = "0.1.0"
__author__ = "PeerConnect"

# expose main so pyproject.toml's entry point can find it
from computeshare_agent.agent import main

__all__ = ["main"]