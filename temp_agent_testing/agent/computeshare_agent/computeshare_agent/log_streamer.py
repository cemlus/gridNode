# Reads stdout from the running container line by line and forwards each line to the backend API in real time.

import time
import threading
import requests


FLUSH_INTERVAL_SECONDS = 0.5   # batch lines every 500ms instead of per-line
MAX_BATCH_SIZE = 50             # never send more than 50 lines per request


class LogStreamer:
    def __init__(self, job_id, backend_url, headers):
        self.job_id      = job_id
        self.backend_url = backend_url
        self.headers     = headers
        self._buffer     = []
        self._lock       = threading.Lock()
        self._stop_event = threading.Event()
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True)

    def start(self):
        self._flush_thread.start()

    def ingest(self, process):
        """
        Call this from the main thread.
        Reads lines from the container process until it exits.
        """
        for raw_line in iter(process.stdout.readline, ""):
            line = raw_line.rstrip()
            if not line:
                continue
            entry = {"line": line, "ts": time.time()}
            with self._lock:
                self._buffer.append(entry)

        self._stop_event.set()
        self._flush_thread.join(timeout=10)
        self._flush()           # final flush after process exits

        return process.wait()   # returns exit code

    def _flush_loop(self):
        while not self._stop_event.is_set():
            time.sleep(FLUSH_INTERVAL_SECONDS)
            self._flush()

    def _flush(self):
        with self._lock:
            if not self._buffer:
                return
            batch = self._buffer[:MAX_BATCH_SIZE]
            self._buffer = self._buffer[MAX_BATCH_SIZE:]

        try:
            requests.post(
                f"{self.backend_url}/api/jobs/{self.job_id}/logs",
                json={"lines": batch},
                headers=self.headers,
                timeout=5
            )
        except Exception as e:
            print(f"  [WARN] Log flush failed: {e}")