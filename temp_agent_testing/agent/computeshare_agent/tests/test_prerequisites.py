import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, ".")
from computeshare_agent.prerequisites import (
    check_python_version,
    check_docker,
)


class TestPrerequisites(unittest.TestCase):

    def test_python_version_passes(self):
        # Should not raise on the Python version running this test
        # (which must be >= 3.9 to even import the module cleanly)
        try:
            check_python_version()
        except SystemExit:
            self.fail("check_python_version() raised SystemExit unexpectedly")

    def test_docker_missing(self):
        with patch("shutil.which", return_value=None):
            with self.assertRaises(SystemExit):
                check_docker()

    def test_docker_daemon_not_running(self):
        with patch("shutil.which", return_value="/usr/bin/docker"):
            mock_result = MagicMock()
            mock_result.returncode = 1
            with patch("subprocess.run", return_value=mock_result):
                with self.assertRaises(SystemExit):
                    check_docker()


if __name__ == "__main__":
    unittest.main()